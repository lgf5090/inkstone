// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUrlTreeDriver } from '../src/worker/clouddrive/drivers/url_tree'
import { type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const STRUCTURE = `Movies:
  Inception:
    2010:
      Inception.2010.mkv:1073741824:1700000000:https://cdn.example/movies/inception.mkv
    Readme:https://cdn.example/readme.txt
  Trailers:
    trailer.mp4:10485760:1700000100:https://cdn.example/trailer.mp4`

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { ...(overrides.credentials ?? {}) }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'url_tree',
    config: { urlStructure: STRUCTURE, writable: false, headSize: false, rootPath: '/', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('URL Tree driver', () => {
  it('parses two-space indentation into nested folders with computed sizes', async () => {
    const driver = createUrlTreeDriver(context())
    const root = await driver.list('/')
    expect(root.entries.map((entry) => entry.name)).toEqual(['Movies'])
    const movies = await driver.list('/Movies')
    expect(movies.entries.map((entry) => entry.name)).toEqual(['Inception', 'Trailers'])
    expect(movies.entries[0]!.kind).toBe('folder')
    expect(movies.entries[0]!.size).toBe(1_073_741_824)
    expect(movies.entries[1]!.size).toBe(10_485_760)
    const nested = await driver.list('/Movies/Inception/2010')
    expect(nested.entries.map((entry) => entry.name)).toEqual(['Inception.2010.mkv'])
  })

  it('stats a file with its declared size and modification time', async () => {
    const driver = createUrlTreeDriver(context())
    const file = await driver.stat('/Movies/Inception/2010/Inception.2010.mkv')
    expect(file.kind).toBe('file')
    expect(file.size).toBe(1_073_741_824)
    expect(file.modifiedAt).toBe(1_700_000_000_000)
    expect(file.ref).toBe('https://cdn.example/movies/inception.mkv')
  })

  it('returns the URL text and honours a Range request', async () => {
    const driver = createUrlTreeDriver(context())
    const full = await driver.read('/Movies/Inception/2010/Inception.2010.mkv')
    expect(full.status).toBe(200)
    expect(await full.text()).toBe('https://cdn.example/movies/inception.mkv')

    const sliced = await driver.read('/Movies/Inception/2010/Inception.2010.mkv', 'bytes=0-7')
    expect(sliced.status).toBe(206)
    expect(sliced.headers.get('content-range')).toMatch(/^bytes 0-7\/\d+$/)
    expect(await sliced.text()).toBe('https://')
  })

  it('applies rootPath to the resolved tree node', async () => {
    const driver = createUrlTreeDriver(context({ config: { urlStructure: STRUCTURE, rootPath: '/Movies/Trailers' } }))
    const root = await driver.list('/')
    expect(root.entries.map((entry) => entry.name)).toEqual(['trailer.mp4'])
  })

  it('rejects a path that escapes the mount before parsing requests', async () => {
    const driver = createUrlTreeDriver(context())
    await expect(driver.list('/Movies/../Movies')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.read('/Movies/../Movies')).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('rejects malformed indentation and missing structures as invalid', async () => {
    const bad = createUrlTreeDriver(context({ config: { urlStructure: 'Movies:\n x:https://example.com/x' } }))
    await expect(bad.list('/')).rejects.toMatchObject({ kind: 'invalid' })

    const empty = createUrlTreeDriver(context({ config: { urlStructure: '   ' } }))
    await expect(empty.list('/')).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('refuses writes when writable is off', async () => {
    const driver = createUrlTreeDriver(context())
    await expect(driver.mkdir('/New')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.rename('/Movies', 'Films')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.remove('/Movies')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.move('/Movies', '/Archive')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.upload('/New/file.txt', new Uint8Array(), { size: 0 })).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('persists writable edits through saveConfig', async () => {
    const saveConfig = vi.fn(async () => undefined)
    const driver = createUrlTreeDriver(context({
      config: { urlStructure: STRUCTURE, writable: true, headSize: false, rootPath: '/' },
      saveConfig,
    }))
    expect(driver.capabilities.write).toBe(true)
    await driver.mkdir('/Archive')
    expect(await driver.list('/')).toEqual({
      entries: expect.arrayContaining([expect.objectContaining({ name: 'Archive', kind: 'folder' })]),
      cursor: null,
      truncated: false,
    })
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ urlStructure: expect.stringContaining('Archive:') }))

    const body = new TextEncoder().encode('https://cdn.example/new.txt')
    await driver.upload('/Archive/link.txt', body, { size: body.byteLength })
    const file = await driver.stat('/Archive/link.txt')
    expect(file.ref).toBe('https://cdn.example/new.txt')
    await driver.rename('/Archive', 'Films')
    await driver.copy!('/Movies/Trailers/trailer.mp4', '/Films/trailer.mp4')
    await driver.move('/Films/trailer.mp4', '/Movies/Trailers/moved.mp4')
    await driver.remove('/Films')
    expect(saveConfig).toHaveBeenCalledTimes(6)
    expect(await driver.list('/')).toEqual({ entries: expect.arrayContaining([expect.objectContaining({ name: 'Movies' })]), cursor: null, truncated: false })
  })

  it('refuses writable edits when the context has no config callback', async () => {
    const driver = createUrlTreeDriver(context({ config: { urlStructure: STRUCTURE, writable: true, rootPath: '/' } }))
    await expect(driver.mkdir('/New')).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('reports readiness through test()', async () => {
    const driver = createUrlTreeDriver(context())
    const result = await driver.test()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('1 top-level')
  })
})
