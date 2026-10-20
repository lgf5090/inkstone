/**
 * The model's own editor: what it is for, what it can do, and the numbers it is given.
 *
 * The composer's chips cover the two settings a reader changes often. This covers the rest, which are
 * per-model facts rather than per-conversation choices: whether the endpoint answers in pictures, how
 * much it claims to take in, and the vendor-specific fields our request builder does not know about.
 * Everything here is read by the request path — a switch that changed nothing would be worse than no
 * switch, because it would be believed.
 */
import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, Copy, Plus, Save, X } from 'lucide-react'
import type {
  AssistantCustomParam,
  AssistantLimits,
  AssistantModel,
  AssistantModelKind,
  AssistantModelPurpose,
  AssistantParamType,
  AssistantPricePeriod,
  AssistantProvider,
  AssistantReasoning,
} from '@shared/assistant'
import { ASSISTANT_MODEL_KINDS, ASSISTANT_MODEL_MODALITIES, ASSISTANT_MODEL_PURPOSES, ASSISTANT_PROTOCOLS, MAX_PRICE_PERIODS, MAX_PRICE_PERIOD_LABEL_CHARS, TOKEN_STEPS, effectiveModelLimits, formatTokenStep, modelWire, protocolCarriesAudio } from '@shared/assistant'
import type { AssistantModelModality, AssistantProtocol } from '@shared/assistant'
import { REASONING_LABELS } from './ComposerControls'
import { modelReasoning, reasoningOptions } from './model-reasoning'
import { ChipRow, SaveFailure, refusalFor } from './assistant-settings-shared'
import type { ReportFailure, WriteFailure } from './assistant-store'
import { cn } from '../../lib/cn'
import { COPY_RESET_MS } from '../../lib/motion'
import { t } from '../../lib/i18n'
import { Field, Input, Segmented, Select, SettingRow, Slider, Switch } from '../../components/form'
import { Button, IconButton } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'

const PURPOSE_KEYS: Record<AssistantModelPurpose, Parameters<typeof t>[0]> = {
  chat: 'assistant.model.purpose.chat',
  image_generate: 'assistant.model.purpose.image_generate',
  image_edit: 'assistant.model.purpose.image_edit',
  realtime: 'assistant.model.purpose.realtime',
}

const PROTOCOL_NAMES: Record<AssistantProtocol, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
}

const KIND_KEYS: Record<AssistantModelKind, Parameters<typeof t>[0]> = {
  text: 'assistant.model.kind.text',
  image: 'assistant.model.kind.image',
  embedding: 'assistant.model.kind.embedding',
  rerank: 'assistant.model.kind.rerank',
}

const PARAM_TYPE_KEYS: Record<AssistantParamType, Parameters<typeof t>[0]> = {
  string: 'assistant.model.type_string',
  number: 'assistant.model.type_number',
  boolean: 'assistant.model.type_boolean',
}

export interface ModelDraft {
  label: string
  purpose: AssistantModelPurpose
  kind: AssistantModelKind
  supportsTools: boolean
  /** The account's standing refusal, kept apart from `supportsTools`: that is the vendor's claim, this is
   *  what the reader will let the model do. See `AssistantModel.noTools`. */
  noTools: boolean
  /** The three switches the model row now draws as its own icons, edited at their full depth here. */
  reasoning: AssistantReasoning
  vision: boolean
  /** The three token numbers, each of which may be left empty — see the fields' own hints for what a
   *  blank one means. None of them is required, and a blank is not the same as typing the default in. */
  contextTokens: number | null
  maxInputTokens: number | null
  maxOutputTokens: number | null
  modalities: AssistantModelModality[]
  temperature: number | null
  topP: number | null
  customParams: AssistantCustomParam[]
  /** Null means the model is called on whatever wire its provider speaks. */
  protocol: AssistantProtocol | null
  /** The model to try when this one cannot answer at all. Null is no spare, which is what most models are. */
  fallbackModelId: string | null
  /** What a million tokens cost, so the usage screen can put a number on a turn. Blank is unpriced. */
  inputPrice: number | null
  outputPrice: number | null
  priceCurrency: string
  /** The windows that override the base price; an empty list leaves the base rates as the whole story. */
  pricePeriods: AssistantPricePeriod[]
}

export function draftFromModel(model: AssistantModel): ModelDraft {
  return {
    label: model.label,
    purpose: model.purpose,
    kind: model.kind,
    supportsTools: model.supportsTools,
    noTools: model.noTools === true,
    reasoning: model.reasoning,
    vision: model.vision,
    contextTokens: model.contextTokens,
    maxInputTokens: model.maxInputTokens,
    modalities: [...model.modalities],
    maxOutputTokens: model.maxOutputTokens,
    temperature: model.temperature,
    topP: model.topP,
    customParams: model.customParams.map((param) => ({ ...param })),
    protocol: model.protocol,
    fallbackModelId: model.fallbackModelId,
    inputPrice: model.inputPrice,
    outputPrice: model.outputPrice,
    priceCurrency: model.priceCurrency,
    pricePeriods: model.pricePeriods.map((period) => ({ ...period, days: [...period.days] })),
  }
}

/** A typed price, or null for a field the reader has cleared. */
function priceValue(raw: string): number | null {
  if (!raw.trim()) return null
  const numeric = Number(raw)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

/** A stable handle for a new window; usage rows keep pointing at it after the list is reordered. */
function newPricePeriodId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return `p${random.replace(/[^a-z0-9]/gi, '').slice(0, 20)}`
}

function periodPricePlaceholder(base: number | null): string {
  return base === null ? t('assistant.model.price_period_inherit') : String(base)
}

const MODALITY_KEYS: Record<AssistantModelModality, Parameters<typeof t>[0]> = {
  audio: 'assistant.model.modality.audio',
}

/**
 * One of the three token numbers: the field, its quick picks, and what a blank one means.
 *
 * Drawn as a full-width row rather than a third of one, because the picks are a row of seven buttons wide: in a
 * column each set wrapped onto three ragged lines and the three settings read as one crowded block.
 *
 * The box around the number and the note it inherits is a wrapper, not the control, so `Field` names the group
 * and this field's input carries its own `aria-label` — the label the row's title would otherwise have to lend.
 */
function TokenField({ labelKey, hintKey, value, inherited, steps, columns = 5, warning, onChange }: {
  labelKey: Parameters<typeof t>[0]
  hintKey: Parameters<typeof t>[0]
  value: number | null
  /** The account ceiling that answers while this field is empty, named beside it so the reader can see it. */
  inherited: number
  steps: readonly number[]
  columns?: 3 | 5 | 6 | 7
  /** Said under the field's own note rather than as a toast, because it belongs to this number. */
  warning?: ReactNode
  onChange: (tokens: number | null) => void
}) {
  const label = t(labelKey)
  return (
    <Field
      label={label}
      hint={(
        <>
          {t(hintKey)}
          {warning && <span className="mt-0.5 block text-[var(--warning)]">{warning}</span>}
        </>
      )}
    >
      {/* The note on the right is what a narrow dialog used to clip: it has a line of its own to fall back
          to, and a fixed input and unshrunk note otherwise never squeeze past the panel's edge. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <Input
          type="number"
          inputMode="numeric"
          aria-label={label}
          value={value ?? ''}
          placeholder={t('assistant.model.unset')}
          onChange={(event) => onChange(numberOrNull(event.target.value))}
          className="w-36 shrink-0"
        />
        <span className="shrink-0 text-right text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
          {value === null ? t('assistant.model.value_inherited', { tokens: formatTokenStep(inherited) }) : t('assistant.model.value_own')}
        </span>
      </div>
      <ChipRow label={label} steps={steps} value={value} columns={columns} onPick={onChange} />
    </Field>
  )
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const numeric = Math.trunc(Number(trimmed))
  return Number.isFinite(numeric) ? numeric : null
}

export function ModelEditorDialog({
  model,
  provider,
  models,
  limits,
  timezone,
  onClose,
  onSave,
}: {
  model: AssistantModel
  /** The provider that answers for this model, which is half of what its thinking dialect is read from. */
  provider: AssistantProvider | null
  /** Every model the reader has, so the spare can be picked by name rather than typed as an id. */
  models: readonly AssistantModel[]
  /** The account's ceilings, which are what an emptied field inherits — named beside each field. */
  limits: AssistantLimits
  /** The clock time-of-day prices are judged by, shown so the reader knows which clock a window means. */
  timezone: string
  onClose: () => void
  /**
   * The write behind Save, awaited. It answers whether the model was saved, and takes the reason a
   * refusal is to be printed with so this dialog can print it instead of a toast arriving over it.
   */
  onSave: (draft: ModelDraft, report: ReportFailure) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<ModelDraft>(() => draftFromModel(model))
  // The rungs this model's own service publishes, and whether it can be stopped at all. Read from the same
  // rule the worker builds the request with, so the levels offered here are the levels that travel.
  const reasoning = modelReasoning(model, provider)
  // A model cannot be its own spare, and a model the reader has switched off cannot answer — except the one
  // already picked, which stays listed so turning it off is something the reader can see and undo here.
  const spares = models.filter((entry) =>
    entry.id !== model.id && (entry.enabled || entry.id === draft.fallbackModelId))
  // What this model is known to hold, and so what its answer can be: the window the reader declared and
  // the numbers the vendor stated for this model id, whichever is tighter. Offering 1M of output on a
  // model known to stop at 8K is an invitation to a provider rejection the reader cannot trace back to
  // this field.
  //
  // Nothing known leaves the whole ladder on the table. The account's `maxContextTokens` is a budget for
  // what to send rather than a claim about any model's window, and its own `maxOutputTokens` answers only
  // while this field is empty — filtering by either would quietly shorten every answer from a reader who
  // never touched them.
  const known = effectiveModelLimits({
    contextTokens: draft.contextTokens,
    vendorContextTokens: model.vendorContextTokens,
    vendorMaxOutputTokens: model.vendorMaxOutputTokens,
  })
  const outputCeiling = known.maxOutput
  const outputSteps = outputCeiling === null
    ? TOKEN_STEPS
    : TOKEN_STEPS.filter((tokens) => tokens <= outputCeiling)
  // A stored number past that ceiling is the request the provider refuses, so it is said here — with the
  // figure and with who stated it, since "the vendor says" and "you declared" ask the reader for different
  // kinds of trust.
  const overCeiling = outputCeiling !== null && draft.maxOutputTokens !== null && draft.maxOutputTokens > outputCeiling
  const vendorStatedCeiling = outputCeiling !== null
    && (model.vendorMaxOutputTokens === outputCeiling || model.vendorContextTokens === outputCeiling)
  const [more, setMore] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<WriteFailure | null>(null)
  const toast = useUi((state) => state.toast)
  // A name is the one thing the route will not accept empty, and the form can see it without asking: a
  // reader who has typed none gets the line at the box rather than a round trip that ends in a refusal.
  const nameMissing = draft.label.trim().length === 0
  // Going back into the draft retires the refusal: it was about what was sent a moment ago, and a reader
  // who has edited the field has to see that it stopped being true.
  const patch = (part: Partial<ModelDraft>) => {
    setFailure(null)
    setDraft((current) => ({ ...current, ...part }))
  }
  // A window with no length cannot be priced and would be dropped by the route; saying so at the box
  // keeps the reader's edit from disappearing in a save that looked like it worked.
  const periodsInvalid = draft.pricePeriods.some((period) => !period.start || !period.end || period.start === period.end)
  const addPeriod = () => {
    if (draft.pricePeriods.length >= MAX_PRICE_PERIODS) return
    patch({
      pricePeriods: [...draft.pricePeriods, {
        id: newPricePeriodId(),
        label: '',
        days: [1, 2, 3, 4, 5],
        start: '09:00',
        end: '18:00',
        inputPrice: null,
        outputPrice: null,
      }],
    })
  }
  const updatePeriod = (index: number, part: Partial<AssistantPricePeriod>) => {
    patch({
      pricePeriods: draft.pricePeriods.map((period, at) => (at === index ? { ...period, ...part } : period)),
    })
  }
  const removePeriod = (index: number) => {
    patch({ pricePeriods: draft.pricePeriods.filter((_, at) => at !== index) })
  }
  const togglePeriodDay = (index: number, day: number) => {
    const period = draft.pricePeriods[index]
    if (!period) return
    const days = period.days.includes(day)
      ? period.days.filter((entry) => entry !== day)
      : [...period.days, day].sort((left, right) => left - right)
    updatePeriod(index, { days })
  }

  // Which wire this model will be called on, read off the one rule the worker builds its request from —
  // the model's own pick when it has one, the provider's when it follows. Null is a model with no provider
  // behind it, which answers nothing at all.
  const wire = provider ? modelWire({ protocol: draft.protocol }, provider) : null
  // Audio is the only thing left to tick and exactly one of the three request formats has a field for it, so
  // the whole group stands or falls on this. A clip has no field on any of them, which is why no switch
  // claims one.
  const audioOnThisWire = wire !== null && protocolCarriesAudio(wire.protocol)
  const honouredModalities = audioOnThisWire ? draft.modalities : []

  const submit = async () => {
    if (saving || nameMissing || periodsInvalid) return
    setSaving(true)
    // The store hands the refusal here instead of toasting it, so one failure is told in one place.
    //
    // A tick the wire cannot honour is taken back out before the write: stored as it stands it would say
    // the reader can attach a recording to a model that answers with "this request format carries no audio
    // field", which is the disagreement this dialog exists to prevent.
    const ok = await onSave({ ...draft, modalities: honouredModalities }, setFailure)
    setSaving(false)
    if (ok) {
      onClose()
      return
    }
    setFailure(refusalFor)
  }

  // The inline "copied" mark is a claim about the clipboard, so it is drawn only when the write
  // answered: a browser can refuse the permission, or have no clipboard at all in an insecure context,
  // and a mark that appears anyway tells the reader the id is in their pasteboard when it is not.
  // The failure goes to a toast, which is how every other copy affordance in the app reports one.
  const copyId = async () => {
    if (!navigator.clipboard) {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' })
      return
    }
    try {
      await navigator.clipboard.writeText(model.model)
    } catch {
      toast({ title: t('preview.could_not_copy'), tone: 'danger' })
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), COPY_RESET_MS)
  }

  return (
    <Modal
      open
      onClose={onClose}
      // A save in flight is the one moment closing this dialog costs the reader their draft, so the
      // backdrop, Escape and the cross are all put away until the write has answered.
      dismissible={!saving}
      title={t('assistant.model.edit')}
      description={provider ? `${provider.label} · ${model.model}` : model.model}
      width={560}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            icon={<Save size={14} />}
            loading={saving}
            disabled={nameMissing || periodsInvalid}
            onClick={() => void submit()}
          >
            {t('assistant.model.save')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <Field label={t('assistant.model.id')}>
          <div className="flex items-center gap-1.5">
            <Input value={model.model} readOnly aria-label={t('assistant.model.id')} className="min-w-0 flex-1 font-mono text-[length:var(--text-12)]" />
            {/* The copy affordance answers on its own face: the mark it used to print beside the field
                pushed the id box narrower every time it appeared. */}
            <button
              type="button"
              onClick={() => void copyId()}
              aria-label={copied ? t('assistant.model.copied') : t('assistant.model.copy')}
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-[var(--r-md)] border md:size-[34px]',
                'transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                copied
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                  : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </Field>

        <Field label={t('assistant.model.name')} required hint={nameMissing ? t('assistant.model.name_required') : undefined}>
          <Input
            value={draft.label}
            aria-label={t('assistant.model.name')}
            invalid={nameMissing}
            onChange={(event) => patch({ label: event.target.value })}
          />
        </Field>

        <Field label={t('assistant.model.purpose')}>
          <Segmented
            value={draft.purpose}
            aria-label={t('assistant.model.purpose')}
            options={ASSISTANT_MODEL_PURPOSES.map((purpose) => ({ value: purpose, label: t(PURPOSE_KEYS[purpose]) }))}
            onChange={(purpose) => patch({ purpose })}
          />
        </Field>

        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore((value) => !value)}
          className={cn(
            'flex w-full items-center justify-between rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2',
            'text-[length:var(--text-12-5)] font-medium text-[var(--text-secondary)]',
            'transition-colors duration-[var(--dur-fast)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]',
          )}
        >
          {t('assistant.model.more')}
          <ChevronDown size={14} className={cn('transition-transform duration-[var(--dur-fast)]', more && 'rotate-180')} />
        </button>

        {more && (
          <div className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
            <Field label={t('assistant.model.kind')}>
              <Segmented
                value={draft.kind}
                aria-label={t('assistant.model.kind')}
                options={ASSISTANT_MODEL_KINDS.map((kind) => ({ value: kind, label: t(KIND_KEYS[kind]) }))}
                onChange={(kind) => patch({ kind })}
              />
            </Field>

            <Field label={t('assistant.model.protocol')} hint={t('assistant.model.protocol_hint')}>
              <Select
                aria-label={t('assistant.model.protocol')}
                value={draft.protocol ?? ''}
                onChange={(event) => patch({ protocol: (event.target.value || null) as AssistantProtocol | null })}
              >
                <option value="">{t('assistant.model.protocol.follow')}</option>
                {ASSISTANT_PROTOCOLS.map((entry) => <option key={entry} value={entry}>{PROTOCOL_NAMES[entry]}</option>)}
              </Select>
            </Field>

            {/* The spare sits with the protocol because both answer "how is this model reached": a turn
                that cannot be answered here is handed to the model named below rather than failing. */}
            <Field label={t('assistant.model.fallback')} hint={t('assistant.model.fallback_hint')}>
              <Select
                aria-label={t('assistant.model.fallback')}
                value={draft.fallbackModelId ?? ''}
                onChange={(event) => patch({ fallbackModelId: event.target.value || null })}
              >
                <option value="">{t('assistant.model.fallback_none')}</option>
                {spares.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </Select>
            </Field>

            <SettingRow title={t('assistant.model.tools')} description={t('assistant.model.tools_hint')}>
              <Switch checked={draft.supportsTools} label={t('assistant.model.tools')} onChange={(checked) => patch({ supportsTools: checked })} />
            </SettingRow>

            {/* The refusal the reader makes for themselves, beside the one the vendor makes: a model can be
                able to call tools and still not be allowed to, and the two switches mean different things
                to the row. Either one on keeps the schemas from going out. */}
            <SettingRow title={t('assistant.model.no_tools')} description={t('assistant.model.no_tools_hint')}>
              <Switch checked={draft.noTools} label={t('assistant.model.no_tools')} onChange={(checked) => patch({ noTools: checked })} />
            </SettingRow>

            {/* The row's reasoning icon is a switch between off and automatic; which of the depths a model is
                asked for is a fact about that model, so it is chosen here rather than on the row — and the
                depths are the ones its own service names, not a fixed list every vendor is shown. */}
            <Field
              label={t('assistant.composer.thinking')}
              hint={reasoning.canDisable ? t('assistant.model.reasoning_hint') : t('assistant.model.reasoning_no_off')}
            >
              <Select
                aria-label={t('assistant.composer.thinking')}
                value={draft.reasoning}
                onChange={(event) => patch({ reasoning: event.target.value as AssistantReasoning })}
              >
                {reasoningOptions(reasoning, draft.reasoning).map((level) => <option key={level} value={level}>{t(REASONING_LABELS[level])}</option>)}
              </Select>
            </Field>

            <SettingRow title={t('assistant.model.vision')} description={t('assistant.model.vision_hint')}>
              <Switch checked={draft.vision} label={t('assistant.model.vision')} onChange={(checked) => patch({ vision: checked })} />
            </SettingRow>

            {/* A switch is only drawn where the request built for this model has a field behind it. On the
                two wires that have none the group would be an empty box, and an empty box is not what the
                reader needs to hear — what they need is the sentence saying why there is nothing to tick. */}
            <Field label={t('assistant.model.modalities')}>
              {audioOnThisWire ? (
                <>
                  <div role="group" aria-label={t('assistant.model.modalities')} className="flex flex-wrap gap-1.5">
                    {ASSISTANT_MODEL_MODALITIES.map((modality) => {
                      const on = draft.modalities.includes(modality)
                      return (
                        <button
                          key={modality}
                          type="button"
                          aria-pressed={on}
                          onClick={() => patch({ modalities: on ? draft.modalities.filter((entry) => entry !== modality) : [...draft.modalities, modality] })}
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-[length:var(--text-11-5)] transition-colors',
                            on
                              ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                              : 'border-[var(--border-subtle)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
                          )}
                        >
                          {t(MODALITY_KEYS[modality])}
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-1 text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">{t('assistant.model.modalities_hint')}</p>
                </>
              ) : (
                <p className="text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">{t('assistant.model.modalities_no_audio')}</p>
              )}
            </Field>
            <div className="flex flex-col gap-3">
              <TokenField
                labelKey="assistant.model.context"
                hintKey="assistant.model.context_hint"
                value={draft.contextTokens}
                inherited={limits.maxContextTokens}
                steps={TOKEN_STEPS}
                columns={7}
                onChange={(tokens) => patch({ contextTokens: tokens })}
              />
              <TokenField
                labelKey="assistant.model.max_input"
                hintKey="assistant.model.max_input_hint"
                value={draft.maxInputTokens}
                inherited={limits.maxInputTokens}
                steps={TOKEN_STEPS}
                columns={7}
                onChange={(tokens) => patch({ maxInputTokens: tokens })}
              />
              <TokenField
                labelKey="assistant.model.max_output"
                hintKey="assistant.model.max_output_hint"
                value={draft.maxOutputTokens}
                inherited={limits.maxOutputTokens}
                warning={overCeiling
                  ? t(vendorStatedCeiling ? 'assistant.model.limit_over_vendor' : 'assistant.model.limit_over_declared', { tokens: formatTokenStep(outputCeiling) })
                  : undefined}
                // A number already stored above the window stays pickable, or the reader could not see
                // which value they are being asked to lower.
                steps={draft.maxOutputTokens !== null && !outputSteps.includes(draft.maxOutputTokens)
                  ? [...outputSteps, draft.maxOutputTokens].sort((left, right) => left - right)
                  : outputSteps}
                columns={7}
                onChange={(tokens) => patch({ maxOutputTokens: tokens })}
              />
            </div>

            {/* The price rows sit with the token ceilings: all three are about what this model is
                allowed or expected to cost, and a reader setting them is reading a pricing page. */}
            <SettingRow title={t('assistant.stats.model_price')} description={t('assistant.stats.model_price_hint')}>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={draft.inputPrice ?? ''}
                  aria-label={`${t('assistant.stats.model_price')} · ${t('assistant.stats.tokens_in')}`}
                  placeholder={t('assistant.stats.tokens_in')}
                  onChange={(event) => patch({ inputPrice: priceValue(event.target.value) })}
                  className="w-24"
                />
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={draft.outputPrice ?? ''}
                  aria-label={`${t('assistant.stats.model_price')} · ${t('assistant.stats.tokens_out')}`}
                  placeholder={t('assistant.stats.tokens_out')}
                  onChange={(event) => patch({ outputPrice: priceValue(event.target.value) })}
                  className="w-24"
                />
                <Input
                  value={draft.priceCurrency}
                  aria-label={t('assistant.stats.model_currency')}
                  placeholder={t('assistant.stats.model_currency')}
                  maxLength={8}
                  onChange={(event) => patch({ priceCurrency: event.target.value.toUpperCase() })}
                  className="w-20"
                />
              </div>
            </SettingRow>

            <SettingRow
              title={t('assistant.model.price_periods')}
              description={t('assistant.model.price_periods_hint', { zone: timezone })}
              className="md:flex-col md:items-stretch md:gap-2"
            >
              <div className="flex flex-col gap-2">
                {draft.pricePeriods.map((period, index) => (
                  <div
                    key={period.id}
                    className="flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={period.label}
                        maxLength={MAX_PRICE_PERIOD_LABEL_CHARS}
                        aria-label={t('assistant.model.price_period_name')}
                        placeholder={t('assistant.model.price_period_name')}
                        onChange={(event) => updatePeriod(index, { label: event.target.value })}
                        className="min-w-0 flex-1"
                      />
                      <IconButton
                        label={t('assistant.model.price_period_remove')}
                        size="sm"
                        onClick={() => removePeriod(index)}
                      >
                        <X size={13} />
                      </IconButton>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <div role="group" aria-label={t('assistant.model.price_period_days')} className="flex gap-0.5">
                        {WEEKDAYS.map((day) => {
                          const on = period.days.includes(day)
                          return (
                            <button
                              key={day}
                              type="button"
                              aria-pressed={on}
                              aria-label={t(`assistant.weekday.${day}`)}
                              onClick={() => togglePeriodDay(index, day)}
                              className={cn(
                                'size-7 rounded-[var(--r-sm)] border text-[length:var(--text-10-5)] transition-colors duration-[var(--dur-fast)]',
                                on
                                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
                                  : 'border-[var(--border-subtle)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
                              )}
                            >
                              {t(`assistant.weekday.${day}`)}
                            </button>
                          )
                        })}
                      </div>
                      <Input
                        type="time"
                        step={60}
                        value={period.start}
                        aria-label={t('assistant.model.price_period_start')}
                        onChange={(event) => updatePeriod(index, { start: event.target.value })}
                        className="w-[98px]"
                      />
                      <span aria-hidden className="text-[var(--text-quaternary)]">–</span>
                      <Input
                        type="time"
                        step={60}
                        value={period.end}
                        aria-label={t('assistant.model.price_period_end')}
                        onChange={(event) => updatePeriod(index, { end: event.target.value })}
                        className="w-[98px]"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <label className="flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                        {t('assistant.model.price_period_in')}
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={period.inputPrice ?? ''}
                          placeholder={periodPricePlaceholder(draft.inputPrice)}
                          aria-label={`${t('assistant.model.price_period_in')} · ${t('assistant.stats.tokens_in')}`}
                          onChange={(event) => updatePeriod(index, { inputPrice: priceValue(event.target.value) })}
                          className="w-24"
                        />
                      </label>
                      <label className="flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                        {t('assistant.model.price_period_out')}
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={period.outputPrice ?? ''}
                          placeholder={periodPricePlaceholder(draft.outputPrice)}
                          aria-label={`${t('assistant.model.price_period_out')} · ${t('assistant.stats.tokens_out')}`}
                          onChange={(event) => updatePeriod(index, { outputPrice: priceValue(event.target.value) })}
                          className="w-24"
                        />
                      </label>
                      <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                        {draft.priceCurrency || t('assistant.stats.model_currency')}
                      </span>
                    </div>
                  </div>
                ))}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]">
                    {t('assistant.model.price_period_all_days')}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus size={12} />}
                    disabled={draft.pricePeriods.length >= MAX_PRICE_PERIODS}
                    onClick={addPeriod}
                  >
                    {t('assistant.model.price_period_add')}
                  </Button>
                </div>
                {periodsInvalid && (
                  <p role="alert" className="text-[length:var(--text-10-5)] text-[var(--danger)]">
                    {t('assistant.model.price_period_error')}
                  </p>
                )}
              </div>
            </SettingRow>

            <SettingRow title={`${t('assistant.model.temperature')} · ${draft.temperature ?? t('assistant.model.off_means_default')}`}>
              <Switch checked={draft.temperature !== null} label={t('assistant.model.temperature')} onChange={(checked) => patch({ temperature: checked ? 0.7 : null })} />
            </SettingRow>
            {draft.temperature !== null && (
              <Slider
                label={t('assistant.model.temperature')}
                value={draft.temperature}
                min={0}
                max={1.5}
                step={0.05}
                onChange={(value) => patch({ temperature: value })}
              />
            )}

            <SettingRow title={`${t('assistant.model.top_p')} · ${draft.topP ?? t('assistant.model.off_means_default')}`}>
              <Switch checked={draft.topP !== null} label={t('assistant.model.top_p')} onChange={(checked) => patch({ topP: checked ? 1 : null })} />
            </SettingRow>
            {draft.topP !== null && (
              <Slider label={t('assistant.model.top_p')} value={draft.topP} min={0} max={1} step={0.05} onChange={(value) => patch({ topP: value })} />
            )}

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('assistant.model.custom')}</span>
                <button
                  type="button"
                  onClick={() => patch({ customParams: [...draft.customParams, { name: '', type: 'string', value: '' }] })}
                  className="rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 py-0.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  {t('assistant.model.custom_add')}
                </button>
              </div>
              <p className="mb-2 text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">{t('assistant.model.custom_hint')}</p>
              {draft.customParams.map((param, index) => (
                <div key={index} className="mb-1.5 flex items-center gap-1.5">
                  <Input
                    aria-label={`${t('assistant.model.custom_name')} ${index + 1}`}
                    value={param.name}
                    placeholder={t('assistant.model.custom_name')}
                    className="min-w-0 flex-1"
                    onChange={(event) => patch({ customParams: draft.customParams.map((row, at) => (at === index ? { ...row, name: event.target.value } : row)) })}
                  />
                  <Select
                    aria-label={`${t('assistant.model.kind')} ${index + 1}`}
                    value={param.type}
                    className="w-[74px] shrink-0"
                    onChange={(event) => patch({ customParams: draft.customParams.map((row, at) => (at === index ? { ...row, type: event.target.value as AssistantParamType } : row)) })}
                  >
                    {(['string', 'number', 'boolean'] as const).map((type) => <option key={type} value={type}>{t(PARAM_TYPE_KEYS[type])}</option>)}
                  </Select>
                  <Input
                    aria-label={`${t('assistant.model.custom_value')} ${index + 1}`}
                    value={param.value}
                    placeholder={t('assistant.model.custom_value')}
                    className="min-w-0 flex-1"
                    onChange={(event) => patch({ customParams: draft.customParams.map((row, at) => (at === index ? { ...row, value: event.target.value } : row)) })}
                  />
                  <button
                    type="button"
                    aria-label={t('assistant.model.remove_param', { index: index + 1 })}
                    onClick={() => patch({ customParams: draft.customParams.filter((_, at) => at !== index) })}
                    className="flex size-11 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--border-default)] text-[var(--danger)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--danger-soft)] md:size-[34px]"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {failure && <SaveFailure failure={failure} />}

        <p className="text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">{t('assistant.model.picker_hint')}</p>
      </div>
    </Modal>
  )
}
