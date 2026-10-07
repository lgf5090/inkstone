import { lazy, Suspense, useEffect, useState } from 'react'
import { ConfirmHost, PromptHost } from './components/overlay'
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

const AppShell = lazy(() =>
  import('./features/shell/AppShell').then((module) => ({ default: module.AppShell })),
)
const SharePage = lazy(() =>
  import('./features/share/SharePage').then((module) => ({ default: module.SharePage })),
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

export function App() {

  useLocale()
  const status = useSession((s) => s.status)
  const load = useSession((s) => s.load)
  const [shareSlug] = useState(() => {
    const match = /^\/s\/([A-Za-z0-9_-]+)/.exec(location.pathname)
    return match?.[1] ?? null
  })
  // The presenter console is a second window over the same app, and it is a document that has been
  // handed a capability rather than an account session: it speaks on the BroadcastChannel and reads
  // nothing of its own. Booting the notebook here would ask it to log in to a room it is already in.
  const [isPresenter] = useState(() => new URLSearchParams(location.search).has('presenter'))

  useEffect(() => {
    if (shareSlug || isPresenter) return
    void load()
  }, [load, shareSlug, isPresenter])

  useEffect(() => watchSystemTheme(), [])

  useEffect(() => {
    if (isPresenter) return
    initializePwa()
  }, [isPresenter])

  useEffect(() => {
    if ((shareSlug || isPresenter) || status !== 'loading') return
    requestOfflineWarmup()
  }, [shareSlug, isPresenter, status])

  useEffect(() => {
    if (shareSlug || isPresenter || status !== 'loading') dismissBootScreen()
  }, [status, shareSlug, isPresenter])

  useEffect(() => {
    if (shareSlug || isPresenter) return
    const timer = window.setTimeout(() => dismissBootScreen(), 8000)
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

  if (shareSlug) {
    return (
      <>
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <SharePage slug={shareSlug} />
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
            <AppShell />
          </Suspense>
        )}
      </ErrorBoundary>
      {/* A show outlives the layout that started it: the shell swaps its whole workspace subtree
          when the breakpoint moves, so the overlay is hosted above that switch rather than inside
          it. It is only mounted while a show is up, which is also what keeps the deck-splitting code
          out of the boot chunk for everyone who is not presenting. */}
      {status === 'authed' && <ShowOverlay />}
      {status === 'authed' && <DecorationLayer />}
      <Toaster />
      <ConfirmHost />
      <PromptHost />
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
