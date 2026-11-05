// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findCloudDriveDriver } from '@shared/clouddrive/drivers'
import { createChunkDriver } from '../src/worker/clouddrive/drivers/chunk'
import {
  DriverError,
  asBytes,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
  type ResolvedMount,
} from '../src/worker/clouddrive/drivers/contract'

function normalize(path: string): string {
  const value = path.startsWith('/') ? path : `/${path}`
  return value === '/' ? value : value.replace(/\/+$/g, '')
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

function childOf(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
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

class MemoryMount implements MountDriver {
  readonly definition = findCloudDriveDriver('r2')!
  readonly capabilities = this.definition.capabilities
  readonly folders = new Set<string>(['/'])
  readonly files = new Map<string, { bytes: Uint8Array; modifiedAt: number }>()
  readonly uploads: Array<{ path: string; size: number }> = []
  readonly readCalls: Array<{ path: string; range: string | null | undefined }> = []
  copy?: (fromPath: string, toPath: string) => Promise<void>

  addFolder(path: string): void {
    const clean = normalize(path)
    if (clean === '/') return
    const segments = clean.slice(1).split('/')
    let current = ''
    for (const segment of segments) {
      current = `${current}/${segment}`
      this.folders.add(current)
    }
  }

  addFile(path: string, content: string | Uint8Array): void {
    const clean = normalize(path)
    this.addFolder(parentOf(clean))
    this.files.set(clean, {
      bytes: typeof content === 'string' ? new TextEncoder().encode(content) : content,
      modifiedAt: 1_700_000_000_000,
    })
  }

  async list(path: string, _options?: DriverListOptions): Promise<DriverListResult> {
    const base = normalize(path)
    if (!this.folders.has(base)) throw DriverError.notFound(`The fake mount has no directory ${base}`)
    const entries: DriverEntry[] = []
    for (const folder of this.folders) {
      if (folder === base || parentOf(folder) !== base) continue
      entries.push({ name: folder.slice(folder.lastIndexOf('/') + 1), kind: 'folder', size: 0, modifiedAt: 0 })
    }
    for (const [file, node] of this.files) {
      if (parentOf(file) !== base) continue
      entries.push({
        name: file.slice(file.lastIndexOf('/') + 1),
        kind: 'file',
        size: node.bytes.byteLength,
        modifiedAt: node.modifiedAt,
        mime: 'application/octet-stream',
      })
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    return { entries, cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const clean = normalize(path)
    if (clean === '/') return { name: 'root', kind: 'folder', size: 0, modifiedAt: 0 }
    if (this.folders.has(clean)) {
      return { name: clean.slice(clean.lastIndexOf('/') + 1), kind: 'folder', size: 0, modifiedAt: 0 }
    }
    const node = this.files.get(clean)
    if (!node) throw DriverError.notFound(`The fake mount has no entry ${clean}`)
    return {
      name: clean.slice(clean.lastIndexOf('/') + 1),
      kind: 'file',
      size: node.bytes.byteLength,
      modifiedAt: node.modifiedAt,
      mime: 'application/octet-stream',
    }
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const clean = normalize(path)
    this.readCalls.push({ path: clean, range })
    const node = this.files.get(clean)
    if (!node) throw DriverError.notFound(`The fake mount has no file ${clean}`)
    const slice = parseRange(range, node.bytes.byteLength)
    const headers = new Headers({ 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' })
    if (!slice) {
      headers.set('content-length', String(node.bytes.byteLength))
      return new Response(node.bytes as unknown as BodyInit, { status: 200, headers })
    }
    const length = slice.end - slice.start + 1
    headers.set('content-length', String(length))
    headers.set('content-range', `bytes ${slice.start}-${slice.end}/${node.bytes.byteLength}`)
    return new Response(node.bytes.subarray(slice.start, slice.end + 1) as unknown as BodyInit, { status: 206, headers })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const clean = normalize(path)
    const bytes = await asBytes(body)
    this.addFolder(parentOf(clean))
    this.files.set(clean, { bytes, modifiedAt: 1_700_000_000_000 })
    this.uploads.push({ path: clean, size: options.size })
    options.onProgress?.(bytes.byteLength, options.size)
  }

  async mkdir(path: string): Promise<void> {
    this.addFolder(path)
  }

  async rename(path: string, newName: string): Promise<void> {
    const from = normalize(path)
    const target = childOf(parentOf(from), newName)
    if (this.files.has(from)) {
      const node = this.files.get(from)!
      this.files.delete(from)
      this.files.set(target, node)
      return
    }
    if (!this.folders.has(from)) throw DriverError.notFound(`The fake mount has no entry ${from}`)
    this.addFolder(target)
    const folders = [...this.folders].filter((folder) => folder === from || folder.startsWith(`${from}/`))
    for (const folder of folders) {
      this.folders.delete(folder)
      this.folders.add(target + folder.slice(from.length))
    }
    for (const [file, node] of [...this.files]) {
      if (!file.startsWith(`${from}/`)) continue
      this.files.delete(file)
      this.files.set(target + file.slice(from.length), node)
    }
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = normalize(fromPath)
    const to = normalize(toPath)
    if (this.files.has(from)) {
      const node = this.files.get(from)!
      this.files.delete(from)
      this.addFolder(parentOf(to))
      this.files.set(to, node)
      return
    }
    if (!this.folders.has(from)) throw DriverError.notFound(`The fake mount has no entry ${from}`)
    this.addFolder(parentOf(to))
    this.addFolder(to)
    for (const folder of [...this.folders].filter((entry) => entry === from || entry.startsWith(`${from}/`))) {
      this.folders.delete(folder)
      this.folders.add(to + folder.slice(from.length))
    }
    for (const [file, node] of [...this.files]) {
      if (!file.startsWith(`${from}/`)) continue
      this.files.delete(file)
      this.files.set(to + file.slice(from.length), node)
    }
  }

  async remove(path: string): Promise<void> {
    const clean = normalize(path)
    if (this.files.delete(clean)) return
    if (!this.folders.has(clean)) throw DriverError.notFound(`The fake mount has no entry ${clean}`)
    for (const folder of [...this.folders].filter((entry) => entry === clean || entry.startsWith(`${clean}/`))) {
      this.folders.delete(folder)
    }
    for (const file of [...this.files.keys()].filter((entry) => entry.startsWith(`${clean}/`))) {
      this.files.delete(file)
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'The fake mount is reachable' }
  }
}

function resolveMounts(mounts: Record<string, MemoryMount>): (reference: string) => Promise<ResolvedMount> {
  return async (reference: string) => {
    const mount = mounts[reference]
    if (!mount) throw DriverError.notFound(`No enabled mount named ${reference} belongs to this user`)
    return {
      mountId: `id-${reference.slice(1)}`,
      mountName: reference.slice(1),
      mountPath: reference,
      readOnly: false,
      driver: mount,
    }
  }
}

function context(config: Record<string, unknown>, resolveMount?: DriverContext['resolveMount']): DriverContext {
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'chunk',
    config,
    credentials: {},
    saveCredentials: async () => undefined,
    markNeedsReauth: async () => undefined,
    ...(resolveMount ? { resolveMount } : {}),
  }
}

const CHUNK = '/data/[openlist_chunk]movie.mkv'

function seedChunked(mount: MemoryMount): void {
  mount.addFile('/data/plain.txt', 'hello')
  mount.addFile('/data/.hidden', 'x')
  mount.addFolder(CHUNK)
  mount.addFile(`${CHUNK}/0`, 'abcd')
  mount.addFile(`${CHUNK}/1`, 'efg')
}

function chunkDriver(mount: MemoryMount, extra: Record<string, unknown> = {}) {
  return createChunkDriver(context(
    { remotePath: '/remote', partSize: 4, rootPath: '/data', ...extra },
    resolveMounts({ '/remote': mount }),
  ))
}

describe('Chunk driver', () => {
  it('aggregates part directories into virtual files and honours showHidden', async () => {
    const mount = new MemoryMount()
    seedChunked(mount)
    const driver = chunkDriver(mount)

    const listed = await driver.list('/')
    expect(listed.entries.map((entry) => [entry.name, entry.kind, entry.size])).toEqual([
      ['movie.mkv', 'file', 7],
      ['plain.txt', 'file', 5],
    ])
    const stat = await driver.stat('/movie.mkv')
    expect(stat.kind).toBe('file')
    expect(stat.size).toBe(7)
    expect(stat.mime).toBe('application/octet-stream')

    const shown = chunkDriver(mount, { showHidden: true })
    const visible = await shown.list('/')
    expect(visible.entries.map((entry) => entry.name)).toEqual(['.hidden', 'movie.mkv', 'plain.txt'])
  })

  it('joins parts in order and slices a Range across part boundaries', async () => {
    const mount = new MemoryMount()
    seedChunked(mount)
    const driver = chunkDriver(mount)

    const full = await driver.read('/movie.mkv')
    expect(full.status).toBe(200)
    expect(full.headers.get('content-length')).toBe('7')
    expect(await full.text()).toBe('abcdefg')

    const ranged = await driver.read('/movie.mkv', 'bytes=2-5')
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/7')
    expect(ranged.headers.get('content-length')).toBe('4')
    expect(await ranged.text()).toBe('cdef')

    const suffix = await driver.read('/movie.mkv', 'bytes=-3')
    expect(suffix.status).toBe(206)
    expect(await suffix.text()).toBe('efg')

    expect(mount.readCalls.map((call) => [call.path, call.range])).toEqual([
      [`${CHUNK}/0`, 'bytes=0-3'],
      [`${CHUNK}/1`, 'bytes=0-2'],
      [`${CHUNK}/0`, 'bytes=2-3'],
      [`${CHUNK}/1`, 'bytes=0-1'],
      [`${CHUNK}/1`, 'bytes=0-2'],
    ])
  })

  it('applies customExt when naming and parsing parts', async () => {
    const mount = new MemoryMount()
    mount.addFolder('/data/[openlist_chunk]track.flac')
    mount.addFile('/data/[openlist_chunk]track.flac/0.part', 'aaaa')
    mount.addFile('/data/[openlist_chunk]track.flac/1.part', 'bb')
    const driver = chunkDriver(mount, { customExt: '.part' })

    expect((await driver.stat('/track.flac')).size).toBe(6)
    const response = await driver.read('/track.flac')
    expect(await response.text()).toBe('aaaabb')
    expect(mount.readCalls.map((call) => call.path)).toEqual([
      '/data/[openlist_chunk]track.flac/0.part',
      '/data/[openlist_chunk]track.flac/1.part',
    ])
  })

  it('passes a normal file read through with its Range and maps directory operations', async () => {
    const mount = new MemoryMount()
    seedChunked(mount)
    const driver = chunkDriver(mount)

    const response = await driver.read('/plain.txt', 'bytes=1-3')
    expect(await response.text()).toBe('ell')
    expect(mount.readCalls[0]).toEqual({ path: '/data/plain.txt', range: 'bytes=1-3' })

    await driver.mkdir('/movies')
    expect(mount.folders.has('/data/movies')).toBe(true)

    await driver.rename('/plain.txt', 'note.txt')
    expect(mount.files.has('/data/note.txt')).toBe(true)
    expect(mount.files.has('/data/plain.txt')).toBe(false)

    await driver.move('/note.txt', '/movies/note.txt')
    expect(mount.files.has('/data/movies/note.txt')).toBe(true)

    await driver.remove('/movies/note.txt')
    expect(mount.files.has('/data/movies/note.txt')).toBe(false)
    await expect(driver.stat('/movies/note.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('uploads a file at or below partSize straight to the underlying mount', async () => {
    const mount = new MemoryMount()
    const driver = chunkDriver(mount)

    await driver.upload('/small.bin', new TextEncoder().encode('abc'), { size: 3, contentType: 'text/plain' })
    expect(mount.files.get('/data/small.bin')?.bytes).toEqual(new TextEncoder().encode('abc'))
    expect(mount.folders.has('/data/[openlist_chunk]small.bin')).toBe(false)
    expect(mount.uploads).toEqual([{ path: '/data/small.bin', size: 3 }])
  })

  it('splits a large upload into parts and reports cumulative progress', async () => {
    const mount = new MemoryMount()
    const driver = chunkDriver(mount)
    const bytes = new TextEncoder().encode('abcdefghij')
    const progress: number[] = []

    await driver.upload('/big.bin', bytes, {
      size: bytes.byteLength,
      onProgress: (uploaded) => progress.push(uploaded),
    })

    expect(progress).toEqual([4, 8, 10])
    expect(mount.files.get('/data/[openlist_chunk]big.bin/0')?.bytes).toEqual(new TextEncoder().encode('abcd'))
    expect(mount.files.get('/data/[openlist_chunk]big.bin/1')?.bytes).toEqual(new TextEncoder().encode('efgh'))
    expect(mount.files.get('/data/[openlist_chunk]big.bin/2')?.bytes).toEqual(new TextEncoder().encode('ij'))
    expect(mount.uploads.map((upload) => [upload.path, upload.size])).toEqual([
      ['/data/[openlist_chunk]big.bin/0', 4],
      ['/data/[openlist_chunk]big.bin/1', 4],
      ['/data/[openlist_chunk]big.bin/2', 2],
    ])

    const listed = await driver.list('/')
    expect(listed.entries.find((entry) => entry.name === 'big.bin')?.size).toBe(10)
    expect(await (await driver.read('/big.bin')).text()).toBe('abcdefghij')
  })

  it('renames, moves and removes a chunk directory through its virtual name', async () => {
    const mount = new MemoryMount()
    seedChunked(mount)
    const driver = chunkDriver(mount)

    await driver.rename('/movie.mkv', 'film.mkv')
    expect(mount.folders.has('/data/[openlist_chunk]film.mkv')).toBe(true)
    expect(mount.folders.has(CHUNK)).toBe(false)
    expect((await driver.list('/')).entries.map((entry) => entry.name)).toContain('film.mkv')

    await driver.move('/film.mkv', '/movies/film.mkv')
    expect(mount.folders.has('/data/movies/[openlist_chunk]film.mkv')).toBe(true)
    expect((await driver.list('/movies')).entries.map((entry) => entry.name)).toEqual(['film.mkv'])

    await driver.remove('/movies/film.mkv')
    expect(mount.folders.has('/data/movies/[openlist_chunk]film.mkv')).toBe(false)
    expect((await driver.list('/movies')).entries).toEqual([])
  })

  it('refuses copy when the underlying driver has no copy, otherwise copies the part directory', async () => {
    const mount = new MemoryMount()
    seedChunked(mount)
    const driver = chunkDriver(mount)

    await expect(driver.copy!('/movie.mkv', '/other.mkv')).rejects.toMatchObject({ kind: 'unsupported' })

    mount.copy = async (fromPath, toPath) => {
      mount.addFolder(toPath)
      for (const [path, node] of [...mount.files]) {
        if (!path.startsWith(`${fromPath}/`)) continue
        mount.files.set(toPath + path.slice(fromPath.length), { ...node })
      }
    }
    await driver.copy!('/movie.mkv', '/other.mkv')
    expect(mount.files.has('/data/[openlist_chunk]other.mkv/0')).toBe(true)
    expect((await driver.stat('/other.mkv')).size).toBe(7)
  })

  it('propagates underlying errors and wraps a non-driver failure', async () => {
    const mount = new MemoryMount()
    seedChunked(mount)
    const driver = chunkDriver(mount)

    mount.list = async () => { throw DriverError.auth('The remote token expired') }
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth', message: 'The remote token expired' })

    mount.list = async () => { throw new Error('the socket closed') }
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'upstream' })
  })

  it('rejects an unauthorized remote mount, a cycle and an invalid partSize', async () => {
    const unauthorized = createChunkDriver(context(
      { remotePath: '/other', partSize: 4 },
      resolveMounts({ '/remote': new MemoryMount() }),
    ))
    await expect(unauthorized.list('/')).rejects.toMatchObject({ kind: 'not_found' })

    const cyclic = createChunkDriver(context(
      { remotePath: '/remote', partSize: 4 },
      async (reference: string) => { throw DriverError.invalid(`Circular mount reference detected: ${reference}`) },
    ))
    await expect(cyclic.list('/')).rejects.toMatchObject({ kind: 'invalid' })

    const badSize = createChunkDriver(context(
      { remotePath: '/remote', partSize: 0 },
      resolveMounts({ '/remote': new MemoryMount() }),
    ))
    await expect(badSize.list('/')).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('requires a resolver and reports readiness through test()', async () => {
    const mount = new MemoryMount()
    seedChunked(mount)
    const driver = chunkDriver(mount)
    const result = await driver.test()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Chunk storage is ready')

    const noResolver = createChunkDriver(context({ remotePath: '/remote', partSize: 4 }))
    await expect(noResolver.list('/')).rejects.toMatchObject({ kind: 'unsupported' })
    expect((await noResolver.test()).ok).toBe(false)

    const badSize = createChunkDriver(context(
      { remotePath: '/remote', partSize: -1 },
      resolveMounts({ '/remote': mount }),
    ))
    expect((await badSize.test()).ok).toBe(false)
  })
})
