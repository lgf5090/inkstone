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
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER = 'user-owner'
const MEMBER = 'user-member'
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

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  vaultValues.clear()
  env = testBindings(db, {
    CREDENTIAL_VAULT: vault as unknown as Env['CREDENTIAL_VAULT'],
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
