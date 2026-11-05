// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOneDriveShareLinkDriver } from '../src/worker/clouddrive/drivers/onedrive_sharelink'
import { type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const SHARE_URL = 'https://contoso.sharepoint.com/sites/team/Shared%20Documents/Eabc123'
const REDIRECT_URL = 'https://contoso.sharepoint.com/sites/team/Shared%20Documents?e=abc&id=%2Fsites%2Fteam%2FShared%20Documents'
const NEXT_URL = 'https://contoso.sharepoint.com/sites/team/_api/web/next-page'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = { ...(overrides.credentials ?? {}) }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'onedrive_sharelink',
    config: { url: SHARE_URL, rootPath: '/', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

function row(name: string, size: number, folder = false, download?: string): Record<string, unknown> {
  return {
    FSObjType: folder ? '1' : '0',
    FileLeafRef: name,
    'File_x0020_Size': String(size),
    UniqueId: `{${name.replace(/\W/g, '')}-id}`,
    'Modified.': '2026-01-02T10:30:00Z',
    ...(download ? { '@microsoft.graph.downloadUrl': download } : {}),
  }
}

function loginRedirect(): Response {
  return new Response('', { status: 302, headers: { location: REDIRECT_URL } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OneDrive Share Link driver', () => {
  it('follows NextHref until the folder listing is exhausted', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === SHARE_URL) return loginRedirect()
      if (url.includes('/_api/web/GetListUsingPath')) {
        return json({
          ListData: {
            Row: [row('Docs', 4096, true), row('a.txt', 10, false, 'https://download.example/a.txt')],
            NextHref: NEXT_URL,
          },
        })
      }
      if (url === NEXT_URL) {
        return json({ ListData: { Row: [row('b.pdf', 20, false)], NextHref: null } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createOneDriveShareLinkDriver(context())
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['Docs', 'a.txt', 'b.pdf'])
    expect(result.entries[0]!.kind).toBe('folder')
    expect(result.cursor).toBeNull()
    expect(result.truncated).toBe(false)
    expect(calls.filter((url) => url.includes('/_api/web/GetListUsingPath')).length).toBe(1)
    expect(calls).toContain(NEXT_URL)
  })

  it('walks to the requested one-based page and keeps its cursor', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === SHARE_URL) return loginRedirect()
      if (url.includes('/_api/web/GetListUsingPath')) {
        return json({ ListData: { Row: [row('a.txt', 10, false)], NextHref: NEXT_URL } })
      }
      if (url === NEXT_URL) {
        return json({ ListData: { Row: [row('b.pdf', 20, false)], NextHref: `${NEXT_URL}-2` } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createOneDriveShareLinkDriver(context())
    const page = await driver.list('/', { page: 2 })
    expect(page.entries.map((entry) => entry.name)).toEqual(['b.pdf'])
    expect(page.cursor).toBe(`${NEXT_URL}-2`)
    expect(page.truncated).toBe(true)
  })

  it('maps a refused anonymous share to an auth error', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }))
    const driver = createOneDriveShareLinkDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('unlocks a password-protected share through its input form', async () => {
    const action = 'https://contoso.sharepoint.com/sites/team/Auth/Unlock.aspx'
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'GET' && url === SHARE_URL) {
        return new Response(
          `<html><body><form id="inputForm" action="${action}">` +
          '<input id="__VIEWSTATE" value="vs" /><input id="__EVENTVALIDATION" value="ev" />' +
          '</form></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        )
      }
      if (url === action && init?.method === 'POST') {
        const body = new URLSearchParams(String(init.body))
        expect(body.get('txtPassword')).toBe('secret')
        return new Response('', { status: 302, headers: { 'set-cookie': 'FedAuth=valid; Path=/; HttpOnly' } })
      }
      if (url.includes('/_api/web/GetListUsingPath')) {
        expect(new Headers(init?.headers).get('Cookie')).toBe('FedAuth=valid')
        return json({ ListData: { Row: [row('a.txt', 10, false)], NextHref: null } })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createOneDriveShareLinkDriver(context({
      config: { url: SHARE_URL, rootPath: '/' },
      credentials: { password: 'secret' },
    }))
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
  })

  it('maps a rejected share password to an auth error', async () => {
    const action = 'https://contoso.sharepoint.com/sites/team/Auth/Unlock.aspx'
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'GET' && url === SHARE_URL) {
        return new Response(
          `<html><body><form id="inputForm" action="${action}"><input id="__VIEWSTATE" value="vs" /></form></body></html>`,
          { status: 200, headers: { 'content-type': 'text/html' } },
        )
      }
      if (url === action && init?.method === 'POST') {
        return new Response('', { status: 200 })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOneDriveShareLinkDriver(context({
      config: { url: SHARE_URL, rootPath: '/' },
      credentials: { password: 'wrong' },
    }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps 429 to rate_limit and keeps an upstream message', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === SHARE_URL) return loginRedirect()
      if (url.includes('/_api/web/GetListUsingPath')) {
        return new Response('', { status: 429, headers: { 'retry-after': '1' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOneDriveShareLinkDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 1000 })

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === SHARE_URL) return loginRedirect()
      if (url.includes('/_api/web/GetListUsingPath')) return json({ message: 'the share is broken' }, 500)
      throw new Error(`unexpected ${url}`)
    })
    const second = createOneDriveShareLinkDriver(context())
    await expect(second.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('the share is broken'),
    })
  })

  it('reports a missing child as not_found', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === SHARE_URL) return loginRedirect()
      if (url.includes('/_api/web/GetListUsingPath')) {
        return json({ ListData: { Row: [row('a.txt', 10, false)], NextHref: null } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOneDriveShareLinkDriver(context())
    await expect(driver.stat('/missing.txt')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('forwards Range to the graph download URL', async () => {
    const download = 'https://download.example/a.txt'
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === SHARE_URL) return loginRedirect()
      if (url.includes('/_api/web/GetListUsingPath')) {
        return json({ ListData: { Row: [row('a.txt', 10, false, download)], NextHref: null } })
      }
      if (url === download) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', {
          status: 206,
          headers: { 'content-range': 'bytes 2-5/10', 'content-length': '4' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createOneDriveShareLinkDriver(context())
    const response = await driver.read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('rejects a path that escapes the mount before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createOneDriveShareLinkDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.read('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declares only the capabilities it has and refuses writes', async () => {
    const driver = createOneDriveShareLinkDriver(context())
    expect(driver.capabilities.write).toBe(false)
    expect(driver.copy).toBeUndefined()
    expect(driver.directLink).toBeUndefined()
    await expect(driver.mkdir('/new')).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
