import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMusicWebdavContext,
  deleteMusicObject,
  fetchMusicObject,
  listMusicDirectory,
  normalizeCloudPath,
  putMusicObject,
  statMusicObject,
} from '../src/worker/music/cloud/webdav'

const BASE = 'https://dav.example.com/root/'

function context(dir = 'music') {
  return createMusicWebdavContext({
    config: { url: BASE, username: 'reader', prefix: '', mode: 'archive' },
    secret: { password: 'secret' },
    dir,
  })
}

function xml(entries: string | string[]): string {
  return `<D:multistatus xmlns:D="DAV:">${Array.isArray(entries) ? entries.join('') : entries}</D:multistatus>`
}

function responseEntry(href: string, size: number | null = null, collection = false): string {
  return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>`
    + `<D:resourcetype>${collection ? '<D:collection/>' : ''}</D:resourcetype>`
    + (size === null ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`)
    + `</D:prop></D:propstat></D:response>`
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('music cloud paths', () => {
  it('normalises relative paths and refuses anything that could leave the folder', () => {
    expect(normalizeCloudPath('/album/song.mp3')).toBe('album/song.mp3')
    expect(normalizeCloudPath(' album//song.mp3 ')).toBe('album/song.mp3')
    expect(normalizeCloudPath('')).toBe('')
    expect(() => normalizeCloudPath('../secret')).toThrow(/leave the music folder/)
    expect(() => normalizeCloudPath('album/../secret')).toThrow(/leave the music folder/)
    expect(() => normalizeCloudPath('https://evil.example/song.mp3')).toThrow(/relative to the music folder/)
    expect(() => normalizeCloudPath('album\\song.mp3')).toThrow(/cannot carry/)
  })
})

describe('webdav listing', () => {
  it('lists direct children relative to the music folder, directories first', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init })
      return new Response(xml([
        responseEntry('/root/music/', null, true),
        responseEntry('/root/music/Zeta/', null, true),
        responseEntry('/root/music/song.mp3', 1234),
        responseEntry('/root/music/notes.txt', 3),
        responseEntry('/root/music/Zeta/deep.mp3', 99),
      ]), { status: 207 })
    })
    const listing = await listMusicDirectory(context(), '')
    expect(listing.entries.map((entry) => entry.path)).toEqual(['Zeta', 'notes.txt', 'song.mp3'])
    expect(listing.entries[2]).toMatchObject({ name: 'song.mp3', sizeBytes: 1234, isDirectory: false })
    expect(calls[0]?.url).toBe('https://dav.example.com/root/music/')
    expect(calls[0]?.init.method).toBe('PROPFIND')
    expect((calls[0]?.init.headers as Record<string, string>).Depth).toBe('1')
  })

  it('lists a subfolder without leaking its parent prefix into entry paths', async () => {
    vi.stubGlobal('fetch', async () => new Response(xml([
      responseEntry('/root/music/Album/', null, true),
      responseEntry('/root/music/Album/one.mp3', 7),
    ]), { status: 207 }))
    const listing = await listMusicDirectory(context(), 'Album')
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0]?.path).toBe('Album/one.mp3')
  })

  it('answers a missing root as an empty listing rather than an error', async () => {
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }))
    await expect(listMusicDirectory(context(), '')).resolves.toEqual({ entries: [], truncated: false })
  })

  it('maps an auth refusal to a named storage error', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }))
    await expect(listMusicDirectory(context(), 'Album')).rejects.toMatchObject({
      status: 502,
      code: 'music_storage_unavailable',
    })
  })

  it('marks a listing at the entry cap as truncated', async () => {
    const blocks = Array.from({ length: 2001 }, (_unused, index) => responseEntry(`/root/music/t${index}.mp3`, 1)).join('')
    vi.stubGlobal('fetch', async () => new Response(xml(blocks), { status: 207 }))
    const listing = await listMusicDirectory(context(), '')
    expect(listing.entries).toHaveLength(2000)
    expect(listing.truncated).toBe(true)
  })
})

describe('webdav objects', () => {
  it('stats one object with a depth-zero request', async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal('fetch', async (_url: URL | string, init: RequestInit = {}) => {
      calls.push(init)
      return new Response(xml(responseEntry('/root/music/song.mp3', 42)), { status: 207 })
    })
    const entry = await statMusicObject(context(), 'song.mp3')
    expect(entry).toMatchObject({ path: 'song.mp3', sizeBytes: 42 })
    expect((calls[0]?.headers as Record<string, string>).Depth).toBe('0')
  })

  it('creates the music directory before putting a file', async () => {
    const methods: string[] = []
    vi.stubGlobal('fetch', async (_url: URL | string, init: RequestInit = {}) => {
      methods.push(String(init.method))
      if (init.method === 'MKCOL') return new Response(null, { status: 405 })
      return new Response(null, { status: 201 })
    })
    await putMusicObject(context(), 'Album/song.mp3', new Uint8Array([1, 2, 3]), 'audio/mpeg')
    expect(methods).toEqual(['MKCOL', 'MKCOL', 'PUT'])
  })

  it('treats deleting an already missing object as a no-op', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    await expect(deleteMusicObject(context(), 'gone.mp3')).resolves.toBe(false)
  })

  it('forwards a range request and returns the upstream 206', async () => {
    const headers: HeadersInit[] = []
    vi.stubGlobal('fetch', async (_url: URL | string, init: RequestInit = {}) => {
      headers.push(init.headers as HeadersInit)
      return new Response(new Uint8Array([1, 2]), { status: 206 })
    })
    const response = await fetchMusicObject(context(), 'song.mp3', 'bytes=0-1')
    expect(response.status).toBe(206)
    expect(headers[0]).toMatchObject({ Range: 'bytes=0-1' })
  })
})
