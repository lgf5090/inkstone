/**
 * The model tab: which provider answers, and which of its models are on.
 *
 * The provider rows and the add-provider form are one surface, because the form is how a provider
 * arrives — including the question it asks the vendor before anything is saved, so the ids it stores are
 * the ones that key can really call rather than a preset's guess.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AudioLines, Brain, Check, ChevronDown, Download, Eye, EyeOff, GalleryVerticalEnd, Image, KeyRound, MoreHorizontal, Plus, Power, Search, Settings2, Trash2, Wand2, Wrench } from 'lucide-react'
import { type AssistantKeyProbe, type AssistantKeyProbeOutcome, type AssistantKeyProbeReason, type AssistantModel, type AssistantModelKind, type AssistantModelPurpose, type AssistantProtocol, type AssistantProvider, type AssistantSettings, type ReasoningDialect } from '@shared/assistant'
import { ASSISTANT_PROTOCOLS, MAX_PROVIDER_KEYS, PROVIDER_PRESETS, endpointFieldState, parseProviderKeys } from '@shared/assistant'
import { iconForModel, iconForProvider } from '@shared/assistant-icons'
import { dialectsForProtocol } from '@shared/reasoning'
import { AssistantIcon } from './AssistantIcon'
import { AssistantIconField } from './AssistantIconPicker'
import { ModelEditorDialog } from './ModelEditorDialog'
import { ModelPickerDialog } from './ModelPickerDialog'
import { ProviderKeys, useProviderBalances, WalletChips } from './ProviderKeys'
import { cn } from '../../lib/cn'
import { api } from '../../lib/api'
import { matchesQuery } from '../../lib/fuzzy'
import { t, type MessageKey } from '../../lib/i18n'
import { Button, Divider, IconButton } from '../../components/primitives'
import { Field, Input, Select, SettingRow, Switch, Textarea, useRovingRadio } from '../../components/form'
import { Menu, Modal, Tooltip, confirm, useClickOutside, useEscape, type MenuItem } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useAssistant, type ReportFailure, type WriteFailure } from './assistant-store'
import { DIALECT_LABELS, Group, modelOptionLabel, PROTOCOL_LABELS, SaveFailure, refusalFor, storedKeyLabel } from './assistant-settings-shared'

/**
 * One model in the choice: the radio, a short read-only account of what it can do, and one menu holding
 * every control that changes it. Six unlabelled icons in a row could not say which was a switch, which
 * was pressed and which was about to delete the row; the words and the checked menu rows do, and the
 * row keeps a single extra tab stop.
 */
function ModelRow({ provider, model, active, itemRef, tabIndex, keyHandler, onEdit }: {
  provider: AssistantProvider
  model: AssistantModel
  active: boolean
  itemRef: (element: HTMLButtonElement | null) => void
  tabIndex: 0 | -1
  keyHandler: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
  onEdit: (model: AssistantModel) => void
}) {
  const activateModel = useAssistant((state) => state.activateModel)
  const updateModel = useAssistant((state) => state.updateModel)
  const removeModel = useAssistant((state) => state.removeModel)
  const [menuOpen, setMenuOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const mark = specialMark(model)
  const capabilities = [
    model.reasoning !== 'off' ? t('assistant.model.reasoning_short') : null,
    model.supportsTools ? t('assistant.model.tools_short') : null,
    model.vision ? t('assistant.model.vision_short') : null,
  ].filter((label): label is string => label !== null)
  const optionsLabel = t('assistant.chat.options', { title: model.label })

  const remove = () => {
    // Deleting a model is one click from a row of them and there is no way back: its turns keep the
    // label but the fallback chain that named it stops one model short.
    void confirm({
      title: t('assistant.settings.delete_model'),
      description: t('assistant.settings.delete_model_hint', { label: model.label }),
      confirmLabel: t('assistant.settings.delete_model'),
      tone: 'danger',
    }).then((yes) => { if (yes) void removeModel(model.id) })
  }

  const items: MenuItem[] = [
    { id: 'edit', label: t('assistant.model.edit'), icon: <Settings2 size={13} />, onSelect: () => onEdit(model) },
    {
      id: 'reasoning', label: t('assistant.model.reasoning_short'), icon: <Brain size={13} />,
      checked: model.reasoning !== 'off', separatorBefore: true,
      onSelect: () => void updateModel(model.id, { reasoning: model.reasoning === 'off' ? 'auto' : 'off' }),
    },
    {
      id: 'tools', label: t('assistant.model.tools_short'), icon: <Wrench size={13} />,
      checked: model.supportsTools,
      onSelect: () => void updateModel(model.id, { supportsTools: !model.supportsTools }),
    },
    {
      id: 'vision', label: t('assistant.model.vision_short'), icon: <Eye size={13} />,
      checked: model.vision,
      onSelect: () => void updateModel(model.id, { vision: !model.vision }),
    },
    {
      id: 'shown', label: t('assistant.model.shown'), icon: <Power size={13} />,
      checked: model.enabled,
      onSelect: () => void updateModel(model.id, { enabled: !model.enabled }),
    },
    {
      id: 'delete', label: t('assistant.settings.delete_model'), icon: <Trash2 size={13} />,
      tone: 'danger', separatorBefore: true, onSelect: remove,
    },
  ]

  return (
    <div className={cn(
      'relative flex items-center rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5',
      'transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
      active ? 'bg-[var(--accent-softer)]' : 'hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)]',
    )}>
      {/* The default is named by a bar and a word; danger red on this screen belongs to failures. */}
      {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[var(--sp-0-75)] rounded-r-[var(--r-sm)] bg-[var(--accent)]" />}
      <button
        ref={itemRef}
        type="button"
        role="radio"
        aria-checked={active}
        tabIndex={tabIndex}
        onKeyDown={keyHandler}
        onClick={() => void activateModel(model.id)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left text-[length:var(--text-12-5)]',
          active ? 'text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)]',
        )}
      >
        <AssistantIcon
          value={iconForModel(model, provider)}
          size={20}
          className={active ? 'ring-1 ring-[var(--accent)]' : undefined}
        />
        {mark && (
          <Tooltip label={t(mark.key)}>
            <span aria-hidden className="shrink-0 text-[var(--text-quaternary)]">{mark.icon}</span>
          </Tooltip>
        )}
        <span className="min-w-0 flex-1 truncate">{model.label}</span>
        {active && (
          <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-1.5 text-[length:var(--text-10-5)] text-[var(--accent-on-soft)]">
            {t('assistant.model.default')}
          </span>
        )}
        <span className="hidden shrink-0 font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)] md:block">{model.model}</span>
      </button>
      {/* Read-only words: a capability is no longer something a colour has to say on its own. */}
      {capabilities.length > 0 && (
        <span className="ml-1 hidden max-w-[120px] shrink-0 truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)] lg:block">
          {capabilities.join(' · ')}
        </span>
      )}
      <span ref={anchor} className="ink-model-options ml-1 shrink-0">
        <IconButton label={optionsLabel} size="sm" onClick={() => setMenuOpen((open) => !open)}>
          <MoreHorizontal size={14} />
        </IconButton>
      </span>
      <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} label={optionsLabel} />
    </div>
  )
}

/**
 * The mark a model wears when it is not a plain text chat model.
 *
 * A picture generator sitting in a list of chat models is the one thing the name alone does not say, and
 * the row has no words left for it. Null for the ordinary case, so the icons that mean something are the
 * only ones drawn.
 */
function specialMark(model: AssistantModel): { key: MessageKey, icon: React.ReactNode } | null {
  const purpose: Partial<Record<AssistantModelPurpose, { key: MessageKey, icon: React.ReactNode }>> = {
    image_generate: { key: 'assistant.model.purpose.image_generate', icon: <Image size={12} /> },
    image_edit: { key: 'assistant.model.purpose.image_edit', icon: <Wand2 size={12} /> },
    realtime: { key: 'assistant.model.purpose.realtime', icon: <AudioLines size={12} /> },
  }
  const kind: Partial<Record<AssistantModelKind, { key: MessageKey, icon: React.ReactNode }>> = {
    embedding: { key: 'assistant.model.kind.embedding', icon: <GalleryVerticalEnd size={12} /> },
    rerank: { key: 'assistant.model.kind.rerank', icon: <GalleryVerticalEnd size={12} /> },
  }
  return purpose[model.purpose] ?? kind[model.kind] ?? null
}

/**
 * The id a provider's own name wears.
 *
 * Derived from the provider id rather than from `useId`, because the name and the list of models it labels
 * are rendered by two components and a screen reader needs one address for both.
 */
const providerLabelId = (providerId: string): string => `assistant-provider-${providerId}`

/**
 * The extra addresses a saved provider carries, minus the one for the wire it is called on.
 *
 * The form draws boxes for the *other* protocols only, so an entry for the provider's own protocol is
 * one it can neither show nor clear. Left in the draft, such a value was still judged and sent: an
 * invalid one disabled the save over a box that was not on screen, and a stored one could be refused
 * by the route under a field the reader had no way to reach.
 */
function otherEndpoints(
  endpoints: Partial<Record<AssistantProtocol, string>>,
  protocol: AssistantProtocol,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [entry, url] of Object.entries(endpoints)) {
    if (entry !== protocol && typeof url === 'string') out[entry] = url
  }
  return out
}

/**
 * One provider's models, as the choice between them that it is.
 *
 * Activating a model picks exactly one of the row, and every row already says so with `role="radio"`. What
 * was missing is the group those radios belong to: its name, one stop in the tab order instead of one per
 * model, and the arrows that move the choice. `useRovingRadio` is the helper the segmented control already
 * uses, so the keys mean the same thing here as they do everywhere else in the app.
 */
function ModelList({ provider, models, activeModelId, labelId, onEdit }: {
  provider: AssistantProvider
  models: readonly AssistantModel[]
  activeModelId: string | null
  /** The id of the provider's own name, which is what labels this group. */
  labelId: string
  onEdit: (model: AssistantModel) => void
}) {
  const activateModel = useAssistant((state) => state.activateModel)
  const roving = useRovingRadio(models.map((model) => model.id), activeModelId ?? '', (id) => void activateModel(id))
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-1 pl-9">
      {models.map((model, index) => (
        <ModelRow
          key={model.id}
          provider={provider}
          model={model}
          active={activeModelId === model.id}
          itemRef={roving.setItemRef(index)}
          tabIndex={roving.tabIndexFor(index)}
          keyHandler={roving.keyHandlerFor(index)}
          onEdit={onEdit}
        />
      ))}
    </div>
  )
}

/**
 * One provider's card: its own row, the keys it rotates through, and the models switched on under it.
 *
 * The card is the smallest thing that can answer "what is this provider worth to me", which is why the
 * balance lives here rather than in the tab: one read of the wallet feeds the chips in the header and the
 * rows in the ring below, so the two can never show two different numbers for the same key.
 */
function ProviderCard({ provider, models, activeModelId, onEditProvider, onPickModels, onAddModel, onEditModel }: {
  provider: AssistantProvider
  models: AssistantModel[]
  activeModelId: string | null
  onEditProvider: (provider: AssistantProvider) => void
  onPickModels: (provider: AssistantProvider) => void
  onAddModel: (provider: AssistantProvider) => void
  onEditModel: (model: AssistantModel) => void
}) {
  const removeProvider = useAssistant((state) => state.removeProvider)
  const wallet = useProviderBalances(provider)
  const [hasFailedKey, setHasFailedKey] = useState(false)
  const onProbes = useCallback((probes: AssistantKeyProbe[]) => {
    setHasFailedKey(probes.some((entry) => entry.outcome === 'failed'))
  }, [])

  return (
    <div className={cn(
      'flex flex-col gap-1.5 rounded-[var(--r-md)] border border-transparent py-3',
      hasFailedKey && 'border-[color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[color-mix(in_oklab,var(--danger)_5%,transparent)]',
    )}>
      <div className="flex items-center gap-2.5">
        {/* The brand says who answers; the small key badge keeps the one fact about this provider that
            costs a round trip to learn without taking the vendor's mark away. */}
        <span className="relative shrink-0">
          <AssistantIcon value={iconForProvider(provider)} size={28} />
          <span
            aria-hidden
            className={cn(
              'absolute -bottom-1 -right-1 flex size-3.5 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)]',
              provider.hasKey ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]',
            )}
          >
            <KeyRound size={9} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p id={providerLabelId(provider.id)} className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{provider.label}</p>
          <p className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
            {PROTOCOL_LABELS[provider.protocol]?.()} · {provider.baseUrl} · {storedKeyLabel(provider)}
          </p>
        </div>
        <WalletChips wallet={wallet} />
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label={t('assistant.settings.edit_provider')} size="xs" onClick={() => onEditProvider(provider)}>
            <Settings2 size={13} />
          </IconButton>
          <IconButton label={t('assistant.picker.open')} size="xs" onClick={() => onPickModels(provider)}>
            <Download size={13} />
          </IconButton>
          <IconButton label={t('assistant.settings.add_model')} size="xs" onClick={() => onAddModel(provider)}>
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
      </div>
      <ProviderKeys provider={provider} wallet={wallet} onProbes={onProbes} />
      {models.length === 0 ? (
        <p className="pl-9 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.settings.no_models')}</p>
      ) : (
        <ModelList
          provider={provider}
          models={models}
          activeModelId={activeModelId}
          labelId={providerLabelId(provider.id)}
          onEdit={onEditModel}
        />
      )}
    </div>
  )
}

export function ModelTab({ settings }: { settings: AssistantSettings }) {
  const providers = useAssistant((state) => state.providers)
  const models = useAssistant((state) => state.models)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const addModel = useAssistant((state) => state.addModel)
  const updateModel = useAssistant((state) => state.updateModel)
  const toast = useUi((state) => state.toast)
  const [addingProvider, setAddingProvider] = useState(false)
  const [addingModel, setAddingModel] = useState<AssistantProvider | null>(null)
  const [picking, setPicking] = useState<AssistantProvider | null>(null)
  const [editingProvider, setEditingProvider] = useState<AssistantProvider | null>(null)
  const [editing, setEditing] = useState<AssistantModel | null>(null)
  const [titlePrompt, setTitlePrompt] = useState(settings.titlePrompt)
  useEffect(() => setTitlePrompt(settings.titlePrompt), [settings.titlePrompt])
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(Math.round(settings.requestTimeoutMs / 1000)))
  useEffect(() => setTimeoutSeconds(String(Math.round(settings.requestTimeoutMs / 1000))), [settings.requestTimeoutMs])
  const chatModels = useMemo(
    () => models.filter((model) => model.enabled && model.purpose === 'chat'),
    [models],
  )
  const timeoutNumber = Number(timeoutSeconds)
  const timeoutValid = Number.isFinite(timeoutNumber) && timeoutNumber >= 5 && timeoutNumber <= 300

  const byProvider = useMemo(() => providers.map((provider) => ({
    provider,
    models: models.filter((model) => model.providerId === provider.id),
  })), [providers, models])

  return (
    <>
      <Group title={t('assistant.settings.providers')}>
        {providers.length === 0 && (
          <div className="flex flex-col items-start gap-2 py-3">
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('assistant.settings.no_providers')}</p>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus size={14} />}
              onClick={() => setAddingProvider(true)}
            >
              {t('assistant.settings.add_first_provider' as MessageKey)}
            </Button>
          </div>
        )}
        {byProvider.map(({ provider, models: list }) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            models={list}
            activeModelId={settings.activeModelId}
            onEditProvider={setEditingProvider}
            onPickModels={setPicking}
            onAddModel={setAddingModel}
            onEditModel={setEditing}
          />
        ))}
              {editing && (
                <ModelEditorDialog
                  model={editing}
                  provider={providers.find((entry) => entry.id === editing.providerId) ?? null}
                  models={models}
                  limits={settings.limits}
                  timezone={settings.timezone}
                  onClose={() => setEditing(null)}
                  onSave={(draft, report) => updateModel(editing.id, draft, report)}
                />
              )}
        <div className="flex justify-end py-2.5">
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setAddingProvider(true)}>
            {t('assistant.settings.add_provider')}
          </Button>
        </div>
      </Group>

      <Group title={t('assistant.settings.defaults')}>
        <SettingRow title={t('assistant.settings.default_chat_model')} description={t('assistant.settings.default_chat_model_hint')}>
          <Select
            aria-label={t('assistant.settings.default_chat_model')}
            value={settings.activeModelId ?? ''}
            onChange={(event) => void saveSettings({ activeModelId: event.target.value || null })}
          >
            <option value="">{t('assistant.settings.model_none_selected')}</option>
            {chatModels.map((model) => <option key={model.id} value={model.id}>{modelOptionLabel(model, chatModels, providers)}</option>)}
          </Select>
        </SettingRow>
        <SettingRow title={t('assistant.settings.naming_model')} description={t('assistant.settings.naming_model_hint')}>
          <Select
            aria-label={t('assistant.settings.naming_model')}
            value={settings.namingModelId ?? ''}
            onChange={(event) => void saveSettings({ namingModelId: event.target.value || null })}
          >
            <option value="">{t('assistant.settings.naming_model_follow')}</option>
            {chatModels.map((model) => <option key={model.id} value={model.id}>{modelOptionLabel(model, chatModels, providers)}</option>)}
          </Select>
        </SettingRow>
        <SettingRow title={t('assistant.settings.auto_recover')} description={t('assistant.settings.auto_recover_hint')}>
          <Switch
            checked={settings.autoRecover}
            label={t('assistant.settings.auto_recover')}
            onChange={(autoRecover) => void saveSettings({ autoRecover })}
          />
        </SettingRow>
        <SettingRow title={t('assistant.settings.request_timeout')} description={t('assistant.settings.request_timeout_hint')}>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (timeoutValid) void saveSettings({ requestTimeoutMs: Math.round(timeoutNumber * 1000) })
            }}
          >
            <Input
              aria-label={t('assistant.settings.request_timeout')}
              type="number"
              min={5}
              max={300}
              value={timeoutSeconds}
              onChange={(event) => setTimeoutSeconds(event.target.value)}
              className="h-8 w-20 text-[length:var(--text-12)]"
              invalid={!timeoutValid}
            />
            <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.settings.seconds')}</span>
            <Button type="submit" size="sm" variant="secondary" disabled={!timeoutValid || Math.round(timeoutNumber * 1000) === settings.requestTimeoutMs}>
              {t('common.save')}
            </Button>
          </form>
        </SettingRow>
        <div className="py-2.5">
          <Field label={t('assistant.settings.title_prompt')} hint={t('assistant.settings.title_prompt_hint')}>
            <Textarea
              value={titlePrompt}
              maxLength={4000}
              rows={3}
              onChange={(event) => setTitlePrompt(event.target.value)}
              placeholder={t('assistant.settings.title_prompt_placeholder')}
            />
          </Field>
          <div className="mt-1.5 flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={titlePrompt === settings.titlePrompt}
              onClick={() => void saveSettings({ titlePrompt })}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Group>

      <Group title={t('assistant.settings.mode')}>
        <SettingRow title={t('assistant.settings.offline')} description={t('assistant.settings.offline_hint')}>
          <Switch checked={settings.offlineMode} onChange={(value) => void saveSettings({ offlineMode: value })} label={t('assistant.settings.offline')} />
        </SettingRow>
      </Group>

      <ProviderForm
        open={addingProvider}
        onClose={() => setAddingProvider(false)}
        // The preset's ids are a guess about the account; opening the listing right after saving is what
        // turns that guess into the ids the key can really call.
        onCreated={(provider) => setPicking(provider)}
      />
      <ProviderForm open={Boolean(editingProvider)} provider={editingProvider} onClose={() => setEditingProvider(null)} />
      <ModelForm provider={addingModel} onClose={() => setAddingModel(null)} onAdd={addModel} />
      {picking && (
        <ModelPickerDialog
          provider={picking}
          onSynced={({ added, removed }) => {
            // One line either way: the two numbers are the same save, and the reader asked for a set, not
            // for two operations.
            if (added && removed) toast({ title: t('assistant.picker.synced', { added, removed }) })
            else if (added) toast({ title: t('assistant.picker.added', { count: added }) })
            else if (removed) toast({ title: t('assistant.picker.removed', { count: removed }) })
          }}
          onClose={() => setPicking(null)}
          onCustom={() => {
            // The manual form is the other way in, and the picker has to be out of its way first.
            const target = picking
            setPicking(null)
            setAddingModel(target)
          }}
        />
      )}
    </>
  )
}

/**
 * Which vendor a new provider is, as a list that can be searched rather than a `<select>` that can only be
 * scrolled. Eight presets over two alphabets is already past the point where the reader knows the name they
 * want and would rather type it: the label, the id and the address are all searched, so a reader who
 * remembers "openrouter" or "api.moonshot.cn" but not the display name still finds the row.
 *
 * The panel is drawn in the dialog beside its trigger instead of being portalled over it: a menu on the
 * document body sits outside the focus trap the dialog installs, so its rows would be reachable by pointer
 * and unreachable by keyboard.
 */
function PresetPicker({ value, onPick }: { value: string, onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const panelId = useId()
  const boxRef = useRef<HTMLDivElement>(null)
  const chosen = PROVIDER_PRESETS.find((entry) => entry.id === value) ?? PROVIDER_PRESETS[0]!
  const rows = PROVIDER_PRESETS.filter((entry) => matchesQuery(`${entry.label} ${entry.id} ${entry.baseUrl}`, query))
  useEscape(open, () => setOpen(false))
  // The trigger is inside the watched box, so opening and closing are the trigger's own decision.
  useClickOutside([boxRef], open, () => setOpen(false))

  return (
    <div ref={boxRef} className="flex flex-col gap-2">
      <Field label={t('assistant.settings.preset')}>
        <button
          type="button"
          aria-expanded={open}
          {...(open ? { 'aria-controls': panelId } : {})}
          onClick={() => {
            setQuery('')
            setOpen((current) => !current)
          }}
          className={cn(
            'flex h-11 w-full items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2.5 text-left md:h-[34px]',
            'transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:border-[var(--border-strong)]',
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <AssistantIcon value={chosen.icon} size={16} />
            <span className="truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{chosen.label}</span>
          </span>
          <ChevronDown size={14} className={cn('shrink-0 text-[var(--text-tertiary)] transition-transform duration-[var(--dur-fast)]', open && 'rotate-180')} />
        </button>
      </Field>

      {open && (
        <div id={panelId} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-1.5">
          <Input
            autoFocus
            leading={<Search size={13} />}
            value={query}
            aria-label={t('assistant.settings.preset_search')}
            placeholder={t('assistant.settings.preset_search')}
            className="h-8 text-[length:var(--text-12)]"
            onChange={(event) => setQuery(event.target.value)}
          />
          {rows.length === 0 ? (
            <p className="px-2 py-3 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.settings.preset_none')}</p>
          ) : (
            <ul className="mt-1 max-h-[190px] overflow-y-auto">
              {rows.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-current={entry.id === value}
                    onClick={() => {
                      onPick(entry.id)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12-5)]',
                      'transition-colors duration-[var(--dur-fast)]',
                      entry.id === value
                        ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    <AssistantIcon value={entry.icon} size={18} />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.id === value && <Check size={13} className="shrink-0" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** One typed key's answer, keyed by its last four characters because a draft has no row to hang on. */
interface DraftProbe {
  keyHint: string
  outcome: AssistantKeyProbeOutcome
  reason: AssistantKeyProbeReason | null
  latencyMs: number | null
}

export function ProviderForm({ open, provider, onClose, onCreated }: {
  open: boolean
  provider?: AssistantProvider | null
  onClose: () => void
  /** The saved provider, so the caller can go straight on to listing what its key can actually call. */
  onCreated?: (provider: AssistantProvider) => void
}) {
  const addProvider = useAssistant((state) => state.addProvider)
  const updateProvider = useAssistant((state) => state.updateProvider)
  const editing = provider ?? null
  const [preset, setPreset] = useState(PROVIDER_PRESETS[0]!.id)
  const [label, setLabel] = useState('')
  const [icon, setIcon] = useState(PROVIDER_PRESETS[0]!.icon)
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS[0]!.baseUrl)
  const [protocol, setProtocol] = useState<AssistantProtocol>(PROVIDER_PRESETS[0]!.protocol)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState(PROVIDER_PRESETS[0]!.models.join(', '))
  const [extra, setExtra] = useState<Record<string, string>>({})
  // '' is "read it off the address". A pin the chosen protocol cannot honour is dropped rather than
  // offered: the two wires do not share a thinking shape, so one that no longer fits would only build a
  // body the far end ignores.
  const [dialect, setDialect] = useState<ReasoningDialect | ''>('')
  /** Keep one key for every turn instead of rotating: the reader's own cost/stability trade. */
  const [sticky, setSticky] = useState(false)
  /** Whether the key box shows what was typed. The plaintext is the reader's own, not a stored secret. */
  const [showKey, setShowKey] = useState(false)
  const [draftProbes, setDraftProbes] = useState<DraftProbe[]>([])
  const [probing, setProbing] = useState(false)
  /** A refused probe is its own fact, not a failed save: it gets a line of its own under the test button. */
  const [probeFailure, setProbeFailure] = useState<string | null>(null)
  /** How many keys this provider already rotates through, so an edit names the ring it is adding to. */
  const [ringCount, setRingCount] = useState(0)
  const [listing, setListing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<WriteFailure | null>(null)
  const chosen = PROVIDER_PRESETS.find((entry) => entry.id === preset) ?? PROVIDER_PRESETS[0]!
  const dialectChoices = dialectsForProtocol(protocol)
  const pinned = dialect && dialectChoices.includes(dialect) ? dialect : ''
  // The addresses drawn under the primary one are the *other* wires'. An entry for the wire the form is
  // on is never a field the reader can see, so it is neither checked nor sent: a value no box shows is one
  // the reader cannot correct, and letting it block the save left a disabled button with no reason on
  // screen.
  const extraProtocols = useMemo(() => ASSISTANT_PROTOCOLS.filter((entry) => entry !== protocol), [protocol])

  // Which box says what, and why the save would be refused. The optional addresses are checked here for
  // the same reason the route checks them: a browser can autocomplete a username into a text box sitting
  // above a password field, and that must not read as "adding a provider is broken".
  const problems = useMemo(() => {
    const out: Record<string, string> = {}
    const primary = endpointFieldState(baseUrl)
    if (primary !== 'ok') out.base_url = primary === 'empty' ? t('assistant.settings.address_missing') : t('assistant.settings.address_invalid')
    for (const entry of extraProtocols) {
      if (endpointFieldState(extra[entry] ?? '') === 'invalid') out[entry] = t('assistant.settings.address_invalid')
    }
    if (parseProviderKeys(apiKey).length > MAX_PROVIDER_KEYS) {
      out.api_key = t('assistant.settings.api_key_too_many', { max: MAX_PROVIDER_KEYS })
    }
    return out
  }, [baseUrl, extra, extraProtocols, apiKey])
  const sendable = Object.fromEntries(
    extraProtocols
      .map((entry) => [entry, extra[entry]] as const)
      .filter(([, url]) => endpointFieldState(url ?? '') === 'ok'),
  )
  // Listing needs both halves to be worth sending; the button says which one is missing instead of
  // opening a dialog that can only fail.
  const canList = parseProviderKeys(apiKey).length > 0 && endpointFieldState(baseUrl) === 'ok'
  // A draft with keys tests what was typed; an edit with an untouched box tests what is stored.
  const canProbe = endpointFieldState(baseUrl) === 'ok'
    && (parseProviderKeys(apiKey).length > 0 || Boolean(editing?.hasKey))

  /**
   * Switching the wire a provider is called on, and taking its address with it.
   *
   * The boxes under the primary address are the *other* wires' addresses, so the one just chosen stops
   * being drawn the moment it becomes the primary wire. Its text moves into the address box rather than
   * staying behind: a value no field shows is still a value the form would have judged and sent, and a
   * reader facing a disabled save or a refusal naming a box they cannot see has no way to fix either.
   */
  const switchProtocol = (next: AssistantProtocol) => {
    const moved = (extra[next] ?? '').trim()
    setProtocol(next)
    // A bare scheme is "nothing was entered", so it must not overwrite a usable address.
    if (moved && endpointFieldState(moved) !== 'empty') setBaseUrl(moved)
    setExtra((current) => {
      if (!(next in current)) return current
      const rest = { ...current }
      delete rest[next]
      return rest
    })
  }

  useEffect(() => {
    if (!open) return
    setListing(false)
    setFailure(null)
    if (editing) {
      // An edit starts from what is stored, not from a preset that would overwrite the reader's address.
      setLabel(editing.label)
      setIcon(editing.icon)
      setBaseUrl(editing.baseUrl)
      setProtocol(editing.protocol)
      // A stored entry for the provider's own wire is dropped here: the address box above already
      // carries that wire, and a second copy this form cannot show is what used to disable the save.
      setExtra(otherEndpoints(editing.endpoints, editing.protocol))
      setDialect(editing.reasoningDialect ?? '')
      setSticky(editing.sticky)
      setDraftProbes([])
      setShowKey(false)
      void api.assistant.providerKeys(editing.id)
        .then((answer) => setRingCount(answer.keys.length + (editing.hasKey ? 1 : 0)))
        .catch(() => setRingCount(editing.hasKey ? 1 : 0))
      setModels('')
      setApiKey('')
      return
    }
    setLabel(chosen.label)
    setIcon(chosen.icon)
    setBaseUrl(chosen.baseUrl)
    setProtocol(chosen.protocol)
    setModels(chosen.models.join(', '))
    setApiKey('')
    setExtra({})
    setDialect('')
    setSticky(false)
    setDraftProbes([])
    setShowKey(false)
    setRingCount(0)
  }, [open, chosen, editing])

  // An edit opens with an empty password box because the plaintext is not ours to show again. The box
  // still has to state that a key is stored — its last four characters while the store keeps them, and
  // the hint that blank means "keep" — or the empty box reads as a key that was lost.
  const storedHint = editing?.hasKey ? editing.keyHint : ''
  const apiKeyPlaceholder = editing?.hasKey
    ? (storedHint
      ? t('assistant.settings.api_key_saved_placeholder', { hint: storedHint })
      : t('assistant.settings.api_key_saved_placeholder_nohint'))
    : t('assistant.settings.api_key_placeholder')
  const apiKeyHint = editing?.hasKey
    ? (storedHint
      ? t('assistant.settings.api_key_edit_hint', { hint: storedHint })
      : t('assistant.settings.api_key_edit_hint_nohint'))
    : t('assistant.settings.api_key_hint')
  // The box is one ring rather than one credential. What the reader sees here is what the route parses,
  // so the count and the cap have to be visible before the save rather than discovered after it.
  const keyCount = parseProviderKeys(apiKey).length
  const apiKeyFieldHint = [
    apiKeyHint,
    t('assistant.settings.api_key_multi', { max: MAX_PROVIDER_KEYS }),
    keyCount > 1 ? t('assistant.settings.api_key_count', { count: keyCount }) : '',
  ].filter(Boolean).join(' ')

  /**
   * Asks the provider about the keys in front of the reader.
   *
   * A draft is tested as typed and never stored; an edit whose box is untouched tests the stored ring,
   * which is the same question asked of the keys that are already in rotation.
   */
  const probeDraft = async () => {
    if (probing) return
    setProbing(true)
    setDraftProbes([])
    setProbeFailure(null)
    try {
      const typed = parseProviderKeys(apiKey)
      if (typed.length) {
        // The worker only probes addresses this account already saved. An edit names that row so the
        // draft keys are tried against its stored baseUrl instead of an arbitrary typed host.
        const answer = await api.assistant.probeDraftKeys({
          protocol,
          baseUrl: baseUrl.trim(),
          apiKeys: typed,
          ...(editing ? { providerId: editing.id } : {}),
        })
        setDraftProbes(answer.results)
      } else if (editing) {
        const answer = await api.assistant.probeProviderKeys(editing.id)
        setDraftProbes(answer.results.map((entry) => ({
          keyHint: entry.keyHint, outcome: entry.outcome, reason: entry.reason, latencyMs: entry.latencyMs,
        })))
        setRingCount(answer.results.length)
      }
    } catch (error) {
      // A refused probe says nothing about the save: report it here, never as a "save failed" line.
      setProbeFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setProbing(false)
    }
  }

  // The save and its answer, in one place: the dialog stays open with the draft intact unless the write
  // says it landed, and the reason it refused is printed here rather than arriving as a toast over a
  // closed panel.
  const submit = async () => {
    if (saving) return
    setSaving(true)
    setFailure(null)
    if (editing) {
      const ok = await updateProvider(editing.id, {
        label: label.trim(),
        icon,
        protocol,
        baseUrl: baseUrl.trim(),
        endpoints: sendable,
        reasoningDialect: pinned || null,
        sticky,
        // A blank box means "keep the stored key", not "forget it": an untouched field is not
        // sent at all, and the worker keeps the ciphertext for a patch that carries no key.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }, setFailure)
      setSaving(false)
      if (ok) onClose()
      else setFailure(refusalFor)
      return
    }
    // Saving is also the moment the vendor can be asked what it offers, so the form hands the
    // created row back and the caller opens the listing on it.
    const created = await addProvider({
      label: label.trim(),
      icon,
      protocol,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      endpoints: sendable,
      reasoningDialect: pinned || null,
      sticky,
      models: models.split(',').map((entry) => entry.trim()).filter(Boolean),
    }, setFailure)
    setSaving(false)
    if (!created) {
      setFailure(refusalFor)
      return
    }
    onClose()
    onCreated?.(created)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      // Closing a form whose save is still on the wire is how a draft gets lost, so the gestures that
      // would do it are put away until the write answers.
      dismissible={!saving}
      title={editing ? t('assistant.settings.edit_provider') : t('assistant.settings.add_provider')}
      width={520}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button
            icon={editing ? <Check size={14} /> : <Plus size={14} />}
            loading={saving}
            disabled={!label.trim() || Object.keys(problems).length > 0}
            onClick={() => void submit()}
          >
            {editing ? t('assistant.settings.edit_provider') : t('assistant.settings.add_provider')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        {!editing && <PresetPicker value={preset} onPick={setPreset} />}
        <Field label={t('assistant.settings.provider_name')}>
          <Input value={label} maxLength={60} autoComplete="off" onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <AssistantIconField
          value={icon}
          fallback={iconForProvider({ icon: '', label, baseUrl })}
          onChange={setIcon}
        />
        <Field label={t('assistant.settings.protocol')}>
          <Select value={protocol} onChange={(event) => switchProtocol(event.target.value as AssistantProtocol)}>
            {ASSISTANT_PROTOCOLS.map((entry) => <option key={entry} value={entry}>{PROTOCOL_LABELS[entry]?.()}</option>)}
          </Select>
        </Field>
        <Field label={t('assistant.settings.dialect')} hint={t('assistant.settings.dialect_hint')}>
          <Select aria-label={t('assistant.settings.dialect')} value={pinned} onChange={(event) => setDialect(event.target.value as ReasoningDialect | '')}>
            <option value="">{t('assistant.settings.dialect.auto')}</option>
            {dialectChoices.map((entry) => (
              <option key={entry} value={entry}>{t(DIALECT_LABELS[entry])}</option>
            ))}
          </Select>
        </Field>
        <div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2">
          <Switch checked={sticky} label={t('assistant.settings.sticky')} onChange={setSticky} />
          <div className="min-w-0 flex-1">
            <p className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('assistant.settings.sticky')}</p>
            <p className="mt-0.5 text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">{t('assistant.settings.sticky_hint')}</p>
          </div>
        </div>
        <Field label={t('assistant.settings.base_url')} hint={problems.base_url ?? t('assistant.settings.base_url_hint')}>
          <Input
            value={baseUrl}
            maxLength={300}
            autoComplete="off"
            invalid={Boolean(problems.base_url)}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="font-mono text-[length:var(--text-12)]"
          />
        </Field>
        {extraProtocols.map((entry) => (
          <Field
            key={entry}
            label={`${t('assistant.settings.endpoint_other')} · ${PROTOCOL_LABELS[entry]?.()}`}
            hint={problems[entry] ?? t('assistant.settings.endpoint_hint')}
          >
            <Input
              aria-label={`${t('assistant.settings.endpoint_other')} ${PROTOCOL_LABELS[entry]?.()}`}
              value={extra[entry] ?? ''}
              maxLength={300}
              autoComplete="off"
              invalid={Boolean(problems[entry])}
              placeholder="https://"
              onChange={(event) => setExtra((current) => ({ ...current, [entry]: event.target.value }))}
              className="font-mono text-[length:var(--text-12)]"
            />
          </Field>
        ))}
        <Divider />
        {/* An edit opens with an empty password box because the plaintext is not ours to show again. The
            field still has to say that a key is stored, or the reader reads the empty box as "my key is
            gone" — the placeholder carries the last four characters, and the hint says blank keeps it. */}
        <Field label={t('assistant.settings.api_key')} hint={problems.api_key ?? apiKeyFieldHint}>
          <Input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            maxLength={4096}
            autoComplete="off"
            invalid={Boolean(problems.api_key)}
            leading={<KeyRound size={13} />}
            placeholder={apiKeyPlaceholder}
            onChange={(event) => setApiKey(event.target.value)}
            className="font-mono text-[length:var(--text-12)]"
            // The plaintext is the reader's own, typed seconds ago and not yet stored. Seeing it is how a
            // paste that lost a character gets noticed before it becomes a 401 nobody can explain.
            trailing={(
              <button
                type="button"
                aria-label={t(showKey ? 'assistant.settings.api_key_hide' : 'assistant.settings.api_key_show')}
                onClick={() => setShowKey((value) => !value)}
                className="flex size-5 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            )}
          />
        </Field>
        {/* The test sits under the box rather than behind a save: what a reader wants to know about a key
            they just pasted is whether it works, and making them store it first is the wrong order. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={!canProbe || probing}
            onClick={() => void probeDraft()}
          >
            {probing ? t('assistant.keys.probe_running') : t('assistant.keys.probe')}
          </Button>
          {draftProbes.map((entry, index) => (
            <span
              key={index}
              className={cn(
                'tabular text-[length:var(--text-11)]',
                entry.outcome === 'passed'
                  ? 'text-[var(--text-secondary)]'
                  : entry.outcome === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]',
              )}
              title={entry.reason ? t(`assistant.keys.probe_reason.${entry.reason}`) : undefined}
            >
              <span className="font-mono">····{entry.keyHint}</span>
              {' '}
              {entry.outcome === 'passed'
                ? t('assistant.keys.probe_passed')
                : entry.outcome === 'failed' ? t('assistant.keys.probe_failed') : t('assistant.keys.probe_unknown')}
              {entry.outcome === 'passed' && entry.latencyMs !== null
                ? ` ${t('assistant.keys.probe_latency', { ms: entry.latencyMs })}`
                : ''}
            </span>
          ))}
          {editing && ringCount > 0 && (
            <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {t('assistant.settings.ring_count', { count: ringCount })}
            </span>
          )}
        </div>
        {probeFailure && (
          <p role="alert" className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--danger)]">
            {t('assistant.keys.probe_draft_failed' as MessageKey)}
            {probeFailure ? ` ${probeFailure}` : ''}
          </p>
        )}
        {!editing && (
          <>
            <Field label={t('assistant.settings.models')} hint={t('assistant.settings.models_hint')}>
              <Input value={models} onChange={(event) => setModels(event.target.value)} className="font-mono text-[length:var(--text-12)]" />
            </Field>
            {/* The preset's ids are a guess about this account. This is the question that replaces the
                guess, asked of the address and key the reader has already typed, before anything is
                saved — and the reason the button names what it is waiting for rather than sitting
                disabled without explanation. */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon={<Download size={13} />}
                disabled={!canList}
                onClick={() => setListing(true)}
              >
                {t('assistant.settings.models_fetch')}
              </Button>
              {!canList && (
                <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {t('assistant.settings.models_fetch_hint')}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {failure && <SaveFailure failure={failure} />}

      {listing && (
        <ModelPickerDialog
          draft={{ protocol, baseUrl: baseUrl.trim(), apiKey: parseProviderKeys(apiKey)[0] ?? '', label: label.trim() || chosen.label }}
          existing={models.split(',').map((entry) => entry.trim()).filter(Boolean)}
          onPicked={(ids) => setModels(ids.join(', '))}
          onClose={() => setListing(false)}
        />
      )}
    </Modal>
  )
}

function ModelForm({ provider, onClose, onAdd }: {
  provider: AssistantProvider | null
  onClose: () => void
  /** The write itself, awaited: the id stays in the box and the reason stays on the screen until it says yes. */
  onAdd: (body: Record<string, unknown>, report: ReportFailure) => Promise<boolean>
}) {
  const [model, setModel] = useState('')
  const [icon, setIcon] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<WriteFailure | null>(null)
  useEffect(() => {
    setModel('')
    setIcon('')
    setFailure(null)
  }, [provider])

  const submit = async () => {
    if (!provider || saving) return
    setSaving(true)
    setFailure(null)
    const ok = await onAdd({ providerId: provider.id, model: model.trim(), icon }, setFailure)
    setSaving(false)
    if (!ok) {
      setFailure(refusalFor)
      return
    }
    onClose()
  }

  return (
    <Modal
      open={!!provider}
      onClose={onClose}
      dismissible={!saving}
      title={t('assistant.settings.add_model')}
      width={420}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button
            icon={<Plus size={14} />}
            loading={saving}
            disabled={!model.trim()}
            onClick={() => void submit()}
          >
            {t('assistant.settings.add_model')}
          </Button>
        </>
      )}
    >
      {/* Which provider the id will be filed under is the one thing the reader can get wrong here, and
          the dialog's own title only says what is being added. */}
      {provider && (
        <p className="mb-2.5 flex items-center gap-1.5 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <KeyRound size={12} className="shrink-0" />
          <span className="min-w-0 truncate">{provider.label}</span>
        </p>
      )}
      <Field label={t('assistant.settings.model_id')} hint={provider?.baseUrl}>
        <Input value={model} maxLength={120} autoFocus onChange={(event) => setModel(event.target.value)} className="font-mono text-[length:var(--text-12)]" />
      </Field>
      <AssistantIconField
        value={icon}
        fallback={provider ? iconForModel({ icon: '', model, label: model }, provider) : ''}
        onChange={setIcon}
      />
      {failure && <div className="mt-3"><SaveFailure failure={failure} /></div>}
    </Modal>
  )
}
