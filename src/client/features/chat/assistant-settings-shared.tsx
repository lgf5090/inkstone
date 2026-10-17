/**
 * What the assistant settings tabs share.
 *
 * The frame they hang in is AssistantSettingsView.tsx; this file is the parts more than one tab draws:
 * the section wrapper a tab groups its rows with, the three protocol names, and the preset row both token
 * editors are built from. They live here rather than in the shell because the shell no longer knows what
 * is inside a tab.
 */
import { type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { formatTokenStep, REASONING_DIALECTS, type AssistantProvider, type ReasoningDialect } from '@shared/assistant'
import { cn } from '../../lib/cn'
import { t, type MessageKey } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import type { WriteFailure } from './assistant-store'

/**
 * What a screen says when the request behind it was refused, instead of going on spinning.
 *
 * A failure that renders as a spinner is worse than no message at all: the reader waits for an answer that
 * is never coming, and a failure that renders as emptiness teaches them their history is gone. This is the
 * block the settings screens already drew inline — named thing, what the route said, one retry that asks
 * again — so a fourth screen does not invent a fifth shape. The headline comes as a key rather than as
 * translated text, because the message has to follow the reader's language after they switch it.
 */
export function LoadFailure({ messageKey, detail, onRetry }: {
  messageKey: MessageKey
  /** What the request itself reported, when the caller has it. The server's own English, so never the headline. */
  detail?: string | null
  onRetry: () => void
}) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))] bg-[var(--bg-base)] px-3 py-3">
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-[var(--danger)]" />
      <div className="min-w-0 flex-1">
        <p className="text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{t(messageKey)}</p>
        {detail && (
          <p className="mt-0.5 break-words text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{detail}</p>
        )}
      </div>
      <Button size="sm" variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>
    </div>
  )
}

/**
 * The refusal a form prints above its own buttons, in place of the toast it used to get.
 *
 * Two lines because they are two facts: the first is what this app's code means, in the reader's language,
 * and the second is what the route said about the field it refused — the server's own English, which is
 * never the headline because no catalog key translates it. A form whose write came back refused without
 * saying anything still shows the first line: no reason is not a pass.
 */
export function SaveFailure({ failure }: { failure: WriteFailure }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[color-mix(in_oklab,var(--danger)_9%,transparent)] px-3 py-2.5">
      <TriangleAlert size={14} className="mt-[1px] shrink-0 text-[var(--danger)]" />
      <div className="min-w-0">
        <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-secondary)]">{failure.headline}</p>
        {failure.detail && (
          <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{failure.detail}</p>
        )}
      </div>
    </div>
  )
}

/**
 * What a form keeps when a write was refused: the reason it was handed, or the plain claim that the draft
 * is still not saved. Usable straight as a state updater, so the reported reason wins over the fallback
 * whichever order the two arrive in.
 */
export function refusalFor(current: WriteFailure | null): WriteFailure {
  return current ?? { headline: t('assistant.toast.failed'), detail: null }
}

export function Group({ title, children }: { title: string, children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <p className="px-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">{title}</p>
      <div className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3">
        {children}
      </div>
    </section>
  )
}

const CHIP_COLUMNS = { 3: 'grid-cols-3', 5: 'grid-cols-5', 6: 'grid-cols-6' } as const

/**
 * One row of preset buttons under a token field: the reader picks 256K rather than typing 262144.
 *
 * Both token editors draw this, because both hold the same ladder — the ceiling a model was given, and the
 * one behind the models that were given none. Pressing the preset that is already taken hands back `null`,
 * which means "take it back": a model's own ceiling can be empty, while the account's number cannot, and
 * that caller simply does not act on it.
 */
export function ChipRow({ label, steps, value, onPick, columns = 5 }: {
  label: string
  steps: readonly number[]
  value: number | null
  onPick: (tokens: number | null) => void
  /** How many picks sit on one line; a fixed count keeps the rows aligned instead of ragged. Six is
   *  the context window's own ladder, which reads as a single row rather than a wider three-plus-three. */
  columns?: 3 | 5 | 6
}) {
  return (
    <div role='group' aria-label={label} className={cn('mt-1.5 grid gap-1', CHIP_COLUMNS[columns])}>
      {steps.map((tokens) => (
        <button
          key={tokens}
          type="button"
          aria-pressed={value === tokens}
          onClick={() => onPick(value === tokens ? null : tokens)}
          className={cn(
            'rounded-full border px-1.5 py-1 text-center text-[length:var(--text-10-5)] tabular-nums',
            'transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
            value === tokens
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
              : 'border-[var(--border-subtle)] text-[var(--text-quaternary)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]',
          )}
        >
          {formatTokenStep(tokens)}
        </button>
      ))}
    </div>
  )
}

/**
 * What may be said about a stored key: that one exists, and its last four characters.
 *
 * The plaintext never leaves the worker, so this is the whole of what a row or a field can honestly
 * claim. A provider row carries no hint at all until the store persists one, which is why the mask is
 * optional here rather than a guaranteed suffix.
 */
export function storedKeyLabel(provider: Pick<AssistantProvider, 'hasKey' | 'keyHint'>): string {
  if (!provider.hasKey) return t('assistant.settings.key_missing')
  return provider.keyHint ? t('assistant.settings.key_stored_hint', { hint: provider.keyHint }) : t('assistant.settings.key_stored')
}

export const PROTOCOL_LABELS: Record<string, () => string> = {
  openai: () => t('assistant.settings.protocol.openai'),
  anthropic: () => t('assistant.settings.protocol.anthropic'),
  gemini: () => t('assistant.settings.protocol.gemini'),
}

/**
 * The name each thinking dialect is offered under in the provider form.
 *
 * The key is the dialect id with its hyphen spelled as an underscore, because a message key may not carry a
 * hyphen; the label itself names the field that dialect sends, which is what tells two dialects of one
 * vendor apart (a 2.5 Gemini's budget from a 3.x one's level).
 */
export const DIALECT_LABELS = Object.fromEntries(
  REASONING_DIALECTS.map((dialect) => [dialect, `assistant.settings.dialect.${dialect.replace(/-/g, '_')}`]),
) as Record<ReasoningDialect, MessageKey>

