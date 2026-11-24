import { useDeferredValue } from 'react'
import { cn } from '../lib/cn'
import { evaluatePasswordStrength } from '../lib/password-strength'

/** Shared visual feedback for any flow that asks the reader to choose a password. */
export function PasswordStrengthIndicator({ password, id }: { password: string; id?: string }) {
  // zxcvbn is the expensive part: let the input paint before scoring the latest value.
  const deferred = useDeferredValue(password)
  if (!password) return null

  const result = evaluatePasswordStrength(deferred || password)
  const color = result.score <= 1
    ? 'bg-[var(--danger)]'
    : result.score === 2
      ? 'bg-[var(--warning)]'
      : result.score === 3
        ? 'bg-[var(--accent)]'
        : 'bg-[var(--success)]'

  return (
    <div id={id} role="status" aria-live="polite" className="mt-1.5 space-y-1" data-testid="password-strength-indicator">
      <div className="flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((barIndex) => (
          <div
            key={barIndex}
            data-testid="strength-bar"
            className={cn('h-1.5 flex-1 rounded-full transition-colors duration-200', barIndex < result.score ? color : 'bg-[var(--border-subtle)]')}
          />
        ))}
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[length:var(--text-11)]">
        <span className="font-medium text-[var(--text-secondary)]" data-testid="strength-label">
          {result.label}
        </span>
        {(result.warning || result.suggestions[0]) && (
          <span className="min-w-0 text-right text-[var(--text-tertiary)]">
            {result.warning || result.suggestions[0]}
          </span>
        )}
      </div>
    </div>
  )
}
