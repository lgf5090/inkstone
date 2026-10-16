import { lazy, Suspense, useEffect, useState } from 'react'
import { ConfirmHost, PromptHost } from './components/overlay'
import { QuickAddPromptGate } from './features/quickadd/prompt-gate'
import { Toaster } from './components/feedback'
import { Spinner } from './components/primitives'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoginPage } from './features/auth/LoginPage'
import { dismissBootScreen } from './lib/boot'
import { peekPropertyDecoration, subscribePropertyDecoration } from './lib/property-commands'
import { t, useLocale } from './lib/i18n'
import { initializePwa, requestOfflineWarmup } from './store/pwa'
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

/**
 * How long the boot screen is allowed to stay up before the app gives up waiting and shows itself.
 *
 * The screen is removed the moment the session resolves, so this is only the ceiling for the case where
 * it never does — a request that hangs, an event that never fires. It is long enough that a slow but
 * living start is never interrupted, and short enough that a dead one is not mistaken for a slow one.
 */
const BOOT_WATCHDOG_MS = 8000

export function App() {

  useLocale()
  const status = useSession((s) => s.status)
  const load = useSession((s) => s.load)
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

  useEffect(() => {
    if ((shareSlug || conversationShareSlug || isPresenter) || status !== 'loading') return
    requestOfflineWarmup()
  }, [shareSlug, conversationShareSlug, isPresenter, status])

  useEffect(() => {
    if (shareSlug || conversationShareSlug || isPresenter || status !== 'loading') dismissBootScreen()
  }, [status, shareSlug, isPresenter])

  useEffect(() => {
    if (shareSlug || conversationShareSlug || isPresenter) return
    const timer = window.setTimeout(() => dismissBootScreen(), BOOT_WATCHDOG_MS)
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
      </>
    )
  }

  return (
    <>
      <ErrorBoundary>
        {status === 'loading' && <div className="h-full" />}
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
      {status === 'authed' && <DecorationLayer />}
      <Toaster />
      <ConfirmHost />
      <PromptHost />
      {/* The lint preview dialog is only ever opened by a run, so its chunk stays unloaded until one asks. */}
      {status === 'authed' && <LintPreviewHost />}
      {/* A choice run asks with its own dialogs, and the gate costs one subscription until a run needs them. */}
      {status === 'authed' && <QuickAddPromptGate />}
    </>
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
