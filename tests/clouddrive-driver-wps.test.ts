// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWpsDriver } from '../src/worker/clouddrive/drivers/wps'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'
import { findCloudDriveDriver } from '../src/shared/clouddrive/drivers'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    cookie: 'wps_sid=valid-session; csrf=token',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'wps',
    config: { mode: 'Personal', rootFolderPath: '/', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const GROUP = { id: 1001, name: '我的文档' }
const WORK = { groupid: 1001, parentid: 0, fname: 'work', fsize: 0, ftype: 'folder', mtime: 1_700_000_000, id: 2001 }
const DOC = { groupid: 1001, parentid: 0, fname: 'doc.docx', fsize: 2048, ftype: 'file', mtime: 1_700_000_100, id: 2002 }
const NOTE = { groupid: 1001, parentid: 0, fname: 'note.md', fsize: 128, ftype: 'file', mtime: 1_700_000_200, id: 2003 }

function loginResponse(): Response {
  return json({ result: 'ok', account_num: 1, is_company_account: false, companyid: 0 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WPS driver', () => {
  it('validates the cookie and lists groups at the mount root', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('account.kdocs.cn/api/v3/islogin')) return loginResponse()
      if (url.includes('/api/v3/groups')) return json({ result: 'ok', groups: [GROUP] })
      throw new Error(`unexpected ${url}`)
    })

    const driver = createWpsDriver(context())
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['我的文档'])
    expect(result.entries[0]!.kind).toBe('folder')
    expect(result.entries[0]!.ref).toBe('1001')
    expect(result.cursor).toBeNull()
  })

  it('follows next_offset and slices the requested page', async () => {
    const offsets: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('islogin')) return loginResponse()
      if (url.includes('/api/v3/groups')) return json({ result: 'ok', groups: [GROUP] })
      if (url.includes('/api/v5/groups/1001/files')) {
        const offset = new URL(url).searchParams.get('offset') ?? ''
        offsets.push(offset)
        return offset === '0'
          ? json({ result: 'ok', files: [WORK, DOC], next_offset: 2 })
          : json({ result: 'ok', files: [NOTE], next_offset: -1 })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createWpsDriver(context())
    const first = await driver.list('/我的文档', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['work', 'doc.docx'])
    expect(first.entries[0]!.kind).toBe('folder')
    expect(first.entries[1]!.modifiedAt).toBe(DOC.mtime * 1000)
    expect(first.cursor).toBe('2')

    const second = await driver.list('/我的文档', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['note.md'])
    expect(second.cursor).toBeNull()
    expect(offsets).toEqual(['0', '2', '0', '2'])
  })

  it('treats a refused login as auth and marks the storage for re-authorization', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }))
    const driver = createWpsDriver(context({ markNeedsReauth: mark }))

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalledTimes(1)
  })

  it('maps an HTTP 429 from the group endpoint to rate_limit', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('islogin')) return loginResponse()
      return new Response('', { status: 429, headers: { 'retry-after': '0.001' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const driver = createWpsDriver(context())

    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('reports a missing file as not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('islogin')) return loginResponse()
      if (url.includes('/api/v3/groups')) return json({ result: 'ok', groups: [GROUP] })
      if (url.includes('/api/v5/groups/1001/files')) return json({ result: 'ok', files: [], next_offset: -1 })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createWpsDriver(context())
    await expect(driver.stat('/我的文档/missing.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range, UA and Referer to the ks3 download link', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('islogin')) return loginResponse()
      if (url.includes('/api/v3/groups')) return json({ result: 'ok', groups: [GROUP] })
      if (url.includes('/api/v5/groups/1001/files/2002/download')) {
        return json({ result: 'ok', url: 'https://ks3.kdocs.cn/download/doc.docx' })
      }
      if (url.includes('/api/v5/groups/1001/files')) return json({ result: 'ok', files: [DOC], next_offset: -1 })
      if (url === 'https://ks3.kdocs.cn/download/doc.docx') {
        const headers = new Headers(init?.headers)
        expect(headers.get('Range')).toBe('bytes=1-4')
        expect(headers.get('Referer')).toBe('https://drive.wps.cn')
        expect(headers.get('User-Agent')).toContain('Chrome/120')
        return new Response('bcde', { status: 206, headers: { 'content-range': 'bytes 1-4/2048' } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createWpsDriver(context())
    const response = await driver.read('/我的文档/doc.docx', 'bytes=1-4')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('bcde')
  })

  it('refuses an escaping path before it talks to WPS', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createWpsDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toBeInstanceOf(DriverError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('matches the registry capabilities while refusing the unimplemented upload path', async () => {
    const driver = createWpsDriver(context())
    expect(driver.definition).toBe(findCloudDriveDriver('wps'))
    expect(driver.capabilities.write).toBe(false)
    expect(driver.copy).toBeTypeOf('function')
    expect(driver.directLink).toBeTypeOf('function')
    await expect(driver.upload('/我的文档/doc.docx', new Uint8Array(1), { size: 1 })).rejects.toMatchObject({
      kind: 'unsupported',
    })
  })
})
