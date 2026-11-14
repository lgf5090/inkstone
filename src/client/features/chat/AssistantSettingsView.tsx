/**
 * Assistant settings: the model it answers from, how it behaves, what it may spend, and what it keeps.
 *
 * The provider key is write-only from here. The form sends it once and never reads it back — the row
 * shows only whether a key is stored — because a key that comes back to the browser can be read by any
 * extension, any XSS, and any screenshot, and the assistant has no need of it on this side.
 */
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Spinner } from '../../components/primitives'
import { useAssistant } from './assistant-store'
import { LoadFailure } from './assistant-settings-shared'
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

export function AssistantSettingsView() {
  const settings = useAssistant((state) => state.settings)
  const loadSettings = useAssistant((state) => state.loadSettings)
  const [tab, setTab] = useState<Tab>('model')
  const [refused, setRefused] = useState(false)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  // A tablist is one stop in the tab order, not nine: arrows, Home and End move the selected tab and
  // its focus together, which is the keyboard contract a set of plain buttons does not provide.
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const current = TABS.indexOf(tab)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? TABS.length - 1
        : event.key === 'ArrowRight' ? (current + 1) % TABS.length
          : event.key === 'ArrowLeft' ? (current - 1 + TABS.length) % TABS.length
            : -1
    if (next < 0) return
    event.preventDefault()
    setTab(TABS[next]!)
    tabRefs.current[next]?.focus()
  }

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
        <div className="mx-auto flex w-full max-w-[720px] px-4 py-5 md:px-8">
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
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-4 py-4 md:px-8">
        <div
          role="tablist"
          aria-label={t('assistant.settings.title')}
          className="no-scrollbar flex max-w-full shrink-0 gap-0.5 self-start overflow-x-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[3px]"
        >
          {TABS.map((entry) => {
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
          {tab === 'other' && <OtherTab settings={settings} />}
        </div>
      </div>
    </div>
  )
}
