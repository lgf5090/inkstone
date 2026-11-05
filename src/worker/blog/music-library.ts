import type { MusicArtist } from '@shared/music/model'
import type {
  BlogMusicConfig,
  BlogMusicLibrarySummary,
  BlogMusicTrack,
  BlogSitePublic,
} from '@shared/blog/model'
import type { Env } from '../env'

/**
 * The blog's read-only view of the owner's music library.
 *
 * Only tracks this account actually stored in R2 are publishable: a provider snapshot without bytes
 * would make the public page ask the music provider for a stream, which is neither the blog's data
 * nor a stable public source. Playlists are owner-scoped by their query, and a playlist id from
 * another account resolves to an empty list instead of a different owner's rows.
 *
 * Audio and covers never expose an R2 key. Each listed track gets a short-lived HMAC token bound to
 * the owner, the object kind and the track id; the public audio/cover routes verify it before reading
 * the bucket. The token is refreshed whenever `/api/blog/site` is rebuilt.
 */

const MEDIA_TOKEN_TTL_MS = 2 * 60 * 60 * 1000
const MAX_AUDIO_TOKEN_LENGTH = 512
const MAX_TRACKS = 200
const MAX_PLAYLIST_TRACKS = 500
/** A fixed local-development secret: the proxy guard already lets dev run without BLOG_PROXY_KEY. */
const DEV_MEDIA_SECRET = 'inkstone-blog-media-dev-secret-0001'

interface MediaTokenPayload {
  k: 'audio' | 'cover'
  u: string
  i: string
  e: number
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

function mediaSecret(env: Env): string | null {
  const unlock = typeof env.BLOG_UNLOCK_SECRET === 'string' ? env.BLOG_UNLOCK_SECRET : ''
  if (unlock.length >= 16) return unlock
  const proxy = typeof env.BLOG_PROXY_KEY === 'string' ? env.BLOG_PROXY_KEY : ''
  if (proxy.length >= 16) return proxy
  // Production compiles `DEV` to false and therefore fails closed; local development may omit both
  // secrets, the same way `requireBlogProxy` permits it, so the library is still playable there.
  return import.meta.env?.DEV === true ? DEV_MEDIA_SECRET : null
}

async function sign(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

export async function issueBlogMediaToken(
  env: Env,
  kind: MediaTokenPayload['k'],
  userId: string,
  trackId: string,
  now = Date.now(),
): Promise<string | null> {
  const secret = mediaSecret(env)
  if (!secret) return null
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ k: kind, u: userId, i: trackId, e: now + MEDIA_TOKEN_TTL_MS })))
  return `${payload}.${base64Url(await sign(secret, payload))}`
}

export async function verifyBlogMediaToken(
  env: Env,
  kind: MediaTokenPayload['k'],
  userId: string,
  trackId: string,
  token: string | null | undefined,
  now = Date.now(),
): Promise<boolean> {
  const secret = mediaSecret(env)
  if (!secret || !token || token.length > MAX_AUDIO_TOKEN_LENGTH) return false
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra) return false
  if (!equal(signature, base64Url(await sign(secret, payload)))) return false
  const bytes = fromBase64Url(payload)
  if (!bytes) return false
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<MediaTokenPayload>
    return parsed.k === kind && parsed.u === userId && parsed.i === trackId
      && typeof parsed.e === 'number' && Number.isFinite(parsed.e) && parsed.e > now
  } catch {
    return false
  }
}

function parseArtists(raw: string): MusicArtist[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const name = typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name.trim() : ''
      return name ? [{ id: typeof (entry as { id?: unknown }).id === 'string' ? (entry as { id: string }).id : '', name }] : []
    })
  } catch {
    return []
  }
}

interface PlayableTrackRow {
  id: string
  title: string
  artists: string
  duration_ms: number
  cover_url: string
  cover_key: string
  r2_key: string
  updated_at: number
}

const PLAYABLE_COLUMNS = 'id, title, artists, duration_ms, cover_url, cover_key, r2_key, updated_at'

export async function listBlogMusicLibrary(
  db: D1Database,
  userId: string,
): Promise<BlogMusicLibrarySummary> {
  const [total, playlists] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total FROM music_track
       WHERE user_id = ?1 AND r2_key IS NOT NULL AND r2_key <> ''`,
    ).bind(userId).first<{ total: number }>(),
    db.prepare(
      `SELECT p.id, p.name, p.description, p.cover_url,
              (p.cover_key IS NOT NULL AND p.cover_key <> '') AS has_cover,
              (SELECT COUNT(*) FROM music_playlist_item i
                WHERE i.user_id = p.user_id AND i.playlist_id = p.id) AS track_count,
              (SELECT COUNT(*) FROM music_playlist_item i
                JOIN music_track t ON t.user_id = i.user_id AND t.id = i.track_id
                WHERE i.user_id = p.user_id AND i.playlist_id = p.id
                  AND t.r2_key IS NOT NULL AND t.r2_key <> '') AS playable_count,
              p.updated_at
         FROM music_playlist p
        WHERE p.user_id = ?1
        ORDER BY (p.pinned_at IS NULL), p.pinned_at DESC, p.sort_order, p.created_at, p.id`,
    ).bind(userId).all<{
      id: string
      name: string
      description: string
      cover_url: string
      has_cover: number
      track_count: number
      playable_count: number
      updated_at: number
    }>(),
  ])
  return {
    total: total?.total ?? 0,
    playlists: playlists.results.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      coverUrl: row.cover_url,
      hasCover: row.has_cover === 1,
      trackCount: row.track_count,
      playableCount: row.playable_count,
      updatedAt: row.updated_at,
    })),
  }
}

async function playlistTracks(
  db: D1Database,
  userId: string,
  playlistId: string,
): Promise<PlayableTrackRow[]> {
  const playlist = await db.prepare(
    `SELECT id FROM music_playlist WHERE user_id = ?1 AND id = ?2`,
  ).bind(userId, playlistId).first<{ id: string }>()
  if (!playlist) return []
  const { results } = await db.prepare(
    `SELECT t.id, t.title, t.artists, t.duration_ms, t.cover_url, t.cover_key, t.r2_key, t.updated_at
       FROM music_playlist_item i
       JOIN music_track t ON t.user_id = i.user_id AND t.id = i.track_id
      WHERE i.user_id = ?1 AND i.playlist_id = ?2
        AND t.r2_key IS NOT NULL AND t.r2_key <> ''
      ORDER BY i.position, i.track_id
      LIMIT ${MAX_PLAYLIST_TRACKS}`,
  ).bind(userId, playlistId).all<PlayableTrackRow>()
  return results
}

async function allTracks(db: D1Database, userId: string): Promise<PlayableTrackRow[]> {
  const { results } = await db.prepare(
    `SELECT ${PLAYABLE_COLUMNS} FROM music_track
      WHERE user_id = ?1 AND r2_key IS NOT NULL AND r2_key <> ''
      ORDER BY updated_at DESC, id DESC
      LIMIT ${MAX_TRACKS}`,
  ).bind(userId).all<PlayableTrackRow>()
  return results
}

async function publicTracks(
  env: Env,
  db: D1Database,
  userId: string,
  music: BlogMusicConfig,
): Promise<BlogMusicTrack[]> {
  if (music.provider !== 'library') return music.tracks
  // A playlist that was deleted, renamed away or belongs to another account resolves to nothing;
  // it must never widen into "all tracks", because the owner asked to publish one selection only.
  const scope = music.libraryScope === 'playlist'
    ? music.libraryPlaylistId
      ? await playlistTracks(db, userId, music.libraryPlaylistId)
      : []
    : await allTracks(db, userId)
  const out: BlogMusicTrack[] = []
  for (const row of scope) {
    const audioToken = await issueBlogMediaToken(env, 'audio', userId, row.id)
    if (!audioToken) continue
    const coverToken = row.cover_key
      ? await issueBlogMediaToken(env, 'cover', userId, row.id)
      : null
    const artist = parseArtists(row.artists).map((entry) => entry.name).join(', ')
    out.push({
      id: row.id,
      title: row.title,
      ...(artist ? { artist: artist.slice(0, 200) } : {}),
      source: `/_blog/music/audio/${encodeURIComponent(row.id)}?t=${encodeURIComponent(audioToken)}`,
      ...(coverToken
        ? { cover: `/_blog/music/cover/${encodeURIComponent(row.id)}?t=${encodeURIComponent(coverToken)}` }
        : row.cover_url && /^https?:\/\//i.test(row.cover_url)
          ? { cover: row.cover_url }
          : {}),
      ...(row.duration_ms > 0 ? { duration: Math.max(1, Math.round(row.duration_ms / 1000)) } : {}),
    })
  }
  return out
}

/** Replace the owner-library projection with real tracks and tokenised public addresses. */
export async function resolvePublicBlogMusic(
  env: Env,
  db: D1Database,
  userId: string,
  site: BlogSitePublic,
): Promise<BlogSitePublic> {
  const music = site.integrations.music
  if (music.provider !== 'library') return site
  const tracks = await publicTracks(env, db, userId, music)
  return {
    ...site,
    integrations: {
      ...site.integrations,
      music: {
        ...music,
        enabled: tracks.length > 0,
        tracks,
      },
    },
  }
}
