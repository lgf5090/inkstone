// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'
import { createAliasDriver } from '../src/worker/clouddrive/drivers/alias'
import {
  DriverError,
  asBytes,
  driverEntryMime,
  type DriverContext,
  type DriverEntry,
  type DriverListOptions,
  type DriverListResult,
  type DriverUploadOptions,
  type MountDriver,
} from '../src/worker/clouddrive/drivers/contract'

interface FakeNode {
  kind: 'folder' | 'file'
  bytes: Uint8Array
  modifiedAt: number
}

function parentOf(path: string): string {
  if (path === '/') return '/'
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

function nameOf(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

function childOf(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** An in-memory MountDriver the alias driver can dispatch to. */
class FakeMount implements MountDriver {
  readonly definition = findCloudDriveDriver('r2')!
  readonly capabilities = this.definition.capabilities
  readonly nodes = new Map<string, FakeNode>()
  failUploads = false

  seed(path: string, bytes: Uint8Array = new Uint8Array(0), kind: FakeNode['kind'] = 'file'): void {
    this.nodes.set(path, { kind, bytes, modifiedAt: 1_700_000_000_000 })
  }

  seedFolder(path: string): void {
    this.seed(path, new Uint8Array(0), 'folder')
  }

  has(path: string): boolean {
    return this.nodes.has(path)
  }

  private node(path: string): FakeNode {
    const found = this.nodes.get(path)
    if (!found) throw DriverError.notFound(`Fake mount has no ${path}`)
    return found
  }

  async list(path: string, _options: DriverListOptions = {}): Promise<DriverListResult> {
    if (!this.nodes.has(path)) throw DriverError.notFound(`Fake mount has no ${path}`)
    const entries: DriverEntry[] = []
    for (const [candidate, node] of this.nodes) {
      if (candidate === path || parentOf(candidate) !== path) continue
      const name = nameOf(candidate)
      entries.push({
        name,
        kind: node.kind,
        size: node.kind === 'folder' ? 0 : node.bytes.length,
        modifiedAt: node.modifiedAt,
        mime: node.kind === 'folder' ? 'application/octet-stream' : driverEntryMime(name),
      })
    }
    return { entries, cursor: null, truncated: false }
  }

  async stat(path: string): Promise<DriverEntry> {
    const node = this.node(path)
    const name = nameOf(path)
    return {
      name,
      kind: node.kind,
      size: node.kind === 'folder' ? 0 : node.bytes.length,
      modifiedAt: node.modifiedAt,
      mime: node.kind === 'folder' ? 'application/octet-stream' : driverEntryMime(name),
    }
  }

  async read(path: string, range?: string | null): Promise<Response> {
    const node = this.node(path)
    if (node.kind !== 'file') throw DriverError.unsupported('A folder cannot be read')
    const size = node.bytes.length
    if (!range) {
      return new Response(node.bytes as BodyInit, {
        status: 200,
        headers: { 'content-length': String(size) },
      })
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim())
    if (!match) return new Response(node.bytes as BodyInit, { status: 200 })
    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (start >= size || end < start) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    }
    const slice = node.bytes.slice(start, end + 1)
    return new Response(slice as BodyInit, {
      status: 206,
      headers: {
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${end}/${size}`,
      },
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    if (this.failUploads) throw DriverError.upstream('Fake mount refused the upload')
    const bytes = await asBytes(body)
    expect(bytes.length).toBe(options.size)
    this.seed(path, bytes)
    options.onProgress?.(bytes.length, bytes.length)
  }

  async mkdir(path: string): Promise<void> {
    this.seedFolder(path)
  }

  async rename(path: string, newName: string): Promise<void> {
    const node = this.node(path)
    const target = childOf(parentOf(path), newName)
    this.nodes.delete(path)
    this.nodes.set(target, node)
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const node = this.node(fromPath)
    this.nodes.delete(fromPath)
    this.nodes.set(toPath, node)
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const node = this.node(fromPath)
    this.nodes.set(toPath, { ...node, bytes: node.bytes.slice() })
  }

  async remove(path: string): Promise<void> {
    for (const key of [...this.nodes.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key)
    }
  }

  async directLink(): Promise<string | null> {
    return null
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'fake mount is ready' }
  }
}

function mounts(): { a: FakeMount; b: FakeMount } {
  const a = new FakeMount()
  const b = new FakeMount()
  a.seedFolder('/')
  b.seedFolder('/')
  return { a, b }
}

function context(
  drivers: Record<string, MountDriver>,
  config: Record<string, unknown> = {},
): DriverContext {
  const resolveMount = vi.fn(async (reference: string) => {
    const driver = drivers[reference]
    if (!driver) throw DriverError.notFound(`No enabled mount named ${reference}`)
    return {
      mountId: reference,
      mountName: reference,
      mountPath: reference,
      readOnly: false,
      driver,
    }
  })
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'alias',
    config: {
      paths: 'shared:/a\nshared:/b',
      readConflictPolicy: 'first',
      writeConflictPolicy: 'disabled',
      putConflictPolicy: 'disabled',
      orderBy: 'name',
      orderDirection: 'asc',
      ...config,
    },
    credentials: {},
    saveCredentials: vi.fn(async () => undefined),
    markNeedsReauth: vi.fn(async () => undefined),
    resolveMount,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('alias driver', () => {
  it('merges duplicate names with the first target under the first policy', async () => {
    const { a, b } = mounts()
    a.seed('/same.txt', new TextEncoder().encode('from-a'))
    b.seed('/same.txt', new TextEncoder().encode('from-b'))
    const driver = createAliasDriver(context({ '/a': a, '/b': b }))

    const response = await driver.read('/shared/same.txt')
    expect(await response.text()).toBe('from-a')

    const listed = await driver.list('/shared')
    expect(listed.entries.filter((entry) => entry.name === 'same.txt')).toHaveLength(1)
    expect(listed.entries.find((entry) => entry.name === 'same.txt')).toMatchObject({ size: 6 })

    const stat = await driver.stat('/shared/same.txt')
    expect(stat.size).toBe(6)
  })

  it('picks a stable target from the path hash under the random policy', async () => {
    const { a, b } = mounts()
    a.seed('/same.txt', new TextEncoder().encode('from-a'))
    b.seed('/same.txt', new TextEncoder().encode('from-b'))
    const driver = createAliasDriver(context({ '/a': a, '/b': b }, { readConflictPolicy: 'random' }))

    const index = stableHash('/shared/same.txt') % 2
    const expected = index === 0 ? 'from-a' : 'from-b'
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await driver.read('/shared/same.txt')
      expect(await response.text()).toBe(expected)
    }
  })

  it('tries every target under the all policy and returns a duplicate once', async () => {
    const { a, b } = mounts()
    a.seed('/same.txt', new TextEncoder().encode('from-a'))
    b.seed('/same.txt', new TextEncoder().encode('from-b'))
    b.seed('/only-b.txt', new TextEncoder().encode('only-b'))
    const driver = createAliasDriver(context({ '/a': a, '/b': b }, { readConflictPolicy: 'all' }))

    const response = await driver.read('/shared/only-b.txt')
    expect(await response.text()).toBe('only-b')

    const duplicate = await driver.read('/shared/same.txt')
    expect(await duplicate.text()).toBe('from-a')

    const listed = await driver.list('/shared')
    const names = listed.entries.map((entry) => entry.name).sort()
    expect(names).toEqual(['only-b.txt', 'same.txt'])
  })

  it('synthesises alias folders when several aliases live at the root', async () => {
    const { a, b } = mounts()
    a.seed('/root-file.txt', new TextEncoder().encode('a'))
    const driver = createAliasDriver(context({ '/a': a, '/b': b }, { paths: 'one:/a\ntwo:/b' }))

    const listed = await driver.list('/')
    expect(listed.entries.map((entry) => entry.name)).toEqual(['one', 'two'])
    expect(listed.entries.every((entry) => entry.kind === 'folder')).toBe(true)

    const single = createAliasDriver(context({ '/a': a, '/b': b }, { paths: '/a' }))
    const root = await single.list('/')
    expect(root.entries.map((entry) => entry.name)).toEqual(['root-file.txt'])
    const file = await single.read('/root-file.txt')
    expect(await file.text()).toBe('a')
  })

  it('refuses writes when the write policy is disabled', async () => {
    const { a, b } = mounts()
    const driver = createAliasDriver(context({ '/a': a, '/b': b }, { writeConflictPolicy: 'disabled' }))
    await expect(driver.mkdir('/shared/new-folder')).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('writes only the first target under the first policy', async () => {
    const { a, b } = mounts()
    const driver = createAliasDriver(context({ '/a': a, '/b': b }, {
      writeConflictPolicy: 'first',
      putConflictPolicy: 'first',
    }))
    const payload = new TextEncoder().encode('new')
    await driver.upload('/shared/new.txt', payload, { size: payload.length })
    expect(a.has('/new.txt')).toBe(true)
    expect(b.has('/new.txt')).toBe(false)

    a.seed('/move.txt', payload)
    await driver.rename('/shared/move.txt', 'renamed.txt')
    expect(a.has('/renamed.txt')).toBe(true)
    expect(a.has('/move.txt')).toBe(false)
    expect(b.has('/renamed.txt')).toBe(false)
  })

  it('fails the whole write under all_strict when one target fails', async () => {
    const { a, b } = mounts()
    b.failUploads = true
    const driver = createAliasDriver(context({ '/a': a, '/b': b }, { putConflictPolicy: 'all' }))
    const failing = createAliasDriver(context({ '/a': a, '/b': b }, { putConflictPolicy: 'all_strict' }))
    const payload = new TextEncoder().encode('payload')
    await expect(failing.upload('/shared/strict.txt', payload, { size: payload.length }))
      .rejects.toMatchObject({ kind: 'upstream' })
    expect(a.has('/strict.txt')).toBe(true)
    expect(b.has('/strict.txt')).toBe(false)

    await driver.upload('/shared/lenient.txt', payload, { size: payload.length })
    expect(a.has('/lenient.txt')).toBe(true)
  })

  it('refuses an upload when the put policy is disabled', async () => {
    const { a, b } = mounts()
    const driver = createAliasDriver(context({ '/a': a, '/b': b }, {
      writeConflictPolicy: 'first',
      putConflictPolicy: 'disabled',
    }))
    const payload = new TextEncoder().encode('x')
    await expect(driver.upload('/shared/x.txt', payload, { size: payload.length }))
      .rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('propagates cycle and unauthorized mount errors unchanged', async () => {
    const drivers = { '/a': new FakeMount() }
    const cycle = context(drivers, { paths: 'shared:/a' })
    cycle.resolveMount = vi.fn(async () => {
      throw DriverError.invalid('Circular mount reference detected')
    })
    await expect(createAliasDriver(cycle).list('/shared')).rejects.toMatchObject({ kind: 'invalid' })

    const foreign = context(drivers, { paths: 'shared:/a' })
    foreign.resolveMount = vi.fn(async () => {
      throw DriverError.notFound('No enabled mount belongs to this user')
    })
    await expect(createAliasDriver(foreign).list('/shared')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('propagates a single target listing error instead of returning an empty folder', async () => {
    const a = new FakeMount()
    a.seedFolder('/')
    const missing = new FakeMount()
    const driver = createAliasDriver(context({ '/a': a }, { paths: 'shared:/missing' }))
    await expect(driver.list('/shared')).rejects.toMatchObject({ kind: 'not_found' })

    const badTarget = createAliasDriver(context({ '/a': missing }, { paths: 'shared:/a' }))
    await expect(badTarget.list('/shared')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('resolves every mapping when testing the driver', async () => {
    const { a, b } = mounts()
    const ctx = context({ '/a': a, '/b': b }, { paths: 'one:/a\ntwo:/b' })
    const driver = createAliasDriver(ctx)
    const result = await driver.test()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('2 path')

    const broken = createAliasDriver(context({ '/a': a }, { paths: 'one:/a\ntwo:/missing' }))
    const failure = await broken.test()
    expect(failure.ok).toBe(false)
    expect(failure.message).toContain('No enabled mount')
  })
})
