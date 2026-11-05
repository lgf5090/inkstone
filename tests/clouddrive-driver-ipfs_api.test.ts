// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'
import { createIpfsApiDriver } from '../src/worker/clouddrive/drivers/ipfs_api'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const ENDPOINT = 'http://ipfs.example:5001'
const GATEWAY = 'https://gw.example'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  return {
    ...overrides,
    userId: overrides.userId ?? 'user-a',
    storageId: overrides.storageId ?? 'storage-a',
    type: overrides.type ?? 'ipfs_api',
    config: { endpoint: ENDPOINT, gateway: GATEWAY, mode: 'mfs', rootPath: '/', ...(overrides.config ?? {}) },
    credentials: { ...(overrides.credentials ?? {}) },
    saveCredentials: overrides.saveCredentials ?? vi.fn(async () => undefined),
    markNeedsReauth: overrides.markNeedsReauth ?? vi.fn(async () => undefined),
  }
}

const FILE = { Name: 'a.txt', Type: 0, Size: 10, Hash: 'QmFile' }
const FOLDER = { Name: 'docs', Type: 1, Size: 0, Hash: 'QmDocs' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('IPFS API driver', () => {
  it('lists an mfs directory through files/ls and keeps the CID as the entry ref', async () => {
    let method = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toContain('/api/v0/files/ls?arg=%2Fdocs')
      method = init?.method ?? ''
      return json({ Entries: [FILE, FOLDER] })
    })

    const driver = createIpfsApiDriver(context())
    const listed = await driver.list('/docs')

    expect(method).toBe('POST')
    expect(listed.entries.map((entry) => entry.name)).toEqual(['a.txt', 'docs'])
    expect(listed.entries[0]).toMatchObject({ kind: 'file', size: 10, ref: 'QmFile' })
    expect(listed.entries[1]).toMatchObject({ kind: 'folder', ref: 'QmDocs' })
    expect(driver.capabilities).toEqual(findCloudDriveDriver('ipfs_api')!.capabilities)
  })

  it('maps a rejected node login to auth', async () => {
    vi.stubGlobal('fetch', async () => json({ message: 'missing api auth' }, 401))
    const driver = createIpfsApiDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps rate limiting to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }))
    const driver = createIpfsApiDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a missing node path to not_found', async () => {
    vi.stubGlobal('fetch', async () => json({ Message: 'no such path' }, 404))
    const driver = createIpfsApiDriver(context())
    await expect(driver.list('/missing')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('keeps the upstream Message when the node answers an unexpected status', async () => {
    vi.stubGlobal('fetch', async () => json({ Message: 'ipfs exploded' }, 400))
    const driver = createIpfsApiDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('ipfs exploded'),
    })
  })

  it('rejects a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createIpfsApiDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards Range to the gateway direct link instead of reading the file into memory', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v0/files/ls')) return json({ Entries: [FILE] })
      if (url.startsWith(`${GATEWAY}/ipfs/QmFile`)) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', {
          status: 206,
          headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createIpfsApiDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
    expect(await driver.directLink!('/a.txt')).toBe(`${GATEWAY}/ipfs/QmFile?filename=a.txt`)
  })

  it('browses ipfs mode through /api/v0/ls under the configured root CID', async () => {
    let requested = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requested = String(input)
      return json({ Objects: [{ Hash: 'QmDocs', Links: [FILE] }] })
    })
    const driver = createIpfsApiDriver(context({ config: { mode: 'ipfs', rootPath: 'bafyroot' } }))
    const listed = await driver.list('/docs')
    const arg = new URL(requested).searchParams.get('arg')
    expect(arg).toBe('/ipfs/bafyroot/docs')
    expect(listed.entries.map((entry) => entry.name)).toEqual(['a.txt'])
  })

  it('uploads through add and files/cp in mfs mode', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/api/v0/add')) {
        expect(init?.method).toBe('POST')
        return json({ Hash: 'QmNew', Size: '5' })
      }
      if (url.includes('/api/v0/files/cp')) return new Response('', { status: 200 })
      throw new Error(`unexpected ${url}`)
    })

    const progress = vi.fn()
    const driver = createIpfsApiDriver(context())
    await driver.upload('/new.txt', new Uint8Array([1, 2, 3, 4, 5]), {
      size: 5,
      contentType: 'text/plain',
      onProgress: progress,
    })

    const copy = new URL(calls.find((url) => url.includes('/files/cp'))!)
    expect(copy.searchParams.getAll('arg')).toEqual(['/ipfs/QmNew', '/new.txt'])
    expect(progress).toHaveBeenCalledWith(5, 5)
  })
})
