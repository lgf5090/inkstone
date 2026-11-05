// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGithubReleasesDriver } from '../src/worker/clouddrive/drivers/github_releases'
import { DriverError, type DriverContext } from '../src/worker/clouddrive/drivers/contract'

function release(tag: string, assetName: string) {
  return {
    tag_name: tag,
    created_at: '2026-01-01T00:00:00Z',
    published_at: '2026-01-02T00:00:00Z',
    zipball_url: `https://github.com/OpenListTeam/OpenList/archive/refs/tags/${tag}.zip`,
    tarball_url: `https://github.com/OpenListTeam/OpenList/archive/refs/tags/${tag}.tar.gz`,
    assets: [
      {
        name: assetName,
        size: 1024,
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        browser_download_url: `https://github.com/OpenListTeam/OpenList/releases/download/${tag}/${assetName}`,
      },
    ],
  }
}

const LATEST = release('v1.0.0', 'openlist-linux-amd64.tar.gz')
const OLDER = release('v0.9.0', 'openlist-v0.9.0.tar.gz')
const EXTRA = release('v0.8.0', 'openlist-v0.8.0.tar.gz')
const ALL = [LATEST, OLDER, EXTRA]

const CONTENTS = [
  { name: 'README.md', size: 10, download_url: 'https://raw.githubusercontent.com/OpenListTeam/OpenList/main/README.md' },
  { name: 'LICENSE', size: 20, download_url: 'https://raw.githubusercontent.com/OpenListTeam/OpenList/main/LICENSE' },
  { name: 'src', size: 0, download_url: 'https://raw.githubusercontent.com/OpenListTeam/OpenList/main/src' },
]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function context(overrides: Partial<DriverContext> = {}): DriverContext {
  return {
    ...overrides,
    userId: overrides.userId ?? 'user-a',
    storageId: overrides.storageId ?? 'storage-a',
    type: overrides.type ?? 'github_releases',
    config: {
      repoStructure: 'OpenListTeam/OpenList',
      rootPath: '/',
      showReadme: true,
      showSourceCode: true,
      showAllVersion: false,
      perPage: 30,
      maxPage: 0,
      ghProxy: '',
      ...(overrides.config ?? {}),
    },
    credentials: { ...(overrides.credentials ?? {}) },
    saveCredentials: overrides.saveCredentials ?? vi.fn(async () => undefined),
    markNeedsReauth: overrides.markNeedsReauth ?? vi.fn(async () => undefined),
  }
}

function serveAll(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/releases/latest')) return json(LATEST)
    if (url.includes('/releases?')) return json(ALL)
    if (url.includes('/contents')) return json(CONTENTS)
    throw new Error(`unexpected ${url}`)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GitHub Releases driver', () => {
  it('lists the latest assets, source bundles and README at the mount root', async () => {
    serveAll()
    const driver = createGithubReleasesDriver(context())
    const listed = await driver.list('/')
    const names = listed.entries.map((entry) => entry.name).sort()
    expect(names).toEqual([
      'LICENSE',
      'README.md',
      'Source code (tar.gz)',
      'Source code (zip)',
      'openlist-linux-amd64.tar.gz',
    ])
    const asset = listed.entries.find((entry) => entry.name === 'openlist-linux-amd64.tar.gz')!
    expect(asset).toMatchObject({ kind: 'file', size: 1024 })
    expect(asset.ref).toBe(
      'https://github.com/OpenListTeam/OpenList/releases/download/v1.0.0/openlist-linux-amd64.tar.gz',
    )
    const readme = listed.entries.find((entry) => entry.name === 'README.md')!
    expect(readme.ref).toBe('https://raw.githubusercontent.com/OpenListTeam/OpenList/main/README.md')
  })

  it('maps a rejected token to auth and marks the storage for re-authorization', async () => {
    const mark = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', async () => json({ message: 'bad credentials' }, 401))
    const driver = createGithubReleasesDriver(context({ markNeedsReauth: mark }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'auth' })
    expect(mark).toHaveBeenCalled()
  })

  it('maps rate limiting to rate_limit', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }))
    const driver = createGithubReleasesDriver(context())
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('maps a missing release list to not_found', async () => {
    vi.stubGlobal('fetch', async () => json({ message: 'not found' }, 404))
    const driver = createGithubReleasesDriver(context({
      config: { showAllVersion: true, showReadme: false, perPage: 30, maxPage: 0 },
    }))
    await expect(driver.list('/')).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('keeps the upstream message on an unexpected status', async () => {
    vi.stubGlobal('fetch', async () => json({ message: 'github exploded' }, 400))
    const driver = createGithubReleasesDriver(context({
      config: { showAllVersion: true, showReadme: false },
    }))
    await expect(driver.list('/')).rejects.toMatchObject({
      kind: 'upstream',
      message: expect.stringContaining('github exploded'),
    })
  })

  it('returns a cursor for the requested virtual page', async () => {
    serveAll()
    const driver = createGithubReleasesDriver(context())
    const first = await driver.list('/', { page: 1, pageSize: 2 })
    expect(first.entries).toHaveLength(2)
    expect(first.cursor).toBe('2')
    expect(first.truncated).toBe(true)

    const last = await driver.list('/', { page: 3, pageSize: 2 })
    expect(last.entries).toHaveLength(1)
    expect(last.cursor).toBeNull()
    expect(last.truncated).toBe(false)
  })

  it('walks release pages until a short page and honours maxPage', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      const parsed = new URL(url)
      const page = Number(parsed.searchParams.get('page') ?? '1')
      const perPage = Number(parsed.searchParams.get('per_page') ?? '30')
      return json(ALL.slice((page - 1) * perPage, page * perPage))
    })

    const driver = createGithubReleasesDriver(context({
      config: { showAllVersion: true, showReadme: false, perPage: 2, maxPage: 2 },
    }))
    const listed = await driver.list('/')

    expect(listed.entries.map((entry) => entry.name)).toEqual(['v1.0.0', 'v0.9.0', 'v0.8.0'])
    expect(calls.some((url) => url.includes('per_page=2') && url.includes('page=1'))).toBe(true)
    expect(calls.some((url) => url.includes('per_page=2') && url.includes('page=2'))).toBe(true)
    expect(calls.some((url) => url.includes('page=3'))).toBe(false)
    expect(listed.truncated).toBe(false)
  })

  it('forwards Range to the resolved asset download URL', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/releases?')) return json(ALL)
      if (url.startsWith('https://github.com/OpenListTeam/OpenList/releases/download/v1.0.0/')) {
        expect(new Headers(init?.headers).get('Range')).toBe('bytes=2-5')
        return new Response('cdef', {
          status: 206,
          headers: { 'content-range': 'bytes 2-5/1024', 'content-length': '4' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })

    const driver = createGithubReleasesDriver(context({
      config: { showAllVersion: true, showReadme: false },
    }))
    const response = await driver.read('/v1.0.0/openlist-linux-amd64.tar.gz', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
  })

  it('applies the rootPath to nested repo mounts', async () => {
    serveAll()
    const driver = createGithubReleasesDriver(context({
      config: { repoStructure: 'repos:OpenListTeam/OpenList', rootPath: '/gh' },
    }))
    const root = await driver.list('/')
    expect(root.entries.map((entry) => entry.name)).toEqual(['repos'])
    const mounted = await driver.list('/repos')
    expect(mounted.entries.some((entry) => entry.name === 'openlist-linux-amd64.tar.gz')).toBe(true)
  })

  it('rewrites only github.com download URLs through ghProxy', async () => {
    serveAll()
    const driver = createGithubReleasesDriver(context({
      config: { ghProxy: 'https://ghproxy.net/https://github.com' },
    }))
    const listed = await driver.list('/')
    const asset = listed.entries.find((entry) => entry.name === 'openlist-linux-amd64.tar.gz')!
    const readme = listed.entries.find((entry) => entry.name === 'README.md')!
    expect(asset.ref).toBe(
      'https://ghproxy.net/https://github.com/OpenListTeam/OpenList/releases/download/v1.0.0/openlist-linux-amd64.tar.gz',
    )
    expect(readme.ref).toBe('https://raw.githubusercontent.com/OpenListTeam/OpenList/main/README.md')
  })

  it('rejects a path that escapes the mount root before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const driver = createGithubReleasesDriver(context())
    await expect(driver.list('/repos/../secret')).rejects.toBeInstanceOf(DriverError)
    await expect(driver.mkdir('/repos/../escape')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('exposes no write capability and no undefined methods', async () => {
    const driver = createGithubReleasesDriver(context())
    expect(driver.copy).toBeUndefined()
    expect(driver.directLink).toBeUndefined()
    await expect(driver.mkdir('/new')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.move('/a', '/b')).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.upload('/a', new Uint8Array(), { size: 0 })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(driver.remove('/a')).rejects.toMatchObject({ kind: 'unsupported' })
  })
})
