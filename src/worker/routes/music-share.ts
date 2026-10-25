/**
 * A playlist's public face: one read-only projection behind an unguessable slug.
 *
 * The owner's account id, storage keys, provider ids and audio never cross this boundary. A slug is
 * generated on request and can be revoked; revoking it is the only thing that makes the address stop
 * answering, so nothing here may outlive a request in a cache except the cover image.
 */
import { Hono, type Context } from 'hono'
import { musicArtistNames } from '@shared/music/format'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidSlug } from '../lib/id'
import { createMinuteBudget } from '../lib/rate-limit'
import { MusicStore, type MusicPlaylistItemEntry } from '../music/store'
import { meterPublicShareAcrossIsolates } from '../music/share-limiter'
import { readMusicObjectStream, requireMusicStorage } from '../music/storage'

const PUBLIC_TRACKS_MAX = 500
const COVER_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
}

export const musicSharePublicRoutes = new Hono<AppBindings>()

const PUBLIC_SHARE_LIMIT = 120
const PUBLIC_SHARE_WINDOW_MS = 60_000
const PUBLIC_SHARE_MESSAGE = 'Too many requests for this shared playlist. Try again in a minute.'
const publicShareBudget = createMinuteBudget(PUBLIC_SHARE_LIMIT, PUBLIC_SHARE_MESSAGE)

async function meterPublicShare(
  c: Context<AppBindings>,
  next: () => Promise<void>,
): Promise<void> {
  // A public slug has no session to meter; the caller address plus the slug keeps one hot link from
  // spending the deployment's D1 budget without making the same visitor's other links share a bucket.
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',', 1)[0]?.trim() ?? 'anonymous'
  const slug = /\/playlists\/([^/]+)/.exec(c.req.path)?.[1]
    ?? c.req.path.split('/').filter(Boolean).at(-1)
    ?? 'index'
  const key = `${ip}:${slug}`
  const shared = await meterPublicShareAcrossIsolates(c.env, key, PUBLIC_SHARE_LIMIT, PUBLIC_SHARE_WINDOW_MS)
  if (shared) {
    if (!shared.allowed) {
      throw new ApiError(429, 'too_many_attempts', PUBLIC_SHARE_MESSAGE, {
        retryAfter: shared.retryAfter,
      })
    }
  } else {
    // A deployment without the binding, or a limiter that could not answer, keeps the old
    // per-isolate brake rather than failing the link outright.
    publicShareBudget(key)
  }
  await next()
}

musicSharePublicRoutes.use('*', meterPublicShare)

musicSharePublicRoutes.get('/playlists/:slug', async (c) => {
  const found = await sharedPlaylist(c)
  const store = new MusicStore(c.env.DB, found.userId)
  const items: MusicPlaylistItemEntry[] = []
  let total = 0
  // The store caps one page at a hundred rows; the public projection walks pages up to its own ceiling.
  for (let page = 1; page <= PUBLIC_TRACKS_MAX / 100; page += 1) {
    const answer = await store.listPlaylistItems(found.playlist.id, { page, limit: 100 })
    if (!answer) break
    total = answer.total
    items.push(...answer.items)
    if (!answer.hasMore || items.length >= PUBLIC_TRACKS_MAX) break
  }
  const visible = items.slice(0, PUBLIC_TRACKS_MAX)
  const tracks = visible.map((item) => ({
    position: item.position,
    title: item.track.title,
    artists: musicArtistNames(item.track),
    album: item.track.album,
    durationMs: item.track.durationMs,
    format: item.track.format,
  }))
  return c.json({
    playlist: {
      name: found.playlist.name,
      description: found.playlist.description,
      coverUrl: publicCoverUrl(found.playlist.coverUrl, found.playlist.shareSlug),
      trackCount: found.playlist.trackCount,
      updatedAt: found.playlist.updatedAt,
    },
    tracks,
    truncated: total > tracks.length,
  }, 200, { 'Cache-Control': 'no-store' })
})

musicSharePublicRoutes.get('/playlists/:slug/cover', async (c) => {
  const found = await sharedPlaylist(c)
  const key = await new MusicStore(c.env.DB, found.userId).getPlaylistCoverKey(found.playlist.id)
  if (!key) throw ApiError.notFound('This playlist has no cover')
  requireMusicStorage(c.env)
  const object = await readMusicObjectStream(c.env, key)
  if (!object) throw ApiError.notFound('This playlist cover is no longer stored')
  const extension = key.split('.').pop()?.toLowerCase() ?? ''
  const headers = new Headers({
    'Content-Type': object.contentType ?? COVER_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
    'Content-Disposition': 'inline',
    // Revoking the slug is the only way this address stops answering; a stored copy would outlive it.
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (object.size !== null) headers.set('Content-Length', String(object.size))
  return new Response(object.body as BodyInit, { headers })
})

async function sharedPlaylist(c: Context<AppBindings>) {
  const slug = c.req.param('slug') ?? ''
  if (!isValidSlug(slug)) throw ApiError.notFound('That shared playlist does not exist')
  const found = await new MusicStore(c.env.DB, '').findPlaylistByShareSlug(slug)
  if (!found) throw ApiError.notFound('That shared playlist does not exist')
  return found
}

/** Uploaded covers point at the owner's private media route; the public page gets its own address. */
function publicCoverUrl(coverUrl: string, slug: string | null): string {
  if (!slug) return ''
  if (coverUrl.startsWith('/api/music/media/cover/playlist/')) {
    return `/api/public/music/playlists/${slug}/cover${cacheBust(coverUrl)}`
  }
  return /^https?:\/\//i.test(coverUrl) ? coverUrl : ''
}

function cacheBust(coverUrl: string): string {
  const query = coverUrl.split('?', 2)[1]
  return query ? `?${query}` : ''
}

export const musicSharePageRoutes = new Hono<AppBindings>()

musicSharePageRoutes.use('*', meterPublicShare)

musicSharePageRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  if (!isValidSlug(slug)) return renderShell(c, null)

  const row = await new MusicStore(c.env.DB, '').getSharedPlaylistMeta(slug)
  return renderShell(c, row)
})

async function renderShell(
  c: Context<AppBindings>,
  row: { name: string; description: string; coverUrl: string; coverKey: string } | null,
) {
  const url = new URL(c.req.url)
  const shell = await c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)))
  if (!shell.ok) return shell

  const siteName = c.env.APP_NAME || 'Inkstone'
  const title = row?.name || 'Shared playlist'
  const description = row?.description || `A playlist shared from ${siteName}`
  const slug = c.req.param('slug') ?? ''
  const image = row?.coverKey
    ? `<meta property="og:image" content="${escapeHtml(`${url.origin}/api/public/music/playlists/${slug}/cover`)}" />`
    : /^https?:\/\//i.test(row?.coverUrl ?? '')
      ? `<meta property="og:image" content="${escapeHtml(row?.coverUrl ?? '')}" />`
      : ''
  const meta = [
    `<title>${escapeHtml(title)} · ${escapeHtml(siteName)}</title>`,
    `<meta property="og:type" content="music.playlist" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    image,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="robots" content="noindex, nofollow" />`,
  ].filter(Boolean).join('\n    ')

  const html = (await shell.text())
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace('</head>', `    ${meta}\n  </head>`)
  return c.html(html, 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
