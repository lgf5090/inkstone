/**
 * The `MUSIC_UPSTREAM_API` fallback: the same provider interface over a self-hosted NCM REST API.
 *
 * The reference server exposes one route per module (`/cloudsearch`, `/song/url/v1`, ...) and accepts
 * the cookie as a query parameter, so this adapter only maps calls and reuses `normalize.ts`. It is a
 * direct HTTPS origin: redirects are refused rather than followed, and the base URL must be HTTPS
 * (localhost is allowed for a development deployment).
 */
import type { MusicAccount, MusicFmMode, MusicSearchType, MusicTrack } from '../../../../shared/music/model'
import { musicTrackKey } from '../../../../shared/music/model'
import type {
  MusicAccountStatus,
  MusicAlbumDetail,
  MusicAlbumSummary,
  MusicArtistDetail,
  MusicArtistEventPage,
  MusicArtistSummary,
  MusicHome,
  MusicLyricPayload,
  MusicMvDetail,
  MusicMvSummary,
  MusicPage,
  MusicPlaylistDetail,
  MusicPlaylistSummary,
  MusicRadioDetail,
  MusicRadioSummary,
  MusicSearchResult,
  MusicToplistSummary,
  MusicUserProfile,
} from '../../../../shared/music/api'
import type { MusicCommentPage } from '../../../../shared/music/comments'
import {
  MusicProviderError,
  type MusicAlbumQuery,
  type MusicArtistQuery,
  type MusicCommentLike,
  type MusicCommentQuery,
  type MusicCursorPage,
  type MusicHeartModeQuery,
  type MusicHotSearch,
  type MusicLoginSession,
  type MusicMvQuery,
  type MusicMvSource,
  type MusicPageQuery,
  type MusicPlaylistCategory,
  type MusicPlaylistQuery,
  type MusicProvider,
  type MusicQrChallenge,
  type MusicQrPollResult,
  type MusicRadioCategory,
  type MusicRadioListQuery,
  type MusicStreamSource,
  type MusicSuggestionResult,
} from '../types'
import {
  normalizeAccount,
  normalizeAlbumDetail,
  normalizeAlbumSummary,
  normalizeArtistDetail,
  normalizeArtistEvents,
  normalizeArtistSummary,
  normalizeCommentPage,
  normalizeDefaultKeyword,
  normalizeHotSearchItems,
  normalizeLyric,
  normalizeMvDetail,
  normalizeMvSource,
  normalizeMvSummary,
  normalizePlaylistCategories,
  normalizePlaylistDetail,
  normalizePlaylistSummary,
  normalizeProgram,
  normalizeRadioCategories,
  normalizeRadioDetail,
  normalizeRadioSummary,
  normalizeSearch,
  normalizeSearchSuggestions,
  normalizeStreamSource,
  normalizeToplistSummary,
  normalizeTrack,
} from './normalize'
import { cookieJarToString, cookiePairs, parseCookie, NETEASE_TIMEOUT_MS } from './request'
import { NeteaseLogin, type NeteaseLoginRequest, type NeteaseLoginTransport } from './login'

export interface ExternalNeteaseOptions {
  baseUrl: string
  cookie?: string
  timeoutMs?: number
  retries?: number
}

const SEARCH_TYPES: Record<MusicSearchType, number> = {
  song: 1,
  album: 10,
  playlist: 1000,
  mv: 1004,
  radio: 1009,
  artist: 100,
  user: 1002,
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function encodeTypeFor(quality: string): string {
  return quality === 'lossless' ? 'aac' : 'flac'
}

export type ExternalQuery = Record<string, string | number | boolean | undefined>

interface ExternalResponse {
  ok: boolean
  status: number
  body: Record<string, unknown>
  error: string
}

export class ExternalNeteaseProvider implements MusicProvider, NeteaseLoginTransport {
  readonly id = 'netease' as const
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly cookies = new Map<string, string>()
  private readonly login: NeteaseLogin

  constructor(options: ExternalNeteaseOptions) {
    let base: URL
    try {
      base = new URL(options.baseUrl)
    } catch {
      throw new MusicProviderError(500, 'server_misconfigured', 'MUSIC_UPSTREAM_API is not a valid URL')
    }
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLocalHost(base.hostname))) {
      throw new MusicProviderError(
        500,
        'server_misconfigured',
        'MUSIC_UPSTREAM_API must use HTTPS (HTTP is allowed only for localhost)',
      )
    }
    if (base.username || base.password) {
      throw new MusicProviderError(500, 'server_misconfigured', 'MUSIC_UPSTREAM_API may not carry credentials')
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? NETEASE_TIMEOUT_MS
    this.retries = options.retries ?? 1
    for (const [name, value] of Object.entries(parseCookie(options.cookie))) {
      this.cookies.set(name, value)
    }
    this.login = new NeteaseLogin(this)
  }

  currentCookie(): string {
    return cookieJarToString(Object.fromEntries(this.cookies))
  }

  private hasSession(): boolean {
    return this.cookies.has('MUSIC_U')
  }

  absorbCookie(cookie: string | string[]): void {
    for (const [name, value] of cookiePairs(cookie)) this.cookies.set(name, value)
  }

  resetCookie(): void {
    this.cookies.clear()
  }

  private urlFor(route: string, params: ExternalQuery): string {
    const url = new URL(`${this.baseUrl}${route}`)
    url.searchParams.set('timestamp', String(Date.now()))
    url.searchParams.set('device', 'web')
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined) continue
      url.searchParams.set(name, String(value))
    }
    const cookie = this.currentCookie()
    if (cookie) url.searchParams.set('cookie', cookie)
    return url.toString()
  }

  private async fetchExternal(route: string, params: ExternalQuery): Promise<ExternalResponse> {
    const url = this.urlFor(route, params)
    let lastError = ''
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
        if (response.status >= 500 && attempt < this.retries) {
          await response.body?.cancel()
          continue
        }
        if (response.status >= 300 && response.status < 400) {
          return {
            ok: false,
            status: 502,
            body: { code: 502, message: 'The music upstream redirected, which this adapter refuses' },
            error: 'The music upstream redirected, which this adapter refuses',
          }
        }
        const raw = await response.text()
        let body: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(raw)
          body = record(parsed)
        } catch {
          return {
            ok: false,
            status: 502,
            body: { code: 502, message: raw.slice(0, 500) },
            error: 'The music upstream returned a non-JSON body',
          }
        }
        if (typeof body.cookie === 'string' && body.cookie) this.absorbCookie(body.cookie)
        if (!response.ok) {
          return { ok: false, status: response.status, body, error: `The music upstream responded ${response.status}` }
        }
        return { ok: true, status: response.status, body, error: '' }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      } finally {
        clearTimeout(timer)
      }
    }
    return {
      ok: false,
      status: 502,
      body: { code: 502, message: lastError },
      error: lastError || 'The music upstream request failed',
    }
  }

  private errorFor(response: ExternalResponse, code: number): MusicProviderError {
    const message = text(response.body.msg) || text(response.body.message) || `The music upstream answered ${code}`
    if (response.error) return new MusicProviderError(502, 'upstream_error', response.error, response.body)
    if (code === 301 || code === -462) {
      return new MusicProviderError(401, 'auth_required', message, response.body)
    }
    if (code >= 500) return new MusicProviderError(502, 'upstream_error', message, response.body)
    return new MusicProviderError(400, 'upstream_error', message, response.body)
  }

  private async bodyOf(
    route: string,
    params: ExternalQuery = {},
    allowed: readonly number[] = [200],
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchExternal(route, params)
    const code = number(response.body.code, response.status)
    if (!response.ok || !allowed.includes(code)) throw this.errorFor(response, code)
    return response.body
  }

  async request(input: NeteaseLoginRequest): Promise<Record<string, unknown>> {
    if (input.kind === 'qr-key') return this.bodyOf('/login/qr/key')
    if (input.kind === 'qr-check') {
      return this.bodyOf('/login/qr/check', { key: input.key, noCookie: true }, [800, 801, 802, 803])
    }
    return this.bodyOf('/logout', {}, [200, 301])
  }

  async readAccount(): Promise<MusicAccount | null> {
    const response = await this.fetchExternal('/user/account', {})
    const code = number(response.body.code, response.status)
    if (code === 301) return null
    if (!response.ok || code >= 400) throw this.errorFor(response, code)
    return normalizeAccount(response.body)
  }

  async search(query: Parameters<MusicProvider['search']>[0]): Promise<MusicSearchResult> {
    const body = await this.bodyOf('/cloudsearch', {
      keywords: query.keywords,
      type: SEARCH_TYPES[query.type],
      limit: query.limit,
      offset: query.offset,
    })
    return normalizeSearch(body, query.type, query.limit, query.offset)
  }

  async searchHot(): Promise<MusicHotSearch> {
    const [defaults, hot] = await Promise.all([
      this.bodyOf('/search/default'),
      this.bodyOf('/search/hot/detail'),
    ])
    return {
      defaultKeyword: normalizeDefaultKeyword(defaults),
      items: normalizeHotSearchItems(hot),
    }
  }

  async suggest(keywords: string): Promise<MusicSuggestionResult> {
    const body = await this.bodyOf('/search/suggest', { keywords })
    return { items: normalizeSearchSuggestions(body) }
  }

  async home(): Promise<MusicHome> {
    const [playlists, songs, artists, albums] = await Promise.all([
      this.bodyOf('/personalized', { limit: 12 }),
      this.bodyOf('/personalized/newsong', { limit: 12 }),
      this.bodyOf('/top/artists', { limit: 12, offset: 0 }),
      this.bodyOf('/album/newest'),
    ])
    let dailyTracks: MusicTrack[] = []
    if (this.hasSession()) {
      try {
        dailyTracks = await this.dailyTracks()
      } catch (error) {
        // Same contract as the native provider: public blocks still render when the login expired.
        if (!(error instanceof MusicProviderError) || error.code !== 'auth_required') throw error
        console.warn('[music] upstream daily recommendations need a fresh login:', error.message)
      }
    }
    return {
      dailyTracks,
      fmEnabled: this.hasSession(),
      recommendedPlaylists: list(record(playlists).result).map(normalizePlaylistSummary),
      hotArtists: list(record(artists).artists).map(normalizeArtistSummary),
      newAlbums: list(record(albums).albums).map(normalizeAlbumSummary),
      newTracks: list(record(songs).result).map((item) => normalizeTrack(item)),
    }
  }

  async dailyTracks(): Promise<MusicTrack[]> {
    const body = await this.bodyOf('/recommend/songs')
    return list(record(body.data).dailySongs).map((item) => normalizeTrack(item))
  }

  async personalFm(mode: MusicFmMode): Promise<MusicTrack[]> {
    void mode
    const body = await this.bodyOf('/personal_fm')
    return list(body.data).map((item) => normalizeTrack(item))
  }

  async fmTrash(providerId: string): Promise<void> {
    await this.bodyOf('/fm_trash', { id: providerId })
  }

  async comments(query: MusicCommentQuery): Promise<MusicCommentPage> {
    const program = query.thread.startsWith('A_DJ_1_')
    const id = query.thread.replace(/^R_SO_4_/, '').replace(/^A_DJ_1_/, '')
    const body = await this.bodyOf(program ? '/comment/dj' : '/comment/music', {
      id,
      limit: query.limit,
      offset: query.offset,
    })
    return normalizeCommentPage(body, query.offset)
  }

  async likeComment(input: MusicCommentLike): Promise<void> {
    const id = input.thread.replace(/^R_SO_4_/, '').replace(/^A_DJ_1_/, '')
    const type = input.thread.startsWith('A_DJ_1_') ? 6 : 0
    await this.bodyOf('/comment/like', {
      id,
      cid: input.commentId,
      t: input.liked ? 1 : 0,
      type,
    })
  }

  async heartMode(query: MusicHeartModeQuery): Promise<MusicTrack[]> {
    const body = await this.bodyOf('/playmode/intelligence/list', {
      songId: query.songId,
      startMusicId: query.startSongId,
      playlistId: query.playlistId,
      type: 'fromPlayOne',
      count: 1,
    })
    return list(body.data)
      .map((item) => record(item).songInfo)
      .filter((item): item is unknown => Boolean(item))
      .map((item) => normalizeTrack(item))
  }

  async likedPlaylistId(): Promise<string> {
    const account = await this.accountStatus()
    if (!account.account) return ''
    const body = await this.bodyOf('/user/playlist', { uid: account.account.accountId, limit: 1000, offset: 0 })
    const playlist = list(body.playlist)
      .map((item) => record(item))
      .find((item) => Number(item.specialType) === 5)
    return playlist ? text(playlist.id) : ''
  }

  async songDetail(providerIds: string[]): Promise<MusicTrack[]> {
    if (providerIds.length === 0) return []
    const body = await this.bodyOf('/song/detail', { ids: providerIds.join(',') })
    return list(body.songs).map((item) => normalizeTrack(item))
  }

  async playlists(query: MusicPlaylistQuery): Promise<MusicCursorPage<MusicPlaylistSummary>> {
    if (query.kind === 'recommended') {
      const body = await this.bodyOf('/personalized', { limit: query.limit })
      const items = list(body.result).map(normalizePlaylistSummary)
      return { items, total: items.length, hasMore: false, cursor: 0 }
    }
    const body =
      query.kind === 'highquality'
        ? await this.bodyOf('/top/playlist/highquality', {
            cat: query.category,
            before: query.before,
            limit: query.limit,
          })
        : await this.bodyOf('/top/playlist', {
            cat: query.category,
            order: query.order,
            limit: query.limit,
            offset: query.offset,
          })
    const items = list(body.playlists).map(normalizePlaylistSummary)
    const total = number(body.total, items.length)
    return {
      items,
      total,
      hasMore: body.more === true || query.offset + items.length < total,
      cursor: number(body.lasttime, 0),
    }
  }

  async playlistCategories(): Promise<MusicPlaylistCategory[]> {
    return normalizePlaylistCategories(await this.bodyOf('/playlist/catlist'))
  }

  async playlist(providerId: string, page: MusicPageQuery): Promise<MusicPlaylistDetail> {
    const detail = normalizePlaylistDetail(await this.bodyOf('/playlist/detail', { id: providerId }))
    const tracks = detail.tracks.slice(page.offset, page.offset + page.limit)
    return {
      playlist: detail.playlist,
      tracks,
      total: detail.total,
      hasMore: page.offset + tracks.length < detail.total,
    }
  }

  async albums(query: MusicAlbumQuery): Promise<MusicPage<MusicAlbumSummary>> {
    const body =
      query.kind === 'newest'
        ? await this.bodyOf('/album/newest')
        : await this.bodyOf('/album/new', {
            area: query.area,
            limit: query.limit,
            offset: query.offset,
          })
    const items = list(body.albums).map(normalizeAlbumSummary)
    const total = number(body.total, items.length)
    return { items, total, hasMore: body.more === true || query.offset + items.length < total }
  }

  async album(providerId: string): Promise<MusicAlbumDetail> {
    return normalizeAlbumDetail(await this.bodyOf('/album', { id: providerId }))
  }

  async artist(query: MusicArtistQuery): Promise<MusicArtistDetail> {
    const [detail, songs, albums] = await Promise.all([
      this.bodyOf('/artist/detail', { id: query.id }),
      this.bodyOf('/artist/songs', {
        id: query.id,
        order: 'hot',
        limit: query.songLimit,
        offset: 0,
      }),
      this.bodyOf('/artist/album', { id: query.id, limit: query.albumLimit, offset: query.albumOffset }),
    ])
    return normalizeArtistDetail(detail, songs, albums, number(record(albums).total, 0))
  }

  async artistSongs(providerId: string, order: 'hot' | 'time', page: MusicPageQuery): Promise<MusicTrack[]> {
    const body = await this.bodyOf('/artist/songs', {
      id: providerId,
      order,
      limit: page.limit,
      offset: page.offset,
    })
    return list(body.songs).map((item) => normalizeTrack(item))
  }

  async artistFollow(providerId: string, follow: boolean): Promise<void> {
    await this.bodyOf('/artist/sub', { id: providerId, t: follow ? 1 : 0 })
  }

  async artistEvents(providerId: string, before: number | null, limit: number): Promise<MusicArtistEventPage> {
    if (!providerId) return { items: [], before: null }
    const profile = await this.bodyOf('/artist/detail', { id: providerId })
    const data = record(profile.data)
    const artist = Object.keys(record(data.artist)).length ? record(data.artist) : record(profile.artist)
    const uid = text(artist.accountId) || text(artist.accountID)
    if (!uid) return { items: [], before: null }
    const body = await this.bodyOf('/event/get', {
      uid,
      time: before === null ? -1 : before,
      limit,
      getcounts: true,
    })
    return normalizeArtistEvents(body)
  }

  async artistsTop(page: MusicPageQuery): Promise<MusicPage<MusicArtistSummary>> {
    const body = await this.bodyOf('/top/artists', { limit: page.limit, offset: page.offset })
    const items = list(body.artists).map(normalizeArtistSummary)
    const total = number(body.total, page.offset + items.length)
    return { items, total, hasMore: body.more === true || page.offset + items.length < total }
  }

  async toplists(): Promise<MusicToplistSummary[]> {
    const body = await this.bodyOf('/toplist')
    return list(body.list).map(normalizeToplistSummary)
  }

  async mvList(query: MusicMvQuery): Promise<MusicPage<MusicMvSummary>> {
    const body = await this.bodyOf('/mv/all', {
      area: query.area,
      type: query.type,
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    })
    const items = list(body.data).map(normalizeMvSummary)
    const total = number(body.count, items.length)
    return { items, total, hasMore: body.hasMore === true || query.offset + items.length < total }
  }

  async mvDetail(providerId: string): Promise<MusicMvDetail> {
    return normalizeMvDetail(await this.bodyOf('/mv/detail', { mvid: providerId }))
  }

  async mvUrl(providerId: string): Promise<MusicMvSource> {
    const source = normalizeMvSource(await this.bodyOf('/mv/url', { id: providerId }))
    if (!source) throw new MusicProviderError(502, 'source_unavailable', 'The music upstream returned no MV URL')
    return source
  }

  async radioCategories(): Promise<MusicRadioCategory[]> {
    return normalizeRadioCategories(await this.bodyOf('/dj/catelist'))
  }

  async radioRecommend(): Promise<MusicRadioSummary[]> {
    const body = await this.bodyOf('/dj/recommend')
    return list(body.djRadios).map(normalizeRadioSummary)
  }

  async radioToday(): Promise<MusicTrack[]> {
    const body = await this.bodyOf('/dj/today/perfered')
    return list(body.data).map(normalizeProgram)
  }

  async radioHot(query: MusicRadioListQuery): Promise<MusicPage<MusicRadioSummary>> {
    const body = await this.bodyOf('/dj/radio/hot', {
      cateId: query.categoryId,
      limit: query.limit,
      offset: query.offset,
    })
    const items = list(body.djRadios).map(normalizeRadioSummary)
    const total = number(body.count, items.length)
    return { items, total, hasMore: query.offset + items.length < total }
  }

  async radioSubscriptions(page: MusicPageQuery): Promise<MusicPage<MusicRadioSummary>> {
    const body = await this.bodyOf('/dj/sublist', { limit: page.limit, offset: page.offset })
    const items = list(body.djRadios).map(normalizeRadioSummary)
    const total = number(body.count, items.length)
    return { items, total, hasMore: page.offset + items.length < total }
  }

  async radio(providerId: string, page: MusicPageQuery): Promise<MusicRadioDetail> {
    const [detail, programs] = await Promise.all([
      this.bodyOf('/dj/detail', { rid: providerId }),
      this.bodyOf('/dj/program', { rid: providerId, limit: page.limit, offset: page.offset }),
    ])
    return normalizeRadioDetail(detail, programs, page.offset)
  }

  async radioSubscribe(providerId: string, subscribe: boolean): Promise<void> {
    await this.bodyOf('/dj/sub', { rid: providerId, t: subscribe ? 1 : 0 })
  }

  async lyrics(providerId: string): Promise<MusicLyricPayload> {
    const body = await this.bodyOf('/lyric/new', { id: providerId })
    return normalizeLyric(body, musicTrackKey('netease', providerId))
  }

  async stream(providerId: string, quality: string): Promise<MusicStreamSource> {
    const body = await this.bodyOf('/song/url/v1', {
      id: providerId,
      level: quality,
      encodeType: encodeTypeFor(quality),
    })
    const source = normalizeStreamSource(body, quality)
    if (!source) {
      throw new MusicProviderError(
        502,
        'source_unavailable',
        'The music upstream returned no playable URL for this track and quality',
        body,
      )
    }
    return source
  }

  async downloadUrl(providerId: string, quality: string): Promise<MusicStreamSource> {
    const body = await this.bodyOf('/song/download/url/v1', {
      id: providerId,
      level: quality,
      encodeType: encodeTypeFor(quality),
    })
    const source = normalizeStreamSource(body, quality)
    if (!source) {
      throw new MusicProviderError(
        502,
        'source_unavailable',
        'The music upstream returned no download URL for this track and quality',
        body,
      )
    }
    return source
  }

  async accountStatus(): Promise<MusicAccountStatus> {
    return this.login.status()
  }

  async userProfile(uid: string): Promise<MusicUserProfile> {
    const [detail, playlists] = await Promise.all([
      this.bodyOf('/user/detail', { uid }),
      this.bodyOf('/user/playlist', { uid, limit: 100, offset: 0 }),
    ])
    const profile = record(detail.profile)
    return {
      id: text(profile.userId) || uid,
      nickname: text(profile.nickname) || 'Netease user',
      avatarUrl: text(profile.avatarUrl),
      signature: text(profile.signature),
      follows: number(profile.follows, 0),
      followers: number(profile.followeds, 0),
      playlists: list(playlists.playlist)
        .map((item) => normalizePlaylistSummary(item))
        .filter((item) => item.id),
    }
  }

  async loginQrKey(): Promise<MusicQrChallenge> {
    return this.login.createQr()
  }

  async loginQrPoll(key: string): Promise<MusicQrPollResult> {
    return this.login.pollQr(key)
  }

  async loginCookie(cookie: string): Promise<MusicLoginSession> {
    return this.login.connectCookie(cookie)
  }

  async logout(): Promise<void> {
    await this.login.logout()
  }
}
