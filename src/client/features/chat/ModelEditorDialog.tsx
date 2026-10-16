/**
 * The model's own editor: what it is for, what it can do, and the numbers it is given.
 *
 * The composer's chips cover the two settings a reader changes often. This covers the rest, which are
 * per-model facts rather than per-conversation choices: whether the endpoint answers in pictures, how
 * much it claims to take in, and the vendor-specific fields our request builder does not know about.
 * Everything here is read by the request path — a switch that changed nothing would be worse than no
 * switch, because it would be believed.
 */
import { useState } from 'react'
import { Check, ChevronDown, Copy, Save, X } from 'lucide-react'
import type {
  AssistantCustomParam,
  AssistantLimits,
  AssistantModel,
  AssistantModelKind,
  AssistantModelPurpose,
  AssistantParamType,
  AssistantProvider,
  AssistantReasoning,
} from '@shared/assistant'
import { ASSISTANT_MODEL_KINDS, ASSISTANT_MODEL_MODALITIES, ASSISTANT_MODEL_PURPOSES, ASSISTANT_PROTOCOLS, CONTEXT_WINDOW_STEPS, TOKEN_STEPS, formatTokenStep } from '@shared/assistant'
import type { AssistantModelModality, AssistantProtocol } from '@shared/assistant'
import { REASONING_LABELS } from './ComposerControls'
import { modelReasoning, reasoningOptions } from './model-reasoning'
import { ChipRow } from './assistant-settings-shared'
import { cn } from '../../lib/cn'
import { COPY_RESET_MS } from '../../lib/motion'
import { t } from '../../lib/i18n'
import { Field, Input, Segmented, Select, SettingRow, Slider, Switch } from '../../components/form'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { useUi } from '../../store/ui'

const PURPOSE_KEYS: Record<AssistantModelPurpose, Parameters<typeof t>[0]> = {
  chat: 'assistant.model.purpose.chat',
  image_generate: 'assistant.model.purpose.image_generate',
  image_edit: 'assistant.model.purpose.image_edit',
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
}

export function draftFromModel(model: AssistantModel): ModelDraft {
  return {
    label: model.label,
    purpose: model.purpose,
    kind: model.kind,
    supportsTools: model.supportsTools,
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
  }
}

/** A typed price, or null for a field the reader has cleared. */
function priceValue(raw: string): number | null {
  if (!raw.trim()) return null
  const numeric = Number(raw)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null
}

const MODALITY_KEYS: Record<AssistantModelModality, Parameters<typeof t>[0]> = {
  audio: 'assistant.model.modality.audio',
  video: 'assistant.model.modality.video',
}

/**
 * One row of preset buttons under a number field. The reader picks 256K rather than typing 262144,
 * and the field still takes any number the presets do not offer.
 *
 * Pressing the preset that is already taken takes it back, which is how a number is cleared without
 * deleting digits by hand: the field is optional, and a row with no way to empty it reads as required.
 */
/**
 * One of the three token numbers: the field, its quick picks, and what a blank one means.
 *
 * Drawn as a full-width row rather than a third of one, because the picks are ten buttons wide: in a
 * column each set wrapped onto three ragged lines and the three settings read as one crowded block.
 */
function TokenField({ labelKey, hintKey, value, inherited, steps, columns = 5, onChange }: {
  labelKey: Parameters<typeof t>[0]
  hintKey: Parameters<typeof t>[0]
  value: number | null
  /** The account ceiling that answers while this field is empty, named beside it so the reader can see it. */
  inherited: number
  steps: readonly number[]
  columns?: 3 | 5
  onChange: (tokens: number | null) => void
}) {
  const label = t(labelKey)
  return (
    <Field label={label} hint={t(hintKey)}>
      <div className="flex items-center justify-between gap-2">
        <Input
          type="number"
          inputMode="numeric"
          aria-label={label}
          value={value ?? ''}
          placeholder={t('assistant.model.unset')}
          onChange={(event) => onChange(numberOrNull(event.target.value))}
          className="w-36"
        />
        <span className="text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
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
  onClose: () => void
  onSave: (draft: ModelDraft) => Promise<void> | void
}) {
  const [draft, setDraft] = useState<ModelDraft>(() => draftFromModel(model))
  // The rungs this model's own service publishes, and whether it can be stopped at all. Read from the same
  // rule the worker builds the request with, so the levels offered here are the levels that travel.
  const reasoning = modelReasoning(model, provider)
  // A model cannot be its own spare, and a model the reader has switched off cannot answer — except the one
  // already picked, which stays listed so turning it off is something the reader can see and undo here.
  const spares = models.filter((entry) =>
    entry.id !== model.id && (entry.enabled || entry.id === draft.fallbackModelId))
  const [more, setMore] = useState(false)
  const [copied, setCopied] = useState(false)
  const toast = useUi((state) => state.toast)
  const patch = (part: Partial<ModelDraft>) => setDraft((current) => ({ ...current, ...part }))

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
      title={t('assistant.model.edit')}
      description={provider ? `${provider.label} · ${model.model}` : model.model}
      width={560}
      bodyClassName="p-4"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={<Save size={14} />} onClick={() => { onSave(draft); onClose() }}>{t('assistant.model.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3.5">
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

        <Field label={t('assistant.model.name')}>
          <Input value={draft.label} aria-label={t('assistant.model.name')} onChange={(event) => patch({ label: event.target.value })} />
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
          <div className="flex flex-col gap-3.5 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
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

            <Field label={t('assistant.model.modalities')}>
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
            </Field>
            <div className="flex flex-col gap-3.5">
              <TokenField
                labelKey="assistant.model.context"
                hintKey="assistant.model.context_hint"
                value={draft.contextTokens}
                inherited={limits.maxContextTokens}
                steps={CONTEXT_WINDOW_STEPS}
                columns={3}
                onChange={(tokens) => patch({ contextTokens: tokens })}
              />
              <TokenField
                labelKey="assistant.model.max_input"
                hintKey="assistant.model.max_input_hint"
                value={draft.maxInputTokens}
                inherited={limits.maxInputTokens}
                steps={TOKEN_STEPS}
                onChange={(tokens) => patch({ maxInputTokens: tokens })}
              />
              <TokenField
                labelKey="assistant.model.max_output"
                hintKey="assistant.model.max_output_hint"
                value={draft.maxOutputTokens}
                inherited={limits.maxOutputTokens}
                steps={TOKEN_STEPS}
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

        <p className="text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">{t('assistant.model.picker_hint')}</p>
      </div>
    </Modal>
  )
}
