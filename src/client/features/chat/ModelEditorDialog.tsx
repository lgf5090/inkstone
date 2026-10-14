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
import { Copy } from 'lucide-react'
import type {
  AssistantCustomParam,
  AssistantModel,
  AssistantModelKind,
  AssistantModelPurpose,
  AssistantParamType,
} from '@shared/assistant'
import { ASSISTANT_MODEL_KINDS, ASSISTANT_MODEL_MODALITIES, ASSISTANT_MODEL_PURPOSES, ASSISTANT_PROTOCOLS, CONTEXT_WINDOW_STEPS, MAX_INPUT_STEPS, MAX_OUTPUT_STEPS, formatTokenStep } from '@shared/assistant'
import type { AssistantModelModality, AssistantProtocol } from '@shared/assistant'
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
  contextTokens: number | null
  maxInputTokens: number | null
  modalities: AssistantModelModality[]
  maxOutputTokens: number
  temperature: number | null
  topP: number | null
  customParams: AssistantCustomParam[]
  /** Null means the model is called on whatever wire its provider speaks. */
  protocol: AssistantProtocol | null
}

export function draftFromModel(model: AssistantModel): ModelDraft {
  return {
    label: model.label,
    purpose: model.purpose,
    kind: model.kind,
    supportsTools: model.supportsTools,
    contextTokens: model.contextTokens,
    maxInputTokens: model.maxInputTokens,
    modalities: [...model.modalities],
    maxOutputTokens: model.maxOutputTokens,
    temperature: model.temperature,
    topP: model.topP,
    customParams: model.customParams.map((param) => ({ ...param })),
    protocol: model.protocol,
  }
}

const MODALITY_KEYS: Record<AssistantModelModality, Parameters<typeof t>[0]> = {
  audio: 'assistant.model.modality.audio',
  video: 'assistant.model.modality.video',
}

/**
 * One row of preset buttons under a number field. The reader picks 256K rather than typing 262144,
 * and the field still takes any number the presets do not offer.
 */
function ChipRow({ label, steps, value, onPick }: {
  label: string
  steps: readonly number[]
  value: number | null
  onPick: (tokens: number) => void
}) {
  return (
    <div role='group' aria-label={label} className="mt-1 flex flex-wrap gap-1">
      {steps.map((tokens) => (
        <button
          key={tokens}
          type="button"
          aria-pressed={value === tokens}
          onClick={() => onPick(tokens)}
          className={cn(
            'rounded-full border px-1.5 py-0.5 text-[length:var(--text-10-5)] tabular-nums transition-colors',
            value === tokens
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
              : 'border-[var(--border-subtle)] text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
          )}
        >
          {formatTokenStep(tokens)}
        </button>
      ))}
    </div>
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
  providerLabel,
  onClose,
  onSave,
}: {
  model: AssistantModel
  providerLabel: string
  onClose: () => void
  onSave: (draft: ModelDraft) => Promise<void> | void
}) {
  const [draft, setDraft] = useState<ModelDraft>(() => draftFromModel(model))
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
    <Modal open onClose={onClose} title={t('assistant.model.edit')} description={`${providerLabel} · ${model.model}`} width={560} bodyClassName="p-4">
      <div className="space-y-3">
        <Field label={t('assistant.model.id')}>
          <div className="flex items-center gap-1.5">
            <Input value={model.model} readOnly aria-label={t('assistant.model.id')} className="min-w-0 flex-1 font-mono text-[length:var(--text-12)]" />
            <button
              type="button"
              onClick={() => void copyId()}
              aria-label={t('assistant.model.copy')}
              className="flex size-8 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
            >
              <Copy size={13} />
            </button>
            {copied && <span className="shrink-0 text-[length:var(--text-11)] text-[var(--success)]">{t('assistant.model.copied')}</span>}
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

        <button type="button" onClick={() => setMore((value) => !value)} className="flex w-full items-center justify-between py-1 text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
          {t('assistant.model.more')}
          <span aria-hidden className={more ? 'rotate-180' : ''}>⌄</span>
        </button>

        {more && (
          <div className="space-y-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5">
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

            <SettingRow title={t('assistant.model.tools')} description={t('assistant.model.tools_hint')}>
              <Switch checked={draft.supportsTools} label={t('assistant.model.tools')} onChange={(checked) => patch({ supportsTools: checked })} />
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
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <Field label={t('assistant.model.context')}>
                <Input
                  type="number"
                  inputMode="numeric"
                  aria-label={t('assistant.model.context')}
                  value={draft.contextTokens ?? ''}
                  placeholder={String(model.maxOutputTokens)}
                  onChange={(event) => patch({ contextTokens: numberOrNull(event.target.value) })}
                />
                <ChipRow
                  label={t('assistant.model.context')}
                  steps={CONTEXT_WINDOW_STEPS}
                  value={draft.contextTokens}
                  onPick={(tokens) => patch({ contextTokens: tokens })}
                />
              </Field>
              <Field label={t('assistant.model.max_input')}>
                <Input
                  type="number"
                  inputMode="numeric"
                  aria-label={t('assistant.model.max_input')}
                  value={draft.maxInputTokens ?? ''}
                  onChange={(event) => patch({ maxInputTokens: numberOrNull(event.target.value) })}
                />
                <ChipRow
                  label={t('assistant.model.max_input')}
                  steps={MAX_INPUT_STEPS}
                  value={draft.maxInputTokens}
                  onPick={(tokens) => patch({ maxInputTokens: tokens })}
                />
                <p className="mt-1 text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">{t('assistant.model.max_input_hint')}</p>
              </Field>
              <Field label={t('assistant.model.max_output')}>
                <Input
                  type="number"
                  inputMode="numeric"
                  aria-label={t('assistant.model.max_output')}
                  value={draft.maxOutputTokens}
                  onChange={(event) => patch({ maxOutputTokens: numberOrNull(event.target.value) ?? 1024 })}
                />
                <ChipRow
                  label={t('assistant.model.max_output')}
                  steps={MAX_OUTPUT_STEPS}
                  value={draft.maxOutputTokens}
                  onPick={(tokens) => patch({ maxOutputTokens: tokens })}
                />
              </Field>
            </div>

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
                    className="shrink-0 rounded-[var(--r-sm)] border border-[var(--border-default)] px-2 py-1 text-[length:var(--text-11-5)] text-[var(--danger)] hover:bg-[var(--bg-hover)]"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">{t('assistant.model.picker_hint')}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => { onSave(draft); onClose() }}>{t('assistant.model.save')}</Button>
        </div>
      </div>
    </Modal>
  )
}
