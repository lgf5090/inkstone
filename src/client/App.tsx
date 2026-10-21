import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { ConfirmHost, PromptHost } from './components/overlay'
import { QuickAddPromptGate } from './features/quickadd/prompt-gate'
import { Toaster } from './components/feedback'
import { Button, Spinner } from './components/primitives'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoginPage } from './features/auth/LoginPage'
import { dismissBootScreen } from './lib/boot'
import { peekPropertyDecoration, subscribePropertyDecoration } from './lib/property-commands'
import { peekTemplateSlotJob, subscribeTemplateSlotJob } from './features/chat/template-slot-job'
import { useTemplaterStartup } from './features/templater/startup-bridge'
import { useTemplaterHotkeys } from './features/templater/hotkeys'
import { installTemplaterCreationTrigger } from './features/templater/creation-trigger'
import { t, useLocale } from './lib/i18n'
import { initializePwa, requestOfflineWarmup, usePwa } from './store/pwa'
import { usePresentation } from './store/presentation'
import { useSession, watchSystemTheme } from './store/session'
import { useUi } from './store/ui'

const AppTabHost = lazy(() =>
  import('./features/shell/AppTabHost').then((module) => ({ default: module.AppTabHost })),
)
const SharePage = lazy(() =>
  import('./features/share/SharePage').then((module) => ({ default: module.SharePage })),
)
const ConversationSharePage = lazy(() =>
  import('./features/share/ConversationSharePage').then((module) => ({ default: module.ConversationSharePage })),
)
const PresentationOverlay = lazy(() =>
  import('./features/presentation').then((module) => ({ default: module.PresentationOverlay })),
)
const PresenterWindow = lazy(() =>
  import('./features/presentation').then((module) => ({ default: module.PresenterWindow })),
)
const PropertyDecorationHost = lazy(() =>
  import('./features/preview/PropertyDecorationHost').then((module) => ({ default: module.PropertyDecorationHost })),
)
const LintPreviewHost = lazy(() =>
  import('./features/linter/LintPreview').then((module) => ({ default: module.LintPreviewHost })),
)
const Lightbox = lazy(() =>
  import('./features/preview/Lightbox').then((module) => ({ default: module.Lightbox })),
)
const TemplateSlotProgress = lazy(() =>
  import('./features/chat/template-progress').then((module) => ({ default: module.TemplateSlotProgress })),
)

/**
 * How long the boot screen is allowed to stay up before the app gives up waiting and shows itself.
 *
 * The screen is removed the moment the session resolves, so this is only the ceiling for the case where
 * it never does — a request that hangs, an event that never fires. It is long enough that a slow but
 * living start is never interrupted, and short enough that a dead one is not mistaken for a slow one.
 */
const BOOT_WATCHDOG_MS = 8000

/**
 * What the reader is shown when the session request never answers.
 *
 * The watchdog above removes the boot screen at its ceiling, and until now that left a page with no words,
 * no reason and nothing to press — a blank sheet that looks like the notes are gone. The request itself
 * says nothing either way, so this says only what is known: the server has not answered, and here is the
 * one thing that can end the wait. Focus moves to that button because a keyboard reader should not have to
 * hunt for it on a page that just changed under them.
 */
function BootStalled({ onRetry }: { onRetry: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])
  return (
    <div ref={box} className="flex min-h-full items-center justify-center p-6">
      <div
        role="alert"
        className="flex w-full max-w-[420px] items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-3"
      >
        <RefreshCw size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
        <p className="min-w-0 flex-1 text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
          {t('auth.server_did_not_answer')}
        </p>
        <Button size="sm" variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>
      </div>
    </div>
  )
}

export function App() {

  useLocale()
  const status = useSession((s) => s.status)
  const load = useSession((s) => s.load)
  // One-way: raised when the boot screen's ceiling is reached, never lowered again. A retry that hangs
  // again has nothing new to say, and a retry that answers changes the status out from under this.
  const [bootStalled, setBootStalled] = useState(false)
  const [shareSlug] = useState(() => {
    const match = /^\/s\/([A-Za-z0-9_-]+)/.exec(location.pathname)
    return match?.[1] ?? null
  })
  // A published conversation lives at an address of its own rather than under `/s/`: the two share the
  // promise but not the payload, and one path that had to be told apart would be a second kind of
  // "did it work" for both of them.
  const [conversationShareSlug] = useState(() => {
    const match = /^\/c\/([A-Za-z0-9_-]+)/.exec(location.pathname)
    return match?.[1] ?? null
  })
  // The presenter console is a second window over the same app, and it is a document that has been
  // handed a capability rather than an account session: it speaks on the BroadcastChannel and reads
  // nothing of its own. Booting the notebook here would ask it to log in to a room it is already in.
  const [isPresenter] = useState(() => new URLSearchParams(location.search).has('presenter'))

  useEffect(() => {
    if (shareSlug || conversationShareSlug || isPresenter) return
    void load()
  }, [load, shareSlug, conversationShareSlug, isPresenter])

  useEffect(() => watchSystemTheme(), [])

  useEffect(() => {
    if (isPresenter) return
    initializePwa()
  }, [isPresenter])

  // The reader's startup templates, once, after the account and the library have both arrived. The hook
  // decides nothing on its own — a device switch has to say yes first — so this line costs a subscription
  // and no work for the overwhelming majority of readers.
  useTemplaterStartup()
  useTemplaterHotkeys()

  // The file-creation trigger listens on the notes store from here, so every way a note can arrive — the
  // sidebar, a duplicate, an excalidraw or mindmap canvas, a contextual note, a template's own create — is
  // seen by the same rule. It decides nothing: with the device switch off it answers and does nothing.
  useEffect(() => installTemplaterCreationTrigger(), [])

  useEffect(() => {
    if ((shareSlug || conversationShareSlug || isPresenter) || status !== 'loading') return
    requestOfflineWarmup()
  }, [shareSlug, conversationShareSlug, isPresenter, status])

  useEffect(() => {
    if (shareSlug || conversationShareSlug || isPresenter || status !== 'loading') dismissBootScreen()
  }, [status, shareSlug, isPresenter])

  useEffect(() => {
    if (shareSlug || conversationShareSlug || isPresenter) return
    const timer = window.setTimeout(() => {
      dismissBootScreen()
      // Set whether or not the session has resolved by now: the flag only ever paints while the status is
      // still 'loading', so a build that boots slowly but alive never sees this branch.
      setBootStalled(true)
    }, BOOT_WATCHDOG_MS)
    return () => window.clearTimeout(timer)
  }, [shareSlug, isPresenter])

  if (isPresenter) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageFallback />}>
          <PresenterWindow />
        </Suspense>
      </ErrorBoundary>
    )
  }

  if (shareSlug || conversationShareSlug) {
    return (
      <>
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            {shareSlug ? <SharePage slug={shareSlug} /> : <ConversationSharePage slug={conversationShareSlug!} />}
          </Suspense>
        </ErrorBoundary>
        <Toaster />
        <UpdateCard />
      </>
    )
  }

  return (
    <>
      <ErrorBoundary>
        {status === 'loading' && (bootStalled
          ? <BootStalled onRetry={() => void load()} />
          : <div className="h-full" />)}
        {status === 'anonymous' && <LoginPage />}
        {status === 'authed' && (
          <Suspense fallback={<PageFallback />}>
            <AppTabHost />
          </Suspense>
        )}
      </ErrorBoundary>
      {/* A show outlives the layout that started it: the shell swaps its whole workspace subtree
          when the breakpoint moves, so the overlay is hosted above that switch rather than inside
          it. It is only mounted while a show is up, which is also what keeps the deck-splitting code
          out of the boot chunk for everyone who is not presenting. */}
      {status === 'authed' && <ShowOverlay />}
      {status === 'authed' && <LightboxLayer />}
      {status === 'authed' && <SlotFillLayer />}
      {status === 'authed' && <DecorationLayer />}
      <Toaster />
      <UpdateCard />
      <ConfirmHost />
      <PromptHost />
      {/* The lint preview dialog is only ever opened by a run, so its chunk stays unloaded until one asks. */}
      {status === 'authed' && <LintPreviewHost />}
      {/* A choice run asks with its own dialogs, and the gate costs one subscription until a run needs them. */}
      {status === 'authed' && <QuickAddPromptGate />}
    </>
  )
}

/**
 * The card a build update puts on the screen.
 *
 * `initializePwa` raises `updateAvailable` the moment a new worker finishes caching its own shell, and
 * this is where that flag becomes something a reader can see and press. It used to be a half-minute
 * toast: a notice that expires in front of a change that does not, leaving a new build installed on the
 * device, unreachable except by a reload nobody asks for. So the card has no dismiss control — that is
 * the design, not an oversight. It goes away when the reader takes the update up, or when another tab
 * already did and this page's waiting worker stopped existing.
 *
 * The other thing it can say is that no update is coming. `updateStuck` is raised when a newer build's
 * worker is discarded before it finishes installing, which is the case where this page is pinned to the
 * build it opened with and every reload re-runs the same failed install; the press clears the worker and
 * the caches it was serving from, the only lever a page has. Same corner, same no-dismiss rule, because
 * the condition behind it is just as standing.
 *
 * The corner is the one this app already uses for a standing, actionable status: the template run's card
 * occupies the same slot, above the phone's navigation row and below a notch, which are the insets the
 * manifest's `display: standalone` makes real rather than decorative.
 */
function UpdateCard() {
  const updateAvailable = usePwa((s) => s.updateAvailable)
  const updateStuck = usePwa((s) => s.updateStuck)
  const applyingUpdate = usePwa((s) => s.applyingUpdate)
  const clearingUpdate = usePwa((s) => s.clearingUpdate)
  const applyUpdate = usePwa((s) => s.applyUpdate)
  const clearStuckUpdate = usePwa((s) => s.clearStuckUpdate)
  if (!updateAvailable && !updateStuck) return null
  // One card, two answers to the same question — "where is my update?". A build that did finish installing
  // is the better answer to a jammed channel, so when both flags are somehow up the ready card owns it.
  const stuck = !updateAvailable
  return (
    <div
      role="status"
      className="pointer-events-none fixed left-2 bottom-[calc(64px+env(safe-area-inset-bottom))] z-[var(--z-toast)] md:left-4 md:bottom-4"
    >
      <div className="pointer-events-auto flex w-[min(400px,calc(100vw-32px))] items-start gap-2.5 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-3 shadow-[var(--shadow-pop)]">
        {stuck
          ? <TriangleAlert size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-[var(--danger)]" />
          : <RefreshCw size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-[var(--accent)]" />}
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--text-12-5)] leading-snug font-medium text-[var(--text-primary)]">
            {stuck ? t('pwa.update_stuck') : t('pwa.update_ready')}
          </div>
          <div className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
            {stuck ? t('pwa.update_stuck_description') : t('pwa.update_ready_description')}
          </div>
        </div>
        <Button
          size="sm"
          variant={stuck ? 'secondary' : 'primary'}
          loading={stuck ? clearingUpdate : applyingUpdate}
          onClick={() => {
            void (stuck ? clearStuckUpdate() : applyUpdate())
          }}
        >
          {stuck ? t('pwa.clear_and_reload') : t('pwa.refresh_now')}
        </Button>
      </div>
    </div>
  )
}

function PageFallback() {
  return (
    <div
      role="status"
      aria-label={t("common.loading")}
      className="flex h-full items-center justify-center bg-[var(--bg-base)] text-[var(--text-tertiary)]"
    >
      <Spinner size={18} />
    </div>
  )
}

function DecorationLayer() {
  const [requested, setRequested] = useState(() => peekPropertyDecoration() !== null)
  useEffect(() => subscribePropertyDecoration((next) => {
    if (next) setRequested(true)
  }), [])
  if (!requested) return null
  return (
    <Suspense fallback={null}>
      <PropertyDecorationHost />
    </Suspense>
  )
}

function ShowOverlay() {
  const open = usePresentation((s) => s.open)
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <PresentationOverlay />
    </Suspense>
  )
}

/**
 * The picture viewer, hosted above the container switch.
 *
 * Any container can ask to enlarge an image — the notebook's preview and the chat's attachment chips
 * both do — and `useUi().lightbox` is one global slot. Mounted inside one container it was reachable
 * from that container only, and a chip elsewhere set the state with nothing left to render it: the
 * click did nothing at all, with nothing in the console to say so.
 */
function LightboxLayer() {
  const open = useUi((s) => s.lightbox !== null)
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <Lightbox />
    </Suspense>
  )
}

/**
 * The card a template's AI passages report to.
 *
 * The note is made and opened before its passages come back, and the gallery closes behind them, so the
 * run needs a host that outlives both — the same reason the lightbox sits here. It is mounted only once a
 * run exists, which keeps the assistant's transport out of the boot chunk for the readers who never use a
 * template with an `ai:` slot in it.
 */
function SlotFillLayer() {
  const [requested, setRequested] = useState(() => peekTemplateSlotJob() !== null)
  useEffect(() => subscribeTemplateSlotJob((job) => {
    if (job) setRequested(true)
  }), [])
  if (!requested) return null
  return (
    <Suspense fallback={null}>
      <TemplateSlotProgress />
    </Suspense>
  )
}
