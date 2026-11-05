// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVirtualDriver } from '../src/worker/clouddrive/drivers/virtual'
import { type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { ...(overrides.credentials ?? {}) }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'virtual',
    config: {
      numFile: 5,
      numFolder: 2,
      minFileSize: 100,
      maxFileSize: 200,
      rootPath: '/',
      ...(overrides.config ?? {}),
    },
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

describe('Virtual driver', () => {
  it('synthesises a stable listing from numFile and numFolder', async () => {
    const driver = createVirtualDriver(context())
    const first = await driver.list('/')
    const second = await driver.list('/anything')
    expect(first.entries).toHaveLength(7)
    expect(first.entries.filter((entry) => entry.kind === 'file')).toHaveLength(5)
    expect(first.entries.filter((entry) => entry.kind === 'folder')).toHaveLength(2)
    expect(first.entries.map((entry) => entry.name)).toEqual([
      'file_0.bin', 'file_1.bin', 'file_2.bin', 'file_3.bin', 'file_4.bin',
      'folder_0', 'folder_1',
    ])
    for (const entry of first.entries.filter((item) => item.kind === 'file')) {
      expect(entry.size).toBeGreaterThanOrEqual(100)
      expect(entry.size).toBeLessThanOrEqual(200)
    }
    expect(second.entries.map((entry) => [entry.name, entry.size])).toEqual(
      first.entries.map((entry) => [entry.name, entry.size]),
    )
  })

  it('keeps stat and read sizes consistent', async () => {
    const driver = createVirtualDriver(context())
    const listed = (await driver.list('/')).entries.find((entry) => entry.name === 'file_3.bin')!
    const stat = await driver.stat('/file_3.bin')
    expect(stat.kind).toBe('file')
    expect(stat.size).toBe(listed.size)
    const response = await driver.read('/file_3.bin')
    expect(response.status).toBe(200)
    expect(Number(response.headers.get('content-length'))).toBe(stat.size)
    expect((await response.arrayBuffer()).byteLength).toBe(stat.size)
  })

  it('returns a folder entry for a generated folder', async () => {
    const driver = createVirtualDriver(context())
    const folder = await driver.stat('/folder_0')
    expect(folder.kind).toBe('folder')
    expect(folder.size).toBe(0)
  })

  it('serves a Range slice with 206 headers', async () => {
    const driver = createVirtualDriver(context())
    const response = await driver.read('/file_1.bin', 'bytes=10-19')
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toMatch(/^bytes 10-19\/\d+$/)
    expect(response.headers.get('content-length')).toBe('10')
    expect((await response.arrayBuffer()).byteLength).toBe(10)
  })

  it('rejects a path that escapes the mount before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createVirtualDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.read('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declares only the capabilities it has and refuses writes', async () => {
    const driver = createVirtualDriver(context())
    expect(driver.capabilities.write).toBe(false)
    expect(driver.capabilities.range).toBe(true)
    expect(driver.copy).toBeUndefined()
    expect(driver.directLink).toBeUndefined()
    await expect(driver.mkdir('/new')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.upload('/file.bin', new Uint8Array(), { size: 0 })).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('reports readiness through test()', async () => {
    const driver = createVirtualDriver(context())
    const result = await driver.test()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Virtual storage is ready')
  })
})
