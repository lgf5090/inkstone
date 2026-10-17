/**
 * What a thumbs-down actually said.
 *
 * A downvote alone tells the assistant nothing: it is a verdict without a ground, and the reader who
 * bothered to press it knows exactly what was wrong. The five grounds below are not invented — each one is
 * a rule the assistant's own system prompt already holds it to (`src/shared/locales/en-US-assistant-prompt.ts`):
 * a claim of a finished task that no tool call backs is *wrong*, an answer cut short is *incomplete*, an
 * answer to a different question is *off topic*, a padded or a one-line reply breaks "the shortest reply
 * that is still useful", and an instruction the model stepped over is the first rule of the prompt. A set
 * the prompts do not distinguish would be a set of words the model cannot act on.
 *
 * The grounds travel two ways: recorded beside the verdict, and re-asking the question *on those grounds* —
 * the second is the one a reader can feel working immediately, while the first only pays off over time.
 */
import { useId, useState, type RefObject } from 'react'
import { X } from 'lucide-react'
import type { MessageFeedback } from '@shared/assistant'
import type { MessageKey } from '@shared/locales/en-US'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { useAssistant } from './assistant-store'

export const FEEDBACK_REASONS = ['wrong', 'incomplete', 'off_topic', 'length', 'ignored_instruction'] as const

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]

const REASON_LABELS: Record<FeedbackReason, MessageKey> = {
  wrong: 'assistant.chat.reason_wrong',
  incomplete: 'assistant.chat.reason_incomplete',
  off_topic: 'assistant.chat.reason_off_topic',
  length: 'assistant.chat.reason_length',
  ignored_instruction: 'assistant.chat.reason_ignored',
}

/**
 * How much a reason may say, in characters.
 *
 * The bound is the one the route is being written against, so it is stated once here and the field is
 * limited to it: a reader cannot submit a paragraph the server would refuse, and the composed grounds are
 * cut to the same length rather than refused after the join.
 */
export const FEEDBACK_REASON_LIMIT = 500

/** The grounds as one line: the ticks the reader made, then whatever they wrote beside them. */
export function feedbackReasonText(reasons: readonly FeedbackReason[], note: string): string {
  const parts = reasons.map((reason) => t(REASON_LABELS[reason]))
  const own = note.trim()
  if (own) parts.push(own)
  return parts.join(' · ').slice(0, FEEDBACK_REASON_LIMIT)
}

/** The body the feedback route is written against: the verdict, and the bounded grounds beside it. */
export interface FeedbackRequestBody {
  feedback: MessageFeedback | null
  reason?: string
}

export function feedbackBody(feedback: MessageFeedback | null, reason: string): FeedbackRequestBody {
  return reason ? { feedback, reason } : { feedback }
}

/**
 * Put the grounds on the wire beside the verdict, and answer with whatever stopped it.
 *
 * The ONE place the shape is spelled, so a route that settled on a different field name is a change here
 * and nowhere else. The verdict itself travels through the store's `rateAnswer` (it owns the optimistic
 * paint, the same-thumb-clears toggle and the rollback); this writes the same row with the grounds added,
 * which is why it re-reads the conversation id rather than assuming one is on screen.
 */
export async function sendAnswerFeedback(messageId: string, reason: string): Promise<string | null> {
  const conversationId = useAssistant.getState().activeId
  // A verdict with no conversation behind it has no row to write the grounds on, and that is said rather
  // than a panel that appears to have saved something.
  if (!conversationId) return t('assistant.embed.no_conversation')
  const body = feedbackBody('down', reason)
  try {
    await api.assistant.rateAnswer(conversationId, messageId, body.feedback, body.reason)
    return null
  } catch (error) {
    return error instanceof Error && error.message ? error.message : String(error)
  }
}

/**
 * The inline card a downvote opens: the grounds, an optional line of the reader's own, and the two things
 * a ground is for — record it, or ask again on it.
 *
 * It is mounted while the bubble lives and shown or hidden by `open`, because a card that unmounts on
 * dismissal takes the reader's half-typed sentence with it. Escape and the close row both hand the focus
 * back to the thumb that opened the card.
 */
export function FeedbackReasonPanel({ messageId, open, triggerRef, onClose }: {
  messageId: string
  open: boolean
  /** The thumbs-down button, so dismissing the card does not strand a keyboard reader at the top of the page. */
  triggerRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const headingId = useId()
  const [picked, setPicked] = useState<FeedbackReason[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'reask' | null>(null)

  if (!open) return null
  const grounds = feedbackReasonText(picked, note)
  const close = (): void => {
    setError(null)
    onClose()
    // The card is a disclosure: the thumb that opened it is where a keyboard reader goes back to, and a
    // card that unmounts under the focus would leave them at the top of the thread.
    triggerRef.current?.focus({ preventScroll: true })
  }

  const record = async (): Promise<string | null> => {
    setBusy('save')
    setError(null)
    const failure = await sendAnswerFeedback(messageId, grounds)
    setBusy(null)
    return failure
  }

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-feedback-reasons=""
      className="max-w-[72ch] space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-2.5"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        close()
      }}
    >
      <div className="flex items-start gap-2">
        <p id={headingId} className="min-w-0 flex-1 text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
          {t('assistant.chat.reason_title')}
        </p>
        <IconButton size="sm" label={t('common.close')} onClick={close}>
          <X size={12} />
        </IconButton>
      </div>
      <div className="flex flex-wrap gap-1">
        {FEEDBACK_REASONS.map((reason) => (
          <button
            key={reason}
            type="button"
            data-feedback-reason={reason}
            aria-pressed={picked.includes(reason)}
            onClick={() => {
              setPicked((current) => (current.includes(reason)
                ? current.filter((entry) => entry !== reason)
                : [...current, reason]))
            }}
            className="inline-flex items-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)] hover:border-[var(--accent)] hover:text-[var(--accent)] aria-pressed:border-[var(--accent)] aria-pressed:text-[var(--accent)]"
          >
            {t(REASON_LABELS[reason])}
          </button>
        ))}
      </div>
      <Field label={t('assistant.chat.reason_note')}>
        <Input
          value={note}
          maxLength={FEEDBACK_REASON_LIMIT}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {/* The grounds read back to the reader before anything is sent: a card that sends a sentence the
          reader has not seen assembled is a sentence they cannot check. */}
      {grounds && (
        <p className="break-words text-[length:var(--text-11)] text-[var(--text-tertiary)]">{grounds}</p>
      )}
      {error && <p role="alert" className="break-words text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || !grounds}
          loading={busy === 'save'}
          onClick={() => {
            void record().then((failure) => {
              if (failure) {
                setError(failure)
                return
              }
              useUi.getState().toast({ title: t('assistant.chat.reason_saved'), tone: 'success' })
              onClose()
            })
          }}
        >
          {t('common.save')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy !== null || !grounds}
          loading={busy === 'reask'}
          onClick={() => {
            setBusy('reask')
            setError(null)
            void (async () => {
              const failure = await sendAnswerFeedback(messageId, grounds)
              if (failure) {
                setBusy(null)
                setError(failure)
                return
              }
              const accepted = await useAssistant.getState().send(t('assistant.chat.reask_prompt', { grounds }))
              setBusy(null)
              if (!accepted) {
                setError(t('assistant.edit.busy'))
                return
              }
              onClose()
            })()
          }}
        >
          {t('assistant.chat.reask')}
        </Button>
      </div>
    </div>
  )
}
