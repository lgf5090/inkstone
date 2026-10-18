/**
 * The template's passages, as far as the run has got.
 *
 * A template that asks the assistant to write several passages spends several turns, and a turn is slow
 * enough that the reader needs the same three answers any long job needs: how many there are, which one
 * is going on, and — when one stopped — which one, with a way back in that does not pay for the ones
 * already answered. The answers themselves are deliberately not shown here: they are the note's text and
 * the note is on screen behind this card.
 *
 * The card is mounted by the shell rather than by the panel that started it, because the panel closes the
 * moment the note is made and the run outlives it.
 */
import { createPortal } from 'react-dom'
import { CheckCircle2, Circle, Loader2, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import {
  canRetryTemplateSlot,
  templateSlotReason,
  templateSlotStoppedTitle,
  useTemplateSlotJob,
  type TemplateSlotState,
} from './template-slot-job'
import { discardTemplateSlotFill, retryTemplateSlot } from './template-fill'

/**
 * The state, in words the reader can scan.
 *
 * Spelled out rather than left to the icon: the icon is decoration, and a screen reader gets the same
 * four facts as an eye.
 */
const STATE_LABELS: Record<TemplateSlotState, () => string> = {
  pending: () => t('assistant.template.slot_pending'),
  running: () => t('assistant.template.slot_running'),
  filled: () => t('assistant.template.slot_filled'),
  failed: () => t('assistant.template.slot_failed'),
}

function SlotMark({ state }: { state: TemplateSlotState }) {
  if (state === 'filled') return <CheckCircle2 size={13} className="text-[var(--accent)]" aria-hidden="true" />
  // `animate-spin` is capped by the `prefers-reduced-motion` rule in `app.css`, which is the only
  // animation on this card: the states are also said in text, so nothing is told by motion alone.
  if (state === 'running') return <Loader2 size={13} className="animate-spin text-[var(--accent)]" aria-hidden="true" />
  if (state === 'failed') return <TriangleAlert size={13} className="text-[var(--danger)]" aria-hidden="true" />
  return <Circle size={13} className="text-[var(--text-quaternary)]" aria-hidden="true" />
}

export function TemplateSlotProgress() {
  const job = useTemplateSlotJob((state) => state.job)
  if (!job) return null
  if (typeof document === 'undefined') return null

  const total = job.slots.length
  const runningIndex = job.slots.findIndex((slot) => slot.state === 'running')
  const filled = job.slots.filter((slot) => slot.state === 'filled').length
  const stoppedIndex = job.stoppedAt
  const stoppedSlot = stoppedIndex === null ? null : job.slots[stoppedIndex] ?? null
  const retryable = stoppedIndex !== null && canRetryTemplateSlot(stoppedIndex)

  return createPortal(
    <section
      role="status"
      aria-live="polite"
      aria-label={t('assistant.template.progress_label')}
      className={cn(
        'pointer-events-auto fixed bottom-[calc(64px+env(safe-area-inset-bottom))] left-2 z-[var(--z-toast)] w-[min(340px,calc(100vw-32px))]',
        'md:left-4 md:bottom-4',
        'rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-3 shadow-[var(--shadow-pop)]',
      )}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
          {job.status === 'stopped' && stoppedIndex !== null
            ? templateSlotStoppedTitle(job)
            : t('assistant.template.progress_count', { current: runningIndex >= 0 ? runningIndex + 1 : filled, total })}
        </p>
        <IconButton label={t('common.close')} size="xs" onClick={() => discardTemplateSlotFill()}>
          <X size={12} />
        </IconButton>
      </div>

      {/* What the run is held up by, said as itself: a passage being waited on is not a passage that
          failed, and the reader who cannot tell the two either closes the card or waits for nothing. */}
      {runningIndex >= 0 && job.status === 'running' && (
        <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.template.waiting_answer')}</p>
      )}

      <ol className="mt-1.5 flex flex-col gap-1">
        {job.slots.map((slot, index) => (
          <li key={index} aria-current={slot.state === 'running' ? 'step' : undefined} className="min-w-0">
            <span className="flex items-start gap-1.5 text-[length:var(--text-11)]">
              <SlotMark state={slot.state} />
              <span className={cn('min-w-0 break-words', slot.state === 'filled' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]')}>
                {slot.instruction}
              </span>
              <span className="sr-only">{STATE_LABELS[slot.state]()}</span>
            </span>
          </li>
        ))}
      </ol>

      {/* A stopped run states its reason and its way out. The note is left as the template wrote it, so
          what the reader is choosing between is trying the one passage again and giving up the set. */}
      {job.status === 'stopped' && (
        <p role="alert" className="mt-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
          {stoppedSlot ? `${STATE_LABELS.failed()} · ${templateSlotReason(stoppedSlot)}` : t('assistant.template.note_gone')}
        </p>
      )}

      {job.status === 'stopped' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {retryable && stoppedIndex !== null && (
            <Button size="sm" variant="primary" onClick={() => retryTemplateSlot(stoppedIndex)}>
              {t('assistant.template.retry_slot')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => discardTemplateSlotFill()}>
            {t('assistant.template.discard')}
          </Button>
        </div>
      )}
    </section>,
    document.body,
  )
}
