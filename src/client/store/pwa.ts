import { create } from 'zustand'
import { t } from '../lib/i18n'
import { useUi } from './ui'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

interface PwaState {
  installAvailable: boolean
  installed: boolean
  installing: boolean
  /**
   * A newer build is installed and waiting for this reader to hand the page over to it.
   *
   * This is the entry the update notice is built on, not a detail behind one: the card in `App.tsx`
   * reads it, so it stays on screen for as long as the worker stays waiting.
   */
  updateAvailable: boolean
  applyingUpdate: boolean
  offlineStatus: 'idle' | 'preparing' | 'ready' | 'error'
  offlineCompleted: number
  offlineTotal: number
  install: () => Promise<void>
  applyUpdate: () => Promise<void>
}

let installPrompt: InstallPromptEvent | null = null
let initialized = false
let waitingWorker: ServiceWorker | null = null
let reloadForUpdate = false
let serviceWorkerRegistration: ServiceWorkerRegistration | null = null
let warmupRequested = false
let warmupScheduled = false

export const usePwa = create<PwaState>((set, get) => ({
  installAvailable: false,
  installed: isStandalone(),
  installing: false,
  updateAvailable: false,
  applyingUpdate: false,
  offlineStatus: 'idle',
  offlineCompleted: 0,
  offlineTotal: 0,

  async install() {
    const prompt = installPrompt
    if (!prompt) return
    installPrompt = null
    set({ installAvailable: false, installing: true })
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      if (choice.outcome === 'accepted') set({ installed: true })
    } finally {
      set({ installing: false })
    }
  },

  /**
   * Hands the page over to the build that is waiting, saving the reader's note first.
   *
   * A press is the only way this happens. Reloading a page because a file changed is how an unsent
   * sentence disappears, so the flush runs ahead of `SKIP_WAITING` and a flush failure stops here: the
   * card stays up, the note stays on the screen, and the reader can press again once it is saved.
   */
  async applyUpdate() {
    const worker = waitingWorker
    // The card and the worker are set together in `notifyUpdate`, so a press with no worker means the
    // flag outlived the worker it was raised for. Nothing went wrong and there is nothing to reload:
    // saying so would be a notice about a state the reader cannot act on.
    if (!worker) return
    if (get().applyingUpdate) return
    set({ applyingUpdate: true })
    const { useNotes } = await import('./notes')
    try {
      await useNotes.getState().flush({ immediate: true })
    } catch (error) {
      set({ applyingUpdate: false })
      useUi.getState().toast({
        title: t('common.save_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
      return
    }
    reloadForUpdate = true
    set({ updateAvailable: false, applyingUpdate: false })
    worker.postMessage({ type: 'SKIP_WAITING' })
  },
}))

export function initializePwa(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true

  window.addEventListener('beforeinstallprompt', (event) => {
    // Taking the browser's banner away is only defensible if the app puts an entry on screen in its place:
    // `preventDefault()` with nothing behind it is the console line "Banner not shown", a reader who cannot
    // install, and no way to tell the two apart. The toast below is that entry, and pressing it is the user
    // gesture `prompt()` requires. A reader who dismisses it has not lost the install — the row in
    // Settings → About spends the same captured prompt — so the notice is a shortcut, not the only door.
    //
    // The deferral itself is not optional, and neither is Chrome's complaint about it: `prompt()` answers
    // with an `AbortError` unless the event was deferred first, so an app that wants to name its own
    // install entry has to prevent the banner, and the browser writes its "Banner not shown" line at the
    // moment of deferral — before any press could have answered it. What this file sets out to remove is
    // the failure that line describes, a prompt intercepted and then never spent. The line itself names
    // the interception, which is the price of the entry, and the press is what pays for it.
    event.preventDefault()
    installPrompt = event as InstallPromptEvent
    usePwa.setState({ installAvailable: true })
    useUi.getState().toast({
      title: t('pwa.install_available'),
      description: t('pwa.install_available_description'),
      action: {
        label: t('pwa.install'),
        run: () => {
          void usePwa.getState().install()
        },
      },
    })
  })
  window.addEventListener('appinstalled', () => {
    installPrompt = null
    usePwa.setState({ installAvailable: false, installed: true, installing: false })
  })

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadForUpdate) {
      location.reload()
      return
    }
    // A second tab that pressed the same card activated the worker for this page too, so the waiting
    // worker this card points at no longer exists. That tab's reload is its own business; a card left
    // here would be an invitation to reload for a reason that already happened.
    waitingWorker = null
    usePwa.setState({ updateAvailable: false, applyingUpdate: false })
  })
  window.addEventListener('online', scheduleOfflineWarmup)
  void registerServiceWorker()
}

/**
 * Tells the worker this reader wants the whole app, so it may start downloading it in the background.
 *
 * What the worker downloads is the everyday set — the shell, the styles, the shared chunks — and what it
 * deliberately leaves out is the heavy engines, listed in `pwa.config.ts`: the diagram renderers, the
 * graph, the drawing board and the RSS reader arrive on the first online visit that asks for one, because
 * warming them would spend every account's bandwidth for a few readers' benefit. The ready notice is
 * written against that line, so a change to the on-demand list is a change to `pwa.offline_ready_description`.
 */
export function requestOfflineWarmup(): void {
  warmupRequested = true
  scheduleOfflineWarmup()
}

/**
 * Registers the worker and turns what it reports into the things a reader can press.
 *
 * Three trade-offs, each of them the whole reason the line below it exists:
 *
 * `updateViaCache: 'none'` — `/sw.js` keeps the name it is registered under, because a registered path
 * cannot move, so the file is the only un-hashed artifact in the build and the browser's HTTP cache is
 * the one thing standing between a deploy and a notice. Bypassing that cache costs one small request per
 * registration and is what makes the update entry reachable the same day rather than the next reopen.
 *
 * Checked on visibility rather than on a clock — a tab left open overnight is the case that would
 * otherwise never hear about a new build, and `update()` against a byte-identical script installs nothing,
 * so the check costs one request each time the reader comes back to the tab instead of a timer running
 * all day on a page nobody is reading.
 *
 * Never reloaded on the app's own say-so — a worker waiting in the background is not a reason to throw
 * away the page a reader is writing in, so the press in `applyUpdate` is the consent and the card in
 * `App.tsx` is what keeps the offer on the table until it happens.
 *
 * A failed registration is swallowed, and it is the one failure here worth swallowing: the reasons are an
 * insecure origin or a browser with no worker, and the app online is the app without the worker. Nothing
 * is claimed in its place — `offlineStatus` stays `idle`, so the offline row in Settings → About hides
 * itself instead of reporting a copy that was never made, and there is no update entry because there is
 * no worker to update.
 */
async function registerServiceWorker(): Promise<void> {
  try {
    // A first visit has no controller to be replaced, so a worker that installs alongside this page is
    // this page's own build: telling the reader an update is waiting would be telling them about the
    // download they just made.
    const wasControlled = Boolean(navigator.serviceWorker.controller)
    const registration = await navigator.serviceWorker.register('/sw.js', {
      // Must stay the manifest's `scope`, and the manifest's `start_url` must stay inside it: a worker
      // that does not control the entry point is not installable. `pwa.test.ts` pins the three together.
      scope: '/',
      updateViaCache: 'none',
    })
    serviceWorkerRegistration = registration

    if (registration.waiting && wasControlled) notifyUpdate(registration.waiting)
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing
      if (!worker) return
      worker.addEventListener('statechange', () => {
        // `installed` and not `activated`: this is the moment the new build has finished caching its own
        // shell, which is what makes the card's promise — reload, and this page still opens — true.
        if (worker.state !== 'installed') return
        if (navigator.serviceWorker.controller) notifyUpdate(worker)
      })
    })

    await navigator.serviceWorker.ready
    readyOfflineStatus()
    scheduleOfflineWarmup()

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        // Best-effort: a check that fails here — offline, a dropped connection, a worker the browser
        // would not fetch — is answered by the next time the tab is shown, and an error thrown into a
        // visibility handler would only take the page down over a question nobody asked.
        void registration.update().catch(() => {})
        scheduleOfflineWarmup()
      }
    })
  } catch {
    // Best-effort by the doc comment above: no worker means no offline copy and no update entry, which
    // is the state the UI already reports, `offlineStatus` having never left `idle`.
  }
}

/** Asks the worker what it actually holds, instead of assuming the cache is what this page wants. */
function readyOfflineStatus(): void {
  const worker = serviceWorkerRegistration?.active ?? navigator.serviceWorker.controller
  worker?.postMessage({ type: 'GET_OFFLINE_CACHE_STATUS' })
}

/**
 * Hands the background download to the worker, when there is one and the browser says it can be spent.
 *
 * `navigator.onLine` decides the download, not the notice: the reader's answer to "am I offline?" stays
 * the save indicator's, which reads the notes store's `online` flag — that one learns from requests that
 * actually failed, and it is the flag the writing surface is judged against. Two answers to the same
 * question is what this file must not add.
 */
function scheduleOfflineWarmup(): void {
  if (!warmupRequested || warmupScheduled || !navigator.onLine) return
  const worker = serviceWorkerRegistration?.active ?? navigator.serviceWorker?.controller
  if (!worker) return
  warmupScheduled = true
  const run = () => {
    warmupScheduled = false
    if (!warmupRequested || !navigator.onLine) return
    worker.postMessage({ type: 'WARM_OFFLINE_CACHE' })
  }
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }
  // Safari ships no `requestIdleCallback`, and the download is worth having there too; the timer is the
  // same policy on a coarser clock, not a fallback for a case nobody has seen.
  if (idleWindow.requestIdleCallback) idleWindow.requestIdleCallback(run, { timeout: 3_000 })
  else window.setTimeout(run, 1_200)
}

function handleServiceWorkerMessage(event: MessageEvent): void {
  const data = event.data as {
    type?: string
    status?: PwaState['offlineStatus']
    completed?: number
    total?: number
  } | null
  if (data?.type !== 'OFFLINE_CACHE_STATUS') return
  // The worker is a separate artifact from a previous deploy, so its status text is input, not a fact:
  // a value the Settings row cannot render is dropped here rather than put on the screen.
  if (!data.status || !['preparing', 'ready', 'error'].includes(data.status)) return
  const completed = Math.max(0, Number(data.completed) || 0)
  const total = Math.max(completed, Number(data.total) || 0)
  const previous = usePwa.getState().offlineStatus
  usePwa.setState({
    offlineStatus: data.status,
    offlineCompleted: completed,
    offlineTotal: total,
  })
  // The notice is derived from the transition the reader was watching, not from a flag on the message:
  // the worker never set one, so the download used to finish in silence. A page that boots straight into
  // a cache someone else already filled says nothing, because nothing changed under the reader — the
  // Settings row is where that state lives.
  if (previous === 'preparing' && data.status === 'ready') {
    useUi.getState().toast({
      title: t('pwa.offline_ready'),
      description: t('pwa.offline_ready_description'),
      tone: 'success',
    })
  }
}

/**
 * Puts a waiting build in front of the reader.
 *
 * The store flag is the entry: `App.tsx` renders it as a card that stays on screen until it is pressed,
 * which is why there is no toast here. A toast expires and a waiting worker does not, so an expiring
 * notice in front of a permanent change would leave the reader with a new build installed on the device
 * and no way back to it — the same mistake the intercepted install banner would be, one entry deeper.
 */
function notifyUpdate(worker: ServiceWorker): void {
  waitingWorker = worker
  usePwa.setState({ updateAvailable: true })
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
}
