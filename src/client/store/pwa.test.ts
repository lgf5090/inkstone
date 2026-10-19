// @vitest-environment jsdom
/**
 * The install prompt the browser offered, the update the worker holds back, and the manifest that names
 * both of them.
 *
 * `initializePwa` calls `preventDefault()` on `beforeinstallprompt`, which takes Chrome's own banner away —
 * the console line "Banner not shown: beforeinstallpromptevent.preventDefault() called." is the browser
 * recording exactly that. Intercepting the banner is the right call for an app that wants to name its own
 * entry, but only if the interception is what puts one on screen. Before this file, the only place the
 * captured prompt could be spent was a row inside Settings → About, so a reader who never opens settings
 * has no install entry and no notice that one was ever possible.
 *
 * The pair these tests hold together: the prompt is captured *and* a visible entry appears, and that
 * entry's press is the user gesture `prompt()` needs. A test that only checked `installAvailable` would
 * pass on a store flag nobody can reach — the same reasoning covers `updateAvailable`, which is why the
 * update half of this file drives a real `updatefound`/`statechange` sequence through a stubbed worker
 * rather than setting the flag by hand. `App.test.ts` is where the card that reads it is shown on screen.
 *
 * The manifest is the other half of the same promise — a field that drifts from the token the shell
 * paints with, from the scope the worker registers at, or from the size of the icon file it names is an
 * install that looks wrong or does not happen — and `tests/pwa-manifest.test.ts` is where that document
 * is read, because these files are typechecked without Node's own modules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestGlobals } from '../lib/test-render'
import type * as I18n from '../lib/i18n'

interface PromptedEvent extends Event {
  preventDefault: () => void
  prompt: ReturnType<typeof vi.fn>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed', platform: string }>
}

/** A waiting worker's own record: what it was told to do, and what its `state` was last read as. */
class FakeWorker extends EventTarget {
  readonly postMessage = vi.fn()

  constructor(public state = 'installed') {
    super()
  }

  /** Moves to a new state and fires the event the real worker fires on the way. */
  moveTo(state: string): void {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget {
  readonly scope = 'http://localhost/'
  readonly update = vi.fn(async () => undefined)
  readonly unregister = vi.fn(async () => true)

  constructor(
    readonly active: FakeWorker | null,
    readonly waiting: FakeWorker | null = null,
    public installing: FakeWorker | null = null,
  ) {
    super()
  }
}

let usePwa: typeof import('./pwa').usePwa
let initializePwa: typeof import('./pwa').initializePwa
let useUi: typeof import('./ui').useUi
/**
 * The i18n module this run is using.
 *
 * `pwa.ts` keeps the captured prompt and `initialized` at module scope, so every test imports the store
 * again — and an import graph that was reset takes its copy of the message table with it. Reading `t` off
 * the old instance would compare a fresh notice against an empty table and report the key.
 */
let i18n: typeof I18n

/**
 * Stands up `navigator.serviceWorker` well enough for the registration path to run, and hands back the
 * three handles the tests need: the registration, the `register` call, and the target the worker's own
 * `message`/`controllerchange` events are dispatched on.
 */
function stubServiceWorker(registration: FakeRegistration, controller: FakeWorker | null) {
  const events = new EventTarget()
  const register = vi.fn(async () => registration)
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller,
      register,
      ready: Promise.resolve(registration),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  })
  return { events, register }
}

/** Registers the worker the way production does: `PROD` on, and a controller already in place. */
async function startControlledWorker(registration = new FakeRegistration(new FakeWorker())) {
  vi.stubEnv('PROD', true)
  const active = registration.active ?? new FakeWorker()
  const stub = stubServiceWorker(registration, active)
  const reload = vi.fn()
  vi.stubGlobal('location', { reload })
  const pwa = await import('./pwa')
  pwa.initializePwa()
  await vi.waitFor(() => expect(stub.register).toHaveBeenCalled())
  return { ...stub, registration, active, reload }
}

/**
 * Runs the event sequence a real browser runs when a deploy lands: `updatefound`, then the worker's own
 * `statechange` into `installed`. The second one is the only moment the card's promise is true — the
 * worker has by then finished caching the shell it will serve after the reload.
 */
function announceWaitingBuild(registration: FakeRegistration): FakeWorker {
  const worker = new FakeWorker('installing')
  registration.installing = worker
  registration.dispatchEvent(new Event('updatefound'))
  worker.moveTo('installed')
  return worker
}

/**
 * Runs the sequence a rejected install runs: the worker appears, then the browser throws it away without
 * ever reading `installed`. That is the update channel jammed — the page keeps its old build, and the next
 * reload repeats the same failure.
 */
function announceFailedBuild(registration: FakeRegistration): FakeWorker {
  const worker = new FakeWorker('installing')
  registration.installing = worker
  registration.dispatchEvent(new Event('updatefound'))
  worker.moveTo('redundant')
  return worker
}

/** Sends the status message a real worker sends, with the shape `sw.js` writes. */
function sendOfflineStatus(status: string, completed = 0, total = 0): void {
  navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
    data: { type: 'OFFLINE_CACHE_STATUS', buildId: 'x', status, completed, total },
  }))
}

/** Fires the event the way the browser does, with the two halves a real prompt carries. */
function fireInstallPrompt(outcome: 'accepted' | 'dismissed' = 'accepted'): PromptedEvent {
  const event = new Event('beforeinstallprompt') as PromptedEvent
  // Spied rather than replaced, so the browser's own answer to `defaultPrevented` still happens: the
  // test is about whether the app asks for it, not about what it does.
  vi.spyOn(event, 'preventDefault')
  event.prompt = vi.fn(async () => undefined)
  event.userChoice = Promise.resolve({ outcome, platform: 'web' })
  window.dispatchEvent(event)
  return event
}

beforeEach(async () => {
  installTestGlobals()
  vi.resetModules()
  i18n = await import('../lib/i18n')
  await i18n.initI18n()
  const pwa = await import('./pwa')
  usePwa = pwa.usePwa
  initializePwa = pwa.initializePwa
  useUi = (await import('./ui')).useUi
})

afterEach(() => {
  useUi.getState().toasts.forEach((toast) => useUi.getState().dismissToast(toast.id))
  Reflect.deleteProperty(navigator, 'serviceWorker')
  Reflect.deleteProperty(window, 'requestIdleCallback')
  Reflect.deleteProperty(navigator, 'onLine')
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.doUnmock('./notes')
})

describe('the install entry', () => {
  it('appears when the browser banner is intercepted', () => {
    initializePwa()
    const event = fireInstallPrompt()
    expect(event.preventDefault, 'the banner was left to the browser, so the app is not intercepting it').toHaveBeenCalled()
    expect(usePwa.getState().installAvailable).toBe(true)
    const toast = useUi.getState().toasts.at(-1)
    expect(toast, 'preventDefault() was called and nothing was offered in the banner place').toBeTruthy()
    expect(toast!.title).toBe(i18n.t('pwa.install_available'))
    expect(toast!.action?.label).toBe(i18n.t('pwa.install'))
  })

  it('spends the captured prompt on the press of that entry', async () => {
    initializePwa()
    const event = fireInstallPrompt()
    const toast = useUi.getState().toasts.at(-1)!
    toast.action!.run()
    expect(event.prompt, 'the entry does not install; it only points at settings').toHaveBeenCalled()
    await vi.waitFor(() => expect(usePwa.getState().installed).toBe(true))
    expect(usePwa.getState().installAvailable).toBe(false)
  })

  it('is not offered again when the reader turns the browser prompt down', async () => {
    initializePwa()
    fireInstallPrompt('dismissed')
    const toast = useUi.getState().toasts.at(-1)!
    toast.action!.run()
    await vi.waitFor(() => expect(usePwa.getState().installAvailable).toBe(false))
    expect(usePwa.getState().installed).toBe(false)
  })

  it('says nothing when no prompt was ever captured', async () => {
    initializePwa()
    const toast = vi.spyOn(useUi.getState(), 'toast')
    await usePwa.getState().install()
    // No banner, no captured prompt: the install row in settings is still there, so this is not a failure
    // the reader has to be told about — it is a press with nothing behind it.
    expect(toast).not.toHaveBeenCalled()
    toast.mockRestore()
  })
})

describe('the worker registration', () => {
  it('registers the built worker at the scope the manifest says it owns', async () => {
    const { register } = await startControlledWorker()
    const call = register.mock.calls[0] as unknown as [string, { scope: string }]
    // The scope here and the manifest's start_url are one promise written in two files: a start_url the
    // registered worker does not control is an app that cannot be installed. tests/pwa-manifest.test.ts
    // pins the other half, that the manifest says the same '/'.
    expect(call[0]).toBe('/sw.js')
    expect(call[1].scope).toBe('/')
    expect(register).toHaveBeenCalledWith('/sw.js', expect.objectContaining({ updateViaCache: 'none' }))
    // The worker is the only un-hashed file in the build, so the browser HTTP cache is the one thing
    // between a deploy and a notice; bypassing it is what makes the update entry reachable today.
  })

  it('asks the worker what it holds before saying anything about it', async () => {
    const { active } = await startControlledWorker()
    // Nothing is claimed from the page's own guess of what is cached: the status on the screen is the
    // worker answer to this question, which is also why a failed registration says nothing at all.
    expect(active.postMessage).toHaveBeenCalledWith({ type: 'GET_OFFLINE_CACHE_STATUS' })
  })
})

describe('the update entry', () => {
  it('raises the card when a build finishes installing behind this page', async () => {
    const { registration } = await startControlledWorker()
    expect(usePwa.getState().updateAvailable).toBe(false)

    announceWaitingBuild(registration)

    expect(usePwa.getState().updateAvailable).toBe(true)
    // And no toast: a notice that expires in front of a change that does not is the hole this card
    // exists to close, so the card has to be the notice rather than a second copy of it.
    expect(useUi.getState().toasts).toHaveLength(0)
  })

  it('says nothing about the build that arrived with the page', async () => {
    vi.stubEnv('PROD', true)
    const registration = new FakeRegistration(null)
    const stub = stubServiceWorker(registration, null)
    const pwa = await import('./pwa')
    pwa.initializePwa()
    await vi.waitFor(() => expect(stub.register).toHaveBeenCalled())

    announceWaitingBuild(registration)

    // No controller before this one started means this is the first visit, not an update: the reader
    // would be told a newer version is waiting for a page that is already the newest thing they have.
    expect(usePwa.getState().updateAvailable).toBe(false)
  })

  it('saves the note first, and only then hands the page over', async () => {
    const flush = vi.fn(async () => undefined)
    vi.doMock('./notes', () => ({ useNotes: { getState: () => ({ flush }) } }))
    const { registration, reload } = await startControlledWorker()
    const worker = announceWaitingBuild(registration)

    await usePwa.getState().applyUpdate()

    expect(flush).toHaveBeenCalledWith({ immediate: true })
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(usePwa.getState().updateAvailable).toBe(false)
    navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(reload, 'the press promised a new build; the page never moved').toHaveBeenCalled()
  })

  it('keeps the card up when the note refuses to save', async () => {
    const flush = vi.fn(async () => {
      throw new Error('the outbox is full')
    })
    vi.doMock('./notes', () => ({ useNotes: { getState: () => ({ flush }) } }))
    const { registration } = await startControlledWorker()
    const worker = announceWaitingBuild(registration)

    await usePwa.getState().applyUpdate()

    // Reloading here would be the app throwing away a reader's work because a file changed, which is the
    // one thing this path must never do; the reason goes on the screen and the offer stays.
    expect(worker.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(usePwa.getState().updateAvailable).toBe(true)
    expect(useUi.getState().toasts.at(-1)?.tone).toBe('danger')
    expect(usePwa.getState().applyingUpdate).toBe(false)
  })

  it('takes the card away when another tab already took the update', async () => {
    const { registration, reload } = await startControlledWorker()
    announceWaitingBuild(registration)

    navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))

    // This page did not press, so it is not reloading; a card left here would invite a reload for a
    // reason that has already happened somewhere else.
    expect(usePwa.getState().updateAvailable).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('points at the newest build when two arrive in one sitting', async () => {
    const flush = vi.fn(async () => undefined)
    vi.doMock('./notes', () => ({ useNotes: { getState: () => ({ flush }) } }))
    const { registration } = await startControlledWorker()
    const first = announceWaitingBuild(registration)
    const second = announceWaitingBuild(registration)

    await usePwa.getState().applyUpdate()

    expect(second.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(first.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('does not offer to save what was never asked for', async () => {
    const flush = vi.fn(async () => undefined)
    vi.doMock('./notes', () => ({ useNotes: { getState: () => ({ flush }) } }))
    await startControlledWorker()

    await usePwa.getState().applyUpdate()

    expect(flush).not.toHaveBeenCalled()
    expect(useUi.getState().toasts).toHaveLength(0)
  })
})

describe('the jammed update channel', () => {
  it('names the build that was thrown away before it installed', async () => {
    const { registration } = await startControlledWorker()

    announceFailedBuild(registration)

    expect(usePwa.getState().updateStuck).toBe(true)
    expect(usePwa.getState().updateAvailable).toBe(false)
  })

  it('says nothing on a first visit, where there is no older build to be stuck on', async () => {
    vi.stubEnv('PROD', true)
    const registration = new FakeRegistration(null)
    const stub = stubServiceWorker(registration, null)
    const pwa = await import('./pwa')
    pwa.initializePwa()
    await vi.waitFor(() => expect(stub.register).toHaveBeenCalled())

    announceFailedBuild(registration)

    expect(usePwa.getState().updateStuck).toBe(false)
  })

  it('goes quiet as soon as a build does finish installing', async () => {
    const { registration } = await startControlledWorker()
    announceFailedBuild(registration)
    expect(usePwa.getState().updateStuck).toBe(true)

    announceWaitingBuild(registration)

    expect(usePwa.getState().updateAvailable).toBe(true)
    expect(usePwa.getState().updateStuck).toBe(false)
  })

  it('clears the worker and this app’s caches, then reloads', async () => {
    const deleted: string[] = []
    vi.stubGlobal('caches', {
      keys: async () => ['inkstone-shell-abc', 'inkstone-assets-abc', 'someone-elses-cache'],
      delete: async (key: string) => { deleted.push(key); return true },
    })
    const { registration, reload } = await startControlledWorker()
    announceFailedBuild(registration)

    await usePwa.getState().clearStuckUpdate()

    expect(registration.unregister).toHaveBeenCalled()
    expect(deleted).toEqual(['inkstone-shell-abc', 'inkstone-assets-abc'])
    expect(reload, 'the card promised a reload; the page never moved').toHaveBeenCalled()
  })

  it('still reloads when the browser will not hand the caches over', async () => {
    vi.stubGlobal('caches', {
      keys: async () => { throw new TypeError('cache storage denied') },
    })
    const { registration, reload } = await startControlledWorker()
    announceFailedBuild(registration)

    await usePwa.getState().clearStuckUpdate()

    expect(registration.unregister).toHaveBeenCalled()
    expect(reload).toHaveBeenCalled()
  })
})

describe('the offline notice', () => {
  beforeEach(() => {
    // The warm-up waits for an idle moment; running it inline is the only way to watch what it asks for.
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: (callback: IdleRequestCallback) => {
        callback({ didTimeout: false, timeRemaining: () => 16 } as IdleDeadline)
        return 1
      },
    })
  })

  it('notices the download the reader watched finish, and only that', async () => {
    const { active } = await startControlledWorker()
    sendOfflineStatus('ready')
    expect(useUi.getState().toasts, 'a page that booted into a full cache has nothing to announce').toHaveLength(0)

    active.postMessage.mockClear()
    sendOfflineStatus('preparing', 4, 40)
    sendOfflineStatus('ready', 40, 40)

    expect(usePwa.getState().offlineStatus).toBe('ready')
    expect(usePwa.getState().offlineTotal).toBe(40)
    expect(useUi.getState().toasts.at(-1)?.title).toBe(i18n.t('pwa.offline_ready'))
  })

  it('names what is still missing instead of promising the whole app', () => {
    // The warm-up set is deliberately smaller than the build: `pwa.config.ts` holds the diagram, graph,
    // board and RSS chunks back until the first online visit that needs one. So the sentence that reports
    // `ready` is only honest while it says that — and this is the guard that says so.
    expect(i18n.t('pwa.offline_ready_description')).toMatch(/online/)
  })

  it('drops a status the settings row cannot render', async () => {
    await startControlledWorker()

    sendOfflineStatus('half-done', 1, 2)

    expect(usePwa.getState().offlineStatus).toBe('idle')
    expect(useUi.getState().toasts).toHaveLength(0)
  })

  it('keeps the background download for a connection the browser reports', async () => {
    const { active } = await startControlledWorker()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const pwa = await import('./pwa')

    pwa.requestOfflineWarmup()
    expect(active.postMessage).not.toHaveBeenCalledWith({ type: 'WARM_OFFLINE_CACHE' })

    // `navigator.onLine` decides when a background download may start. It is not the reader-facing answer
    // to "am I offline?" — that one is the notes store's, learned from requests that actually failed and
    // shown by the save indicator — and this file adds no second version of it.
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    window.dispatchEvent(new Event('online'))
    expect(active.postMessage).toHaveBeenCalledWith({ type: 'WARM_OFFLINE_CACHE' })
  })
})
