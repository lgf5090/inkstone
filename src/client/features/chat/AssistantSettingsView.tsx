/**
 * Assistant settings: the model it answers from, how it behaves, what it may spend, and what it keeps.
 *
 * The provider key is write-only from here. The form sends it once and never reads it back — the row
 * shows only whether a key is stored — because a key that comes back to the browser can be read by any
 * extension, any XSS, and any screenshot, and the assistant has no need of it on this side.
 */
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { t, type MessageKey } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { api } from '../../lib/api'
import { Button, Spinner } from '../../components/primitives'
import { Input } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { useAssistant } from './assistant-store'
import { Group, LoadFailure } from './assistant-settings-shared'
import { formatInZone } from './time-format'
import { ShortcutSettings } from './shortcut-settings'
import { ModelTab } from './AssistantModelTab'
import { McpTab } from './AssistantMcpTab'
import { BehaviourTab } from './AssistantBehaviourTab'
import { MemoryTab } from './AssistantMemoryTab'
import { BudgetTab } from './AssistantBudgetTab'
import { DataTab } from './AssistantDataTab'
import { KnowledgeTab } from './AssistantKnowledgeTab'
import { WritingTab } from './AssistantWritingTab'
import { OtherTab } from './AssistantOtherTab'

const TABS = ['model', 'mcp', 'knowledge', 'writing', 'behaviour', 'memory', 'budget', 'data', 'other'] as const
type Tab = (typeof TABS)[number]

/**
 * The section titles a reader may type to reach a tab. The search filters the tab sections themselves,
 * not the rows inside a tab — a row lives in another file and this view only owns which section is open.
 */
const TAB_SEARCH_TERMS: Record<Tab, readonly MessageKey[]> = {
  model: ['assistant.settings.providers', 'assistant.settings.defaults'],
  mcp: ['assistant.mcp.servers'],
  knowledge: ['assistant.knowledge.index_settings'],
  writing: ['assistant.settings.writing_assist', 'assistant.settings.quick_ask'],
  behaviour: ['assistant.settings.identity', 'assistant.settings.compaction', 'assistant.settings.notifications'],
  memory: ['assistant.settings.memory', 'assistant.settings.semantic'],
  budget: ['assistant.settings.usage', 'assistant.settings.limits'],
  data: ['assistant.settings.files', 'assistant.settings.log_group', 'assistant.settings.config'],
  other: [
    'assistant.settings.interaction',
    'assistant.settings.debug',
    'assistant.settings.shortcuts' as MessageKey,
    'assistant.settings.security_audit' as MessageKey,
  ],
}

/** A tab matches when its own label, one of its section titles, or its id contains the typed words. */
function matchesTab(tab: Tab, query: string): boolean {
  const words = [t(`assistant.settings.tab.${tab}`), ...TAB_SEARCH_TERMS[tab].map((key) => t(key)), tab]
  return words.some((word) => word.toLowerCase().includes(query))
}

/** One line of the account's security audit, as the route reports it. */
interface AuditEvent {
  id: string
  kind: string
  summary: string
  sessionId: string
  ip: string
  userAgent: string
  createdAt: number
}

type AuditState =
  | { status: 'loading' }
  | { status: 'ready', events: AuditEvent[] }
  | { status: 'failed', detail: string | null }

/**
 * The timeline itself, mounted only while its section is open so opening the settings page does not
 * spend a request on an audit the reader may never look at. The route's `ip` is a hash and `userAgent`
 * is a raw client string: neither is printed, because the point of the timeline is the event, not a
 * second copy of connection metadata on the screen.
 */
function SecurityAuditTimeline() {
  const [state, setState] = useState<AuditState>({ status: 'loading' })

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const { events } = await api.assistant.securityAudit()
      setState({ status: 'ready', events })
    } catch (error) {
      setState({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (state.status === 'loading') return <LoadingBlock />
  if (state.status === 'failed') {
    return (
      <LoadFailure
        messageKey={'assistant.settings.security_audit_failed' as MessageKey}
        detail={state.detail}
        onRetry={() => void load()}
      />
    )
  }
  if (!state.events.length) {
    return (
      <p role="status" className="py-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t('assistant.settings.security_audit_empty' as MessageKey)}
      </p>
    )
  }
  return (
    <ul className="divide-y divide-[var(--border-subtle)]">
      {state.events.map((event) => (
        <li key={event.id} className="flex flex-col gap-0.5 py-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <time
              dateTime={new Date(event.createdAt).toISOString()}
              className="text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]"
            >
              {formatInZone(event.createdAt)}
            </time>
            <span className="rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[length:var(--text-10-5)] text-[var(--text-secondary)]">
              {event.kind}
            </span>
            <span
              aria-label={t('assistant.settings.security_audit_session' as MessageKey)}
              className="font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
            >
              {event.sessionId.slice(0, 8)}
            </span>
          </div>
          <p className="break-words text-[length:var(--text-12)] text-[var(--text-secondary)]">{event.summary}</p>
        </li>
      ))}
    </ul>
  )
}

function SecurityAuditSection() {
  const [open, setOpen] = useState(false)
  return (
    <Group title={t('assistant.settings.security_audit' as MessageKey)}>
      <div className="flex flex-col gap-2 py-3">
        <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
          {t('assistant.settings.security_audit_hint' as MessageKey)}
        </p>
        <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          {open
            ? t('assistant.settings.security_audit_hide' as MessageKey)
            : t('assistant.settings.security_audit_show' as MessageKey)}
        </Button>
        {open && <SecurityAuditTimeline />}
      </div>
    </Group>
  )
}

export function AssistantSettingsView() {
  const settings = useAssistant((state) => state.settings)
  const loadSettings = useAssistant((state) => state.loadSettings)
  const [tab, setTab] = useState<Tab>('model')
  const [query, setQuery] = useState('')
  const [refused, setRefused] = useState(false)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const trimmedQuery = query.trim().toLowerCase()
  const visibleTabs: readonly Tab[] = trimmedQuery
    ? TABS.filter((entry) => matchesTab(entry, trimmedQuery))
    : TABS

  // A tablist is one stop in the tab order: arrows, Home and End move the selected tab and its focus
  // together. They walk the filtered list, so a hidden section is never offered by the keyboard either.
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const current = visibleTabs.indexOf(tab)
    const last = visibleTabs.length - 1
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? last
        : event.key === 'ArrowRight' ? (current + 1) % visibleTabs.length
          : event.key === 'ArrowLeft' ? (current - 1 + visibleTabs.length) % visibleTabs.length
            : -1
    if (next < 0 || !visibleTabs.length) return
    event.preventDefault()
    const target = visibleTabs[next]!
    setTab(target)
    tabRefs.current[TABS.indexOf(target)]?.focus()
  }

  // A filter that hides the open section moves to the first match, so the panel never shows a section
  // the reader just filtered out. A filter with no match shows the empty state instead.
  useEffect(() => {
    if (!trimmedQuery) return
    const first = TABS.find((entry) => matchesTab(entry, trimmedQuery))
    if (first && !matchesTab(tab, trimmedQuery)) setTab(first)
  }, [trimmedQuery, tab])

  /**
   * A load that was refused has to be named, because the store cannot tell one from a load in flight:
   * `loadSettings` reports through a toast and leaves `settings` empty, and empty is exactly what the
   * spinner branch renders — so the reader watched a spinner for a reply that was never coming. The route
   * answers a successful load with settings, so still-empty once the await settles *is* the refusal.
   */
  const load = useCallback(async () => {
    setRefused(false)
    await loadSettings()
    setRefused(useAssistant.getState().settings === null)
  }, [loadSettings])

  useEffect(() => {
    void load()
  }, [load])

  if (!settings) {
    if (refused) {
      return (
        <div className="mx-auto flex w-full max-w-[var(--assistant-settings-width,720px)] px-4 py-5 md:px-8">
          <LoadFailure messageKey="assistant.settings.load_failed" onRetry={() => void load()} />
        </div>
      )
    }
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="no-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[var(--assistant-settings-width,720px)] flex-col gap-3 px-4 py-4 md:px-8">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('assistant.settings.search' as MessageKey)}
          aria-label={t('assistant.settings.search_label' as MessageKey)}
        />
        {visibleTabs.length > 0 && (
          <div
            role="tablist"
            aria-label={t('assistant.settings.title')}
            className="no-scrollbar flex max-w-full shrink-0 gap-0.5 self-start overflow-x-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-0-75)]"
          >
            {visibleTabs.map((entry) => {
              const active = entry === tab
              return (
                <button
                  key={entry}
                  ref={(node) => { tabRefs.current[TABS.indexOf(entry)] = node }}
                  id={`assistant-settings-tab-${entry}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls="assistant-settings-panel"
                  tabIndex={active ? 0 : -1}
                  onKeyDown={onTabKeyDown}
                  onClick={() => setTab(entry)}
                  className={cn(
                    'inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-[var(--r-sm)] px-2.5 text-[length:var(--text-11-5)] font-medium transition-[color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                    active
                      ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[var(--shadow-xs)]'
                      : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                  )}
                >
                  {t(`assistant.settings.tab.${entry}`)}
                </button>
              )
            })}
          </div>
        )}
        {visibleTabs.length === 0 ? (
          <p role="status" className="px-1 py-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('assistant.settings.search_empty' as MessageKey, { query })}
          </p>
        ) : (
          <div
            id="assistant-settings-panel"
            role="tabpanel"
            aria-labelledby={`assistant-settings-tab-${tab}`}
            className="min-w-0"
          >
            {tab === 'model' && <ModelTab settings={settings} />}
            {tab === 'mcp' && <McpTab />}
            {tab === 'knowledge' && <KnowledgeTab />}
            {tab === 'writing' && <WritingTab settings={settings} />}
            {tab === 'behaviour' && <BehaviourTab settings={settings} />}
            {tab === 'memory' && <MemoryTab settings={settings} />}
            {tab === 'budget' && <BudgetTab settings={settings} />}
            {tab === 'data' && <DataTab />}
            {tab === 'other' && (
              <>
                <OtherTab settings={settings} />
                <ShortcutSettings shortcuts={settings.shortcuts ?? {}} />
                <SecurityAuditSection />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
