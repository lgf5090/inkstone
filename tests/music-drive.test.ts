// @vitest-environment node
/**
 * The WebDAV write surface: import references, upload one file, delete one remote object, and the
 * stream that plays a reference back through this worker.
 *
 * The credential vault is a map stand-in so the target resolves at all; the assertions never look at
 * a password. Every WebDAV request is answered by a `fetch` stub, so no test reaches a real server.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MUSIC_DRIVE_UPLOAD_MAX_BYTES } from '../src/shared/music/api'
import { DEFAULT_MUSIC_SETTINGS } from '../src/shared/music/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { MusicStore } from '../src/worker/music/store'
import { musicRoutes } from '../src/worker/routes/music'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

// Generated-id shape: R2 keys and the media routes refuse arbitrary account labels.
const OWNER = 'a'.repeat(26)
const MEMBER = 'b'.repeat(26)
/** A generated-id shape, because the vault scopes a credential by a valid id. */
const TARGET = 't'.repeat(26)
const DAV = 'https://dav.example.com'

const vaultValues = new Map<string, unknown>()

const vault = {
  idFromName: () => 'vault-id',
  get: () => ({
    async fetch(url: string, init: { body?: unknown }): Promise<Response> {
      const request = JSON.parse(String(init.body)) as { value?: unknown; ciphertext?: string }
      if (url.endsWith('/encrypt')) {
        const ciphertext = `cipher-${vaultValues.size + 1}`
        vaultValues.set(ciphertext, request.value)
        return Response.json({ ciphertext })
      }
      if (url.endsWith('/decrypt')) {
        if (!request.ciphertext || !vaultValues.has(request.ciphertext)) {
          return Response.json({}, { status: 422 })
        }
        return Response.json({ value: vaultValues.get(request.ciphertext) })
      }
      return Response.json({}, { status: 404 })
    },
  }),
}

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('/api/music/*', async (c, next) => {
  const userId = c.req.header('x-test-user')
  if (userId) {
    c.set('userId', userId)
    c.set('user', {
      id: userId,
      username: userId,
      login: userId,
      name: userId,
      avatarUrl: '',
      role: 'member',
      createdAt: 0,
      settingsRaw: '{}',
    })
  }
  await next()
})
app.route('/api/music', musicRoutes)

async function send(path: string, init: RequestInit = {}, user = OWNER): Promise<Response> {
  const headers = new Headers(init.headers)
  if (user) headers.set('x-test-user', user)
  if ((init.method ?? 'GET') !== 'GET') headers.set('X-Inkstone-Client', '1')
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }), env)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

function xml(entries: string | string[]): string {
  return `<D:multistatus xmlns:D="DAV:">${Array.isArray(entries) ? entries.join('') : entries}</D:multistatus>`
}

function entry(href: string, size: number | null = null, collection = false): string {
  return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>`
    + `<D:resourcetype>${collection ? '<D:collection/>' : ''}</D:resourcetype>`
    + (size === null ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`)
    + `</D:prop></D:propstat></D:response>`
}

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let store: MusicStore
let bucket: TestR2Bucket

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  vaultValues.clear()
  bucket = testR2Bucket()
  env = testBindings(db, {
    CREDENTIAL_VAULT: vault as unknown as Env['CREDENTIAL_VAULT'],
    FILES: bucket,
  })
  sqlite.prepare(
    `INSERT INTO backup_targets (id, user_id, type, name, enabled, config, secret, created_at, updated_at)
     VALUES (?, ?, 'webdav', 'Drive', 1, ?, 'cipher-1', 1, 1)`,
  ).run(TARGET, OWNER, JSON.stringify({ url: DAV, username: 'reader' }))
  vaultValues.set('cipher-1', { password: 'secret' })
  store = new MusicStore(db, OWNER)
  await store.saveSettings({ ...DEFAULT_MUSIC_SETTINGS, cloudWebdavTargetId: TARGET })
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

/** Stat answers for a batch: one entry per file, a folder, or a 404. */
function statFor(kinds: Record<string, 'file' | 'directory' | 'missing'>, size = 1_234) {
  return async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input))
    if (init.method !== 'PROPFIND') return new Response(null, { status: 405 })
    const name = url.pathname.split('/').pop() ?? ''
    const kind = kinds[name] ?? 'file'
    if (kind === 'missing') return new Response('missing', { status: 404 })
    return new Response(xml(entry(url.pathname, kind === 'directory' ? null : size, kind === 'directory')), {
      status: 207,
    })
  }
}

describe('webdav import', () => {
  it('imports media files, reports refusals and stays idempotent', async () => {
    vi.stubGlobal('fetch', statFor({
      'folder': 'directory',
      'notes.txt': 'file',
      'missing.mp3': 'missing',
    }))

    const response = await send('/api/music/drive/webdav/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['Album/song.mp3', 'folder', 'notes.txt', 'missing.mp3'] }),
    })
    expect(response.status).toBe(200)
    const first = await json<{
      tracks: Array<Record<string, unknown>>
      skipped: Array<{ path: string, reason: string }>
    }>(response)
    expect(first.tracks).toHaveLength(1)
    expect(first.tracks[0]).toMatchObject({
      provider: 'webdav',
      providerId: `${TARGET}:Album/song.mp3`,
      title: 'song',
      format: 'mp3',
      size: 1_234,
      r2Key: null,
      source: 'webdav',
      sourceQuality: 'original',
    })
    expect(first.skipped).toEqual([
      { path: 'folder', reason: 'directory' },
      { path: 'notes.txt', reason: 'unsupported' },
      { path: 'missing.mp3', reason: 'missing' },
    ])

    const again = await send('/api/music/drive/webdav/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['Album/song.mp3'] }),
    })
    const second = await json<{ tracks: Array<{ id: string }> }>(again)
    expect(second.tracks[0]?.id).toBe(String(first.tracks[0]?.id))
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM music_track WHERE user_id = ?').get(OWNER)).toEqual({ count: 1 })
    // A referenced track registers no R2 object, so it costs no quota.
    expect(await store.quotaUsage()).toEqual({ bytes: 0, count: 0 })
  })

  it('skips a path whose reference would not fit the library provider field', async () => {
    vi.stubGlobal('fetch', statFor({}))
    const longPath = `${'a'.repeat(150)}.mp3`
    const response = await send('/api/music/drive/webdav/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [longPath] }),
    })
    const body = await json<{ tracks: unknown[], skipped: Array<{ reason: string }> }>(response)
    expect(body.tracks).toEqual([])
    expect(body.skipped).toEqual([{ path: longPath, reason: 'path_too_long' }])
  })

  it('adds imported tracks to a playlist this account owns and refuses a foreign one', async () => {
    vi.stubGlobal('fetch', statFor({}))
    const playlist = await store.createPlaylist({ name: 'Cloud' })
    const response = await send('/api/music/drive/webdav/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['song.mp3'], targetPlaylistId: playlist.id }),
    })
    expect(response.status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM music_playlist_item WHERE user_id = ?').get(OWNER)).toEqual({ count: 1 })

    const foreign = await new MusicStore(db, MEMBER).createPlaylist({ name: 'Theirs' })
    const refused = await send('/api/music/drive/webdav/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['other.mp3'], targetPlaylistId: foreign.id }),
    })
    expect(refused.status).toBe(404)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM music_track WHERE user_id = ?').get(OWNER)).toEqual({ count: 1 })
  })

  it('refuses an empty or oversized batch before any request', async () => {
    const empty = await send('/api/music/drive/webdav/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    })
    expect(empty.status).toBe(400)
    const many = await send('/api/music/drive/webdav/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: Array.from({ length: 51 }, (_unused, index) => `t${index}.mp3`) }),
    })
    expect(many.status).toBe(400)
  })
})

const PNG_1PX = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3CnwAAAABJRU5ErkJggg==',
  'base64',
))
const GIF_1PX = new Uint8Array([...'GIF89a'].map((character) => character.charCodeAt(0)).concat([1, 0, 1, 0]))

describe('imported metadata', () => {
  async function importedTrack(provider: 'webdav' | 'alist' | 'netease' = 'webdav') {
    return await store.upsertTrack({
      provider,
      providerId: provider === 'netease' ? '1234' : `${TARGET}:Album/song.mp3`,
      kind: 'song',
      title: 'song',
      format: 'mp3',
      source: provider,
    })
  }

  it('writes duration, tags, cover and embedded lyrics onto an imported reference', async () => {
    const track = await importedTrack()
    const form = new FormData()
    form.append('metadata', JSON.stringify({
      title: 'Tagged title',
      artists: ['Singer'],
      album: 'Tagged album',
      durationMs: 214_000,
      bitrate: 320_000,
      lyrics: '[00:01.00]hello',
    }))
    form.append('cover', new File([PNG_1PX], 'cover.png', { type: 'image/png' }))

    const response = await send(`/api/music/drive/imported/${track.id}/metadata`, {
      method: 'POST',
      body: form,
    })
    expect(response.status).toBe(200)
    const body = await json<{
      track: {
        id: string
        title: string
        artists: Array<{ id: string; name: string }>
        album: string
        durationMs: number
        bitrate: number | null
        coverKey: string
      }
    }>(response)
    expect(body.track).toMatchObject({
      id: track.id,
      title: 'Tagged title',
      artists: [{ id: '', name: 'Singer' }],
      album: 'Tagged album',
      durationMs: 214_000,
      bitrate: 320_000,
      coverKey: `music/covers/${OWNER}/${track.id}.png`,
    })
    expect(bucket.objects.has(body.track.coverKey)).toBe(true)
    const lyric = await store.getLyric(`webdav:${TARGET}:Album/song.mp3`)
    expect(lyric).toMatchObject({ source: 'embedded', lrc: '[00:01.00]hello' })
    // A reference still costs no R2 quota; only the small cover object was written.
    expect(await store.quotaUsage()).toEqual({ bytes: 0, count: 0 })

    // A new artwork extension replaces the old object instead of leaking both.
    const replacement = new FormData()
    replacement.append('metadata', JSON.stringify({ title: 'Tagged title', durationMs: 214_000 }))
    replacement.append('cover', new File([GIF_1PX], 'cover.gif', { type: 'image/gif' }))
    const replaced = await send(`/api/music/drive/imported/${track.id}/metadata`, {
      method: 'POST',
      body: replacement,
    })
    expect(replaced.status).toBe(200)
    const next = await json<{ track: { coverKey: string } }>(replaced)
    expect(next.track.coverKey).toBe(`music/covers/${OWNER}/${track.id}.gif`)
    expect(bucket.objects.has(`music/covers/${OWNER}/${track.id}.png`)).toBe(false)
    expect(bucket.objects.has(next.track.coverKey)).toBe(true)
  })

  it('refuses foreign ids, provider tracks and malformed covers', async () => {
    const track = await importedTrack()
    const foreign = await new MusicStore(db, MEMBER).upsertTrack({
      provider: 'webdav',
      providerId: `${TARGET}:theirs.mp3`,
      kind: 'song',
      title: 'theirs',
      format: 'mp3',
      source: 'webdav',
    })
    const form = new FormData()
    form.append('metadata', JSON.stringify({ durationMs: 1_000 }))
    expect((await send(`/api/music/drive/imported/${foreign.id}/metadata`, { method: 'POST', body: form })).status)
      .toBe(404)

    const online = await importedTrack('netease')
    const onlineForm = new FormData()
    onlineForm.append('metadata', JSON.stringify({ durationMs: 1_000 }))
    expect((await send(`/api/music/drive/imported/${online.id}/metadata`, { method: 'POST', body: onlineForm })).status)
      .toBe(400)

    const empty = new FormData()
    expect((await send(`/api/music/drive/imported/${track.id}/metadata`, { method: 'POST', body: empty })).status)
      .toBe(400)

    const brokenCover = new FormData()
    brokenCover.append('metadata', JSON.stringify({ durationMs: 1_000 }))
    brokenCover.append('cover', new File([new Uint8Array(64)], 'cover.png', { type: 'image/png' }))
    expect((await send(`/api/music/drive/imported/${track.id}/metadata`, {
      method: 'POST',
      body: brokenCover,
    })).status).toBe(415)
  })
})

function uploadRequest(path: string, file: File, declaredLength?: number): Request {
  const form = new FormData()
  form.append('file', file, file.name)
  const headers = new Headers({ 'x-test-user': OWNER, 'X-Inkstone-Client': '1' })
  if (declaredLength !== undefined) headers.set('content-length', String(declaredLength))
  return new Request(`http://localhost/api/music/drive/webdav/upload?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers,
    body: form,
  })
}

describe('webdav upload', () => {
  it('puts one file into the current folder with an extension-derived type', async () => {
    const methods: string[] = []
    const putHeaders: Headers[] = []
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
      methods.push(String(init.method))
      if (init.method === 'PROPFIND') return new Response('missing', { status: 404 })
      if (init.method === 'PUT') {
        putHeaders.push(new Headers(init.headers))
        return new Response(null, { status: 201 })
      }
      return new Response(null, { status: 405 })
    })
    const file = new File([new Uint8Array([1, 2, 3])], 'song.mp3', { type: 'text/html' })
    const response = await app.fetch(uploadRequest('Album', file), env)
    expect(response.status).toBe(201)
    expect(await json(response)).toEqual({ path: 'Album/song.mp3', size: 3 })
    expect(methods.at(-1)).toBe('PUT')
    expect(putHeaders[0]?.get('content-type')).toBe('audio/mpeg')
  })

  it('refuses a file that already exists in that folder', async () => {
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
      if (init.method === 'PROPFIND') {
        const url = new URL(String(input))
        return new Response(xml(entry(url.pathname, 9)), { status: 207 })
      }
      return new Response(null, { status: 201 })
    })
    const response = await app.fetch(uploadRequest('', new File(['x'], 'song.mp3')), env)
    expect(response.status).toBe(409)
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({ error: { code: 'conflict' } })
  })

  it('refuses an extension outside the music formats before touching the server', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('the server must not be reached')
    })
    const response = await app.fetch(uploadRequest('', new File(['text'], 'notes.txt')), env)
    expect(response.status).toBe(415)
  })

  it('refuses a declared body over the upload envelope', async () => {
    // The envelope adds one megabyte for the multipart frame; a declared body past it is refused
    // before the form is parsed, without needing to allocate the file itself.
    const response = await app.fetch(
      uploadRequest('', new File(['x'], 'song.mp3'), MUSIC_DRIVE_UPLOAD_MAX_BYTES + 2 * 1024 * 1024),
      env,
    )
    expect(response.status).toBe(413)
  })

  it('scrubs a client filename down to its base name', async () => {
    vi.stubGlobal('fetch', async (_input: URL | string, init: RequestInit = {}) => {
      if (init.method === 'PROPFIND') return new Response('missing', { status: 404 })
      return new Response(null, { status: 201 })
    })
    const response = await app.fetch(uploadRequest('', new File(['x'], '../../evil.mp3')), env)
    expect(response.status).toBe(201)
    expect(await json<{ path: string }>(response)).toEqual({ path: 'evil.mp3', size: 1 })
  })
})

describe('webdav delete', () => {
  it('treats a missing remote object as already gone and leaves the library alone', async () => {
    const imported = await store.upsertTrack({
      provider: 'webdav',
      providerId: `${TARGET}:Album/song.mp3`,
      title: 'song',
      format: 'mp3',
      source: 'webdav',
      sourceQuality: 'original',
    })
    const methods: string[] = []
    vi.stubGlobal('fetch', async (_input: URL | string, init: RequestInit = {}) => {
      methods.push(String(init.method))
      return new Response(null, { status: 404 })
    })
    const response = await send(`/api/music/drive/webdav/object?path=${encodeURIComponent('Album/song.mp3')}`, {
      method: 'DELETE',
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ ok: true, removed: false })
    expect(methods).toEqual(['DELETE'])
    expect(await store.getTrack(imported.id)).not.toBeNull()
  })

  it('reports a removed object', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }))
    const response = await send('/api/music/drive/webdav/object?path=song.mp3', { method: 'DELETE' })
    expect(await json(response)).toEqual({ ok: true, removed: true })
  })

  it('deletes a selection in one call and reports the missing path', async () => {
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const url = new URL(String(input))
      return new Response(null, { status: url.pathname.endsWith('missing.mp3') ? 404 : 204 })
    })
    const response = await send('/api/music/drive/webdav/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['Album/gone.mp3', 'Album/missing.mp3'] }),
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      removed: ['Album/gone.mp3'],
      skipped: [{ path: 'Album/missing.mp3', reason: 'missing' }],
    })
  })
})

describe('webdav stream', () => {
  async function seedTrack(providerId = `${TARGET}:Album/song.mp3`) {
    return await store.upsertTrack({
      provider: 'webdav',
      providerId,
      title: 'song',
      format: 'mp3',
      source: 'webdav',
      sourceQuality: 'original',
    })
  }

  it('relays the upstream 206 with a media type and no shared cache', async () => {
    const track = await seedTrack()
    const ranges: Array<string | null> = []
    vi.stubGlobal('fetch', async (_input: URL | string, init: RequestInit = {}) => {
      ranges.push((init.headers as Record<string, string> | undefined)?.Range ?? null)
      return new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-1/4', 'Content-Length': '2', 'Content-Type': 'text/html' },
      })
    })
    const response = await send(`/api/music/media/stream/${track.id}`, { headers: { Range: 'bytes=0-1' } })
    expect(response.status).toBe(206)
    expect(ranges).toEqual(['bytes=0-1'])
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(response.headers.get('content-range')).toBe('bytes 0-1/4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('private, max-age=0')
  })

  it('keeps an upstream 200 as a 200 when the client asked for a range', async () => {
    const track = await seedTrack()
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }))
    const response = await send(`/api/music/media/stream/${track.id}`, { headers: { Range: 'bytes=2-' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(response.headers.get('content-range')).toBeNull()
  })

  it('answers a refused credential with a readable 502', async () => {
    const track = await seedTrack()
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }))
    const response = await send(`/api/music/media/stream/${track.id}`)
    expect(response.status).toBe(502)
    const body = await json<{ error: { code: string, message: string } }>(response)
    expect(body.error.code).toBe('music_storage_unavailable')
    expect(body.error.message).toMatch(/refused the saved credentials/)
  })

  it('refuses a reference imported from a different target without a request', async () => {
    const track = await seedTrack(`${'o'.repeat(26)}:song.mp3`)
    vi.stubGlobal('fetch', async () => {
      throw new Error('no request may be made')
    })
    const response = await send(`/api/music/media/stream/${track.id}`)
    expect(response.status).toBe(502)
  })
})

describe('alist mounts', () => {
  async function createMount(): Promise<{ id: string, name: string }> {
    const response = await send('/api/music/drive/alist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Drive',
        baseUrl: 'https://alist.example.com',
        rootPath: '/music',
        token: 'alist-token',
      }),
    })
    expect(response.status).toBe(201)
    const body = await json<{ mount: { id: string, name: string, hasSecret: boolean } }>(response)
    expect(body.mount.hasSecret).toBe(true)
    expect('secret' in body.mount).toBe(false)
    return body.mount
  }

  it('stores the token encrypted and never returns it', async () => {
    const mount = await createMount()
    const listed = await send('/api/music/drive/alist')
    const body = await json<{ mounts: Array<Record<string, unknown>> }>(listed)
    expect(body.mounts).toHaveLength(1)
    expect(body.mounts[0]).toMatchObject({ id: mount.id, name: 'Drive', kind: 'alist', hasSecret: true })
    expect('secret' in body.mounts[0]!).toBe(false)
    expect([...vaultValues.values()]).toContainEqual({ token: 'alist-token' })

    const foreign = await send('/api/music/drive/alist', {}, MEMBER)
    expect(await json<{ mounts: unknown[] }>(foreign)).toEqual({ mounts: [] })
  })

  it('lists a folder relative to the mount root with the saved token', async () => {
    const mount = await createMount()
    const requests: Array<{ url: string, auth: string, body: unknown }> = []
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
      requests.push({
        url: String(input),
        auth: String((init.headers as Record<string, string>).Authorization),
        body: JSON.parse(String(init.body)),
      })
      return Response.json({
        code: 200,
        data: {
          content: [
            { name: 'Album', is_dir: true, size: 0 },
            { name: 'song.mp3', is_dir: false, size: 42, modified: '2026-10-24T00:00:00Z' },
            { name: 'notes.txt', is_dir: false, size: 3 },
          ],
        },
      })
    })
    const response = await send(`/api/music/drive/alist/${mount.id}/list?path=`)
    expect(response.status).toBe(200)
    const body = await json<{
      listing: { path: string, entries: Array<Record<string, unknown>> }
    }>(response)
    expect(body.listing.path).toBe('')
    expect(body.listing.entries[0]).toMatchObject({ name: 'Album', path: 'Album', isDirectory: true })
    expect(body.listing.entries[1]).toMatchObject({ name: 'notes.txt', isMedia: false })
    expect(body.listing.entries[2]).toMatchObject({ name: 'song.mp3', path: 'song.mp3', sizeBytes: 42, isMedia: true })
    expect(requests[0]?.url).toBe('https://alist.example.com/api/fs/list')
    expect(requests[0]?.auth).toBe('alist-token')
    expect(requests[0]?.body).toMatchObject({ path: '/music', page: 1, per_page: 200 })
  })

  it('searches under the mount root and keeps media files only', async () => {
    const mount = await createMount()
    vi.stubGlobal('fetch', async () => Response.json({
      code: 200,
      data: {
        content: [
          { name: 'song.flac', parent: '/music/Album', is_dir: false, size: 9 },
          { name: 'cover.jpg', parent: '/music/Album', is_dir: false, size: 1 },
          { name: 'Sub', parent: '/music/Album', is_dir: true, size: 0 },
        ],
      },
    }))
    const response = await send(`/api/music/drive/alist/${mount.id}/search?keywords=song`)
    expect(response.status).toBe(200)
    const body = await json<{ entries: Array<Record<string, unknown>> }>(response)
    expect(body.entries).toEqual([
      expect.objectContaining({ name: 'song.flac', path: 'Album/song.flac', isMedia: true }),
    ])
  })

  it('imports an Alist file as a library reference and streams it through the worker', async () => {
    const mount = await createMount()
    let rangeSeen = ''
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input)
      if (url.endsWith('/api/fs/get')) {
        return Response.json({
          code: 200,
          data: { name: 'song.mp3', is_dir: false, size: 42, raw_url: 'https://files.example.com/song.mp3' },
        })
      }
      if (url === 'https://files.example.com/song.mp3') {
        rangeSeen = String((init.headers as Record<string, string> | undefined)?.Range ?? '')
        return new Response(new Uint8Array(42), {
          status: 206,
          headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '42', 'Content-Range': 'bytes 0-41/42' },
        })
      }
      return Response.json({}, { status: 404 })
    })

    const imported = await send(`/api/music/drive/alist/${mount.id}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['song.mp3'] }),
    })
    expect(imported.status).toBe(200)
    const body = await json<{ tracks: Array<{ id: string, provider: string, providerId: string, size: number }> }>(imported)
    expect(body.tracks[0]).toMatchObject({ provider: 'alist', providerId: `${mount.id}:song.mp3`, size: 42 })

    const listed = await json<{ items: Array<{ id: string }> }>(
      await send('/api/music/library/tracks?provider=alist'),
    )
    expect(listed.items.map((track) => track.id)).toEqual([body.tracks[0]!.id])

    const stream = await send(`/api/music/media/stream/${body.tracks[0]!.id}`, {
      headers: { range: 'bytes=0-41' },
    })
    expect(stream.status).toBe(206)
    expect(rangeSeen).toBe('bytes=0-41')
  })

  it('uploads into the current folder and deletes a remote file', async () => {
    const mount = await createMount()
    const calls: Array<{ url: string; method: string; path: string | null; body: unknown }> = []
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        path: (init.headers as Record<string, string> | undefined)?.['File-Path'] ?? null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })
      if (url.endsWith('/api/fs/get')) return Response.json({ code: 500, message: 'not found' }, { status: 500 })
      return Response.json({ code: 200 })
    })

    const form = new FormData()
    form.append('file', new File([new Uint8Array(42)], 'upload.mp3', { type: 'audio/mpeg' }))
    const uploaded = await send(`/api/music/drive/alist/${mount.id}/upload?path=Album`, { method: 'POST', body: form })
    expect(uploaded.status).toBe(201)
    expect(await json<{ path: string; size: number }>(uploaded)).toEqual({ path: 'Album/upload.mp3', size: 42 })
    const put = calls.find((call) => call.url.endsWith('/api/fs/put'))
    expect(put?.method).toBe('PUT')
    expect(put?.path).toBe(encodeURIComponent('/music/Album/upload.mp3'))

    const removed = await send(`/api/music/drive/alist/${mount.id}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['Album/upload.mp3'] }),
    })
    expect(removed.status).toBe(200)
    expect(await json(removed)).toEqual({ removed: ['Album/upload.mp3'], skipped: [] })
    const remove = calls.find((call) => call.url.endsWith('/api/fs/remove'))
    expect(remove?.body).toEqual({ dir: '/music/Album', names: ['upload.mp3'] })
  })

  it('refuses unsafe addresses and lets the owner delete a mount', async () => {
    const bad = await send('/api/music/drive/alist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', baseUrl: 'http://127.0.0.1:5244', token: 't' }),
    })
    expect(bad.status).toBe(400)

    const mount = await createMount()
    const foreign = await send(`/api/music/drive/alist/${mount.id}`, { method: 'DELETE' }, MEMBER)
    expect(foreign.status).toBe(404)
    const removed = await send(`/api/music/drive/alist/${mount.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(await store.listMounts()).toEqual([])
  })
})

describe('r2 drive', () => {
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

  async function uploadMp3(title = 'Direct'): Promise<{
    track: { id: string; provider: string; r2Key: string | null; size: number | null }
    entry: { key: string; title: string; size: number }
  }> {
    const form = new FormData()
    form.append('file', new File([mp3], `${title.toLowerCase()}.mp3`, { type: 'audio/mpeg' }))
    form.append('metadata', JSON.stringify({
      title,
      artists: ['Singer'],
      album: 'Album',
      durationMs: 1_200,
      bitrate: 128_000,
      lyrics: '',
    }))
    const response = await send('/api/music/drive/r2/upload', { method: 'POST', body: form })
    expect(response.status).toBe(201)
    return await json(response)
  }

  it('uploads one file, lists it and deletes its bytes with the track', async () => {
    const uploaded = await uploadMp3()
    expect(uploaded.track).toMatchObject({ provider: 'upload', size: 10 })
    expect(uploaded.entry.key.startsWith('music/mp3/')).toBe(true)
    expect(bucket.objects.has(uploaded.entry.key)).toBe(true)
    expect(await store.quotaUsage()).toEqual({ bytes: 10, count: 1 })

    const listed = await json<{ entries: Array<{ key: string; title: string; artists: string[] }> }>(
      await send('/api/music/drive/r2'),
    )
    expect(listed.entries).toEqual([
      expect.objectContaining({ key: uploaded.entry.key, title: 'Direct', artists: ['Singer'] }),
    ])

    const deleted = await json<{ removed: string[]; skipped: unknown[] }>(
      await send('/api/music/drive/r2/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: [uploaded.entry.key] }),
      }),
    )
    expect(deleted).toEqual({ removed: [uploaded.entry.key], skipped: [] })
    expect(bucket.objects.has(uploaded.entry.key)).toBe(false)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM music_track WHERE user_id = ?').get(OWNER)).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM music_object WHERE user_id = ?').get(OWNER)).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM music_cleanup WHERE user_id = ?').get(OWNER)).toEqual({ count: 0 })
  })

  it('refuses a container that disagrees with the extension', async () => {
    const form = new FormData()
    form.append('file', new File([mp3], 'not-flac.flac', { type: 'audio/flac' }))
    form.append('metadata', JSON.stringify({ title: 'Wrong' }))
    const response = await send('/api/music/drive/r2/upload', { method: 'POST', body: form })
    expect(response.status).toBe(415)
    expect(bucket.objects.size).toBe(0)
  })

  it('deletes a download cache without deleting the track it came from', async () => {
    const track = await store.upsertTrack({
      provider: 'netease',
      providerId: 'cache-1',
      title: 'Cached song',
      format: 'mp3',
    })
    const key = `music/mp3/${OWNER}/${track.id}-standard.mp3`
    bucket.objects.set(key, new Uint8Array(5))
    await store.registerObject({ r2Key: key, trackId: track.id, format: 'mp3', quality: 'standard', size: 5 })
    const now = Date.now()
    sqlite.prepare(
      `INSERT INTO music_download
         (user_id, id, track_id, quality, format, status, progress, r2_key, created_at, updated_at)
       VALUES (?, ?, ?, 'standard', 'mp3', 'completed', 100, ?, ?, ?)`,
    ).run(OWNER, 'download-1', track.id, key, now, now)

    const deleted = await json<{ removed: string[]; skipped: unknown[] }>(
      await send('/api/music/drive/r2/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: [key] }),
      }),
    )
    expect(deleted).toEqual({ removed: [key], skipped: [] })
    expect(bucket.objects.has(key)).toBe(false)
    expect(await store.getTrack(track.id)).not.toBeNull()
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM music_download WHERE user_id = ?').get(OWNER)).toEqual({ count: 0 })
  })

  it('keeps one account from listing or deleting another account\'s object', async () => {
    const uploaded = await uploadMp3()
    const foreignList = await json<{ entries: unknown[] }>(await send('/api/music/drive/r2', {}, MEMBER))
    expect(foreignList.entries).toEqual([])
    const foreignDelete = await json<{ removed: string[]; skipped: Array<{ reason: string }> }>(
      await send('/api/music/drive/r2/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: [uploaded.entry.key] }),
      }, MEMBER),
    )
    expect(foreignDelete).toEqual({ removed: [], skipped: [{ path: uploaded.entry.key, reason: 'missing' }] })
    expect(bucket.objects.has(uploaded.entry.key)).toBe(true)
  })
})
