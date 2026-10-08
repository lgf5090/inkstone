/**
 * The dialogs a QuickAdd run asks with: one per prompt, or a single page for a whole run, plus the
 * suggester list, the date shortcuts and the live arithmetic preview behind them.
 *
 * Everything here is Inkstone chrome — `Modal`, `Button`, `FIELD_BASE`, the command palette's row
 * classes — because a prompt that appears in the middle of typing into a note has to feel like the
 * note's own. The queue in `prompt-queue.ts` owns the promises; this file renders what the queue says
 * to render and answers back.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Check, Plus } from 'lucide-react'
import type { PromptAnswer, PromptRequest } from '../../lib/quickadd/format'
import { evaluateMathExpression, formatMathValue } from '../../lib/quickadd/math'
import { applyCaseStyle } from '../../lib/quickadd/token-grammar'
import { Button } from '../../components/primitives'
import { FIELD_BASE, Slider, Textarea, commitOnEnter } from '../../components/form'
import { Modal } from '../../components/overlay'
import { fuzzyFilter } from '../../lib/fuzzy'
import { usePinyinVersion } from '../../lib/pinyin'
import { randomLocalId } from '../../lib/random-id'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import {
  cancelQuickAddPrompts,
  currentPromptGroup,
  currentPromptSequence,
  queuedPromptCount,
  resetQuickAddPrompts,
  submitQuickAddPrompts,
  subscribeQuickAddPrompts,
  type PromptAnswers,
  type PromptGroup,
} from './prompt-queue'

const ROW_CLASS = 'flex w-full items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left text-[13px]'

interface DraftEntry {
  text: string
  picks: string[]
  query: string
}

function emptyDraft(request: PromptRequest): DraftEntry {
  return { text: request.defaultValue, picks: [], query: '' }
}

export function QuickAddPromptHost() {
  const group = useSyncExternalStore(subscribeQuickAddPrompts, currentPromptGroup)
  const sequence = useSyncExternalStore(subscribeQuickAddPrompts, currentPromptSequence)
  useEffect(() => resetQuickAddPrompts, [])
  if (!group) return null
  return group.onePage
    ? <OnePagePrompt key={sequence} group={group} />
    : <SinglePrompt key={sequence} group={group} />
}

function contextLine(group: PromptGroup): string {
  const queued = queuedPromptCount()
  const base = group.destination
    ? t('quickadd.prompt_for_into', { name: group.choiceName, destination: group.destination })
    : t('quickadd.prompt_for', { name: group.choiceName })
  return queued > 0 ? `${base} · ${t('quickadd.prompt_queued', { count: queued })}` : base
}

function answerOf(request: PromptRequest, draft: DraftEntry): PromptAnswer {
  if (request.multiSelect && draft.picks.length > 0)
    return request.caseStyle ? draft.picks.map((item) => applyCaseStyle(item, request.caseStyle)) : [...draft.picks]
  const text = request.trim ? draft.text.trim() : draft.text
  return applyCaseStyle(text, request.caseStyle)
}

/** What counts as an answer: a pick for a picker, text otherwise; `|optional` always allows empty. */
function hasAnswer(request: PromptRequest, draft: DraftEntry): boolean {
  if (request.optional) return true
  // A yes/no question needs an explicit press: closing the dialog is a cancelled run, not a "No".
  if (request.kind === 'checkbox' || request.kind === 'confirm')
    return draft.text === 'true' || draft.text === 'false'
  return draft.text.trim() !== '' || draft.picks.length > 0
}

function SuggesterRows({
  request,
  draft,
  onPick,
}: {
  request: PromptRequest
  draft: DraftEntry
  onPick: (value: string) => void
}) {
  const pinyinVersion = usePinyinVersion()
  const rows = useMemo(() => {
    const base = request.options.map((value, index) => ({
      value,
      text: request.displayOptions?.[index] ?? value,
    }))
    if (draft.query.trim() === '') return base
    return fuzzyFilter(base, draft.query, (item) => item.text).map((match) => match.item)
  }, [draft.query, request.displayOptions, request.options, pinyinVersion])

  return (
    <div className="space-y-1">
      <div role="listbox" aria-multiselectable={request.multiSelect || undefined} className="max-h-[min(46vh,320px)] overflow-y-auto">
        {rows.map((row) => {
          const selected = draft.picks.includes(row.value) || (!request.multiSelect && draft.text === row.value)
          return (
            <button
              key={row.value}
              type="button"
              role="option"
              aria-selected={selected}
              data-quickadd-option={row.value}
              onClick={() => onPick(row.value)}
              className={cn(selected ? `${ROW_CLASS} bg-[var(--accent-soft)]` : ROW_CLASS, 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}
            >
              <span className={cn('grid size-4 shrink-0 place-items-center rounded-[5px] border',
                selected ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-overlay)]' : 'border-[var(--border-default)]')}>
                {selected && <Check size={11} aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.text}</span>
            </button>
          )
        })}
        {rows.length === 0 && (
          <p className="px-1 py-3 text-[12.5px] text-[var(--text-tertiary)]">{t('quickadd.prompt_no_options')}</p>
        )}
      </div>
      {request.allowCustom && draft.query.trim() !== '' && (
        <button type="button" data-quickadd-custom className={cn(ROW_CLASS, 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')} onClick={() => onPick(draft.query.trim())}>
          <Plus size={14} className="shrink-0 text-[var(--text-quaternary)]" />
          <span className="min-w-0 flex-1 truncate">{t('quickadd.prompt_use_text', { text: draft.query.trim() })}</span>
        </button>
      )}
    </div>
  )
}

function PromptField({
  request,
  draft,
  onChange,
  onPick,
}: {
  request: PromptRequest
  draft: DraftEntry
  onChange: (next: Partial<DraftEntry>) => void
  onPick: (value: string) => void
}) {
  const fieldId = useMemo(() => `quickadd-${randomLocalId('field')}`, [])

  if (request.kind === 'confirm' || request.kind === 'checkbox')
    return (
      <div className="space-y-2">
        {request.kind === 'confirm' && (
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">{request.label}</p>
        )}
        <div className="flex gap-2">
          <Button variant={draft.text === 'true' ? 'primary' : 'secondary'} data-quickadd-yes onClick={() => onPick('true')}>
            {t('quickadd.prompt_yes')}
          </Button>
          <Button variant={draft.text === 'false' ? 'primary' : 'secondary'} data-quickadd-no onClick={() => onPick('false')}>
            {t('quickadd.prompt_no')}
          </Button>
        </div>
      </div>
    )

  if (request.kind === 'suggester')
    return (
      <div className="space-y-2">
        <input
          data-autofocus
          className={cn(FIELD_BASE, 'h-9')}
          placeholder={t('quickadd.prompt_filter')}
          aria-label={t('quickadd.prompt_filter_aria', { name: request.label })}
          value={draft.query}
          onChange={(event) => onChange({ query: event.target.value })}
        />
        <SuggesterRows request={request} draft={draft} onPick={onPick} />
      </div>
    )

  if (request.kind === 'multiline')
    return (
      <Textarea
        data-autofocus
        rows={6}
        value={draft.text}
        placeholder={request.defaultValue}
        aria-label={request.label}
        onChange={(event) => onChange({ text: event.target.value })}
      />
    )

  if (request.kind === 'slider') {
    const min = request.numeric.min ?? 0
    const max = request.numeric.max ?? 100
    const step = request.numeric.step ?? 1
    const parsed = Number(draft.text)
    const current = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min
    return (
      <div className="space-y-2">
        <Slider value={current} min={min} max={max} step={step} label={request.label} onChange={(next) => onChange({ text: String(next) })} />
        <p className="text-[12.5px] text-[var(--text-tertiary)]">{t('quickadd.prompt_value_is', { value: String(current) })}</p>
      </div>
    )
  }

  if (request.kind === 'number')
    return (
      <input
        id={fieldId}
        data-autofocus
        type="number"
        className={cn(FIELD_BASE, 'h-9')}
        min={request.numeric.min}
        max={request.numeric.max}
        step={request.numeric.step ?? 1}
        value={draft.text}
        placeholder={request.defaultValue}
        aria-label={request.label}
        onChange={(event) => onChange({ text: event.target.value })}
      />
    )

  if (request.kind === 'date') {
    const recognized = draft.text === '' || Number.isFinite(Date.parse(draft.text))
    return (
      <div className="space-y-1.5">
        <input
          data-autofocus
          type={recognized || draft.text === '' ? (request.withTime ? 'datetime-local' : 'date') : 'text'}
          className={cn(FIELD_BASE, 'h-9', !recognized && 'border-[var(--danger)]')}
          value={draft.text}
          aria-label={request.label}
          aria-describedby={recognized ? undefined : fieldId}
          id={fieldId}
          onChange={(event) => onChange({ text: event.target.value })}
        />
        {!recognized && (
          <p id={fieldId} className="text-[12px] text-[var(--danger)]">{t('quickadd.prompt_date_kept')}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {([-1, 0, 1, 7] as const).map((offset) => (
            <Button key={offset} size="sm" variant="ghost" onClick={() => onChange({ text: isoDayFrom(offset) })}>
              {offsetLabel(offset)}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  if (request.kind === 'math') {
    const result = evaluateMathExpression(draft.text)
    return (
      <div className="space-y-1">
        <input
          data-autofocus
          className={cn(FIELD_BASE, 'h-9 font-mono')}
          value={draft.text}
          placeholder={t('quickadd.prompt_math_example')}
          aria-label={request.label}
          onChange={(event) => onChange({ text: event.target.value })}
        />
        <p className={cn('text-[12.5px]', result.error ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]')}>
          {result.error || result.value === null
            ? t('quickadd.prompt_math_error', { reason: result.error ?? 'unknown' })
            : t('quickadd.prompt_math_result', { value: formatMathValue(result.value) })}
        </p>
      </div>
    )
  }

  return (
    <input
      data-autofocus
      className={cn(FIELD_BASE, 'h-9')}
      value={draft.text}
      placeholder={request.defaultValue}
      aria-label={request.label}
      onChange={(event) => onChange({ text: event.target.value })}
    />
  )
}

function offsetLabel(offset: number): string {
  if (offset === -1) return t('quickadd.prompt_yesterday')
  if (offset === 0) return t('quickadd.prompt_today')
  if (offset === 1) return t('quickadd.prompt_tomorrow')
  return t('quickadd.prompt_next_week')
}

function isoDayFrom(offset: number): string {
  const now = new Date()
  now.setDate(now.getDate() + offset)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function useDrafts(group: PromptGroup) {
  const [drafts, setDrafts] = useState<Map<string, DraftEntry>>(() =>
    new Map(group.requests.map((request) => [request.key, emptyDraft(request)])))

  const patch = useCallback((key: string, next: Partial<DraftEntry>) => {
    setDrafts((current) => {
      const entry = current.get(key)
      if (!entry) return current
      const merged = new Map(current)
      merged.set(key, { ...entry, ...next })
      return merged
    })
  }, [])

  const pick = useCallback((request: PromptRequest, value: string) => {
    setDrafts((current) => {
      const entry = current.get(request.key)
      if (!entry) return current
      const merged = new Map(current)
      if (request.multiSelect) {
        const picks = entry.picks.includes(value)
          ? entry.picks.filter((item) => item !== value)
          : [...entry.picks, value]
        merged.set(request.key, { ...entry, picks })
      } else {
        merged.set(request.key, { ...entry, text: value, picks: [value] })
      }
      return merged
    })
  }, [])

  return { drafts, patch, pick }
}

function collect(group: PromptGroup, drafts: Map<string, DraftEntry>, onlyFilled: boolean): PromptAnswers {
  const answers: PromptAnswers = new Map()
  for (const request of group.requests) {
    const draft = drafts.get(request.key)
    if (!draft) continue
    if (onlyFilled && !hasAnswer(request, draft)) continue
    answers.set(request.key, answerOf(request, draft))
  }
  return answers
}

function SinglePrompt({ group }: { group: PromptGroup }) {
  const request = group.requests[0]
  const { drafts, patch, pick } = useDrafts(group)
  const draft = drafts.get(request.key) ?? emptyDraft(request)

  const commit = useCallback(() => {
    submitQuickAddPrompts(collect(group, drafts, false))
  }, [drafts, group])

  const dismiss = useCallback(() => {
    cancelQuickAddPrompts(collect(group, drafts, true))
  }, [drafts, group])

  const pickAndMaybeCommit = useCallback((value: string) => {
    // A one-press answer: a single-choice picker or a yes/no question has said everything the OK
    // button would say, so waiting for a second click only slows the run down.
    if (!request.multiSelect && (request.kind === 'suggester' || request.kind === 'checkbox' || request.kind === 'confirm')) {
      submitQuickAddPrompts(new Map([[request.key, answerOf(request, { ...draft, text: value, picks: [value] })]]))
      return
    }
    pick(request, value)
  }, [draft, pick, request])

  const ready = hasAnswer(request, draft)

  return (
    <Modal
      open
      onClose={dismiss}
      title={request.label || group.choiceName}
      description={contextLine(group)}
      width={request.kind === 'suggester' ? 460 : 420}
      footer={<>
        <Button variant="ghost" onClick={dismiss}>{t('common.cancel')}</Button>
        {request.optional && (
          <Button variant="secondary" data-quickadd-skip onClick={() => submitQuickAddPrompts(new Map([[request.key, '']]))}>
            {t('quickadd.prompt_skip')}
          </Button>
        )}
        <Button variant="primary" disabled={!ready} onClick={commit}>
          {t('quickadd.prompt_ok')}
        </Button>
      </>}
    >
      <div
        className="space-y-2 pt-1"
        onKeyDown={(event) => {
          const multiline = event.target instanceof HTMLElement && event.target.tagName === 'TEXTAREA'
          if (multiline && !event.ctrlKey && !event.metaKey) {
            if (event.key === 'Escape') dismiss()
            return
          }
          if (commitOnEnter(event, commit)) return
          if (event.key === 'Escape') dismiss()
        }}
      >
        <PromptField
          request={request}
          draft={draft}
          onChange={(next) => patch(request.key, next)}
          onPick={pickAndMaybeCommit}
        />
        {request.multiSelect && draft.picks.length > 0 && (
          <p className="text-[12.5px] text-[var(--text-tertiary)]">{t('quickadd.prompt_selected', { count: draft.picks.length })}</p>
        )}
        {!ready && !request.optional && (draft.text !== '' || draft.picks.length > 0) && (
          <p className="text-[12px] text-[var(--text-tertiary)]">{t('quickadd.prompt_required_hint')}</p>
        )}
      </div>
    </Modal>
  )
}

function OnePagePrompt({ group }: { group: PromptGroup }) {
  const { drafts, patch, pick } = useDrafts(group)
  const missing = group.requests.filter((request) => {
    const draft = drafts.get(request.key)
    return draft !== undefined && !hasAnswer(request, draft)
  })

  return (
    <Modal
      open
      onClose={() => cancelQuickAddPrompts(collect(group, drafts, true))}
      title={t('quickadd.prompt_page_title', { name: group.choiceName })}
      description={contextLine(group)}
      width={520}
      footer={<>
        <Button variant="ghost" onClick={() => cancelQuickAddPrompts(collect(group, drafts, true))}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={missing.length > 0} onClick={() => submitQuickAddPrompts(collect(group, drafts, false))}>
          {t('quickadd.prompt_ok')}
        </Button>
      </>}
    >
      <div className="space-y-4 pt-1">
        {group.requests.map((request, index) => {
          const draft = drafts.get(request.key)
          if (!draft) return null
          return (
            <div key={`${request.key}-${index}`} data-quickadd-page-row={request.key}>
              <div className="flex items-baseline justify-between gap-3 pb-1.5">
                <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]">{request.label || request.key}</span>
                {!request.optional && <span className="shrink-0 text-[11.5px] text-[var(--text-quaternary)]">{t('quickadd.prompt_required')}</span>}
              </div>
              <PromptField
                request={request}
                draft={draft}
                onChange={(next) => patch(request.key, next)}
                onPick={(value) => pick(request, value)}
              />
            </div>
          )
        })}
        {missing.length > 0 && (
          <p className="text-[12px] text-[var(--text-tertiary)]">{t('quickadd.prompt_missing', { count: missing.length })}</p>
        )}
      </div>
    </Modal>
  )
}
