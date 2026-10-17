/**
 * How much of the window this thread already takes.
 *
 * The composer has always carried the control that *sets* the window and nothing that says how full it is,
 * so a reader cannot see the moment the app starts folding their older turns into a summary — which is a
 * decision about their own words, made silently, several turns before anything goes wrong.
 *
 * What is counted here is only what the browser may legitimately know: the thread's own turns, the answers
 * its tools brought back, and what is being typed. The system prompt is not reachable from a client at all —
 * it carries the reader's standing instructions, the recalled memories and the pinned note, and only the
 * worker builds it — so the bar measures the thread against the room the window can give it rather than
 * against the whole window. That makes it a floor: the thread is at least this full, and the app takes what
 * it charges for the prompt out of the same window first. The wording says so rather than dressing an
 * undercount up as a measurement.
 */
import { useMemo } from 'react'
import type { AssistantLimits, AssistantMessage, AssistantModel } from '@shared/assistant'
import { contextBudgetFor, estimateTokens, formatTokenStep } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'

/**
 * The share of the room that turns the bar into a warning.
 *
 * Below eight tenths the thread is still the size the reader chose; past it, the turns the app is about to
 * fold away are the ones being read now, so the fact deserves to be said before the limit is reached rather
 * than at it. It is not a hover affordance: the reason is written under the bar for every pointing device.
 */
const WARN_AT_PERCENT = 80

/**
 * What the app adds around one stored turn when it rebuilds the prompt.
 *
 * The same figure the worker budgets a turn at: the role and the framing are a cost of their own, and a
 * thread of many short turns is not the same size as the same words in one block.
 */
const TURN_FRAMING_TOKENS = 4

/**
 * What the thread's own turns cost, before anything is typed.
 *
 * A tool's answer is counted because it rides back out on every later prompt — leaving it out under-priced
 * exactly the turns that read the most, which is the mistake the worker's own budget already fixes.
 */
export function threadTokens(messages: readonly AssistantMessage[]): number {
  return messages.reduce(
    (total, message) => total
      + estimateTokens(message.content)
      + (message.tools ?? []).reduce((sum, tool) => sum + estimateTokens(tool.result ?? ''), 0)
      + TURN_FRAMING_TOKENS,
    0,
  )
}

export function ContextUsageMeter({ messages, hasMore, draft, model, limits }: {
  messages: readonly AssistantMessage[]
  /** Whether earlier turns exist that this page never loaded, and so never counted. */
  hasMore: boolean
  draft: string
  model: AssistantModel
  limits: AssistantLimits
}) {
  // Only the thread is memoised: the draft changes on every keystroke, and it is one short text.
  const counted = useMemo(() => threadTokens(messages), [messages])
  const used = counted + estimateTokens(draft)
  // What the answer is allowed to spend comes off the window before the thread is fed into it, so what is
  // left here is the most a thread can ever be given — the prompt's own cost is not knowable from a client.
  const room = Math.max(1, contextBudgetFor(model, limits) - (model.maxOutputTokens ?? limits.maxOutputTokens))
  const percent = Math.min(100, Math.round((used / room) * 100))
  const warning = percent >= WARN_AT_PERCENT
  const detail = t('assistant.context.meter_detail', {
    used: formatTokenStep(used),
    limit: formatTokenStep(room),
    turns: messages.length,
  })
  return (
    <div className="px-1 pb-1">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {t('assistant.context.meter_label')}
        </span>
        <span
          role="progressbar"
          aria-label={t('assistant.context.meter_label')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={detail}
          className={cn(
            'h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--bg-inset)]',
            warning && 'bg-[color-mix(in_oklab,var(--warning)_35%,var(--bg-inset))]',
          )}
        >
          {/* The width is the reading itself, so it is a runtime value rather than a style rule. */}
          <span
            className={cn(
              'block h-full rounded-full transition-[width] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              warning ? 'bg-[var(--warning)]' : 'bg-[var(--accent)]',
            )}
            style={{ width: `${percent}%` }}
          />
        </span>
        <span
          className={cn(
            'shrink-0 text-[length:var(--text-10-5)] tabular-nums',
            warning ? 'text-[var(--warning)]' : 'text-[var(--text-quaternary)]',
          )}
        >
          {formatTokenStep(used)} / {formatTokenStep(room)}
        </span>
      </div>
      <p className="mt-0.5 text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">
        {t('assistant.context.meter_scope')}
        {hasMore && ` · ${t('assistant.context.meter_older')}`}
      </p>
      {/* Spoken as well as drawn: a warning that only a hover could reach would be a warning most readers
          never get, and this one is about what happens to the reader's own words. */}
      {warning && (
        <p role="status" className="mt-0.5 text-[length:var(--text-10-5)] leading-snug text-[var(--warning)]">
          {t('assistant.context.meter_warning')}
        </p>
      )}
    </div>
  )
}
