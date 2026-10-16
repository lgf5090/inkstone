/**
 * How the usage screen writes its numbers.
 *
 * Two functions rather than one copy per panel, because the same figures appear in the detail view and the
 * account overview: a token count shortened one way in one place and another way beside it reads as two
 * different numbers rather than one.
 */

/** Tokens, shortened the way a reader reads them at a glance. */
export function compact(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * An amount with its currency.
 *
 * Four decimals below one, because a single cheap turn is fractions of a cent and rounding it to two would
 * show a reader who just spent something the same numbers as one who spent nothing.
 */
export function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(amount < 1 ? 4 : 2)}`
}
