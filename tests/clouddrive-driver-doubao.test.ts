// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDoubaoDriver } from '../src/worker/clouddrive/drivers/doubao'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const USER = 'user-a'
const STORAGE = 'storage-a'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { cookie: 'session=abc', ...(overrides.credentials ?? {}) }
  const config: Record<string, unknown> = {
    downloadApi: 'get_file_url',
    rootFolderId: '0',
    ...(overrides.config ?? {}),
  }
  return Object.assign<DriverContext, Partial<DriverContext>, Partial<DriverContext>>(
    {
      userId: USER,
      storageId: STORAGE,
      type: 'doubao',
      config,
      credentials,
      saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
      markNeedsReauth: vi.fn(async () => undefined),
    },
    overrides,
    { config, credentials },
  )
}

const FILE_A = { id: '101', name: 'a.txt', key: 'k1', node_type: 2, size: 10, parent_id: '0', update_time: 1760000000 }
const FILE_B = { id: '102', name: 'b.pdf', key: 'k2', node_type: 2, size: 20, parent_id: '0', update_time: 1760001000 }
const FOLDER = { id: '103', name: 'docs', key: '', node_type: 1, size: 0, parent_id: '0', update_time: 1760002000 }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Doubao driver', () => {
  it('walks the cursor pages with the requested page size and returns the next cursor', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.endsWith('/samantha/aispace/node_info')) throw new Error(`unexpected ${url}`)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      bodies.push(body)
      if (body.cursor === 'c1') {
        return json({ code: 0, data: { children: [FOLDER], next_cursor: '-1' } })
      }
      return json({ code: 0, data: { children: [FILE_A, FILE_B], next_cursor: 'c1' } })
    })

    const driver = createDoubaoDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.entries[0]!.modifiedAt).toBe(1760000000 * 1000)
    expect(first.cursor).toBe('c1')

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()
    expect(bodies.map((body) => body.size)).toEqual([2, 2, 2])
  })

  it('marks the storage for re-authorization when Doubao keeps answering an auth code', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ code: 401, message: 'login required' }))

    const driver = createDoubaoDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps 429 to a rate-limit driver error', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    const driver = createDoubaoDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps 404 to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const driver = createDoubaoDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the resolved download URL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/samantha/aispace/node_info')) {
        return json({ code: 0, data: { children: [FILE_A], next_cursor: '-1' } })
      }
      if (url.endsWith('/alice/message/get_file_url')) {
        return json({ code: 0, data: { file_urls: [{ main_url: 'https://cdn.example/a.txt' }] } })
      }
      if (url === 'https://cdn.example/a.txt') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createDoubaoDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects escaping paths and control characters before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createDoubaoDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.stat('/bad\u0000name')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.remove('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps copy/upload undefined or unsupported while the rest of the write surface is present', async () => {
    const driver = createDoubaoDriver(context())
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.capabilities.write).toBe(false)
    expect(driver.copy).toBeUndefined()
    expect(typeof driver.mkdir).toBe('function')
    expect(typeof driver.directLink).toBe('function')
    await expect(driver.upload('/a.txt', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
