// @vitest-environment node
/**
 * What the worker does when a push arrives, and where pressing the notice takes the reader.
 *
 * The worker is generated: `pwa.config.ts` builds `sw.js` as a string at build time. These cases run that
 * string the way `tests/service-worker-warmup.test.ts` runs it — inside a `new Function`, with a fake `self`
 * — because the wiring is the thing under test here, not an algorithm the file could import. A copy of the
 * decision that is inlined would drift from the copy that ships; so the assertion is against the shipped
 * source, and the pure selector exported from `pwa.config.ts` is pinned to the same answers.
 *
 * The privacy rule this file exists to hold: `sendPush` (`src/worker/assistant/push.ts`) declares
 * `aes128gcm` without doing the RFC 8291 encryption behind that name, so the payload is an empty shell and
 * anything it ever carried would arrive in plain text through a push service the deployment does not run.
 * The notice therefore may not read `event.data` at all — the fakes below make reading it throw, and name
 * the fixed copy as the only thing that may be shown.
 */
import { describe, expect, it } from 'vitest'
import { inkstonePwa, pickPushNotificationCopy } from '../pwa.config'

const ORIGIN = 'https://note.test'

/** A note body, in the language a reader of this deployment actually writes in. */
const SECRET_BODY = '秘密笔记：周五之前把租约看完'

type Handler = (event: unknown) => void

interface Shown {
  title: string
  options: { body?: string, tag?: string, icon?: string, data?: Record<string, unknown> }
  /** A real notification closed twice is still one closed notification, so this is a flag, not a count. */
  closed: boolean
  close: () => void
}

function generateServiceWorkerSource(): string {
  const emitted = new Map<string, string>()
  const context = {
    emitFile: (file: { fileName: string; source: string | Uint8Array }) => {
      emitted.set(file.fileName, String(file.source))
    },
  }
  const bundle = {
    'index.html': { type: 'asset', fileName: 'index.html', source: '<html><head></head></html>' },
    'assets/app.js': {
      type: 'chunk', fileName: 'assets/app.js', code: '// app', isEntry: true,
      imports: [], facadeModuleId: '/src/client/main.tsx', viteMetadata: { importedCss: new Set<string>() },
    },
  }
  const plugin = inkstonePwa() as unknown as {
    generateBundle: (options: unknown, bundle: unknown) => void
  }
  plugin.generateBundle.call(context, {}, bundle)
  const source = emitted.get('sw.js')
  if (!source) throw new Error('the pwa plugin emitted no sw.js')
  return source
}

function bootWorker(options: { language?: string } = {}) {
  const listeners = new Map<string, Handler[]>()
  const shown: Shown[] = []
  const posted: Record<string, unknown>[] = []
  const opened: string[] = []
  const focused: string[] = []

  const windows: Array<Record<string, unknown>> = []

  const self = {
    location: { origin: ORIGIN },
    navigator: { language: options.language ?? 'en-US' },
    addEventListener: (type: string, handler: Handler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler])
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url); return null },
    },
    registration: {
      showNotification: (title: string, init: Shown['options'] = {}) => {
        const entry: Shown = { title, options: init, closed: false, close: () => {} }
        entry.close = () => { entry.closed = true }
        shown.push(entry)
      },
      getNotifications: async (filter?: { tag?: string }) => shown
        .filter((entry) => !filter?.tag || entry.options.tag === filter.tag),
    },
  }

  // Nothing in the push path may touch the offline caches or the network: a push that re-cached the shell
  // would be a worker doing warm-up work it was not asked to do, on the push service's clock.
  const caches = { open: async () => { throw new Error('push touched the cache storage') } }
  const fetchImpl = async () => { throw new Error('push touched the network') }

  new Function('self', 'caches', 'fetch', 'Response', generateServiceWorkerSource())(
    self, caches, fetchImpl, class {},
  )

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const settled: Array<Promise<unknown>> = []
    const waitUntil = (promise: Promise<unknown>) => { settled.push(promise) }
    for (const handler of listeners.get(type) ?? []) handler({ ...event, waitUntil })
    await Promise.all(settled)
    return settled.length
  }

  /** A payload whose every accessor is booby-trapped: reading it is the violation. */
  const pushEvent = () => ({
    data: {
      text: () => { throw new Error('the worker read the payload as text') },
      json: () => { throw new Error('the worker read the payload as JSON') },
      arrayBuffer: () => { throw new Error('the worker read the payload as bytes') },
    },
  })

  const addWindow = (url: string) => {
    const client = {
      url,
      focused: false,
      focus: async () => { focused.push(url); client.focused = true },
      postMessage: (message: Record<string, unknown>) => { posted.push(message) },
    }
    windows.push(client)
    return client
  }

  return {
    push: () => dispatch('push', pushEvent()),
    clickNotification: (entry: Shown) => dispatch('notificationclick', { notification: entry }),
    shown,
    posted,
    opened,
    focused,
    addWindow,
    listenerTypes: () => [...listeners.keys()],
  }
}

describe('the worker’s push handling', () => {
  it('listens for push and notificationclick, and never reads the payload', async () => {
    const worker = bootWorker()
    expect(worker.listenerTypes()).toContain('push')
    expect(worker.listenerTypes()).toContain('notificationclick')
    // The accessors throw on contact, so reaching this line at all is the proof.
    await expect(worker.push()).resolves.toBeGreaterThanOrEqual(1)
  })

  it('shows the fixed generic notice rather than anything the payload could carry', async () => {
    const worker = bootWorker({ language: 'en-US' })
    await worker.push()
    expect(worker.shown).toHaveLength(1)
    const notice = worker.shown[0]!
    const copy = pickPushNotificationCopy('en-US')
    expect(notice.title).toBe(copy.title)
    expect(notice.options.body).toBe(copy.body)
    // The empty-shell payload is the reason: no title or body here may be assembled from it.
    expect(notice.title).not.toContain(SECRET_BODY)
    expect(notice.options.body ?? '').not.toContain(SECRET_BODY)
    expect(`${notice.title} ${notice.options.body ?? ''}`).not.toMatch(/秘密|笔记|租约/)
  })

  it('answers a Chinese-language device with the Chinese copy, and the same selector decides both', async () => {
    for (const language of ['zh-CN', 'zh-TW', 'zh', 'en-GB', 'ja-JP', '']) {
      const worker = bootWorker({ language })
      await worker.push()
      expect(worker.shown[0]!.title, language).toBe(pickPushNotificationCopy(language).title)
      expect(worker.shown[0]!.options.body, language).toBe(pickPushNotificationCopy(language).body)
    }
  })

  it('reuses one tag so a second push replaces the notice instead of stacking another', async () => {
    const worker = bootWorker()
    await worker.push()
    await worker.push()
    const tags = worker.shown.map((entry) => entry.options.tag)
    expect(tags).toHaveLength(2)
    expect(new Set(tags).size, 'two pushes showed two different tags, so the notices stack').toBe(1)
    expect(tags[0], 'the notice carries no tag, so nothing dedupes it').toBeTruthy()
  })

  it('focuses the app and names the notification centre when the notice is pressed', async () => {
    const worker = bootWorker()
    const client = worker.addWindow(`${ORIGIN}/chat`)
    await worker.push()
    await worker.clickNotification(worker.shown[0]!)
    expect(worker.focused).toEqual([`${ORIGIN}/chat`])
    expect(worker.opened, 'an existing window was there, and a second one was opened anyway').toEqual([])
    expect(worker.posted).toContainEqual({ type: 'OPEN_NOTIFICATION_CENTER' })
    expect(client.focused).toBe(true)
  })

  it('closes every copy of its own notice when one is pressed', async () => {
    const worker = bootWorker()
    worker.addWindow(`${ORIGIN}/chat`)
    await worker.push()
    await worker.push()
    expect(worker.shown.map((entry) => entry.closed), 'no notice was closed before this press').toEqual([false, false])
    await worker.clickNotification(worker.shown[1]!)
    expect(worker.shown.map((entry) => entry.closed), 'a notice survived the press').toEqual([true, true])
  })

  it('opens the app at the notification centre when no window is open', async () => {
    const worker = bootWorker()
    await worker.push()
    await worker.clickNotification(worker.shown[0]!)
    expect(worker.opened).toHaveLength(1)
    const url = new URL(worker.opened[0]!, ORIGIN)
    expect(url.pathname).toBe('/chat')
    expect(url.searchParams.get('notifications')).toBe('1')
  })

  it('leaves a non-app window alone and opens its own instead', async () => {
    const worker = bootWorker()
    worker.addWindow('https://elsewhere.test/chat')
    await worker.push()
    await worker.clickNotification(worker.shown[0]!)
    expect(worker.focused, 'the worker hijacked a window from another origin').toEqual([])
    expect(worker.opened).toHaveLength(1)
  })
})
