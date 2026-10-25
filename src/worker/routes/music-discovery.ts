/**
 * Discovery reads: home, search, playlists, albums, artists, toplists, MVs and podcasts.
 *
 * Every handler is a thin adapter over one provider call: query strings are parsed and bounded here,
 * pagination is converted to an offset once, and the provider's answer crosses the wire unchanged.
 * The provider is injected by `music.ts`, which also owns the rate budget and the error translation.
 *
 * Registration order matters: Hono matches in order, so `/playlists/categories` is claimed before
 * `/playlists/:id` and cannot be read as a playlist whose id is "categories".
 */
import { Hono, type Context } from 'hono'
import type { MusicPlaylistSummary, MusicSearchResult } from '@shared/music/api'
import type { MusicSearchType } from '@shared/music/model'
import { MUSIC_SEARCH_TYPES } from '@shared/music/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { readOptionalJson } from '../lib/request'
import { MusicStore, musicPageOffset, normalizeMusicLimit, normalizeMusicPage } from '../music/store'
import type {
  MusicAlbumQuery,
  MusicArtistQuery,
  MusicMvQuery,
  MusicPageQuery,
  MusicPlaylistQuery,
  MusicProvider,
  MusicRadioListQuery,
} from '../music/providers/types'
import type { MusicRouteDeps } from './music'

const KEYWORDS_MAX = 200
const ID_MAX = 128
const AREAS = ['ALL', 'ZH', 'EA', 'KR', 'JP'] as const
const MV_AREA: Record<string, string> = {
  ALL: '',
  ZH: '\u5185\u5730',
  EA: '\u6e2f\u53f0',
  US: '\u6b27\u7f8e',
  JP: '\u65e5\u672c',
  KR: '\u97e9\u56fd',
}
type AlbumArea = (typeof AREAS)[number]

function isSearchType(value: string): value is MusicSearchType {
  return (MUSIC_SEARCH_TYPES as readonly string[]).includes(value)
}

function isAlbumArea(value: string): value is AlbumArea {
  return (AREAS as readonly string[]).includes(value)
}

function numberParam(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
}

function boundedId(raw: string | undefined, label: string): string {
  const id = (raw ?? '').trim()
  if (!id) throw ApiError.badRequest(`A ${label} id is required`)
  if (id.length > ID_MAX) throw ApiError.badRequest(`That ${label} id is too long`)
  return id
}

export function createMusicDiscoveryRoutes(deps: MusicRouteDeps): Hono<AppBindings> {
  const routes = new Hono<AppBindings>()

  interface PageQuery extends MusicPageQuery {
    page: number
  }

  function pageOf(c: Context<AppBindings>): PageQuery {
    const page = normalizeMusicPage(c.req.query('page'))
    const limit = normalizeMusicLimit(c.req.query('limit'))
    return { page, limit, offset: musicPageOffset(page, limit) }
  }

  /**
   * Upstream refuses the hot shelf without a category, so an unfiltered request answers with the
   * editorial recommendation instead of an empty first page.
   */
  async function radioPage(
    provider: MusicProvider,
    query: MusicRadioListQuery,
  ): Promise<Awaited<ReturnType<MusicProvider['radioHot']>>> {
    if (query.categoryId) return provider.radioHot(query)
    const items = await provider.radioRecommend()
    return { items, total: items.length, hasMore: false }
  }

  async function guarded(
    c: Context<AppBindings>,
    run: (provider: MusicProvider) => Promise<Response>,
  ): Promise<Response> {
    try {
      return await run(await deps.provider(c))
    } catch (error) {
      throw deps.translate(error)
    }
  }

  routes.get('/home', (c) => guarded(c, async (provider) => c.json(await provider.home())))

  routes.get('/daily', (c) => guarded(c, async (provider) => c.json({ tracks: await provider.dailyTracks() })))

  routes.get('/home/fm', (c) => guarded(c, async (provider) => c.json({ tracks: await provider.personalFm() })))

  routes.get('/user/:id', (c) => {
    const id = boundedId(c.req.param('id'), 'user')
    return guarded(c, async (provider) => c.json(await provider.userProfile(id)))
  })

  routes.post('/home/fm/trash', async (c) => {
    const body = await readOptionalJson<{ trackId?: unknown; providerId?: unknown }>(c, 8 * 1024, {})
    const raw = typeof body.providerId === 'string'
      ? body.providerId
      : typeof body.trackId === 'string' ? body.trackId : ''
    const providerId = boundedId(raw, 'track')
    return guarded(c, async (provider) => {
      await provider.fmTrash(providerId)
      return c.json({ ok: true })
    })
  })

  routes.get('/search', (c) => {
    const type = c.req.query('type') ?? 'song'
    if (!isSearchType(type)) throw ApiError.badRequest('The search type is not supported')
    const keywords = (c.req.query('q') ?? '').trim()
    if (!keywords) throw ApiError.badRequest('The q parameter is required')
    if (keywords.length > KEYWORDS_MAX) {
      throw ApiError.badRequest(`The search query is longer than ${KEYWORDS_MAX} characters`)
    }
    return guarded(c, async (provider) => {
      const page = pageOf(c)
      const result: MusicSearchResult = await provider.search({ type, keywords, ...page })
      return c.json(result)
    })
  })

  routes.get('/search/suggest', (c) => {
    const keywords = (c.req.query('q') ?? '').trim()
    if (!keywords) return c.json({ items: [] as string[] })
    if (keywords.length > KEYWORDS_MAX) {
      throw ApiError.badRequest(`The search query is longer than ${KEYWORDS_MAX} characters`)
    }
    return guarded(c, async (provider) => {
      const suggestion = await provider.suggest(keywords)
      return c.json({ items: suggestion.keywords })
    })
  })

  routes.get('/search/hot', (c) => guarded(c, async (provider) => {
    const hot = await provider.searchHot()
    // The client renders keyword strings; the score only ordered the list upstream.
    return c.json({ defaultKeyword: hot.defaultKeyword, items: hot.items.map((item) => item.keyword) })
  }))

  routes.get('/playlists/categories', (c) => guarded(c, async (provider) => (
    c.json({ items: await provider.playlistCategories() })
  )))

  routes.get('/playlists', (c) => {
    const kind = c.req.query('kind')
    const resolvedKind: MusicPlaylistQuery['kind'] =
      kind === 'recommended' || kind === 'highquality' ? kind : 'hot'
    const order = c.req.query('order') === 'new' ? 'new' : 'hot'
    return guarded(c, async (provider) => {
      const query: MusicPlaylistQuery = {
        ...pageOf(c),
        kind: resolvedKind,
        category: c.req.query('cat') || undefined,
        order,
        before: numberParam(c.req.query('before')),
      }
      return c.json(await provider.playlists(query))
    })
  })

  routes.get('/playlists/:id', (c) => {
    const id = boundedId(c.req.param('id'), 'playlist')
    if (c.req.query('provider') === 'local') {
      return guarded(c, async () => {
        const page = pageOf(c)
        const store = new MusicStore(c.env.DB, c.get('userId'))
        const playlist = await store.getPlaylist(id)
        if (!playlist) throw ApiError.notFound('That playlist does not exist')
        const items = await store.listPlaylistItems(id, { page: page.page, limit: page.limit })
        if (!items) throw ApiError.notFound('That playlist does not exist')
        const summary: MusicPlaylistSummary = {
          id: playlist.id,
          provider: playlist.provider,
          providerId: playlist.providerId,
          name: playlist.name,
          description: playlist.description,
          coverUrl: playlist.coverUrl,
          trackCount: playlist.trackCount,
        }
        return c.json({
          playlist: summary,
          tracks: items.items.map((item) => item.track),
          total: items.total,
          hasMore: items.hasMore,
        })
      })
    }
    return guarded(c, async (provider) => {
      const page = pageOf(c)
      return c.json(await provider.playlist(id, page))
    })
  })

  routes.get('/albums/newest', (c) => guarded(c, async (provider) => (
    c.json(await provider.albums({ ...pageOf(c), kind: 'newest' }))
  )))

  routes.get('/albums/new', (c) => {
    const area = c.req.query('area') ?? 'ALL'
    if (!isAlbumArea(area)) throw ApiError.badRequest('The album area is not supported')
    return guarded(c, async (provider) => {
      const query: MusicAlbumQuery = { ...pageOf(c), kind: 'new', area }
      return c.json(await provider.albums(query))
    })
  })

  routes.get('/albums/:id', (c) => {
    const id = boundedId(c.req.param('id'), 'album')
    return guarded(c, async (provider) => c.json(await provider.album(id)))
  })

  routes.get('/artists/:id/songs', (c) => {
    const id = boundedId(c.req.param('id'), 'artist')
    return guarded(c, async (provider) => {
      const page = pageOf(c)
      // The provider exposes a hot-song prefix, not an arbitrary offset. Ask for the prefix that
      // covers this page (capped at one hundred) and slice it locally rather than inventing rows.
      const songLimit = Math.min(100, page.offset + page.limit)
      const detail = await provider.artist({
        id,
        albumLimit: 1,
        albumOffset: 0,
        songLimit,
      })
      const items = detail.hotTracks.slice(page.offset, page.offset + page.limit)
      return c.json({
        items,
        total: page.offset + detail.hotTracks.length,
        hasMore: detail.hotTracks.length >= page.offset + page.limit,
      })
    })
  })

  routes.get('/artists/:id/albums', (c) => {
    const id = boundedId(c.req.param('id'), 'artist')
    return guarded(c, async (provider) => {
      const page = pageOf(c)
      const query: MusicArtistQuery = {
        id,
        albumLimit: page.limit,
        albumOffset: page.offset,
        songLimit: 1,
      }
      const detail = await provider.artist(query)
      return c.json({
        items: detail.albums,
        total: detail.albumTotal,
        hasMore: detail.albumHasMore,
      })
    })
  })

  routes.get('/artists/:id', (c) => {
    const id = boundedId(c.req.param('id'), 'artist')
    return guarded(c, async (provider) => {
      const query: MusicArtistQuery = {
        id,
        albumLimit: normalizeMusicLimit(c.req.query('limit'), 30),
        albumOffset: 0,
        songLimit: 50,
      }
      return c.json(await provider.artist(query))
    })
  })

  routes.get('/toplists', (c) => guarded(c, async (provider) => (
    c.json({ items: await provider.toplists() })
  )))

  routes.get('/toplists/:id', (c) => {
    const id = boundedId(c.req.param('id'), 'toplist')
    return guarded(c, async (provider) => {
      const page = pageOf(c)
      // A toplist is a Netease playlist; the detail endpoint is the same call.
      return c.json(await provider.playlist(id, page))
    })
  })

  routes.get('/mvs', (c) => {
    // The Netease MV filter expects its own Chinese tag labels; the app's public axis uses stable
    // ASCII names so a translated screen never changes what the request means.
    const area = MV_AREA[c.req.query('area') ?? 'ALL'] ?? ''
    const type = c.req.query('type') === 'ALL' || !c.req.query('type') ? '' : c.req.query('type')!
    const order = c.req.query('order') === 'new' ? '\u6700\u65b0' : ''
    return guarded(c, async (provider) => {
      const query: MusicMvQuery = { ...pageOf(c), area, type, order }
      return c.json(await provider.mvList(query))
    })
  })

  routes.get('/mvs/:id', (c) => {
    const id = boundedId(c.req.param('id'), 'MV')
    return guarded(c, async (provider) => c.json(await provider.mvDetail(id)))
  })

  routes.get('/podcasts/categories', (c) => guarded(c, async (provider) => (
    c.json({ items: await provider.radioCategories() })
  )))

  routes.get('/podcasts/recommend', (c) => guarded(c, async (provider) => (
    c.json({ items: await provider.radioRecommend() })
  )))

  routes.get('/podcasts/today', (c) => guarded(c, async (provider) => (
    c.json({ tracks: await provider.radioToday() })
  )))

  routes.get('/radio/categories', (c) => guarded(c, async (provider) => (
    c.json({ items: await provider.radioCategories() })
  )))

  routes.get('/radio/recommend', (c) => guarded(c, async (provider) => (
    c.json({ items: await provider.radioRecommend() })
  )))

  routes.get('/radio/today', (c) => guarded(c, async (provider) => (
    c.json({ tracks: await provider.radioToday() })
  )))

  routes.get('/radio/hot', (c) => guarded(c, async (provider) => {
    const query = {
      ...pageOf(c),
      categoryId: c.req.query('cat') || c.req.query('categoryId') || undefined,
    }
    return c.json(await radioPage(provider, query))
  }))

  routes.get('/radio/subscriptions', (c) => guarded(c, async (provider) => {
    const page = pageOf(c)
    return c.json(await provider.radioSubscriptions(page))
  }))

  routes.get('/podcasts', (c) => guarded(c, async (provider) => {
    const query = {
      ...pageOf(c),
      categoryId: c.req.query('cat') || c.req.query('categoryId') || undefined,
      toplistType: c.req.query('type') === 'hot' ? 'hot' as const : undefined,
    }
    return c.json(await radioPage(provider, query))
  }))

  routes.post('/podcasts/:id/subscribe', async (c) => {
    const id = boundedId(c.req.param('id'), 'podcast')
    const body = await readOptionalJson<{ subscribe?: unknown }>(c, 8 * 1024, {})
    const subscribe = body.subscribe !== false
    return guarded(c, async (provider) => {
      await provider.radioSubscribe(id, subscribe)
      return c.json({ ok: true })
    })
  })

  routes.get('/podcasts/:id/programs', (c) => {
    const id = boundedId(c.req.param('id'), 'podcast')
    return guarded(c, async (provider) => {
      const page = pageOf(c)
      return c.json(await provider.radio(id, page))
    })
  })

  routes.get('/podcasts/:id', (c) => {
    const id = boundedId(c.req.param('id'), 'podcast')
    return guarded(c, async (provider) => {
      const page = pageOf(c)
      return c.json(await provider.radio(id, page))
    })
  })

  return routes
}
