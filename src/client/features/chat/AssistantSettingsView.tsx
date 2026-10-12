/**
 * Assistant settings: the model it answers from, how it behaves, what it may spend, and what it keeps.
 *
 * The provider key is write-only from here. The form sends it once and never reads it back — the row
 * shows only whether a key is stored — because a key that comes back to the browser can be read by any
 * extension, any XSS, and any screenshot, and the assistant has no need of it on this side.
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Download, KeyRound, Plus, Trash2, Upload } from 'lucide-react'
import type { AssistantLimits, AssistantProvider, AssistantSettings } from '@shared/assistant'
import { ASSISTANT_PROTOCOLS, LIMIT_RANGES, PROVIDER_PRESETS } from '@shared/assistant'
import { isValidTimeZone } from '@shared/assistant-schedule'
import { cn } from '../../lib/cn'
import { t, type MessageKey } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Field, Input, Segmented, Select, SettingRow, Slider, Switch } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'

const TABS = ['model', 'behaviour', 'memory', 'budget', 'data'] as const
type Tab = (typeof TABS)[number]

const PROTOCOL_LABELS: Record<string, () => string> = {
  openai: () => t('assistant.settings.protocol.openai'),
  anthropic: () => t('assistant.settings.protocol.anthropic'),
  gemini: () => t('assistant.settings.protocol.gemini'),
}

const IMPORT_KEYS: Record<string, 'assistant.settings.import_conversations' | 'assistant.settings.import_messages' | 'assistant.settings.import_memories' | 'assistant.settings.import_tasks' | 'assistant.settings.import_projects' | 'assistant.settings.import_automations' | 'assistant.settings.import_notifications'> = {
  conversations: 'assistant.settings.import_conversations',
  messages: 'assistant.settings.import_messages',
  memories: 'assistant.settings.import_memories',
  tasks: 'assistant.settings.import_tasks',
  projects: 'assistant.settings.import_projects',
  automations: 'assistant.settings.import_automations',
  notifications: 'assistant.settings.import_notifications',
}

const LIMIT_FIELDS: { key: keyof AssistantLimits, label: MessageKey, hint: MessageKey }[] = [
  { key: 'maxOutputTokens', label: 'assistant.settings.limit.output', hint: 'assistant.settings.limit.output_hint' },
  { key: 'maxContextTokens', label: 'assistant.settings.limit.context', hint: 'assistant.settings.limit.context_hint' },
  { key: 'maxToolCalls', label: 'assistant.settings.limit.tools', hint: 'assistant.settings.limit.tools_hint' },
  { key: 'maxAgentSteps', label: 'assistant.settings.limit.steps', hint: 'assistant.settings.limit.steps_hint' },
  { key: 'maxRequestsPerDay', label: 'assistant.settings.limit.requests', hint: 'assistant.settings.limit.requests_hint' },
  { key: 'maxScheduledRunsPerDay', label: 'assistant.settings.limit.scheduled', hint: 'assistant.settings.limit.scheduled_hint' },
]

export function AssistantSettingsView() {
  const settings = useAssistant((state) => state.settings)
  const loadSettings = useAssistant((state) => state.loadSettings)
  const [tab, setTab] = useState<Tab>('model')

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="no-scrollbar h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-5 md:px-8">
        <Segmented
          size="sm"
          label={t('assistant.settings.title')}
          value={tab}
          onChange={setTab}
          options={TABS.map((entry) => ({ value: entry, label: t(`assistant.settings.tab.${entry}`) }))}
          className="self-start"
        />
        {tab === 'model' && <ModelTab settings={settings} />}
        {tab === 'behaviour' && <BehaviourTab settings={settings} />}
        {tab === 'memory' && <MemoryTab settings={settings} />}
        {tab === 'budget' && <BudgetTab settings={settings} />}
        {tab === 'data' && <DataTab />}
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string, children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <p className="px-1 text-[10.5px] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{title}</p>
      <div className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3">
        {children}
      </div>
    </section>
  )
}

function ModelTab({ settings }: { settings: AssistantSettings }) {
  const providers = useAssistant((state) => state.providers)
  const models = useAssistant((state) => state.models)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const removeProvider = useAssistant((state) => state.removeProvider)
  const removeModel = useAssistant((state) => state.removeModel)
  const addModel = useAssistant((state) => state.addModel)
  const activateModel = useAssistant((state) => state.activateModel)
  const [addingProvider, setAddingProvider] = useState(false)
  const [addingModel, setAddingModel] = useState<AssistantProvider | null>(null)

  const byProvider = useMemo(() => providers.map((provider) => ({
    provider,
    models: models.filter((model) => model.providerId === provider.id),
  })), [providers, models])

  return (
    <>
      <Group title={t('assistant.settings.providers')}>
        {providers.length === 0 && (
          <p className="py-3 text-[12px] text-[var(--text-tertiary)]">{t('assistant.settings.no_providers')}</p>
        )}
        {byProvider.map(({ provider, models: list }) => (
          <div key={provider.id} className="flex flex-col gap-1 py-2.5">
            <div className="flex items-center gap-2">
              <KeyRound size={13} className={provider.hasKey ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]'} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--text-primary)]">{provider.label}</p>
                <p className="truncate text-[11px] text-[var(--text-quaternary)]">
                  {PROTOCOL_LABELS[provider.protocol]?.()} · {provider.baseUrl} · {provider.hasKey ? t('assistant.settings.key_stored') : t('assistant.settings.key_missing')}
                </p>
              </div>
              <IconButton label={t('assistant.settings.add_model')} size="xs" onClick={() => setAddingModel(provider)}>
                <Plus size={13} />
              </IconButton>
              <IconButton
                label={t('assistant.settings.delete_provider')}
                size="xs"
                onClick={() => {
                  void confirm({
                    title: t('assistant.settings.delete_provider'),
                    description: t('assistant.settings.delete_provider_hint', { label: provider.label }),
                    confirmLabel: t('assistant.settings.delete_provider'),
                    tone: 'danger',
                  }).then((yes) => {
                    if (yes) void removeProvider(provider.id)
                  })
                }}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
            {list.length === 0 ? (
              <p className="pl-6 text-[11px] text-[var(--text-quaternary)]">{t('assistant.settings.no_models')}</p>
            ) : (
              <ul className="flex flex-col gap-px pl-6">
                {list.map((model) => (
                  <li key={model.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={settings.activeModelId === model.id}
                      onClick={() => void activateModel(model.id)}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2 rounded-[var(--r-sm)] px-2 py-1 text-left text-[12.5px]',
                        settings.activeModelId === model.id
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <span aria-hidden className={cn('size-2 shrink-0 rounded-full border', settings.activeModelId === model.id ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border-strong)]')} />
                      <span className="min-w-0 flex-1 truncate">{model.label}</span>
                      <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-quaternary)]">{model.model}</span>
                    </button>
                    <IconButton label={t('assistant.settings.delete_model')} size="xs" onClick={() => void removeModel(model.id)}>
                      <Trash2 size={12} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <div className="flex justify-end py-2.5">
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setAddingProvider(true)}>
            {t('assistant.settings.add_provider')}
          </Button>
        </div>
      </Group>

      <Group title={t('assistant.settings.mode')}>
        <SettingRow title={t('assistant.settings.offline')} description={t('assistant.settings.offline_hint')}>
          <Switch checked={settings.offlineMode} onChange={(value) => void saveSettings({ offlineMode: value })} label={t('assistant.settings.offline')} />
        </SettingRow>
      </Group>

      <ProviderForm open={addingProvider} onClose={() => setAddingProvider(false)} />
      <ModelForm provider={addingModel} onClose={() => setAddingModel(null)} onAdd={addModel} />
    </>
  )
}

function ProviderForm({ open, onClose }: { open: boolean, onClose: () => void }) {
  const addProvider = useAssistant((state) => state.addProvider)
  const [preset, setPreset] = useState(PROVIDER_PRESETS[0]!.id)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS[0]!.baseUrl)
  const [protocol, setProtocol] = useState<string>(PROVIDER_PRESETS[0]!.protocol)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState(PROVIDER_PRESETS[0]!.models.join(', '))
  const chosen = PROVIDER_PRESETS.find((entry) => entry.id === preset) ?? PROVIDER_PRESETS[0]!

  useEffect(() => {
    if (!open) return
    setLabel(chosen.label)
    setBaseUrl(chosen.baseUrl)
    setProtocol(chosen.protocol)
    setModels(chosen.models.join(', '))
    setApiKey('')
  }, [open, chosen])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('assistant.settings.add_provider')}
      width={520}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            disabled={!label.trim() || !baseUrl.trim()}
            onClick={() => {
              void addProvider({
                label: label.trim(),
                protocol,
                baseUrl: baseUrl.trim(),
                apiKey: apiKey.trim(),
                models: models.split(',').map((entry) => entry.trim()).filter(Boolean),
              }).then(onClose)
            }}
          >
            {t('assistant.settings.add_provider')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('assistant.settings.preset')}>
          <Select
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
          >
            {PROVIDER_PRESETS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </Select>
        </Field>
        <Field label={t('assistant.settings.provider_name')}>
          <Input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label={t('assistant.settings.protocol')}>
          <Select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
            {ASSISTANT_PROTOCOLS.map((entry) => <option key={entry} value={entry}>{PROTOCOL_LABELS[entry]?.()}</option>)}
          </Select>
        </Field>
        <Field label={t('assistant.settings.base_url')} hint={t('assistant.settings.base_url_hint')}>
          <Input value={baseUrl} maxLength={300} onChange={(event) => setBaseUrl(event.target.value)} className="font-mono text-[12px]" />
        </Field>
        <Field label={t('assistant.settings.api_key')} hint={t('assistant.settings.api_key_hint')}>
          <Input
            type="password"
            value={apiKey}
            maxLength={4096}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            className="font-mono text-[12px]"
          />
        </Field>
        <Field label={t('assistant.settings.models')} hint={t('assistant.settings.models_hint')}>
          <Input value={models} onChange={(event) => setModels(event.target.value)} className="font-mono text-[12px]" />
        </Field>
      </div>
    </Modal>
  )
}

function ModelForm({ provider, onClose, onAdd }: { provider: AssistantProvider | null, onClose: () => void, onAdd: (body: Record<string, unknown>) => Promise<void> }) {
  const [model, setModel] = useState('')
  useEffect(() => {
    setModel('')
  }, [provider])
  return (
    <Modal
      open={!!provider}
      onClose={onClose}
      title={t('assistant.settings.add_model')}
      width={420}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            disabled={!model.trim()}
            onClick={() => {
              if (!provider) return
              void onAdd({ providerId: provider.id, model: model.trim() }).then(onClose)
            }}
          >
            {t('assistant.settings.add_model')}
          </Button>
        </>
      )}
    >
      <Field label={t('assistant.settings.model_id')} hint={provider?.baseUrl}>
        <Input value={model} maxLength={120} autoFocus onChange={(event) => setModel(event.target.value)} className="font-mono text-[12px]" />
      </Field>
    </Modal>
  )
}

function BehaviourTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [name, setName] = useState(settings.agentName)
  useEffect(() => setName(settings.agentName), [settings.agentName])
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zones = useMemo(() => {
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserZone]
    return list.includes(settings.timezone) ? list : [settings.timezone, ...list]
  }, [browserZone, settings.timezone])

  return (
    <>
      <Group title={t('assistant.settings.identity')}>
        <SettingRow title={t('assistant.settings.agent_name')} description={t('assistant.settings.agent_name_hint')}>
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (name.trim() && name !== settings.agentName) void saveSettings({ agentName: name.trim() })
            }}
          >
            <Input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} className="h-8 w-44 text-[12.5px]" />
            <Button type="submit" size="sm" variant="secondary" disabled={!name.trim() || name === settings.agentName}>
              {t('common.save')}
            </Button>
          </form>
        </SettingRow>
        <SettingRow title={t('assistant.settings.language')} description={t('assistant.settings.language_hint')}>
          <Segmented
            size="sm"
            label={t('assistant.settings.language')}
            value={settings.language}
            onChange={(value) => void saveSettings({ language: value })}
            options={[
              { value: 'en-US', label: t('settings.english') },
              { value: 'zh-CN', label: t('settings.simplified_chinese') },
            ]}
          />
        </SettingRow>
        <SettingRow
          title={t('assistant.settings.timezone')}
          description={settings.timezone !== browserZone
            ? t('assistant.settings.timezone_use_device', { zone: browserZone })
            : t('assistant.settings.timezone_hint')}
        >
          <div className="flex items-center gap-2">
            {settings.timezone !== browserZone && isValidTimeZone(browserZone) && (
              <Button size="sm" variant="ghost" onClick={() => void saveSettings({ timezone: browserZone })}>
                {t('assistant.settings.timezone_detect')}
              </Button>
            )}
            <Select value={settings.timezone} onChange={(event) => void saveSettings({ timezone: event.target.value })} className="max-w-[220px]">
              {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </Select>
          </div>
        </SettingRow>
      </Group>

      <Group title={t('assistant.settings.behaviour')}>
        <SettingRow title={t('assistant.settings.send_enter')} description={t('assistant.settings.send_enter_hint')}>
          <Switch checked={settings.sendOnEnter} onChange={(value) => void saveSettings({ sendOnEnter: value })} label={t('assistant.settings.send_enter')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.start_view')} description={t('assistant.settings.start_view_hint')}>
          <Select value={settings.startView} onChange={(event) => void saveSettings({ startView: event.target.value })}>
            <option value="chat">{t('assistant.view.chat')}</option>
            <option value="memory">{t('assistant.view.memory')}</option>
            <option value="tasks">{t('assistant.view.tasks')}</option>
            <option value="automations">{t('assistant.view.automations')}</option>
            <option value="settings">{t('assistant.view.settings')}</option>
          </Select>
        </SettingRow>
      </Group>
    </>
  )
}

function MemoryTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  return (
    <>
      <Group title={t('assistant.settings.memory')}>
        <SettingRow title={t('assistant.settings.auto_memory')} description={t('assistant.settings.auto_memory_hint')}>
          <Switch checked={settings.autoMemory} onChange={(value) => void saveSettings({ autoMemory: value })} label={t('assistant.settings.auto_memory')} />
        </SettingRow>
        <SettingRow title={t('assistant.settings.conflict_review')} description={t('assistant.settings.conflict_review_hint')}>
          <Switch checked={settings.conflictReview} onChange={(value) => void saveSettings({ conflictReview: value })} label={t('assistant.settings.conflict_review')} />
        </SettingRow>
        {settings.conflictReview && (
          <SettingRow title={t('assistant.settings.ai_conflict')} description={t('assistant.settings.ai_conflict_hint')}>
            <Switch checked={settings.aiConflictCheck} onChange={(value) => void saveSettings({ aiConflictCheck: value })} label={t('assistant.settings.ai_conflict')} />
          </SettingRow>
        )}
      </Group>
      <SemanticRecallRow settings={settings} />
      <NoteScopeRow />
    </>
  )
}

/**
 * The vector index over the reader's memories.
 *
 * The switch is a settings field, so it saves like any other; the numbers come from the server
 * because only it knows how many vectors exist and what the deployment can embed.
 */
function SemanticRecallRow({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.assistant.semantic>> | null>(null)
  const [busy, setBusy] = useState<'reindex' | 'clear' | null>(null)
  const toast = useUi((state) => state.toast)

  const refresh = async () => {
    try {
      setStatus(await api.assistant.semantic())
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <Group title={t('assistant.settings.semantic')}>
      <SettingRow title={t('assistant.settings.semantic')} description={t('assistant.settings.semantic_hint')}>
        <Switch
          checked={settings.semanticMemory}
          onChange={(value) => void saveSettings({ semanticMemory: value })}
          label={t('assistant.settings.semantic')}
        />
      </SettingRow>
      {!status ? (
        <p className="px-3 pb-2 text-[11.5px] text-[var(--text-quaternary)]">…</p>
      ) : !status.available ? (
        <p className="px-3 pb-2 text-[11.5px] text-[var(--text-tertiary)]">{t('assistant.settings.semantic_off')}</p>
      ) : (
        <>
          <SettingRow
            title={t('assistant.settings.semantic_vectors', { count: status.vectors })}
            description={[
              status.pending > 0 ? t('assistant.settings.semantic_pending', { count: status.pending }) : '',
              t('assistant.settings.semantic_today', { used: status.today, cap: status.cap }),
            ].filter(Boolean).join(' · ')}
          >
            <div className="flex shrink-0 gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null || status.pending === 0}
                onClick={() => {
                  setBusy('reindex')
                  void api.assistant.reindexSemantic().then((result) => {
                    toast({
                      title: result.embedded
                        ? t('assistant.settings.semantic_done', { count: result.embedded })
                        : result.capped ? t('assistant.settings.semantic_capped') : t('assistant.settings.semantic_none'),
                      tone: 'success',
                    })
                    return refresh()
                  }).catch((error) => toast({ title: error instanceof Error ? error.message : String(error), tone: 'danger' }))
                    .finally(() => setBusy(null))
                }}
              >
                {t('assistant.settings.semantic_reindex')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null || status.vectors === 0}
                onClick={() => {
                  setBusy('clear')
                  void confirm({
                    title: t('assistant.settings.semantic_clear'),
                    description: t('assistant.settings.semantic_clear_hint'),
                    confirmLabel: t('assistant.settings.semantic_clear'),
                    tone: 'danger',
                  }).then(async (yes) => {
                    if (yes) await api.assistant.clearSemantic()
                    await refresh()
                  }).finally(() => setBusy(null))
                }}
              >
                {t('assistant.settings.semantic_clear')}
              </Button>
            </div>
          </SettingRow>
          <p className="px-3 pb-2 text-[11px] text-[var(--text-quaternary)]">{status.model}</p>
        </>
      )}
    </Group>
  )
}

function NoteScopeRow() {
  const settings = useAssistant((state) => state.settings)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [folders, setFolders] = useState<{ id: string, path: string }[]>([])

  useEffect(() => {
    void api.folders.list().then((result) => {
      // The list is a flat set of parent pointers; the scope is read by a person, so show the path.
      const byId = new Map(result.folders.map((folder) => [folder.id, folder]))
      const pathOf = (id: string): string => {
        const parts: string[] = []
        let cursor = byId.get(id)
        for (let depth = 0; cursor && depth < 12; depth++) {
          parts.unshift(cursor.name)
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
        }
        return parts.join(' / ')
      }
      setFolders(result.folders.map((folder) => ({ id: folder.id, path: pathOf(folder.id) })))
    }).catch(() => setFolders([]))
  }, [])

  const scope = settings?.noteScope ?? []
  const toggle = (id: string) => {
    const next = scope.includes(id) ? scope.filter((entry) => entry !== id) : [...scope, id]
    void saveSettings({ noteScope: next.slice(0, 12) })
  }

  return (
    <Group title={t('assistant.settings.note_scope')}>
      <div className="py-3">
        <p className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">{t('assistant.settings.note_scope_hint')}</p>
        {folders.length === 0 ? (
          <p className="mt-2 text-[11.5px] text-[var(--text-quaternary)]">{t('assistant.settings.note_scope_none')}</p>
        ) : (
          <ul className="mt-2 flex max-h-52 flex-col gap-px overflow-y-auto">
            {folders.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  aria-pressed={scope.includes(folder.id)}
                  onClick={() => toggle(folder.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1 text-left text-[12.5px]',
                    scope.includes(folder.id)
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <span aria-hidden className={cn('size-2 shrink-0 rounded-full border', scope.includes(folder.id) ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border-strong)]')} />
                  <span className="min-w-0 truncate">{folder.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Group>
  )
}

function BudgetTab({ settings }: { settings: AssistantSettings }) {
  const saveSettings = useAssistant((state) => state.saveSettings)
  const [limits, setLimits] = useState<AssistantLimits>(settings.limits)
  const [temperature, setTemperature] = useState(settings.temperature)
  const [usage, setUsage] = useState<{ today: Record<string, number>, last7Days: Record<string, number> } | null>(null)
  const dirty = useMemo(
    () => JSON.stringify(limits) !== JSON.stringify(settings.limits) || temperature !== settings.temperature,
    [limits, settings.limits, temperature],
  )

  useEffect(() => {
    void api.assistant.usage().then((result) => {
      setUsage({ today: result.today as unknown as Record<string, number>, last7Days: result.last7Days as unknown as Record<string, number> })
    }).catch(() => setUsage(null))
  }, [])

  return (
    <>
      <Group title={t('assistant.settings.usage')}>
        {!usage ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : (
          <div className="grid grid-cols-2 gap-2 py-3 md:grid-cols-4">
            {[
              [t('assistant.settings.usage_requests'), `${usage.today.requests} / ${settings.limits.maxRequestsPerDay}`],
              [t('assistant.settings.usage_tokens'), ((usage.today.inputTokens ?? 0) + (usage.today.outputTokens ?? 0)).toLocaleString()],
              [t('assistant.settings.usage_tools'), String(usage.today.toolCalls ?? 0)],
              [t('assistant.settings.usage_scheduled'), `${usage.today.scheduledRuns ?? 0} / ${settings.limits.maxScheduledRunsPerDay}`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2">
                <p className="text-[10.5px] text-[var(--text-quaternary)]">{label}</p>
                <p className="mt-0.5 text-[15px] font-semibold tabular text-[var(--text-primary)]">{value}</p>
              </div>
            ))}
            <p className="col-span-2 text-[11px] leading-relaxed text-[var(--text-quaternary)] md:col-span-4">
              {t('assistant.settings.usage_note', { week: usage.last7Days.requests ?? 0, errors: usage.last7Days.errors ?? 0 })}
            </p>
          </div>
        )}
      </Group>

      <Group title={t('assistant.settings.limits')}>
        <SettingRow title={t('assistant.settings.temperature')} description={t('assistant.settings.temperature_hint')}>
          <Slider
            value={temperature}
            min={0}
            max={1.5}
            step={0.1}
            onChange={setTemperature}
            label={t('assistant.settings.temperature')}

          />
        </SettingRow>
        {LIMIT_FIELDS.map((entry) => {
          const [min, max] = LIMIT_RANGES[entry.key]
          return (
            <SettingRow key={entry.key} title={t(entry.label)} description={t(entry.hint)}>
              <Input
                type="number"
                min={min}
                max={max}
                value={limits[entry.key]}
                onChange={(event) => setLimits({ ...limits, [entry.key]: Number(event.target.value) })}
                className="h-8 w-28 text-[12.5px]"
              />
            </SettingRow>
          )
        })}
        <div className="flex justify-end gap-2 py-3">
          <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => { setLimits(settings.limits); setTemperature(settings.temperature) }}>
            {t('assistant.settings.revert')}
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void saveSettings({ limits, temperature })}>
            {t('common.save')}
          </Button>
        </div>
      </Group>
    </>
  )
}

function DataTab() {
  const [importing, setImporting] = useState(false)
  const [file, setFile] = useState<File | null>(null)

  /**
   * The summary is read back from the server rather than counted here, so the toast cannot claim a
   * merge that did not happen; the skipped notes are what an imported file was not allowed to change.
   */
  const runImport = async () => {
    if (!file) return
    setImporting(true)
    try {
      const payload = JSON.parse(await file.text())
      const result = await api.assistant.importBackup(payload)
      const counts = Object.entries(result.imported)
        .filter(([key, value]) => key !== 'skipped' && typeof value === 'number' && (value as number) > 0)
        .map(([key, value]) => t(IMPORT_KEYS[key] ?? 'assistant.settings.import_items', { count: value as number }))
      const notes = result.imported.skipped ?? []
      useUi.getState().toast({
        title: counts.length ? counts.join(' · ') : t('assistant.settings.import_nothing'),
        description: notes.length ? notes.join('; ') : undefined,
        tone: 'success',
        duration: 8000,
      })
      await useAssistant.getState().bootstrap(true)
    } catch (error) {
      useUi.getState().toast({
        title: error instanceof SyntaxError ? t('assistant.settings.import_bad_json') : t('assistant.toast.failed'),
        tone: 'danger',
      })
    } finally {
      setImporting(false)
      setFile(null)
    }
  }

  return (
    <>
      <Group title={t('assistant.settings.data')}>
        <SettingRow title={t('assistant.settings.export')} description={t('assistant.settings.export_hint')}>
          <a
            href={api.assistant.exportUrl}
            download="inkstone-assistant-backup.json"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <Download size={14} />
            {t('assistant.settings.export')}
          </a>
        </SettingRow>
        <SettingRow title={t('assistant.settings.import')} description={t('assistant.settings.import_hint')}>
          <div className="flex items-center gap-1.5">
            <input
              type="file"
              accept="application/json,.json"
              aria-label={t('assistant.settings.import')}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="max-w-[170px] text-[11px] text-[var(--text-tertiary)]"
            />
            <Button size="sm" variant="secondary" loading={importing} disabled={!file} onClick={() => void runImport()}>
              <Upload size={14} />
              {t('assistant.settings.import')}
            </Button>
          </div>
        </SettingRow>
      </Group>

      <Group title={t('assistant.settings.danger')}>
        <SettingRow title={t('assistant.settings.clear_chats')} description={t('assistant.settings.clear_chats_hint')}>
          <Button
            size="sm"
            variant="secondary"
            className="text-[var(--danger)]"
            onClick={() => {
              void confirm({
                title: t('assistant.settings.clear_chats'),
                description: t('assistant.settings.clear_danger_hint'),
                confirmLabel: t('assistant.settings.clear_chats'),
                tone: 'danger',
              }).then(async (yes) => {
                if (!yes) return
                await api.assistant.deleteConversations()
                useAssistant.getState().bootstrap(true)
              })
            }}
          >
            {t('assistant.settings.clear_chats')}
          </Button>
        </SettingRow>
        <SettingRow title={t('assistant.settings.clear_memories')} description={t('assistant.settings.clear_memories_hint')}>
          <Button
            size="sm"
            variant="secondary"
            className="text-[var(--danger)]"
            onClick={() => {
              void confirm({
                title: t('assistant.settings.clear_memories'),
                description: t('assistant.settings.clear_danger_hint'),
                confirmLabel: t('assistant.settings.clear_memories'),
                tone: 'danger',
              }).then(async (yes) => {
                if (!yes) return
                await api.assistant.clearMemories()
                await useAssistant.getState().loadMemories()
              })
            }}
          >
            {t('assistant.settings.clear_memories')}
          </Button>
        </SettingRow>
      </Group>
    </>
  )
}
