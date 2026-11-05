// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFebBoxDriver } from '../src/worker/clouddrive/drivers/febbox'
import type { DriverContext } from '../src/worker/clouddrive/drivers/contract'

const TOKEN_URL = 'https://api.febbox.com/oauth/token'
const API_URL = 'https://api.febbox.com/oauth'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(credentials: Record<string, string> = {}, config: Record<string, unknown> = {}): DriverContext {
  const stored: Record<string, string> = {
    clientId: 'client-1',
    clientSecret: 'secret',
    accessToken: 'a1',
    expiresAt: String(Date.now() + 3_600_000),
    refreshToken: 'r1',
    ...credentials,
  }
  return {
    userId: 'user-a',
    storageId: 'storage-febbox',
    type: 'febbox',
    config: { rootFolderId: '0', ...config },
    credentials: stored,
    saveCredentials: vi.fn(async (patch) => { Object.assign(stored, patch); return { ...stored } }),
    markNeedsReauth: vi.fn(async () => undefined),
  }
}

const FILE_A = { fid: 1, file_name: 'a.txt', file_size: 10, is_dir: 0, file_update_time: 1_767_225_600 }
const FILE_B = { fid: 2, file_name: 'b.pdf', file_size: 20, is_dir: 0, file_update_time: 1_767_225_600 }
const FOLDER = { fid: 3, file_name: 'docs', file_size: 0, is_dir: 1, file_update_time: 1_767_225_600 }

function fileList(files: unknown[]): Response {
  return json({ code: 1, msg: 'ok', data: { file_list: files } })
}

function formOf(init?: RequestInit): FormData {
  return init?.body as FormData
}

function tokenResponse(): Response {
  return json({ code: 1, msg: 'ok', data: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600, token_type: 'Bearer' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FebBox driver', () => {
  it('walks pages and returns a requested page plus its cursor', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) throw new Error('the access token should be reused')
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      const form = formOf(init)
      if (form.get('module') !== 'file_list') throw new Error(`unexpected module ${String(form.get('module'))}`)
      listCalls++
      return form.get('page') === '2' ? fileList([FOLDER]) : fileList([FILE_A, FILE_B])
    })

    const driver = createFebBoxDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.pdf'])
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const second = await driver.list('/', { page: 2, pageSize: 2 })
    expect(second.entries.map((entry) => entry.name)).toEqual(['docs'])
    expect(second.entries[0]!.kind).toBe('folder')
    expect(second.cursor).toBeNull()

    const all = await driver.list('/', { pageSize: 2 })
    expect(all.entries).toHaveLength(3)
    expect(all.truncated).toBe(false)
    expect(listCalls).toBe(4)
  })

  it('refreshes once and retries after the -10001 token-expired code', async () => {
    let tokenCalls = 0
    let listCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return tokenResponse()
      }
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      if (formOf(init).get('module') !== 'file_list') throw new Error('unexpected module')
      listCalls++
      if (listCalls === 1) return json({ code: -10001, msg: 'token expired', server_name: 'api' })
      return fileList([FILE_A])
    })

    const result = await createFebBoxDriver(context()).list('/')
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.txt'])
    expect(tokenCalls).toBe(1)
    expect(listCalls).toBe(2)
  })

  it('marks the storage when the token cannot be refreshed', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) return json({ code: 0, msg: 'bad credentials' }, 401)
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      if (formOf(init).get('module') === 'file_list') return new Response('', { status: 401 })
      throw new Error(`unexpected module ${String(formOf(init).get('module'))}`)
    })
    const ctx = context()
    ctx.markNeedsReauth = mark
    const driver = createFebBoxDriver(ctx)
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps throttling to rate_limit and a missing item to not_found', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0.1' } }))
    await expect(createFebBoxDriver(context()).list('/')).rejects.toMatchObject({ kind: 'rate_limit' })

    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    await expect(createFebBoxDriver(context()).list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses an escaping path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createFebBoxDriver(context()).list('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes once for two concurrent requests', async () => {
    let tokenCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return tokenResponse()
      }
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      return fileList([])
    })
    const shared = context({ accessToken: '', expiresAt: '0' })
    const first = createFebBoxDriver(shared)
    const second = createFebBoxDriver(shared)
    await Promise.all([first.list('/'), second.list('/')])
    expect(tokenCalls).toBe(1)
    expect(shared.credentials.accessToken).toBe('a2')
  })

  it('forwards Range to the resolved download address', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.href === TOKEN_URL) throw new Error('the access token should be reused')
      if (url.href === API_URL) {
        const form = formOf(init)
        if (form.get('module') === 'file_get_download_url') {
          return json({ code: 1, msg: 'ok', data: [{ download_url: 'https://dl.example/f1', fid: 1 }] })
        }
        return fileList([FILE_A])
      }
      if (url.hostname === 'dl.example') {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } })
      }
      throw new Error(`unexpected ${url}`)
    })
    const response = await createFebBoxDriver(context()).read('/a.txt', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('creates a folder through the create_dir form', async () => {
    const forms: FormData[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) throw new Error('the access token should be reused')
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      const form = formOf(init)
      if (form.get('module') !== 'create_dir') throw new Error(`unexpected module ${String(form.get('module'))}`)
      forms.push(form)
      return json({ code: 1, msg: 'ok' })
    })

    await createFebBoxDriver(context()).mkdir('/docs')
    expect(forms).toHaveLength(1)
    expect(forms[0]!.get('parent_id')).toBe('0')
    expect(forms[0]!.get('name')).toBe('docs')
  })

  it('renames an entry through the file_rename form', async () => {
    const forms: FormData[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) throw new Error('the access token should be reused')
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      const form = formOf(init)
      if (form.get('module') === 'file_list') return fileList([FILE_A])
      if (form.get('module') !== 'file_rename') throw new Error(`unexpected module ${String(form.get('module'))}`)
      forms.push(form)
      return json({ code: 1, msg: 'ok' })
    })

    await createFebBoxDriver(context()).rename('/a.txt', 'b.txt')
    expect(forms).toHaveLength(1)
    expect(forms[0]!.get('fid')).toBe('1')
    expect(forms[0]!.get('name')).toBe('b.txt')
  })

  it('moves an entry into the resolved destination folder through the file_move form', async () => {
    const forms: FormData[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) throw new Error('the access token should be reused')
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      const form = formOf(init)
      if (form.get('module') === 'file_list') return fileList([FILE_A, FOLDER])
      if (form.get('module') !== 'file_move') throw new Error(`unexpected module ${String(form.get('module'))}`)
      forms.push(form)
      return json({ code: 1, msg: 'ok' })
    })

    await createFebBoxDriver(context()).move('/a.txt', '/docs/a.txt')
    expect(forms).toHaveLength(1)
    expect(forms[0]!.get('fids[]')).toBe('1')
    expect(forms[0]!.get('to')).toBe('3')
  })

  it('copies an entry into the resolved destination folder through the file_copy form', async () => {
    const forms: FormData[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) throw new Error('the access token should be reused')
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      const form = formOf(init)
      if (form.get('module') === 'file_list') return fileList([FILE_A, FOLDER])
      if (form.get('module') !== 'file_copy') throw new Error(`unexpected module ${String(form.get('module'))}`)
      forms.push(form)
      return json({ code: 1, msg: 'ok' })
    })

    await createFebBoxDriver(context()).copy!('/a.txt', '/docs/a.txt')
    expect(forms).toHaveLength(1)
    expect(forms[0]!.get('fids[]')).toBe('1')
    expect(forms[0]!.get('to')).toBe('3')
  })

  it('removes an entry through the file_delete form', async () => {
    const forms: FormData[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) throw new Error('the access token should be reused')
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      const form = formOf(init)
      if (form.get('module') === 'file_list') return fileList([FILE_A])
      if (form.get('module') !== 'file_delete') throw new Error(`unexpected module ${String(form.get('module'))}`)
      forms.push(form)
      return json({ code: 1, msg: 'ok' })
    })

    await createFebBoxDriver(context()).remove('/a.txt')
    expect(forms).toHaveLength(1)
    expect(forms[0]!.get('fids[]')).toBe('1')
  })

  it('maps a throttled write call to rate_limit', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) throw new Error('the access token should be reused')
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      const form = formOf(init)
      if (form.get('module') === 'create_dir') {
        return new Response('', { status: 429, headers: { 'retry-after': '0.01' } })
      }
      throw new Error(`unexpected module ${String(form.get('module'))}`)
    })

    await expect(createFebBoxDriver(context()).mkdir('/docs')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a 401 on a write call to auth, refreshing once and marking the storage', async () => {
    const mark = vi.fn(async () => undefined)
    let tokenCalls = 0
    let writeCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TOKEN_URL) {
        tokenCalls++
        return tokenResponse()
      }
      if (url !== API_URL) throw new Error(`unexpected ${url}`)
      const form = formOf(init)
      if (form.get('module') === 'file_list') return fileList([FILE_A])
      if (form.get('module') === 'file_rename') {
        writeCalls++
        return new Response('', { status: 401 })
      }
      throw new Error(`unexpected module ${String(form.get('module'))}`)
    })

    const ctx = context()
    ctx.markNeedsReauth = mark
    await expect(createFebBoxDriver(ctx).rename('/a.txt', 'b.txt')).rejects.toMatchObject({ kind: 'auth' })
    expect(tokenCalls).toBe(1)
    expect(writeCalls).toBe(2)
    expect(mark).toHaveBeenCalled()
  })

  it('refuses an escaping write path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createFebBoxDriver(context())
    await expect(driver.mkdir('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.rename('/docs/../secret', 'b.txt')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.move('/docs/../secret', '/docs')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.move('/a.txt', '/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.copy!('/a.txt', '/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    await expect(driver.remove('/docs/../secret')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('declares the write capabilities while keeping upload unsupported', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createFebBoxDriver(context())
    expect(driver.capabilities).toMatchObject({
      write: false,
      mkdir: true,
      rename: true,
      move: true,
      copy: true,
      delete: true,
      directLink: true,
      range: true,
    })
    await expect(driver.upload('/a.txt', new Uint8Array([1]), { size: 1 }))
      .rejects.toMatchObject({ kind: 'unsupported', message: expect.stringContaining('reference client') })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
