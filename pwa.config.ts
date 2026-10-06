import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const rootFile = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const CORE_PUBLIC_ASSETS = [
  'apple-touch-icon.png',
  'boot.js',
  'inkstone-logo.svg',
  'manifest.webmanifest',
  'pwa-192x192.png',
  'pwa-512x512.png',
  'pwa-maskable-512x512.png',
] as const

const OPTIONAL_PUBLIC_ASSETS = [
  'inkstone-markdown-demo.svg',
] as const

const PUBLIC_ASSETS = [...CORE_PUBLIC_ASSETS, ...OPTIONAL_PUBLIC_ASSETS] as const

const CORE_LAZY_MODULES = [
  '/src/client/App.tsx',
  '/src/client/features/shell/AppShell.tsx',
  '/src/client/features/workspace/Workspace.tsx',
  '/src/shared/locales/en-US.ts',
  '/src/shared/locales/zh-CN.ts',
] as const

type BuildChunk = {
  type: 'chunk'
  fileName: string
  code: string
  isEntry: boolean
  imports: string[]
  facadeModuleId: string | null
  viteMetadata?: {
    importedCss?: Set<string>
  }
}

type BuildAsset = {
  type: 'asset'
  fileName: string
  source: string | Uint8Array
}

type BuildBundle = Record<string, BuildChunk | BuildAsset>

export function inkstonePwa(): Plugin {
  return {
    name: 'inkstone:pwa',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle(_options, bundle) {
      const bundleFiles = Object.values(bundle)
        .map((entry) => entry.fileName)
        .filter((fileName) => !fileName.endsWith('.map'))
      const allFiles = [...new Set([
        'index.html',
        ...bundleFiles,
        ...PUBLIC_ASSETS,
      ])].sort()
      const coreFiles = collectCoreFiles(bundle as BuildBundle)

      const hash = createHash('sha256')
      for (const entry of Object.values(bundle).sort((left, right) =>
        left.fileName.localeCompare(right.fileName))) {
        hash.update(entry.fileName)
        hash.update(entry.type === 'chunk' ? entry.code : entry.source)
      }
      for (const fileName of PUBLIC_ASSETS) {
        hash.update(fileName)
        hash.update(readFileSync(rootFile(`./public/${fileName}`)))
      }
      const buildId = hash.digest('hex').slice(0, 16)

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorkerSource(
          buildId,
          coreFiles.map((fileName) => `/${fileName}`),
          allFiles.map((fileName) => `/${fileName}`),
        ),
      })
    },
  }
}

function collectCoreFiles(bundle: BuildBundle): string[] {
  const files = new Set<string>(['index.html', ...CORE_PUBLIC_ASSETS])
  const pending = Object.values(bundle)
    .filter((entry): entry is BuildChunk =>
      entry.type === 'chunk' && (entry.isEntry || isCoreLazyChunk(entry)))

  while (pending.length) {
    const chunk = pending.pop()!
    if (files.has(chunk.fileName)) continue
    files.add(chunk.fileName)
    for (const style of chunk.viteMetadata?.importedCss ?? []) files.add(style)
    for (const imported of chunk.imports) {
      const dependency = bundle[imported]
      if (dependency?.type === 'chunk') pending.push(dependency)
    }
  }

  const index = bundle['index.html']
  if (index?.type === 'asset') {
    const html = typeof index.source === 'string'
      ? index.source
      : new TextDecoder().decode(index.source)
    for (const match of html.matchAll(/(?:src|href)=["']\/?([^"'#?]+)["']/g)) {
      const fileName = match[1]
      if (fileName && (bundle[fileName] || CORE_PUBLIC_ASSETS.includes(fileName as never))) {
        files.add(fileName)
      }
    }
  }

  return [...files].sort()
}

function isCoreLazyChunk(chunk: BuildChunk): boolean {
  const moduleId = chunk.facadeModuleId?.replaceAll('\\', '/')
  return Boolean(moduleId && CORE_LAZY_MODULES.some((suffix) => moduleId.endsWith(suffix)))
}

/**
 * The generated service worker splits the bundle three ways: the shell it must have to boot
 * (`CORE_URLS`), everything it may serve offline (`ALL_OFFLINE_URLS`), and the subset of the latter it
 * downloads ahead of time (`WARMUP_URLS`). `ON_DEMAND_PATTERN` is what keeps the third set small — the
 * diagram engines (mermaid's per-shape chunks, cytoscape behind the graph, the CodeMirror language
 * bundles) are named there because they are hundreds of kilobytes each and most accounts never open one,
 * so warming them would spend everyone's bandwidth for a few people's benefit. The cost of being on that
 * list is that the first offline visit to a note using one of them shows its source instead of the
 * picture, until it has been opened online once.
 *
 * `auto-` is chart.js's chunk, named after the `chart.js/auto` entry the dynamic import asks for; it is
 * the only built asset whose name begins that way.
 */
function serviceWorkerSource(buildId: string, coreUrls: string[], allUrls: string[]): string {
	return `const BUILD_ID = ${JSON.stringify(buildId)}
	const SHELL_CACHE = ${JSON.stringify(`inkstone-shell-${buildId}`)}
	const ASSET_CACHE = ${JSON.stringify(`inkstone-assets-${buildId}`)}
	const CORE_URLS = ${JSON.stringify(coreUrls)}
	const ALL_OFFLINE_URLS = ${JSON.stringify(allUrls)}
	const OPTIONAL_URLS = ALL_OFFLINE_URLS.filter((url) => !CORE_URLS.includes(url))
	const OPTIONAL_URL_SET = new Set(OPTIONAL_URLS)
	const ON_DEMAND_PATTERN = /(?:mermaid|diagram|cytoscape|langium|vscode-|chunk-KEIR6QF5|auto-)/i
	const WARMUP_URLS = OPTIONAL_URLS.filter((url) => !ON_DEMAND_PATTERN.test(url))
	const WARMUP_TOTAL = CORE_URLS.length + WARMUP_URLS.length
	const CACHE_META_URL = '/.inkstone-cache-meta'
	const MANIFEST_META_PREFIX = '/.inkstone-offline-manifest/'
	const CURRENT_MANIFEST_URL = MANIFEST_META_PREFIX + BUILD_ID
	const NETWORK_ONLY_EXACT_PATHS = ['/authorize', '/mcp']
	const NETWORK_ONLY_PATH_PREFIXES = ['/api/', '/authorize/', '/mcp/', '/oauth/', '/.well-known/']
	let warmPromise = null

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const previousShells = (await caches.keys()).filter((key) =>
      key.startsWith('inkstone-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
    await cacheCoreResources()
    if (previousShells.length) await warmOfflineCache(false)
  })())
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
    return
  }
  if (event.data?.type === 'GET_OFFLINE_CACHE_STATUS') {
    event.waitUntil(reportOfflineStatus(event.source))
    return
  }
  if (event.data?.type === 'WARM_OFFLINE_CACHE') {
    event.waitUntil(warmOfflineCache(false))
  }
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys
      .filter((key) => key.startsWith('inkstone-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
      .map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
	  if (
	    url.origin !== self.location.origin ||
	    NETWORK_ONLY_EXACT_PATHS.includes(url.pathname) ||
	    NETWORK_ONLY_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
	  ) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const shell = await caches.open(SHELL_CACHE)
        const cached = await shell.match('/index.html')
        return cached || Response.error()
      }),
    )
    return
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true })
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok && OPTIONAL_URL_SET.has(url.pathname)) {
      const assets = await caches.open(ASSET_CACHE)
      await assets.put(url.pathname, response.clone())
    }
    return response
  })())
})

async function cacheCoreResources() {
  const shell = await caches.open(SHELL_CACHE)
  await forEachConcurrent(CORE_URLS, 4, async (url) => {
    if (await shell.match(url)) return
    let response = null
    if (isImmutableAsset(url)) response = await caches.match(url, { ignoreSearch: true })
    if (!response) response = await fetchRequired(url)
    await shell.put(url, response.clone())
  })
  await shell.put(CACHE_META_URL, new Response(String(Date.now())))
}

function warmOfflineCache(notifyWhenComplete) {
  if (!warmPromise) {
    warmPromise = runOfflineWarmup(notifyWhenComplete).finally(() => {
      warmPromise = null
    })
  }
  return warmPromise
}

async function runOfflineWarmup(notifyWhenComplete) {
  const assets = await caches.open(ASSET_CACHE)
  if (await assets.match(CURRENT_MANIFEST_URL)) {
    await broadcastStatus('ready', WARMUP_TOTAL, WARMUP_TOTAL, false)
    return
  }
  let completed = await countAvailable()
  let processed = 0
  await broadcastStatus('preparing', completed, WARMUP_TOTAL, false)

  try {
    // Fill the complete offline cache quietly after the app is ready. A single
    // request at a time plus a short yield keeps foreground traffic responsive.
    await forEachConcurrent(WARMUP_URLS, 1, async (url) => {
      if (isImmutableAsset(url) && await assets.match(url)) return
      const reused = isImmutableAsset(url)
        ? await caches.match(url, { ignoreSearch: true })
        : null
      const response = reused || await fetchRequired(url)
      await assets.put(url, response.clone())
      if (!reused) completed++
      processed++
      if (processed % 8 === 0) {
        await broadcastStatus('preparing', completed, WARMUP_TOTAL, false)
      }
      await pauseBackgroundWarmup()
    })
    await writeCurrentManifest(assets)
    await pruneAssetCache(assets)
    await broadcastStatus('ready', WARMUP_TOTAL, WARMUP_TOTAL, notifyWhenComplete)
  } catch (error) {
    await broadcastStatus('error', await countAvailable(), WARMUP_TOTAL, false)
    throw error
  }
}

async function reportOfflineStatus(target) {
  const assets = await caches.open(ASSET_CACHE)
  const complete = Boolean(await assets.match(CURRENT_MANIFEST_URL))
  const completed = complete ? WARMUP_TOTAL : await countAvailable()
  const message = statusMessage(complete ? 'ready' : 'preparing', completed, WARMUP_TOTAL, false)
  if (target && 'postMessage' in target) target.postMessage(message)
  else await broadcast(message)
}

async function countAvailable() {
  let count = 0
  const checkUrls = [...CORE_URLS, ...WARMUP_URLS]
  await forEachConcurrent(checkUrls, 8, async (url) => {
    if (await caches.match(url, { ignoreSearch: true })) count++
  })
  return count
}

async function writeCurrentManifest(cache) {
  await cache.put(CURRENT_MANIFEST_URL, new Response(JSON.stringify({
    buildId: BUILD_ID,
    createdAt: Date.now(),
    urls: OPTIONAL_URLS,
  }), { headers: { 'Content-Type': 'application/json' } }))
}

async function pruneAssetCache(cache) {
  const keys = await cache.keys()
  const manifests = []
  for (const request of keys) {
    const path = new URL(request.url).pathname
    if (!path.startsWith(MANIFEST_META_PREFIX)) continue
    try {
      const value = await (await cache.match(request)).json()
      if (Array.isArray(value.urls)) manifests.push(value)
    } catch {
    }
  }
  manifests.sort((left, right) => Number(right.createdAt) - Number(left.createdAt))
  const retained = manifests.slice(0, 2)
  const retainedUrls = new Set(retained.flatMap((manifest) => manifest.urls))
  const retainedBuilds = new Set(retained.map((manifest) => manifest.buildId))

  await Promise.all(keys.map(async (request) => {
    const path = new URL(request.url).pathname
    if (path.startsWith(MANIFEST_META_PREFIX)) {
      const id = path.slice(MANIFEST_META_PREFIX.length)
      if (!retainedBuilds.has(id)) await cache.delete(request)
      return
    }
    if (!retainedUrls.has(path)) await cache.delete(request)
  }))
}

async function fetchRequired(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Failed to cache ' + url + ': HTTP ' + response.status)
  return response
}

function pauseBackgroundWarmup() {
  return new Promise((resolve) => setTimeout(resolve, 75))
}

function isImmutableAsset(url) {
  return url.startsWith('/assets/')
}

async function forEachConcurrent(values, concurrency, work) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      await work(values[index])
    }
  })
  await Promise.all(workers)
}

function statusMessage(status, completed, total, notify) {
  return { type: 'OFFLINE_CACHE_STATUS', buildId: BUILD_ID, status, completed, total, notify }
}

async function broadcastStatus(status, completed, total, notify) {
  await broadcast(statusMessage(status, completed, total, notify))
}

async function broadcast(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of clients) client.postMessage(message)
}
`
}
