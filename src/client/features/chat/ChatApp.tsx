/**
 * The chat app: the assistant's own container behind the rail's Chat tab.
 *
 * It borrows the notebook's chrome vocabulary rather than the reference project's — the same 48px
 * icon rail, the same 44px header, the same tokens — so the reader moves between containers without
 * finding a second visual language. What the reference called its sidebar becomes a second rail one
 * step in from the app rail, because the app rail already owns the outermost column.
 *
 * The five surfaces share one store on purpose: a turn in the chat can write a memory, a task and a
 * schedule in the same breath, and the tab that shows them has to be current the moment it is opened.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { BarChart3, BookMarked, Brain, CheckSquare, FolderKanban, LayoutList, MessageSquare, ScrollText, Settings2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t, type MessageKey } from '../../lib/i18n'
import { Tooltip } from '../../components/overlay'
import { LoadingBlock } from '../../components/feedback'
import { useAssistant, type AssistantView } from './assistant-store'
import { ASSISTANT_VIEWS } from './assistant-store'
import { ChatView } from './ChatView'
import { MemoryView } from './MemoryView'
import { TasksView } from './TasksView'
import { AutomationsView } from './AutomationsView'
import { SkillsView } from './SkillsView'
import { AssistantSettingsView } from './AssistantSettingsView'
import { ProjectsView } from './ProjectsView'
import { NotificationsBell } from './NotificationCenter'
import { DeepResearchProgress } from './DeepResearchProgress'
import { MermaidViewer } from './MermaidViewer'
import {
  clearOfflineQueue,
  enqueueOfflineText,
  OFFLINE_CAPTURE_EVENT,
  OFFLINE_REPLAY_EVENT,
  offlineQueueSize,
  readOfflineQueue,
} from './offline-queue'

/**
 * The two report views are heavy (charts, log tables, filter panels) and most readers never open them.
 * They arrive when their tab is opened instead of sitting in the chat shell's own bytes.
 */
const RequestStatsView = lazy(() => import('./RequestStatsView').then((m) => ({ default: m.RequestStatsView })))
const RequestLogsView = lazy(() => import('./RequestLogsView').then((m) => ({ default: m.RequestLogsView })))

const VIEW_ICONS: Record<AssistantView, typeof MessageSquare> = {
  chat: MessageSquare,
  memory: Brain,
  tasks: CheckSquare,
  automations: LayoutList,
  skills: BookMarked,
  projects: FolderKanban,
  stats: BarChart3,
  logs: ScrollText,
  settings: Settings2,
}

/**
 * The seven names as the bottom bar has to wear them: short enough that a tab's label still reads at the
 * width where labels are drawn at all, so the settings tab takes its common name rather than the full one.
 * The rail and the header keep the long name.
 */
const VIEW_TAB_LABELS: Record<AssistantView, MessageKey> = {
  chat: 'assistant.view.chat',
  memory: 'assistant.view.memory',
  tasks: 'assistant.view.tasks',
  automations: 'assistant.view.automations',
  skills: 'assistant.view.skills',
  projects: 'assistant.projects.title',
  stats: 'assistant.view.stats',
  logs: 'assistant.view.logs',
  settings: 'common.settings',
}

const VIEW_LABELS: Record<AssistantView, MessageKey> = {
  chat: 'assistant.view.chat',
  memory: 'assistant.view.memory',
  tasks: 'assistant.view.tasks',
  automations: 'assistant.view.automations',
  skills: 'assistant.view.skills',
  projects: 'assistant.projects.title',
  stats: 'assistant.view.stats',
  logs: 'assistant.view.logs',
  settings: 'assistant.view.settings',
}

export function ChatApp() {
  const view = useAssistant((state) => state.view)
  const setView = useAssistant((state) => state.setView)
  const bootstrap = useAssistant((state) => state.bootstrap)
  const loaded = useAssistant((state) => state.loaded)
  const error = useAssistant((state) => state.error)
  const agentName = useAssistant((state) => state.settings?.agentName)
  const chatScale = useAssistant((state) => state.settings?.chatScale ?? 1)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  const [pending, setPending] = useState(() => offlineQueueSize())

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  /**
   * Offline is a shelf, not an engine. While the tab has no connection an input surface may hand its
   * draft to OFFLINE_CAPTURE_EVENT; this container keeps the count on the banner, and on 'online' it
   * hands the queued text back through OFFLINE_REPLAY_EVENT for the composer to put in the input box.
   * It never sends a message, runs no local model, and stores no request body, key or provider.
   */
  useEffect(() => {
    const onOnline = () => {
      setOffline(false)
      const queued = readOfflineQueue()
      if (queued.length) {
        // One event with the drafts joined by a blank line, so a composer that replaces its box still
        // keeps every queued draft instead of only the last one.
        window.dispatchEvent(new CustomEvent(OFFLINE_REPLAY_EVENT, { detail: { text: queued.join('\n\n') } }))
        clearOfflineQueue()
      }
      setPending(0)
    }
    const onOffline = () => setOffline(true)
    const onCapture = (event: Event) => {
      const text = (event as CustomEvent<{ text?: unknown }>).detail?.text
      if (typeof text !== 'string') return
      setPending(enqueueOfflineText(text))
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener(OFFLINE_CAPTURE_EVENT, onCapture)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener(OFFLINE_CAPTURE_EVENT, onCapture)
    }
  }, [])

  /**
   * The door a push notice walks through.
   *
   * The notice carries no content — the payload is an empty shell, so it can only say that something is
   * waiting — which makes the press a request to be taken to where the waiting things are read. An open
   * page is told by message rather than navigated, because reloading over a push would cost a note that is
   * half written; a window opened from nothing carries the same intent in its address, since there is no
   * page to talk to yet. The address is cleaned afterwards, so a reload of the reader's own is not a second
   * opening of a centre they already closed.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('notifications') === '1') {
      params.delete('notifications')
      const query = params.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
      setNotificationsOpen(true)
    }
    const worker = navigator.serviceWorker
    if (!worker) return
    const onMessage = (event: MessageEvent): void => {
      if ((event.data as { type?: string } | null)?.type !== 'OPEN_NOTIFICATION_CENTER') return
      setNotificationsOpen(true)
    }
    worker.addEventListener('message', onMessage)
    return () => { worker.removeEventListener('message', onMessage) }
  }, [])

  const title = useMemo(() => (view === 'chat' ? agentName || t('assistant.app.title') : t(VIEW_LABELS[view])), [view, agentName])

  return (
    <section
      className="flex h-full min-h-0 overflow-hidden bg-[var(--bg-base)]"
      data-assistant-app="1"
      style={{ zoom: chatScale }}
    >
      {/* Below md the five sections move to the same bottom bar the notebook uses; a second 48px
          column beside the app rail would cost a quarter of a phone's width. */}
      <nav
        aria-label={t('assistant.app.navigation')}
        className="hidden h-full w-12 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] py-2 md:flex"
      >
        <div className="no-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
          {ASSISTANT_VIEWS.map((entry) => {
            const Icon = VIEW_ICONS[entry]
            const label = t(VIEW_LABELS[entry])
            const active = entry === view
            return (
              <Tooltip key={entry} label={label} side="right">
                <button
                  type="button"
                  aria-label={label}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setView(entry)}
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)]',
                    'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                    active
                      ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <Icon size={17} />
                </button>
              </Tooltip>
            )
          })}
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
          <span className="min-w-0 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">{title}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <NotificationsBell
              open={notificationsOpen}
              onOpen={() => setNotificationsOpen(true)}
              onClose={() => setNotificationsOpen(false)}
            />
          </div>
        </header>

        {offline && (
          <div role="status" className="border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('assistant.offline.banner' as MessageKey, { count: pending })}
          </div>
        )}

        {error && !loaded && (
          <div role="alert" className="border-b border-[var(--border-subtle)] bg-[color-mix(in_oklab,var(--danger)_12%,transparent)] px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
            {error}
          </div>
        )}

        {/* A research run belongs above whichever surface the reader walked to, because it is the one job
            this container drives across them; its steps, findings and retry live in its own banner. */}
        <DeepResearchProgress />

        <div className="min-h-0 flex-1 overflow-hidden">
          {view === 'chat' && <ChatView />}
          {view === 'memory' && <MemoryView />}
          {view === 'tasks' && <TasksView />}
          {view === 'automations' && <AutomationsView />}
          {view === 'skills' && <SkillsView />}
          {view === 'projects' && <ProjectsView />}
          {view === 'stats' && (
            <Suspense fallback={<LoadingBlock />}><RequestStatsView /></Suspense>
          )}
          {view === 'logs' && (
            <Suspense fallback={<LoadingBlock />}><RequestLogsView /></Suspense>
          )}
          {view === 'settings' && <AssistantSettingsView />}
        </div>

        {/* UI2-02: all seven surfaces stay one tap away, rather than four with a "More" door. The bar is
            always on screen, so a door would add a second gesture and an overlay to keep the focus honest
            just to reach tabs that already fit — 7 × 44px of touch target plus the bar's 24px of padding is
            332px, inside a 360px phone. What had to go was the notebook's 56px per-tab content minimum
            (7 × 56 + 24 = 416px), so the tabs use the chat's own scoped class, which drops the label under
            the width where seven no longer fit while `aria-label` and the header keep naming each surface. */}
        <nav
          aria-label={t('assistant.app.navigation')}
          className="mobile-bottom-nav flex h-[calc(64px+env(safe-area-inset-bottom))] shrink-0 items-stretch justify-around border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {ASSISTANT_VIEWS.map((entry) => {
            const Icon = VIEW_ICONS[entry]
            const label = t(VIEW_TAB_LABELS[entry])
            return (
              <button
                key={entry}
                type="button"
                aria-label={label}
                aria-current={entry === view ? 'page' : undefined}
                onClick={() => setView(entry)}
                className={cn(
                  'flex min-w-0 flex-1 items-center justify-center text-[length:var(--text-12)] transition-colors',
                  entry === view ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]',
                )}
              >
                <span className="chat-mobile-tab-content"><Icon size={17} /><span className="chat-mobile-tab-label">{label}</span></span>
              </button>
            )
          })}
        </nav>
        <MermaidViewer />
      </div>
    </section>
  )
}
