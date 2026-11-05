// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'
import { createCryptDriver } from '../src/worker/clouddrive/drivers/crypt'
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

function fakeRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

/** An in-memory MountDriver the crypt driver can wrap. */
class FakeMount implements MountDriver {
  readonly definition = findCloudDriveDriver('r2')!
  readonly capabilities = this.definition.capabilities
  readonly nodes = new Map<string, FakeNode>()

  seed(path: string, bytes: Uint8Array = new Uint8Array(0), kind: FakeNode['kind'] = 'file'): void {
    this.nodes.set(path, { kind, bytes, modifiedAt: 1_700_000_000_000 })
  }

  seedFolder(path: string): void {
    this.seed(path, new Uint8Array(0), 'folder')
  }

  has(path: string): boolean {
    return this.nodes.has(path)
  }

  bytesAt(path: string): Uint8Array | undefined {
    return this.nodes.get(path)?.bytes
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
    const parsed = fakeRange(range, size)
    if (parsed === 'unsatisfiable' || !parsed) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    }
    const slice = node.bytes.slice(parsed.start, parsed.end + 1)
    return new Response(slice as BodyInit, {
      status: 206,
      headers: {
        'content-length': String(slice.length),
        'content-range': `bytes ${parsed.start}-${parsed.end}/${size}`,
      },
    })
  }

  async upload(path: string, body: Uint8Array | ReadableStream, options: DriverUploadOptions): Promise<void> {
    const bytes = await asBytes(body)
    if (bytes.length !== options.size) throw DriverError.invalid('Fake upload size mismatch')
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

function context(
  mount: MountDriver,
  config: Record<string, unknown> = {},
  credentials: Record<string, string> = {},
): DriverContext {
  const vault: Record<string, string> = { password: 'secret', ...credentials }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'crypt',
    config: {
      remotePath: '/vault',
      rootPath: '/',
      encryptedSuffix: '.bin',
      filenameEncryption: 'off',
      showHidden: false,
      ...config,
    },
    credentials: vault,
    saveCredentials: vi.fn(async (patch) => {
      Object.assign(vault, patch)
    }),
    markNeedsReauth: vi.fn(async () => undefined),
    resolveMount: vi.fn(async () => ({
      mountId: 'vault',
      mountName: 'Vault',
      mountPath: '/vault',
      readOnly: false,
      driver: mount,
    })),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('crypt driver', () => {
  it('rejects a wrong password through the stored key check', async () => {
    const mount = new FakeMount()
    mount.seedFolder('/')
    const owner = context(mount)
    const driver = createCryptDriver(owner)
    await driver.upload('/notes.txt', new Uint8Array([1, 2, 3, 4]), { size: 4 })
    expect(owner.credentials.keyCheck).toBeTruthy()

    const intruder = context(mount, {}, {
      password: 'wrong-password',
      keyCheck: owner.credentials.keyCheck,
    })
    await expect(createCryptDriver(intruder).list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('validates the password and salt shape before deriving', async () => {
    const mount = new FakeMount()
    const empty = createCryptDriver(context(mount, {}, { password: '' }))
    await expect(empty.list('/')).rejects.toMatchObject({ kind: 'invalid' })

    const long = createCryptDriver(context(mount, {}, { password: 'x'.repeat(1025) }))
    await expect(long.list('/')).rejects.toMatchObject({ kind: 'invalid' })

    const control = createCryptDriver(context(mount, {}, { salt: 'bad\u0000salt' }))
    await expect(control.list('/')).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('encrypts an upload into a suffixed file and decrypts it back with the plain size', async () => {
    const mount = new FakeMount()
    mount.seedFolder('/')
    mount.seedFolder('/docs')
    const driver = createCryptDriver(context(mount))
    const plaintext = Uint8Array.from({ length: 97 }, (_, index) => index % 251)

    await driver.upload('/docs/hello.txt', plaintext, { size: plaintext.length })
    expect(mount.has('/docs/hello.txt.bin')).toBe(true)
    const stored = mount.bytesAt('/docs/hello.txt.bin')!
    expect(stored.length).toBe(plaintext.length + 32)

    const listed = await driver.list('/docs')
    const entry = listed.entries.find((candidate) => candidate.name === 'hello.txt')
    expect(entry).toMatchObject({ kind: 'file', size: plaintext.length })
    expect(entry?.mime).toBe('text/plain')

    const stat = await driver.stat('/docs/hello.txt')
    expect(stat).toMatchObject({ name: 'hello.txt', kind: 'file', size: plaintext.length })

    const response = await driver.read('/docs/hello.txt')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(plaintext.length))
    const decrypted = new Uint8Array(await response.arrayBuffer())
    expect([...decrypted]).toEqual([...plaintext])
  })

  it('answers a Range by decrypting whole 16-byte-aligned blocks only', async () => {
    const mount = new FakeMount()
    mount.seedFolder('/')
    const driver = createCryptDriver(context(mount))
    const plaintext = Uint8Array.from({ length: 100 }, (_, index) => index)

    await driver.upload('/range.bin', plaintext, { size: plaintext.length })
    const response = await driver.read('/range.bin', 'bytes=10-19')
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(response.headers.get('content-length')).toBe('10')
    expect([...(new Uint8Array(await response.arrayBuffer()))]).toEqual([...plaintext.slice(10, 20)])

    const tail = await driver.read('/range.bin', 'bytes=95-')
    expect(tail.status).toBe(206)
    expect(tail.headers.get('content-range')).toBe('bytes 95-99/100')
    expect([...(new Uint8Array(await tail.arrayBuffer()))]).toEqual([...plaintext.slice(95)])
  })

  it('streams a file larger than the 1 MiB decryption block and keeps the counter aligned', async () => {
    const mount = new FakeMount()
    mount.seedFolder('/')
    const driver = createCryptDriver(context(mount))
    const size = 1024 * 1024 + 17
    const plaintext = Uint8Array.from({ length: size }, (_, index) => index % 251)

    await driver.upload('/large.bin', plaintext, { size })
    const response = await driver.read('/large.bin')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(size))
    const decrypted = new Uint8Array(await response.arrayBuffer())
    expect(decrypted.length).toBe(size)
    for (const index of [0, 15, 1024 * 1024 - 16, 1024 * 1024, size - 1]) {
      expect(decrypted[index]).toBe(plaintext[index])
    }

    const crossing = await driver.read('/large.bin', `bytes=${1024 * 1024 - 20}-${1024 * 1024 + 20}`)
    expect(crossing.status).toBe(206)
    expect([...(new Uint8Array(await crossing.arrayBuffer()))])
      .toEqual([...plaintext.slice(1024 * 1024 - 20, 1024 * 1024 + 21)])
  })

  it('reports an encrypted file shorter than its header and refuses satisfiable ranges', async () => {
    const mount = new FakeMount()
    mount.seedFolder('/')
    mount.seed('/short.bin', Uint8Array.from({ length: 10 }, (_, index) => index))
    const driver = createCryptDriver(context(mount))
    await expect(driver.read('/short')).rejects.toMatchObject({ kind: 'upstream' })

    const plaintext = new Uint8Array(20)
    await driver.upload('/plain.bin', plaintext, { size: plaintext.length })
    const response = await driver.read('/plain.bin', 'bytes=25-30')
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */20')
  })

  it('refuses filename encryption modes the port does not implement', () => {
    for (const mode of ['standard', 'obfuscate']) {
      let caught: unknown = null
      try {
        createCryptDriver(context(new FakeMount(), { filenameEncryption: mode }))
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ name: 'DriverError', kind: 'unsupported' })
    }
    let unknown: unknown = null
    try {
      createCryptDriver(context(new FakeMount(), { filenameEncryption: 'rot13' }))
    } catch (error) {
      unknown = error
    }
    expect(unknown).toMatchObject({ name: 'DriverError', kind: 'invalid' })
  })

  it('propagates a cycle and an unauthorized mount reference unchanged', async () => {
    const cycle = context(new FakeMount())
    cycle.resolveMount = vi.fn(async () => {
      throw DriverError.invalid('Circular mount reference detected')
    })
    await expect(createCryptDriver(cycle).list('/')).rejects.toMatchObject({ kind: 'invalid' })

    const foreign = context(new FakeMount())
    foreign.resolveMount = vi.fn(async () => {
      throw DriverError.notFound('No enabled mount belongs to this user')
    })
    await expect(createCryptDriver(foreign).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('tests the mount, the key derivation and the key check together', async () => {
    const mount = new FakeMount()
    mount.seedFolder('/')
    const ctx = context(mount)
    const driver = createCryptDriver(ctx)
    const result = await driver.test()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Crypt is ready')
    expect(ctx.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({ keyCheck: expect.any(String) }))
  })
})
