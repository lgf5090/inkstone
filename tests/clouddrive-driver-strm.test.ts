// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import { createStrmDriver } from '../src/worker/clouddrive/drivers/strm'
import {
  DriverError,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
  type ResolvedMount,
} from '../src/worker/clouddrive/drivers/contract'

interface FakeOptions {
  tree: Record<string, DriverEntry[]>
  contents?: Record<string, string>
  readError?: DriverError
}

class FakeMount implements MountDriver {
  readonly definition = findCloudDriveDriver('r2')!
  readonly capabilities = this.definition.capabilities
  readonly contents: Map<string, string>
  readonly readRanges: Array<string | null | undefined> = []
  readPath = ''
  readError: DriverError | undefined

  constructor(readonly tree: Record<string, DriverEntry[]>, options: Pick<FakeOptions, 'contents' | 'readError'> = {}) {
    this.contents = new Map(Object.entries(options.contents ?? {}))
    this.readError = options.readError
  }

  async list(path: string, _options?: DriverListOptions): Promise<DriverListResult> {
    const key = path || '/'
    const entries = this.tree[key]
    if (!entries) throw DriverError.notFound(`The fake mount has no directory ${key}`)
    return { entries: [...entries], cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    if (path === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0 }
    const index = path.lastIndexOf('/')
    const parent = index <= 0 ? '/' : path.slice(0, index)
    const name = path.slice(index + 1)
    const hit = this.tree[parent]?.find((entry) => entry.name === name)
    if (!hit) throw DriverError.notFound(`The fake mount has no entry ${path}`)
    return hit
  }

  async read(path: string, range?: string | null): Promise<Response> {
    this.readPath = path
    this.readRanges.push(range)
    if (this.readError) throw this.readError
    const text = this.contents.get(path)
    if (text === undefined) throw DriverError.notFound(`The fake mount has no file ${path}`)
    const bytes = new TextEncoder().encode(text)
    const slice = parseRange(range, bytes.byteLength)
    const headers = new Headers({ 'content-type': 'text/plain', 'accept-ranges': 'bytes', 'content-length': String(bytes.byteLength) })
    if (!slice) return new Response(bytes, { status: 200, headers })
    const length = slice.end - slice.start + 1
    headers.set('content-length', String(length))
    headers.set('content-range', `bytes ${slice.start}-${slice.end}/${bytes.byteLength}`)
    return new Response(bytes.subarray(slice.start, slice.end + 1), { status: 206, headers })
  }

  async upload(_path: string, _body: Uint8Array | ReadableStream, _options: DriverUploadOptions): Promise<void> {
    throw DriverError.unsupported('The fake mount is read-only')
  }

  async mkdir(_path: string): Promise<void> {
    throw DriverError.unsupported('The fake mount is read-only')
  }

  async rename(_path: string, _newName: string): Promise<void> {
    throw DriverError.unsupported('The fake mount is read-only')
  }

  async move(_fromPath: string, _toPath: string): Promise<void> {
    throw DriverError.unsupported('The fake mount is read-only')
  }

  async remove(_path: string): Promise<void> {
    throw DriverError.unsupported('The fake mount is read-only')
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'The fake mount is reachable' }
  }
}

function parseRange(value: string | null | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const first = match[1] ?? ''
  const second = match[2] ?? ''
  if (!first && !second) return null
  if (!first) {
    const suffix = Number(second)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isFinite(start) || start >= size) return null
  const end = second ? Math.min(Number(second), size - 1) : size - 1
  return end >= start ? { start, end } : null
}

const MOVIE: DriverEntry = { name: 'movie.mkv', kind: 'file', size: 100, modifiedAt: 1_700_000_000_000 }
const SUBTITLE: DriverEntry = { name: 'subtitle.srt', kind: 'file', size: 12, modifiedAt: 1_700_000_000_100 }
const NOTES: DriverEntry = { name: 'notes.txt', kind: 'file', size: 5, modifiedAt: 1_700_000_000_200 }
const SHOWS: DriverEntry = { name: 'shows', kind: 'folder', size: 0, modifiedAt: 1_700_000_000_300 }

function resolveMounts(mounts: Record<string, FakeMount>): (reference: string) => Promise<ResolvedMount> {
  return async (reference: string) => {
    const mount = mounts[reference]
    if (!mount) throw DriverError.notFound(`No enabled mount named ${reference} belongs to this user`)
    return {
      mountId: `id-${reference.slice(1)}`,
      mountName: reference.slice(1),
      mountPath: reference,
      readOnly: true,
      driver: mount,
    }
  }
}

function context(config: Record<string, unknown>, resolveMount?: DriverContext['resolveMount']): DriverContext {
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'strm',
    config,
    credentials: {},
    saveCredentials: async () => ({}),
    markNeedsReauth: async () => undefined,
    ...(resolveMount ? { resolveMount } : {}),
  }
}

const LIBRARY = (): FakeMount => new FakeMount({
  '/': [SHOWS, MOVIE, SUBTITLE, NOTES],
}, {
  contents: { '/subtitle.srt': 'abcdefgh', '/shows/movie.mkv': 'video' },
})

describe('STRM driver', () => {
  it('lists aliases and converts media to strm while downloading subtitles through', async () => {
    const library = LIBRARY()
    const mirror = new FakeMount({
      '/': [{ name: 'movie.mkv', kind: 'file', size: 200, modifiedAt: 2 }, { name: 'other.mp4', kind: 'file', size: 30, modifiedAt: 3 }],
    })
    const driver = createStrmDriver(context(
      { paths: 'media:/library\nextra:/mirror', siteUrl: 'https://files.example/', pathPrefix: '/d' },
      resolveMounts({ '/library': library, '/mirror': mirror }),
    ))

    const root = await driver.list('/')
    expect(root.entries.map((entry) => [entry.name, entry.kind])).toEqual([['media', 'folder'], ['extra', 'folder']])

    const media = await driver.list('/media')
    expect(media.entries.map((entry) => entry.name)).toEqual(['movie.strm', 'shows', 'subtitle.srt'])
    const movie = media.entries.find((entry) => entry.name === 'movie.strm')!
    const link = 'https://files.example/d/media/movie.mkv'
    expect(movie.size).toBe(new TextEncoder().encode(link).byteLength)
    expect(movie.ref).toBe('/media/movie.mkv')
    expect(movie.modifiedAt).toBe(MOVIE.modifiedAt)
    expect(media.entries.find((entry) => entry.name === 'subtitle.srt')!.size).toBe(SUBTITLE.size)

    const extra = await driver.list('/extra')
    expect(extra.entries.map((entry) => entry.name)).toEqual(['movie.strm', 'other.strm'])
  })

  it('merges several mappings behind one alias and drops duplicate names', async () => {
    const library = LIBRARY()
    const mirror = new FakeMount({
      '/': [{ name: 'movie.mkv', kind: 'file', size: 200, modifiedAt: 2 }, { name: 'other.mp4', kind: 'file', size: 30, modifiedAt: 3 }],
    })
    const driver = createStrmDriver(context(
      { paths: 'media:/library\nmedia:/mirror' },
      resolveMounts({ '/library': library, '/mirror': mirror }),
    ))

    const media = await driver.list('/')
    expect(media.entries.map((entry) => entry.name)).toEqual(['movie.strm', 'other.strm', 'shows', 'subtitle.srt'])
    expect(media.entries.filter((entry) => entry.name === 'movie.strm')).toHaveLength(1)
  })

  it('flattens a single mapping and serves the URL with Range', async () => {
    const library = LIBRARY()
    const driver = createStrmDriver(context(
      { paths: 'media:/library', siteUrl: 'https://files.example', withoutUrl: false },
      resolveMounts({ '/library': library }),
    ))

    const listed = await driver.list('/')
    expect(listed.entries.map((entry) => entry.name)).toEqual(['movie.strm', 'shows', 'subtitle.srt'])
    const link = 'https://files.example/d/movie.mkv'
    const stat = await driver.stat('/movie.strm')
    expect(stat.kind).toBe('file')
    expect(stat.size).toBe(new TextEncoder().encode(link).byteLength)

    const full = await driver.read('/movie.strm')
    expect(full.status).toBe(200)
    expect(await full.text()).toBe(link)

    const ranged = await driver.read('/movie.strm', 'bytes=0-9')
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-9/${link.length}`)
    expect(await ranged.text()).toBe(link.slice(0, 10))
  })

  it('honours withoutUrl, pathPrefix and encodePath in the strm body', async () => {
    const space = new FakeMount({
      '/': [{ name: 'a b.mp4', kind: 'file', size: 10, modifiedAt: 1 }],
    })
    const driver = createStrmDriver(context(
      { paths: 'media:/library', withoutUrl: true, pathPrefix: '/dl', encodePath: true },
      resolveMounts({ '/library': space }),
    ))
    const response = await driver.read('/a b.strm')
    expect(await response.text()).toBe('/dl/a%20b.mp4')
  })

  it('forwards the read of a pass-through file with its Range to the mapped mount', async () => {
    const library = LIBRARY()
    const driver = createStrmDriver(context(
      { paths: 'media:/library' },
      resolveMounts({ '/library': library }),
    ))
    const response = await driver.read('/subtitle.srt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
    expect(library.readPath).toBe('/subtitle.srt')
    expect(library.readRanges).toEqual(['bytes=2-5'])
    expect((await driver.stat('/subtitle.srt')).size).toBe(SUBTITLE.size)
  })

  it('propagates an upstream error instead of hiding it', async () => {
    const library = LIBRARY()
    library.readError = DriverError.auth('The library token expired')
    const driver = createStrmDriver(context(
      { paths: 'media:/library' },
      resolveMounts({ '/library': library }),
    ))
    await expect(driver.read('/subtitle.srt')).rejects.toMatchObject({ kind: 'auth', message: 'The library token expired' })
  })

  it('rejects an unauthorized or missing mount reference with not_found', async () => {
    const driver = createStrmDriver(context(
      { paths: 'media:/other' },
      resolveMounts({ '/library': LIBRARY() }),
    ))
    await expect(driver.list('/media')).rejects.toMatchObject({ kind: 'not_found' })
    await expect(driver.stat('/media/movie.strm')).rejects.toMatchObject({ kind: 'not_found' })
    await expect(driver.read('/media/movie.mkv')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('does not swallow a circular reference raised by resolveMount', async () => {
    const driver = createStrmDriver(context(
      { paths: 'loop:/loop' },
      async (reference: string) => {
        throw DriverError.invalid(`Circular mount reference detected: ${reference}`)
      },
    ))
    await expect(driver.list('/loop')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/loop/movie.strm')).rejects.toMatchObject({ kind: 'invalid' })
    const tested = await driver.test()
    expect(tested.ok).toBe(false)
    expect(tested.message).toContain('Circular mount reference')
  })

  it('reports the resolver requirement when the context has none', async () => {
    const driver = createStrmDriver(context({ paths: 'media:/library' }))
    await expect(driver.list('/media')).rejects.toMatchObject({ kind: 'unsupported' })
    const tested = await driver.test()
    expect(tested.ok).toBe(false)
    expect(tested.message).toContain('cross-mount resolution')
  })

  it('probes every mapping in test()', async () => {
    const library = LIBRARY()
    const mirror = new FakeMount({ '/': [{ name: 'other.mp4', kind: 'file', size: 30, modifiedAt: 3 }] })
    const driver = createStrmDriver(context(
      { paths: 'media:/library\nextra:/mirror' },
      resolveMounts({ '/library': library, '/mirror': mirror }),
    ))
    const result = await driver.test()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('2 mappings across 2 aliases')
  })

  it('refuses every write explicitly', async () => {
    const driver = createStrmDriver(context({ paths: 'media:/library' }, resolveMounts({ '/library': LIBRARY() })))
    await expect(driver.mkdir('/new')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.upload('/x.bin', new Uint8Array(), { size: 0 })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.rename('/movie.strm', 'other.strm')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.move('/movie.strm', '/other.strm')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.copy!('/movie.strm', '/other.strm')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.remove('/movie.strm')).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
