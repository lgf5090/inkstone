import { expect, it } from 'vitest'
import { inkstonePwa } from '../pwa.config'

const ORIGIN = 'https://note.test'

type FakeInit = { status?: number; headers?: Record<string, string> }

class FakeResponse {
  readonly body: string
  readonly status: number
  readonly ok: boolean
  readonly headers: Headers

  constructor(body: string, init: FakeInit = {}) {
    this.body = body
    this.status = init.status ?? 200
    this.ok = this.status >= 200 && this.status < 300
    this.headers = new Headers(init.headers ?? {})
  }

  clone() {
    return new FakeResponse(this.body, {
      status: this.status,
      headers: Object.fromEntries(this.headers.entries()),
    })
  }

  async json() {
    return JSON.parse(this.body)
  }

  async text() {
    return this.body
  }
}

const toHref = (input: unknown) => {
  const raw = typeof input === 'string' ? input : (input as { url: string }).url
  return new URL(raw, ORIGIN).href
}

const toPath = (input: unknown) => new URL(toHref(input)).pathname

class FakeCache {
  readonly entries = new Map<string, FakeResponse>()

  async match(input: unknown, options?: { ignoreSearch?: boolean }) {
    const href = toHref(input)
    const direct = this.entries.get(href)
    if (direct) return direct
    if (options?.ignoreSearch) {
      const base = href.split('?')[0]
      for (const [key, value] of this.entries) {
        if (key.split('?')[0] === base) return value
      }
    }
    return undefined
  }

  async put(input: unknown, response: FakeResponse) {
    this.entries.set(toHref(input), response.clone())
  }

  async delete(input: unknown) {
    return this.entries.delete(toHref(input))
  }

  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }))
  }
}

class FakeCacheStorage {
  readonly maps = new Map<string, FakeCache>()

  async keys() {
    return [...this.maps.keys()]
  }

  async open(name: string) {
    const existing = this.maps.get(name)
    if (existing) return existing
    const created = new FakeCache()
    this.maps.set(name, created)
    return created
  }

  async delete(name: string) {
    return this.maps.delete(name)
  }

  async match(input: unknown, options?: { ignoreSearch?: boolean }) {
    for (const cache of this.maps.values()) {
      const hit = await cache.match(input, options)
      if (hit) return hit
    }
    return undefined
  }
}

function chunk(fileName: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'chunk',
    fileName,
    code: `// ${fileName}`,
    isEntry: false,
    imports: [],
    facadeModuleId: null,
    viteMetadata: { importedCss: new Set<string>() },
    ...extra,
  }
}

function asset(fileName: string, source: string) {
  return { type: 'asset', fileName, source }
}

function buildServiceWorker() {
  return {
    'index.html': asset('index.html',
      '<html><head></head><body><script type="module" src="/assets/app.js"></script></body></html>'),
    'assets/app.js': chunk('assets/app.js', {
      isEntry: true,
      imports: ['assets/react.js', 'assets/Workspace-2.js'],
      facadeModuleId: '/src/client/main.tsx',
    }),
    'assets/react.js': chunk('assets/react.js'),
    'assets/Workspace-2.js': chunk('assets/Workspace-2.js', {
      facadeModuleId: '/src/client/features/workspace/Workspace.tsx',
    }),
    'assets/excalidraw-6.js': chunk('assets/excalidraw-6.js'),
    'assets/notes-4.js': chunk('assets/notes-4.js'),
    'assets/pele-5.js': chunk('assets/pele-5.js'),
    'vendor/excalidraw/excalidraw.production.min.js':
      asset('vendor/excalidraw/excalidraw.production.min.js', 'engine'),
    'vendor/excalidraw/fonts/Xiaolai/Xiaolai-Regular-abc.woff2':
      asset('vendor/excalidraw/fonts/Xiaolai/Xiaolai-Regular-abc.woff2', 'font'),
    'vendor/excalidraw/locales/zh-CN-XYZ.js':
      asset('vendor/excalidraw/locales/zh-CN-XYZ.js', 'locale'),
  }
}

function generateServiceWorkerSource() {
  const emitted = new Map<string, string>()
  const context = {
    emitFile: (file: { fileName: string; source: string | Uint8Array }) => {
      emitted.set(file.fileName, String(file.source))
    },
  }
  const plugin = inkstonePwa() as unknown as {
    generateBundle: (options: unknown, bundle: unknown) => void
  }
  plugin.generateBundle.call(context, {}, buildServiceWorker())
  const source = emitted.get('sw.js')
  if (!source) throw new Error('the pwa plugin emitted no sw.js')
  return source
}

const APP_DOCUMENT = '<!doctype html><html><head></head><body><div id="root"></div></body></html>'

const documentResponse = () => new FakeResponse(APP_DOCUMENT, {
  headers: { 'content-type': 'text/html; charset=utf-8' },
})

function bootServiceWorker(options: {
  failing?: string[]
  previousShell?: boolean
  brokenCaches?: boolean
  documents?: string[]
  poisoned?: Array<{ cache: string, path: string }>
} = {}) {
  const listeners = new Map<string, Array<(event: never) => void>>()
  const statuses: Array<Record<string, unknown>> = []
  const fetched: string[] = []
  const caches = new FakeCacheStorage()
  const failing = new Set(options.failing ?? [])
  const documents = new Set(options.documents ?? [])
  if (options.previousShell) caches.maps.set('inkstone-shell-previous', new FakeCache())
  for (const entry of options.poisoned ?? []) {
    const cache = caches.maps.get(entry.cache) ?? new FakeCache()
    cache.entries.set(`${ORIGIN}${entry.path}`, documentResponse())
    caches.maps.set(entry.cache, cache)
  }
  if (options.brokenCaches) {
    caches.open = async () => { throw new Error('cache storage unavailable') }
  }

  const fetchImpl = async (input: unknown) => {
    const path = toPath(input)
    fetched.push(path)
    if (failing.has(path)) throw new TypeError('Failed to fetch')
    if (documents.has(path)) return documentResponse()
    // The document is the one path that is honestly HTML: it must still be cached, or this guard becomes
    // the reason offline boot fails.
    if (path.endsWith('.html')) return new FakeResponse(`body:${path}`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    return new FakeResponse(`body:${path}`)
  }

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: never) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler])
    },
    clients: {
      matchAll: async () => [{ postMessage: (message: Record<string, unknown>) => statuses.push(message) }],
    },
    skipWaiting: () => {},
  }

  new Function('self', 'caches', 'fetch', 'Response', generateServiceWorkerSource())(
    self, caches, fetchImpl, FakeResponse,
  )

  const dispatch = async (type: string, buildEvent: () => Record<string, unknown>) => {
    const settled: Array<Promise<unknown>> = []
    const event = { ...buildEvent(), waitUntil: (promise: Promise<unknown>) => settled.push(promise) }
    for (const handler of listeners.get(type) ?? []) {
      (handler as (e: unknown) => void)(event)
    }
    return Promise.all(settled)
  }

  const install = () => dispatch('install', () => ({}))
  const message = (data: Record<string, unknown>) => dispatch('message', () => ({ data }))
  const requestPath = async (path: string) => {
    let respondWith: Promise<unknown> | null = null
    await dispatch('fetch', () => ({
      request: { method: 'GET', url: ORIGIN + path, mode: 'cors' },
      respondWith: (promise: Promise<unknown>) => { respondWith = promise },
    }))
    if (!respondWith) throw new Error(`the worker answered nothing for ${path}`)
    return respondWith
  }

  const namedCache = async (prefix: string) => {
    const pattern = new RegExp(`^${prefix}-[0-9a-f]{16}$`)
    const name = (await caches.keys()).find((key) => pattern.test(key))
    return name ? (caches.maps.get(name)?.entries ?? new Map<string, FakeResponse>())
      : new Map<string, FakeResponse>()
  }
  const assetCache = () => namedCache('inkstone-assets')
  const shellCache = () => namedCache('inkstone-shell')
  const setFailing = (paths: string[]) => {
    failing.clear()
    for (const path of paths) failing.add(path)
  }
  const setDocuments = (paths: string[]) => {
    documents.clear()
    for (const path of paths) documents.add(path)
  }

  return { install, message, requestPath, assetCache, shellCache, fetched, statuses, setFailing, setDocuments }
}

const manifestPath = async (worker: ReturnType<typeof bootServiceWorker>) => {
  const entries = await worker.assetCache()
  return [...entries.keys()].filter((key) => key.includes('/.inkstone-offline-manifest/'))
}

it('keeps the drawing engine out of the background download but warms ordinary chunks', async () => {
  const worker = bootServiceWorker({ previousShell: true })
  await expect(worker.install()).resolves.toHaveLength(1)

  expect(worker.fetched).toContain('/assets/notes-4.js')
  expect(worker.fetched).toContain('/assets/excalidraw-6.js')
  expect(worker.fetched).toContain('/inkstone-markdown-demo.svg')
  expect(worker.fetched).not.toContain('/assets/pele-5.js')
  expect(worker.fetched.filter((path) => path.startsWith('/vendor/excalidraw/'))).toEqual([])

  expect((await worker.shellCache()).size).toBe(12)
  const warmed = [...(await worker.assetCache()).keys()]
    .filter((key) => !key.includes('/.inkstone-offline-manifest/'))
    .sort()
  expect(warmed).toEqual([
    `${ORIGIN}/assets/excalidraw-6.js`,
    `${ORIGIN}/assets/notes-4.js`,
    `${ORIGIN}/inkstone-markdown-demo.svg`,
  ])

  const last = worker.statuses.at(-1)
  expect(last?.status).toBe('ready')
  expect(last?.total).toBe(14)
  expect(last?.completed).toBe(14)
  expect(await manifestPath(worker)).toHaveLength(1)
})

it('caches a dropped drawing engine file on first use instead of at install', async () => {
  const worker = bootServiceWorker()
  await worker.install()
  const engine = '/vendor/excalidraw/excalidraw.production.min.js'
  expect((await worker.assetCache()).has(ORIGIN + engine)).toBe(false)

  await expect(worker.requestPath(engine)).resolves.toBeInstanceOf(FakeResponse)
  expect(worker.fetched).toContain(engine)
  expect((await worker.assetCache()).has(ORIGIN + engine)).toBe(true)
})

it('finishes the download around a failed file and never rejects the install', async () => {
  const worker = bootServiceWorker({ previousShell: true, failing: ['/assets/excalidraw-6.js'] })
  await expect(worker.install()).resolves.toHaveLength(1)

  const entries = await worker.assetCache()
  expect(entries.has(ORIGIN + '/assets/excalidraw-6.js')).toBe(false)
  expect(entries.has(ORIGIN + '/assets/notes-4.js')).toBe(true)
  expect(entries.has(ORIGIN + '/inkstone-markdown-demo.svg')).toBe(true)
  expect(await manifestPath(worker)).toEqual([])
  expect(worker.statuses.at(-1)?.status).toBe('error')
})

it('retries only the missing files on the next pass without rejecting', async () => {
  const worker = bootServiceWorker({ previousShell: true, failing: ['/assets/notes-4.js'] })
  await expect(worker.install()).resolves.toHaveLength(1)
  expect(worker.statuses.at(-1)?.status).toBe('error')

  const before = worker.fetched.length
  worker.setFailing([])
  await expect(worker.message({ type: 'WARM_OFFLINE_CACHE' })).resolves.toHaveLength(1)
  const retried = worker.fetched.slice(before)
  expect(retried).toContain('/assets/notes-4.js')
  expect(retried).not.toContain('/assets/excalidraw-6.js')
  expect(worker.statuses.at(-1)?.status).toBe('ready')
  expect(await manifestPath(worker)).toHaveLength(1)
})

it('reports an error state when the cache layer fails, without rejecting', async () => {
  const worker = bootServiceWorker({ brokenCaches: true })
  await expect(worker.message({ type: 'WARM_OFFLINE_CACHE' })).resolves.toHaveLength(1)
  expect(worker.statuses.at(-1)?.status).toBe('error')
  expect(worker.statuses.at(-1)?.type).toBe('OFFLINE_CACHE_STATUS')
})

it('caches the shell before anything else so a first visit can boot offline', async () => {
  const worker = bootServiceWorker()
  await worker.install()
  const shell = await worker.shellCache()
  expect(shell.has(ORIGIN + '/index.html')).toBe(true)
  expect(shell.has(ORIGIN + '/assets/app.js')).toBe(true)
  expect(shell.has(ORIGIN + '/assets/Workspace-2.js')).toBe(true)
  expect(shell.has(ORIGIN + '/.inkstone-cache-meta')).toBe(true)
  expect(worker.fetched.filter((path) => path.startsWith('/vendor/excalidraw/'))).toEqual([])
})

// A connection the edge dropped says nothing about the build, but an install that rejects on it leaves
// the previous worker in control forever — its cached shell and its cached boot.js included, which is the
// start-up guard a deploy exists to replace. Measured on the live deployment: one install killed this way
// left every build after it stuck in `installing`, never activating.
it('activates with a short shell when the edge drops a core file, and fills it in later', async () => {
  const worker = bootServiceWorker({ failing: ['/assets/app.js'] })
  await expect(worker.install()).resolves.toHaveLength(1)

  const short = await worker.shellCache()
  expect(short.has(ORIGIN + '/assets/app.js')).toBe(false)
  expect(short.has(ORIGIN + '/index.html')).toBe(true)
  expect(short.has(ORIGIN + '/boot.js')).toBe(true)

  worker.setFailing([])
  await expect(worker.message({ type: 'WARM_OFFLINE_CACHE' })).resolves.toHaveLength(1)
  expect((await worker.shellCache()).get(ORIGIN + '/assets/app.js')?.body).toBe('body:/assets/app.js')
})

// The guard must not be delivered by the thing it recovers from, so it is the one cached file this
// worker asks the network for — and the cache is still what an offline start reads.
it('serves the start-up guard from the network, and from the cache only when there is no network', async () => {
  const worker = bootServiceWorker()
  await worker.install()
  const shell = await worker.shellCache()
  shell.set(ORIGIN + '/boot.js', new FakeResponse('the previous build guard'))

  const online = await worker.requestPath('/boot.js')
  expect((online as FakeResponse).body).toBe('body:/boot.js')

  worker.setFailing(['/boot.js'])
  const offline = await worker.requestPath('/boot.js')
  expect((offline as FakeResponse).body).toBe('the previous build guard')
})

// The edge answers a missing file with HTTP 200 and the app document, so a chunk that is simply not there
// looks like a successful fetch. Storing that document under the chunk's name is the worst thing this worker
// can do: the reader gets HTML where a `<script type=module>` belongs, the browser refuses it, and every
// reload repeats — the screen stays empty and nothing in the console explains it.
it('rejects the install when a shell chunk comes back as the app document', async () => {
  const worker = bootServiceWorker({ documents: ['/assets/app.js'] })
  await expect(worker.install()).rejects.toThrow(/Refused to cache \/assets\/app\.js/)
  expect((await worker.shellCache()).has(ORIGIN + '/assets/app.js')).toBe(false)
})

it('counts a background chunk served as the document as a failure and retries it clean', async () => {
  const worker = bootServiceWorker({ previousShell: true, documents: ['/assets/notes-4.js'] })
  await expect(worker.install()).resolves.toHaveLength(1)
  const entries = await worker.assetCache()
  expect(entries.has(ORIGIN + '/assets/notes-4.js')).toBe(false)
  expect(worker.statuses.at(-1)?.status).toBe('error')
  expect(await manifestPath(worker)).toEqual([])

  worker.setDocuments([])
  await expect(worker.message({ type: 'WARM_OFFLINE_CACHE' })).resolves.toHaveLength(1)
  expect(worker.statuses.at(-1)?.status).toBe('ready')
  expect((await worker.assetCache()).get(ORIGIN + '/assets/notes-4.js')?.body).toBe('body:/assets/notes-4.js')
  expect(await manifestPath(worker)).toHaveLength(1)
})

it('will not copy a document an earlier build left under a chunk name into the new shell', async () => {
  // Install runs before activate deletes the previous build's caches, and reuse looks across all of them —
  // without this check the poison outlives the very deploy that was meant to clear it.
  const worker = bootServiceWorker({ poisoned: [{ cache: 'inkstone-assets-previous', path: '/assets/app.js' }] })
  await worker.install()
  expect((await worker.shellCache()).get(ORIGIN + '/assets/app.js')?.body).toBe('body:/assets/app.js')
  expect(worker.fetched).toContain('/assets/app.js')
})

it('serves the real file instead of a cached document, and caches the real file', async () => {
  const engine = '/vendor/excalidraw/excalidraw.production.min.js'
  const worker = bootServiceWorker({ poisoned: [{ cache: 'inkstone-assets-previous', path: engine }] })
  const response = await worker.requestPath(engine)
  expect(response).toBeInstanceOf(FakeResponse)
  expect((response as FakeResponse).body).toBe(`body:${engine}`)
  expect((await worker.assetCache()).get(ORIGIN + engine)?.body).toBe(`body:${engine}`)
})
