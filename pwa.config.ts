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
  // The tab host is what the authed page renders, so the chunk it lands in is part of the shell even
  // though the notebook itself hangs off it. Dropping it here leaves an offline boot with a rail and
  // no container: measured on this branch's build, AppShell's code moved into `AppTabHost-*.js` and
  // that chunk fell out of CORE_URLS until both names were listed.
  '/src/client/features/shell/AppTabHost.tsx',
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

/** A chunk this large is a feature of its own, not a piece of the everyday shell. */
const HEAVY_CHUNK_BYTES = 300_000

/** What may be said about a push, when nothing about the note itself may be said. */
const PUSH_CHINESE_LOCALE = 'zh-CN'
const PUSH_ENGLISH_LOCALE = 'en-US'

/**
 * The one sentence a push notice is allowed to wear, in each of the two languages the app ships.
 *
 * It is fixed text chosen here rather than anything read off the payload: `sendPush`
 * (`src/worker/assistant/push.ts`) declares `aes128gcm` without the RFC 8291 encryption that name promises,
 * so a payload that carried note text would deliver it in plain text to a device through a push service the
 * deployment does not run. The shell is therefore empty on purpose, and the notice is a pointer to the app —
 * where the transport is the reader's own authenticated one — rather than a summary of what is waiting.
 *
 * The table is inlined into the worker by value and `pickPushNotificationCopy` is the same decision a test
 * can call directly, so `tests/service-worker-push.test.ts` can pin the shipped source to this file: a
 * worker that showed something else would be a drift no source read would catch.
 */
const PUSH_NOTIFICATION_COPY: Record<string, { title: string, body: string }> = {
  [PUSH_CHINESE_LOCALE]: { title: 'Inkstone 有待读的更新', body: '打开 Inkstone 看看有什么在等。' },
  [PUSH_ENGLISH_LOCALE]: { title: 'Inkstone has something to read', body: 'Open Inkstone to see what is waiting.' },
}

export type PushNotificationCopy = { title: string, body: string }

/**
 * Which sentence a device gets.
 *
 * A worker woken by a push has no page to ask what language the reader picked, so this follows the same
 * rule the app itself falls back to when nothing was saved: `detectInitialLocale`
 * (`src/client/lib/i18n.ts`) answers a `navigator.language` starting with `zh` with Chinese. A reader who
 * overrode the language inside the app is the case this cannot see, which is why the notice says nothing
 * that would be wrong to read in either language.
 */
export function pickPushNotificationCopy(language: string | null | undefined): PushNotificationCopy {
  return normalisePushLanguage(language) === PUSH_CHINESE_LOCALE
    ? PUSH_NOTIFICATION_COPY[PUSH_CHINESE_LOCALE]!
    : PUSH_NOTIFICATION_COPY[PUSH_ENGLISH_LOCALE]!
}

/** The same choice, spelled so the generated worker and this file cannot answer differently. */
function normalisePushLanguage(language: string | null | undefined): string {
  const tag = String(language ?? '').toLowerCase()
  return tag.startsWith('zh') ? PUSH_CHINESE_LOCALE : PUSH_ENGLISH_LOCALE
}

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

      // Shared chunks big enough that most accounts never open one. The threshold is bytes of generated
      // code, which is what the download actually costs; the exclusion list is built from the bundle
      // rather than written by hand, so a chunk that changes hash stays excluded.
      const built = bundle as BuildBundle
      const heavy = Object.values(built)
        .filter((entry): entry is BuildChunk => entry.type === 'chunk')
        .filter((chunk) => !coreFiles.includes(chunk.fileName) && chunk.code.length >= HEAVY_CHUNK_BYTES)
        // A catalog is not a feature: the first screen needs one, so however large it is it stays in the
        // warm-up. Its name comes from the source file rather than from a content hash, which is why it
        // can be recognised here at all.
        .filter((chunk) => !/\/(?:en|zh)-[A-Z]{2}-[\w-]+\.js$/.test(chunk.fileName))
        .map((chunk) => chunk.fileName)

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorkerSource(
          buildId,
          coreFiles.map((fileName) => `/${fileName}`),
          allFiles.map((fileName) => `/${fileName}`),
          onDemandSource(heavy),
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
 * the only built asset whose name begins that way. `mind-elixir` is the mind map engine, reached the
 * same way through `lib/markdown/mindmap/mind-elixir-vendor.ts` — the module is named for the library so
 * this pattern can see it, because a chunk named for the importer (`vendor.ts`) reads as an ordinary
 * vendor bundle and would otherwise join the background download for every visitor.
 *
 * `vendor/excalidraw` is the drawing engine's own file tree, which the bundler cannot see: `vite.config.ts`
 * copies the whole `@zsviczian/excalidraw/prod` directory in as emitted assets, so rollup's dynamic-import
 * closure never claims it and every one of those files would fall into the background download. Measured on
 * a real build: 306 files / 24.08 MiB raw, of which 234 are the Xiaolai Chinese font subsets the project
 * decided not to ship — 87% of the whole warm-up set by bytes, for the few accounts that draw at all. They
 * stay reachable offline the same way as every other on-demand file: the fetch handler caches any
 * `OPTIONAL_URLS` path it serves, so an opened drawing keeps its engine and fonts for the next flight.
 *
 * The fixed names above are the ones that do not move. Everything else is generated per build from the
 * bundle: a shared chunk large enough to be one of the app's heavy features is excluded by the name it was
 * actually emitted under, because that name carries a content hash — a name written here by hand stops
 * matching the moment the chunk changes, which is exactly how the one hand-written chunk name this list
 * used to carry silently fell out of the exclusion.
 */
function onDemandSource(extraNames: readonly string[]): string {
  const fixed = ['mermaid', 'diagram', 'cytoscape', 'langium', 'vscode-', 'auto-', 'mind-elixir', 'vendor/excalidraw', '/rss/', '/memos/', 'MemosApp']
  const escaped = extraNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return [...fixed, ...escaped].join('|')
}

function serviceWorkerSource(buildId: string, coreUrls: string[], allUrls: string[], onDemand: string): string {
	return `const BUILD_ID = ${JSON.stringify(buildId)}
	const SHELL_CACHE = ${JSON.stringify(`inkstone-shell-${buildId}`)}
	const ASSET_CACHE = ${JSON.stringify(`inkstone-assets-${buildId}`)}
	const CORE_URLS = ${JSON.stringify(coreUrls)}
	const ALL_OFFLINE_URLS = ${JSON.stringify(allUrls)}
	const OPTIONAL_URLS = ALL_OFFLINE_URLS.filter((url) => !CORE_URLS.includes(url))
	const OPTIONAL_URL_SET = new Set(OPTIONAL_URLS)
	const ON_DEMAND_PATTERN = new RegExp(${JSON.stringify(onDemand)}, 'i')
	const WARMUP_URLS = OPTIONAL_URLS.filter((url) => !ON_DEMAND_PATTERN.test(url))
	const WARMUP_TOTAL = CORE_URLS.length + WARMUP_URLS.length
	const CACHE_META_URL = '/.inkstone-cache-meta'
	const MANIFEST_META_PREFIX = '/.inkstone-offline-manifest/'
	const CURRENT_MANIFEST_URL = MANIFEST_META_PREFIX + BUILD_ID
	const NETWORK_ONLY_EXACT_PATHS = ['/authorize', '/mcp']
	const NETWORK_ONLY_PATH_PREFIXES = ['/api/', '/authorize/', '/mcp/', '/oauth/', '/.well-known/']
	// One tag for every Inkstone push, which is what keeps five schedules from leaving five notices in the
	// tray: a later push replaces the earlier one instead of stacking beside it.
	const PUSH_TAG = 'inkstone-updates'
	const PUSH_COPY = ${JSON.stringify(PUSH_NOTIFICATION_COPY)}
	// The payload is never read, on purpose. See PUSH_NOTIFICATION_COPY above: the shell is empty because
	// nothing may be sent unencrypted, so the notice carries no words that could belong to a note.
	const NOTIFICATION_CENTER_URL = '/chat?notifications=1'
	let warmPromise = null

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const previousShells = (await caches.keys()).filter((key) =>
      key.startsWith('inkstone-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
    // The shell is the whole promise of the offline mode: without these files the cached page is an
    // empty document. It is cached before anything else, and a file the build does not actually have
    // rejects the install, which is what makes the installed state the page's own listener waits for
    // mean "this build opens offline". A connection the edge dropped is not that: see
    // cacheCoreResources, where the difference decides whether this worker ever activates.
    await cacheCoreResources()
    if (previousShells.length) await warmOfflineCache()
  })())
})

self.addEventListener('message', (event) => {
  // Nothing here activates a waiting worker on its own. The page keeps serving the build it booted with
  // until a reader presses the update card, which is the only moment the app knows the reload is wanted;
  // skipWaiting on install would swap the files under a note that is half written.
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
    return
  }
  if (event.data?.type === 'GET_OFFLINE_CACHE_STATUS') {
    event.waitUntil(reportOfflineStatus(event.source))
    return
  }
  if (event.data?.type === 'WARM_OFFLINE_CACHE') {
    event.waitUntil(warmOfflineCache())
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

self.addEventListener('push', (event) => {
  event.waitUntil(showIncomingUpdate())
})

self.addEventListener('notificationclick', (event) => {
  event.waitUntil(revealNotificationCenter(event.notification))
})

function pushCopyForLanguage(language) {
  const tag = String(language || '').toLowerCase()
  return tag.startsWith('zh') ? PUSH_COPY['zh-CN'] : PUSH_COPY['en-US']
}

/**
 * Puts the one thing this worker is allowed to say on the screen.
 *
 * event.data is left alone by design, and the reader ends up in the app to find out what arrived: the
 * payload is an empty shell because the sender declares a cipher it does not implement, so a notice that
 * quoted it would be quoting whatever a push service carried in plain text.
 */
async function showIncomingUpdate() {
  const copy = pushCopyForLanguage(self.navigator && self.navigator.language)
  await self.registration.showNotification(copy.title, {
    body: copy.body,
    tag: PUSH_TAG,
    icon: '/pwa-192x192.png',
    data: { intent: 'notification-center' },
  })
}

/**
 * Takes the reader to the notification centre and leaves no copy of the notice behind.
 *
 * An open page is focused and told, rather than navigated: reloading a page over a push would cost a note
 * that is half written. With nothing open, the new window carries the intent in its address, because there
 * is no page yet to receive a message. The sweep by tag closes what is still up — including a notice an
 * older build left under a different tag scheme, which the browser would otherwise keep showing.
 */
async function revealNotificationCenter(notification) {
  const shown = await self.registration.getNotifications({ tag: PUSH_TAG })
  for (const notice of shown) notice.close()
  if (notification && typeof notification.close === 'function') notification.close()
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const client = windows.find((entry) => {
    try {
      return new URL(entry.url, self.location.origin).origin === self.location.origin
    } catch {
      return false
    }
  })
  if (client) {
    await client.focus()
    client.postMessage({ type: 'OPEN_NOTIFICATION_CENTER' })
    return
  }
  await self.clients.openWindow(NOTIFICATION_CENTER_URL)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
	  if (
	    url.origin !== self.location.origin ||
	    NETWORK_ONLY_EXACT_PATHS.includes(url.pathname) ||
	    NETWORK_ONLY_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
	  ) return

  // The document itself is network-first and every file behind it is cache-first, and that split is the
  // whole cache policy: a reader with a connection must never be served yesterday's page (the document is
  // what says which build this is), while the files it names are content-hashed and can only ever be the
  // ones this build shipped. The few un-hashed paths — the shell assets, the icons, the feed fixtures —
  // live in a cache named after the build that wrote them, and the activate step deletes every older one, so
  // cache-first cannot outlive a deploy by more than one reload.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const shell = await caches.open(SHELL_CACHE)
        const cached = await shell.match('/index.html')
        // No cached shell is a real answer with nothing to give, not a page to dress up: the browser
        // shows its own offline notice, which is true, instead of a blank document from a cache that
        // was never filled.
        return cached || Response.error()
      }),
    )
    return
  }

  // The guard that answers a broken start-up must not be delivered by the thing it exists to recover
  // from. A client whose install keeps failing serves the previous build's boot.js out of the previous
  // build's cache, so the fix that would let it update never reaches it — which is how one dropped
  // connection turned into a page that could never leave an old build. This one path gets the
  // document's own policy, and falls back to the cache so an offline start still has its guard.
  if (url.pathname === '/boot.js') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(request)) || Response.error()),
    )
    return
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true })
    if (cached && !isDocumentFallback(url, cached)) return cached
    const response = await fetch(request)
    if (response.ok && OPTIONAL_URL_SET.has(url.pathname) && !isDocumentFallback(url, response)) {
      const assets = await caches.open(ASSET_CACHE)
      await assets.put(url.pathname, response.clone())
    }
    return response
  })())
})

async function cacheCoreResources() {
  const shell = await caches.open(SHELL_CACHE)
  const dropped = []
  await forEachConcurrent(CORE_URLS, 4, async (url) => {
    if (await shell.match(url)) return
    let response = null
    if (isImmutableAsset(url)) response = await caches.match(url, { ignoreSearch: true })
    // Reuse reaches across every cache, and install runs before activate deletes the previous build's —
    // so a document someone left under this file's name would be copied forward into the new shell and
    // survive the deploy that was supposed to clear it. Checked exactly like a fresh fetch.
    if (response && isDocumentFallback(url, response)) response = null
    if (!response) {
      try {
        response = await fetchRequired(url)
      } catch (error) {
        // Two failures that only look alike. A file the edge answers with the app document is a file this
        // build does not have, and the previous worker is the safe thing to keep, so that one still
        // rejects the install. A dropped connection says nothing about the build — the warm-up below
        // already skips and retries those — and rejecting for it leaves the client pinned to the previous
        // worker forever, whose cached boot.js is the start-up guard a deploy exists to replace.
        if (error && error.refused) throw error
        dropped.push(url)
        return
      }
    }
    await shell.put(url, response.clone())
  })
  if (dropped.length) {
    console.warn('[inkstone] shell left incomplete, the warm-up retries it: ' + dropped.join(', '))
  }
  await shell.put(CACHE_META_URL, new Response(String(Date.now())))
}

function warmOfflineCache() {
  if (!warmPromise) {
    warmPromise = runOfflineWarmup()
      .catch(() => broadcastStatus('error', 0, WARMUP_TOTAL).catch(() => {}))
      .finally(() => {
        warmPromise = null
      })
  }
  return warmPromise
}

async function runOfflineWarmup() {
  // A core file the install skipped because the edge dropped its connection is filled in here, on every
  // trigger the page already gives this function. Ahead of the manifest check below, or a build whose
  // background set is complete would never notice its own shell is short one file.
  await cacheCoreResources()
  const assets = await caches.open(ASSET_CACHE)
  if (await assets.match(CURRENT_MANIFEST_URL)) {
    await broadcastStatus('ready', WARMUP_TOTAL, WARMUP_TOTAL)
    return
  }
  let completed = await countAvailable()
  let processed = 0
  let failed = 0
  await broadcastStatus('preparing', completed, WARMUP_TOTAL)

  // Fill the complete offline cache quietly after the app is ready. A single
  // request at a time plus a short yield keeps foreground traffic responsive.
  // A URL the edge drops is skipped instead of ending the run, because the whole
  // download shares one queue: one reset connection used to abort every file behind
  // it and leave an uncaught rejection in the console. The manifest stays unwritten
  // while anything is missing, so the next pass — on 'online', on tab focus, on the
  // next install — retries just those URLs.
  await forEachConcurrent(WARMUP_URLS, 1, async (url) => {
    try {
      if (isImmutableAsset(url) && await assets.match(url)) return
      let reused = isImmutableAsset(url)
        ? await caches.match(url, { ignoreSearch: true })
        : null
      if (reused && isDocumentFallback(url, reused)) reused = null
      const response = reused || await fetchRequired(url)
      await assets.put(url, response.clone())
      if (!reused) completed++
    } catch {
      failed++
    }
    processed++
    if (processed % 8 === 0) {
      await broadcastStatus('preparing', completed, WARMUP_TOTAL)
    }
    await pauseBackgroundWarmup()
  })
  if (failed) {
    await broadcastStatus('error', completed, WARMUP_TOTAL)
    return
  }
  await writeCurrentManifest(assets)
  await pruneAssetCache(assets)
  await broadcastStatus('ready', WARMUP_TOTAL, WARMUP_TOTAL)
}

async function reportOfflineStatus(target) {
  const assets = await caches.open(ASSET_CACHE)
  const complete = Boolean(await assets.match(CURRENT_MANIFEST_URL))
  const completed = complete ? WARMUP_TOTAL : await countAvailable()
  const message = statusMessage(complete ? 'ready' : 'preparing', completed, WARMUP_TOTAL)
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
  if (isDocumentFallback(url, response)) {
    const error = new Error('Refused to cache ' + url + ': the edge answered with the app document')
    // The one failure the shell's caller must not swallow: it is the build being wrong, not the
    // connection being brief. Marked rather than matched by message, so the two can never be confused
    // by a rewording.
    error.refused = true
    throw error
  }
  return response
}

/**
 * A file this build no longer serves does not come back as a 404. The edge is configured to answer a miss
 * with HTTP 200 and the app document (not_found_handling in wrangler.toml), so response.ok cannot tell a
 * chunk from the page that replaced it, and caching that page under a .js key is the most damaging mistake
 * available to this worker: the next load reads HTML where a module script belongs, the browser refuses it
 * on MIME grounds, the entry point's dynamic import never settles, and the reader stares at an empty root
 * that survives every reload because the cache is consulted first. So a body that claims to be a document
 * while the URL asked for a file counts as a failed fetch, and the existing retry paths handle it as one.
 */
function isDocumentFallback(url, response) {
  const type = response.headers.get('content-type') || ''
  if (!type.toLowerCase().includes('text/html')) return false
  return !new URL(url, self.location.origin).pathname.endsWith('.html')
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

// What the ready status means, and the page repeats it: every file in the warm-up set is cached. It is not a claim
// about ON_DEMAND_PATTERN files, which this worker only caches when a page asks for one while online, so
// a notice built on this status has to leave the heavy engines out of its promise.
function statusMessage(status, completed, total) {
  return { type: 'OFFLINE_CACHE_STATUS', buildId: BUILD_ID, status, completed, total }
}

async function broadcastStatus(status, completed, total) {
  await broadcast(statusMessage(status, completed, total))
}

async function broadcast(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of clients) client.postMessage(message)
}
`
}
