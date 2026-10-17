/**
 * The model tab: which provider answers, and which of its models are on.
 *
 * The provider rows and the add-provider form are one surface, because the form is how a provider
 * arrives — including the question it asks the vendor before anything is saved, so the ids it stores are
 * the ones that key can really call rather than a preset's guess.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Brain, Check, ChevronDown, Download, Eye, GalleryVerticalEnd, Image, KeyRound, Plus, Power, Search, Server, Settings2, Trash2, Wand2, Wrench } from 'lucide-react'
import { type AssistantModel, type AssistantModelKind, type AssistantModelPurpose, type AssistantProtocol, type AssistantProvider, type AssistantSettings, type ReasoningDialect } from '@shared/assistant'
import { ASSISTANT_PROTOCOLS, PROVIDER_PRESETS, endpointFieldState } from '@shared/assistant'
import { dialectsForProtocol } from '@shared/reasoning'
import { ModelEditorDialog } from './ModelEditorDialog'
import { ModelPickerDialog } from './ModelPickerDialog'
import { ProviderKeys } from './ProviderKeys'
import { cn } from '../../lib/cn'
import { matchesQuery } from '../../lib/fuzzy'
import { t, type MessageKey } from '../../lib/i18n'
import { Button, Divider, IconButton } from '../../components/primitives'
import { Field, Input, Select, SettingRow, Switch } from '../../components/form'
import { Modal, Tooltip, confirm, useClickOutside, useEscape } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { DIALECT_LABELS, Group, PROTOCOL_LABELS, storedKeyLabel } from './assistant-settings-shared'

/**
 * One capability, drawn as the switch that sets it.
 *
 * The model list is where a reader changes these — a reply that came back wrong is noticed here, not in a
 * dialog three presses away — so the icon is the control rather than a badge reporting one. Its on state is
 * the accent fill the rest of the app uses for a pressed toggle, and the word behind it lives in the
 * accessible name and the tooltip, which is the only place a phone has room for it.
 */
function CapabilityToggle({ on, label, icon, onToggle }: { on: boolean, label: string, icon: React.ReactNode, onToggle: () => void }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={on}
        onClick={onToggle}
        className={cn(
          'inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--r-md)]',
          'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          on
            ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
            : 'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
        )}
      >
        {icon}
      </button>
    </Tooltip>
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
  }
  const kind: Partial<Record<AssistantModelKind, { key: MessageKey, icon: React.ReactNode }>> = {
    embedding: { key: 'assistant.model.kind.embedding', icon: <GalleryVerticalEnd size={12} /> },
    rerank: { key: 'assistant.model.kind.rerank', icon: <GalleryVerticalEnd size={12} /> },
  }
  return purpose[model.purpose] ?? kind[model.kind] ?? null
}

export function ModelTab({ settings }: { settings: AssistantSettings }) {
  const providers = useAssistant((state) => state.providers)
  const models = useAssistant((state) => state.models)
  const saveSettings = useAssistant((state) => state.saveSettings)
  const removeProvider = useAssistant((state) => state.removeProvider)
  const removeModel = useAssistant((state) => state.removeModel)
  const addModel = useAssistant((state) => state.addModel)
  const activateModel = useAssistant((state) => state.activateModel)
  const updateModel = useAssistant((state) => state.updateModel)
  const toast = useUi((state) => state.toast)
  const [addingProvider, setAddingProvider] = useState(false)
  const [addingModel, setAddingModel] = useState<AssistantProvider | null>(null)
  const [picking, setPicking] = useState<AssistantProvider | null>(null)
  const [editingProvider, setEditingProvider] = useState<AssistantProvider | null>(null)
  const [editing, setEditing] = useState<AssistantModel | null>(null)

  const byProvider = useMemo(() => providers.map((provider) => ({
    provider,
    models: models.filter((model) => model.providerId === provider.id),
  })), [providers, models])

  return (
    <>
      <Group title={t('assistant.settings.providers')}>
        {providers.length === 0 && (
          <p className="py-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('assistant.settings.no_providers')}</p>
        )}
        {byProvider.map(({ provider, models: list }) => (
          <div key={provider.id} className="flex flex-col gap-1.5 py-3">
            <div className="flex items-center gap-2.5">
              {/* The key state is the one fact about a provider that costs a round trip to learn, so it is
                  drawn as the row's own mark rather than as a word at the end of a sentence. */}
              <span
                aria-hidden
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-[var(--r-md)] border',
                  provider.hasKey
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                    : 'border-[var(--border-default)] text-[var(--text-quaternary)]',
                )}
              >
                <KeyRound size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{provider.label}</p>
                <p className="truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">
                  {PROTOCOL_LABELS[provider.protocol]?.()} · {provider.baseUrl} · {storedKeyLabel(provider)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton label={t('assistant.settings.edit_provider')} size="xs" onClick={() => setEditingProvider(provider)}>
                  <Settings2 size={13} />
                </IconButton>
                <IconButton label={t('assistant.picker.open')} size="xs" onClick={() => setPicking(provider)}>
                  <Download size={13} />
                </IconButton>
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
            </div>
            <ProviderKeys provider={provider} />
            {list.length === 0 ? (
              <p className="pl-9 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.settings.no_models')}</p>
            ) : (
              <ul className="flex flex-col gap-1 pl-9">
                {list.map((model) => {
                  const mark = specialMark(model)
                  return (
                  <li
                    key={model.id}
                    className={cn(
                      'flex items-center rounded-[var(--r-md)] border px-2 py-1.5',
                      'transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                      settings.activeModelId === model.id
                        ? 'border-[var(--accent)] bg-[var(--accent-softer)]'
                        : 'border-[var(--border-subtle)] hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    {/* One line of controls, no words: a phone-width card had two selects and two
                        switches stacked under every model, which pushed the list itself off the screen.
                        What a model can do is now the icons themselves — they are the switches — and the
                        level behind each one (how much thinking, whose context window) is a fact the
                        editor dialog holds. */}
                    <div className="flex min-w-0 flex-1 items-center gap-0.5">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={settings.activeModelId === model.id}
                        onClick={() => void activateModel(model.id)}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left text-[length:var(--text-12-5)]',
                          settings.activeModelId === model.id
                            ? 'text-[var(--accent-on-soft)]'
                            : 'text-[var(--text-secondary)]',
                        )}
                      >
                        <span aria-hidden className={cn('size-2 shrink-0 rounded-full border', settings.activeModelId === model.id ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border-strong)]')} />
                        {mark && (
                          <Tooltip label={t(mark.key)}>
                            <span aria-hidden className="shrink-0 text-[var(--text-quaternary)]">{mark.icon}</span>
                          </Tooltip>
                        )}
                        <span className="min-w-0 flex-1 truncate">{model.label}</span>
                        <span className="hidden shrink-0 font-mono text-[length:var(--text-10-5)] text-[var(--text-quaternary)] md:block">{model.model}</span>
                      </button>
                      <CapabilityToggle
                        on={model.reasoning !== 'off'}
                        label={t('assistant.model.reasoning_short')}
                        icon={<Brain size={12} />}
                        onToggle={() => void updateModel(model.id, { reasoning: model.reasoning === 'off' ? 'auto' : 'off' })}
                      />
                      <CapabilityToggle
                        on={model.supportsTools}
                        label={t('assistant.model.tools_short')}
                        icon={<Wrench size={12} />}
                        onToggle={() => void updateModel(model.id, { supportsTools: !model.supportsTools })}
                      />
                      <CapabilityToggle
                        on={model.vision}
                        label={t('assistant.model.vision_short')}
                        icon={<Eye size={12} />}
                        onToggle={() => void updateModel(model.id, { vision: !model.vision })}
                      />
                      <CapabilityToggle
                        on={model.enabled}
                        label={t('assistant.model.shown')}
                        icon={<Power size={12} />}
                        onToggle={() => void updateModel(model.id, { enabled: !model.enabled })}
                      />
                      <IconButton label={t('assistant.model.edit')} size="xs" onClick={() => setEditing(model)}>
                        <Settings2 size={12} />
                      </IconButton>
                      <IconButton label={t('assistant.settings.delete_model')} size="xs" onClick={() => void removeModel(model.id)}>
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </li>
                  )
                })}
              </ul>
            )}
          </div>
        ))}
              {editing && (
                <ModelEditorDialog
                  model={editing}
                  provider={providers.find((entry) => entry.id === editing.providerId) ?? null}
                  models={models}
                  limits={settings.limits}
                  onClose={() => setEditing(null)}
                  onSave={(draft) => void updateModel(editing.id, draft)}
                />
              )}
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
            <Server size={13} className="shrink-0 text-[var(--text-tertiary)]" />
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
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS[0]!.baseUrl)
  const [protocol, setProtocol] = useState<AssistantProtocol>(PROVIDER_PRESETS[0]!.protocol)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState(PROVIDER_PRESETS[0]!.models.join(', '))
  const [extra, setExtra] = useState<Record<string, string>>({})
  // '' is "read it off the address". A pin the chosen protocol cannot honour is dropped rather than
  // offered: the two wires do not share a thinking shape, so one that no longer fits would only build a
  // body the far end ignores.
  const [dialect, setDialect] = useState<ReasoningDialect | ''>('')
  const [listing, setListing] = useState(false)
  const chosen = PROVIDER_PRESETS.find((entry) => entry.id === preset) ?? PROVIDER_PRESETS[0]!
  const dialectChoices = dialectsForProtocol(protocol)
  const pinned = dialect && dialectChoices.includes(dialect) ? dialect : ''

  // Which box says what, and why the save would be refused. The optional addresses are checked here for
  // the same reason the route checks them: a browser can autocomplete a username into a text box sitting
  // above a password field, and that must not read as "adding a provider is broken".
  const problems = useMemo(() => {
    const out: Record<string, string> = {}
    const primary = endpointFieldState(baseUrl)
    if (primary !== 'ok') out.base_url = primary === 'empty' ? t('assistant.settings.address_missing') : t('assistant.settings.address_invalid')
    for (const [entry, url] of Object.entries(extra)) {
      if (endpointFieldState(url) === 'invalid') out[entry] = t('assistant.settings.address_invalid')
    }
    return out
  }, [baseUrl, extra])
  const sendable = Object.fromEntries(Object.entries(extra).filter(([, url]) => endpointFieldState(url) === 'ok'))
  // Listing needs both halves to be worth sending; the button says which one is missing instead of
  // opening a dialog that can only fail.
  const canList = Boolean(apiKey.trim()) && endpointFieldState(baseUrl) === 'ok'

  useEffect(() => {
    if (!open) return
    setListing(false)
    if (editing) {
      // An edit starts from what is stored, not from a preset that would overwrite the reader's address.
      setLabel(editing.label)
      setBaseUrl(editing.baseUrl)
      setProtocol(editing.protocol)
      setExtra(editing.endpoints as Record<string, string>)
      setDialect(editing.reasoningDialect ?? '')
      setModels('')
      setApiKey('')
      return
    }
    setLabel(chosen.label)
    setBaseUrl(chosen.baseUrl)
    setProtocol(chosen.protocol)
    setModels(chosen.models.join(', '))
    setApiKey('')
    setExtra({})
    setDialect('')
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('assistant.settings.edit_provider') : t('assistant.settings.add_provider')}
      width={520}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            icon={editing ? <Check size={14} /> : <Plus size={14} />}
            disabled={!label.trim() || Object.keys(problems).length > 0}
            onClick={() => {
              if (editing) {
                void updateProvider(editing.id, {
                  label: label.trim(),
                  protocol,
                  baseUrl: baseUrl.trim(),
                  endpoints: sendable,
                  reasoningDialect: pinned || null,
                  // A blank box means "keep the stored key", not "forget it": an untouched field is not
                  // sent at all, and the worker keeps the ciphertext for a patch that carries no key.
                  ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                }).then(onClose)
                return
              }
              // Saving is also the moment the vendor can be asked what it offers, so the form hands the
              // created row back and the caller opens the listing on it.
              void addProvider({
                label: label.trim(),
                protocol,
                baseUrl: baseUrl.trim(),
                apiKey: apiKey.trim(),
                endpoints: sendable,
                reasoningDialect: pinned || null,
                models: models.split(',').map((entry) => entry.trim()).filter(Boolean),
              }).then((created) => {
                onClose()
                if (created) onCreated?.(created)
              })
            }}
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
        <Field label={t('assistant.settings.protocol')}>
          <Select value={protocol} onChange={(event) => setProtocol(event.target.value as AssistantProtocol)}>
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
        {ASSISTANT_PROTOCOLS.filter((entry) => entry !== protocol).map((entry) => (
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
        <Field label={t('assistant.settings.api_key')} hint={apiKeyHint}>
          <Input
            type="password"
            value={apiKey}
            maxLength={4096}
            autoComplete="off"
            leading={<KeyRound size={13} />}
            placeholder={apiKeyPlaceholder}
            onChange={(event) => setApiKey(event.target.value)}
            className="font-mono text-[length:var(--text-12)]"
          />
        </Field>
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

      {listing && (
        <ModelPickerDialog
          draft={{ protocol, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), label: label.trim() || chosen.label }}
          existing={models.split(',').map((entry) => entry.trim()).filter(Boolean)}
          onPicked={(ids) => setModels(ids.join(', '))}
          onClose={() => setListing(false)}
        />
      )}
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
            icon={<Plus size={14} />}
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
    </Modal>
  )
}
