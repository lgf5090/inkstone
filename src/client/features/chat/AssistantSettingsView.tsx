/**
 * Assistant settings: the model it answers from, how it behaves, what it may spend, and what it keeps.
 *
 * The provider key is write-only from here. The form sends it once and never reads it back — the row
 * shows only whether a key is stored — because a key that comes back to the browser can be read by any
 * extension, any XSS, and any screenshot, and the assistant has no need of it on this side.
 */
import { useCallback, useEffect, useState } from 'react'
import { t } from '../../lib/i18n'
import { Spinner } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { useAssistant } from './assistant-store'
import { LoadFailure } from './assistant-settings-shared'
import { ModelTab } from './AssistantModelTab'
import { McpTab } from './AssistantMcpTab'
import { BehaviourTab } from './AssistantBehaviourTab'
import { MemoryTab } from './AssistantMemoryTab'
import { BudgetTab } from './AssistantBudgetTab'
import { DataTab } from './AssistantDataTab'

const TABS = ['model', 'mcp', 'behaviour', 'memory', 'budget', 'data'] as const
type Tab = (typeof TABS)[number]

export function AssistantSettingsView() {
  const settings = useAssistant((state) => state.settings)
  const loadSettings = useAssistant((state) => state.loadSettings)
  const [tab, setTab] = useState<Tab>('model')
  const [refused, setRefused] = useState(false)

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
        <Segmented
          size="sm"
          label={t('assistant.settings.title')}
          value={tab}
          onChange={setTab}
          options={TABS.map((entry) => ({ value: entry, label: t(`assistant.settings.tab.${entry}`) }))}
          className="self-start"
        />
        {tab === 'model' && <ModelTab settings={settings} />}
        {tab === 'mcp' && <McpTab />}
        {tab === 'behaviour' && <BehaviourTab settings={settings} />}
        {tab === 'memory' && <MemoryTab settings={settings} />}
        {tab === 'budget' && <BudgetTab settings={settings} />}
        {tab === 'data' && <DataTab />}
      </div>
    </div>
  )
}
