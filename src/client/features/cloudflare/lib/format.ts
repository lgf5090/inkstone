/**
 * Number, size and duration formatting for Cloudflare's screens.
 *
 * These are arithmetic, not copy: the words around them ("requests", "of") come from the catalogue.
 * A byte count uses the notebook's own `formatBytes`, so a size in this app and the same size in the
 * attachment panel cannot disagree.
 */
export { formatBytes } from '@shared/byte-format'

export function formatNumber(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString()
}

/** Neurons are billed in fractions, so a whole-number separator would hide a busy model row. */
export function formatNeurons(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/**
 * A usage percentage a reader can act on.
 *
 * Rounding alone turned "489 of 100,000" into a flat `0%`, which is indistinguishable from "nothing
 * used" on the same screen that prints `—` for "no number at all".
 */
export function percentLabel(used: number, limit: number): string {
  if (!limit) return '0%'
  const exact = (used / limit) * 100
  if (exact > 0 && exact < 1) return '<1%'
  return `${percentOf(used, limit)}%`
}

export function splitSeconds(total: number): { m: number; s: number } {
  const safe = Math.max(0, Math.round(total))
  return { m: Math.floor(safe / 60), s: safe % 60 }
}

export function stringifyOrPretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2)
}

/** `2026-10-27 09:41` in the reader's locale, from a millisecond timestamp. */
export function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

/** Relative time for a log or a conversation; falls back to the absolute date after a week. */
export function formatRelative(timestamp: number, now = Date.now()): string {
  const delta = now - timestamp
  if (delta < 60_000) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(0, 'second')
  if (delta < 3_600_000) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.round(delta / 60_000), 'minute')
  }
  if (delta < 86_400_000) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.round(delta / 3_600_000), 'hour')
  }
  if (delta < 7 * 86_400_000) {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.round(delta / 86_400_000), 'day')
  }
  return formatDateTime(timestamp)
}

/** A percentage for a ring or a bar, clamped to what can be drawn. */
export function percentOf(used: number, limit: number): number {
  if (!limit) return 0
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)))
}
