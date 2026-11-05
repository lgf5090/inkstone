// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLanzouDriver } from '../src/worker/clouddrive/drivers/lanzou'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

const BASE = 'https://pc.woozooo.com'
const SHARE = 'https://pan.lanzoui.com'

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function payloadOf(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ''))
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  const credentials: Record<string, string> = {
    cookie: 'ylogin=100; phpdisk_info=abc',
    password: '',
    ...(overrides.credentials ?? {}),
  }
  return {
    userId: 'user-a',
    storageId: 'storage-a',
    type: 'lanzou',
    config: { type: 'cookie', baseUrl: BASE, shareUrl: SHARE, rootFolderId: '-1', ...(overrides.config ?? {}) },
    credentials,
    saveCredentials: vi.fn(async (patch) => { Object.assign(credentials, patch) }),
    markNeedsReauth: vi.fn(async () => undefined),
    ...overrides,
  }
}

const MYDISK_HTML = '<html><body><a href="mydisk.php?uid=12345">x</a><script>var a = {data: {vei:\'vei-token\'}};</script></body></html>'

const FILE_A = { id: '55', name_all: 'a.mp3', size: '1 M', time: '2026-01-02' }
const FILE_B = { id: '56', name_all: 'b.txt', size: '2 K', time: '2026-01-03' }
const FILE_C = { id: '57', name_all: 'c.zip', size: '3 M', time: '2026-01-04' }

/** Personal-disk fixture: mydisk bootstrap plus the task 47/5 task protocol. */
function personalFixture(options: { files?: unknown[]; pageTwo?: unknown[]; folders?: unknown[]; extra?: (url: string, init?: RequestInit) => Response | null } = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/mydisk.php')) return new Response(MYDISK_HTML, { headers: { 'content-type': 'text/html' } })
    if (url.includes('/doupload.php')) {
      const body = payloadOf(init)
      const task = body.get('task')
      if (task === '47') return json({ zt: 1, text: options.folders ?? [] })
      if (task === '5') {
        const pg = body.get('pg')
        if (pg === '1') return json({ zt: 1, text: options.files ?? [FILE_A, FILE_B] })
        if (pg === '2') return json({ zt: 1, text: options.pageTwo ?? [FILE_C] })
        return json({ zt: 1, text: [] })
      }
      const extra = options.extra?.(url, init)
      if (extra) return extra
      throw new Error(`unexpected task ${task ?? ''}`)
    }
    throw new Error(`unexpected ${url}`)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Lanzou driver', () => {
  it('walks the personal file pages and stops on the empty page', async () => {
    vi.stubGlobal('fetch', personalFixture())
    const driver = createLanzouDriver(context())
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.mp3', 'b.txt', 'c.zip'])
    expect(result.entries[1]!.mime).toBe('text/plain')
    expect(result.cursor).toBeNull()
  })

  it('returns the next page cursor for a requested page', async () => {
    vi.stubGlobal('fetch', personalFixture())
    const driver = createLanzouDriver(context())
    const first = await driver.list('/', { page: 1 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.mp3', 'b.txt'])
    expect(first.cursor).toBe('2')
    const second = await driver.list('/', { page: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['c.zip'])
    expect(second.cursor).toBe('3')
  })

  it('requires a cookie in cookie mode and reports auth without any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createLanzouDriver(context({ credentials: { cookie: '', password: '' } }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks the storage for re-authorization when doupload reports zt=9', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/mydisk.php')) return new Response(MYDISK_HTML, { headers: { 'content-type': 'text/html' } })
      if (url.includes('/doupload.php')) return json({ zt: 9, info: 'not logged in' })
      throw new Error(`unexpected ${url} ${String(init?.method)}`)
    })
    const driver = createLanzouDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps HTTP 429 from doupload to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/mydisk.php')) return new Response(MYDISK_HTML, { headers: { 'content-type': 'text/html' } })
      return new Response('', { status: 429, headers: { 'retry-after': '0' } })
    })
    const driver = createLanzouDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a missing public share to not_found without requiring credentials', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>文件不存在</html>', { headers: { 'content-type': 'text/html' } }))
    const driver = createLanzouDriver(context({
      config: { type: 'url', shareUrl: 'https://pan.lanzoui.com/b00missing', rootFolderId: '', baseUrl: BASE },
      credentials: { cookie: '', password: '' },
    }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('lists a public share page and its filemoreajax pages', async () => {
    const calls: string[] = []
    const sharePage = `<html><body>
      <a class="folderlink" href="/b00sub">子目录</a>
      <script>data: {task:'5', pwd:'', pg:'1'}</script>
    </body></html>`
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/filemoreajax.php')) {
        const page = payloadOf(init).get('pg')
        if (page === '1') return json({ zt: 1, text: [{ id: '66', name_all: 'readme.txt', size: '2 K', time: '2026-01-03' }] })
        return json({ zt: 1, text: [] })
      }
      return new Response(sharePage, { headers: { 'content-type': 'text/html' } })
    })
    const driver = createLanzouDriver(context({
      config: { type: 'url', shareUrl: 'https://pan.lanzoui.com/b00share', rootFolderId: '', baseUrl: BASE },
      credentials: { cookie: '', password: '' },
    }))
    const result = await driver.list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['子目录', 'readme.txt'])
    expect(result.entries[0]!.kind).toBe('folder')
    expect(result.entries[1]!.kind).toBe('file')
    expect(calls.some((url) => url.includes('/filemoreajax.php'))).toBe(true)
  })

  it('solves the WAF challenge, replays the acw cookie and persists refreshed cookies', async () => {
    const cookies: string[] = []
    let mydiskCalls = 0
    const save = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/mydisk.php')) {
        mydiskCalls++
        cookies.push(new Headers(init?.headers).get('cookie') ?? '')
        if (mydiskCalls === 1) {
          return new Response("<html><script>var arg1='0123456789012345678901234567890123456789'</script>acw_sc__v2</html>", {
            headers: { 'content-type': 'text/html', 'set-cookie': 'acw_sc__v2=challenge; Path=/' },
          })
        }
        return new Response(MYDISK_HTML, {
          headers: { 'content-type': 'text/html', 'set-cookie': 'ylogin=refresh; Path=/' },
        })
      }
      if (url.includes('/doupload.php')) return json({ zt: 1, text: [] })
      throw new Error(`unexpected ${url}`)
    })
    const driver = createLanzouDriver(context({ saveCredentials: save }))
    await driver.list('/')
    expect(mydiskCalls).toBe(2)
    expect(cookies[1]).toContain('acw_sc__v2=')
    expect(save).toHaveBeenCalled()
  })

  it('forwards Range to a resolved link and keeps the 206 body', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://cdn.example/a.mp3') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=1-4')
        return new Response('bcde', { status: 206, headers: { 'content-range': 'bytes 1-4/9' } })
      }
      if (url.includes('/mydisk.php')) return new Response(MYDISK_HTML, { headers: { 'content-type': 'text/html' } })
      if (url.includes('/doupload.php')) {
        const body = payloadOf(init)
        const task = body.get('task')
        if (task === '47') return json({ zt: 1, text: [] })
        if (task === '5') {
          return body.get('pg') === '1'
            ? json({ zt: 1, text: [{ id: '55', name_all: 'a.mp3', size: '1 M', time: '2026-01-02', url: 'https://cdn.example/a.mp3' }] })
            : json({ zt: 1, text: [] })
        }
      }
      throw new Error(`unexpected ${url}`)
    })
    const driver = createLanzouDriver(context())
    const response = await driver.read('/a.mp3', 'bytes=1-4')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('bcde')
  })

  it('rejects an invalid path before any request and reports upload as unsupported', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createLanzouDriver(context())
    await expect(driver.list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.mkdir('/docs/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.upload('/a.txt', new Uint8Array([1]), { size: 1 })).rejects.toMatchObject({ kind: 'unsupported' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declares write and copy as unavailable', () => {
    const driver = createLanzouDriver(context())
    expect(driver.capabilities.write).toBe(false)
    expect(driver.capabilities.copy).toBe(false)
    expect(driver.copy).toBeUndefined()
    expect(driver.capabilities.directLink).toBe(false)
  })

  it('keeps folder rename and move unsupported', async () => {
    vi.stubGlobal('fetch', personalFixture({
      files: [],
      folders: [{ fol_id: '77', name: 'folder-a' }],
    }))
    const driver = createLanzouDriver(context())
    await expect(driver.rename('/folder-a', 'folder-b')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.move('/folder-a', '/dest')).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
