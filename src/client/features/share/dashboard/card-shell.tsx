import type { ReactNode } from "react"
import { Minus, TrendingDown, TrendingUp } from "lucide-react"
import { cn } from "../../../lib/cn"
import { formatNumber } from "../../../lib/time"

/**
 * The four shapes every card on this screen is built out of: a framed card, its title row, what it
 * draws when the window holds nothing, one headline figure, and one labelled share of a total.
 *
 * They live here rather than in the shared layer because this screen is their only caller so far, and
 * a second dashboard that needs them can promote them from one place instead of from six.
 */

export function DashboardCard({ icon, title, badge, action, children, className }: {
  icon: ReactNode
  title: string
  /** The scope the rows describe, e.g. "top 10" or "this window" — read after the title. */
  badge?: string
  /** A control in the title row's right slot, for a card whose own switch decides what it draws. */
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-4)] shadow-[var(--shadow-xs)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-[var(--sp-2)] border-b border-[var(--border-subtle)] pb-[var(--sp-2-5)]">
        <h3 className="flex min-w-0 items-center gap-[var(--sp-1-5)] text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {icon}
          <span className="truncate">{title}</span>
        </h3>
        {action ?? (badge && (
          <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{badge}</span>
        ))}
      </div>
      {children}
    </section>
  )
}

/** What a card draws in place of its rows when the range holds nothing yet. */
export function CardEmpty({ label }: { label: string }) {
  return (
    <p className="py-[var(--sp-6)] text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{label}</p>
  )
}

/**
 * One headline figure with the change against the previous window beside it.
 *
 * `value` is a string as often as a number: a window with no visits at all shows a dash rather than a
 * `0`, because `0` would answer "nobody came" where the truth is "nothing happened in this window".
 * The arrow carries direction as a glyph and colour, and the sr-only text names what the percentage is
 * measured against — an arrow says nothing to a screen reader.
 */
export function KpiTile({ icon, label, value, delta, deltaHint, footnote, tone = "accent" }: {
  icon: ReactNode
  label: string
  value: string | number
  delta?: number
  deltaHint?: string
  footnote?: string
  tone?: "accent" | "success" | "warning"
}) {
  const toneClass = {
    accent: "text-[var(--accent)]",
    success: "text-[var(--success)]",
    warning: "text-[var(--warning)]",
  }[tone]
  return (
    <div className="flex flex-col justify-between rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[var(--sp-3-5)] shadow-[var(--shadow-xs)]">
      <div className="flex items-center justify-between gap-[var(--sp-2)]">
        <span className="min-w-0 truncate text-[length:var(--text-12)] font-medium text-[var(--text-tertiary)]">{label}</span>
        <span className={cn("shrink-0", toneClass)}>{icon}</span>
      </div>
      <div className="flex items-baseline justify-between gap-[var(--sp-2)] pt-[var(--sp-2)]">
        <span className="min-w-0 truncate font-mono text-[length:var(--text-22)] font-bold tracking-tight text-[var(--text-primary)]">
          {typeof value === "number" ? formatNumber(value) : value}
        </span>
        {delta !== undefined && <DeltaBadge delta={delta} hint={deltaHint} />}
      </div>
      {footnote && (
        <p className="pt-[var(--sp-1)] text-[length:var(--text-11)] text-[var(--text-quaternary)]">{footnote}</p>
      )}
    </div>
  )
}

/** A change against the previous window; `undefined` means the window has nothing to divide by. */
function DeltaBadge({ delta, hint }: { delta: number; hint?: string }) {
  const tone = delta === 0
    ? "text-[var(--text-tertiary)]"
    : delta > 0
      ? "text-[var(--success)]"
      : "text-[var(--danger)]"
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-[var(--sp-0-5)] text-[length:var(--text-11)] font-medium tabular", tone)}>
      {delta === 0
        ? <Minus size={12} aria-hidden />
        : delta > 0
          ? <TrendingUp size={12} aria-hidden />
          : <TrendingDown size={12} aria-hidden />}
      {delta > 0 ? `+${delta}%` : `${delta}%`}
      {hint && <span className="sr-only"> {hint}</span>}
    </span>
  )
}

/**
 * One labelled share of a total: the name, the count, the percentage, and a bar that repeats the
 * percentage as length. The bar is decoration beside the numbers, so it stays out of the reading order.
 */
export function BreakdownRow({ name, flag, count, percentage }: {
  name: string
  flag?: string
  count: number
  percentage: number
}) {
  return (
    <div className="flex flex-col gap-[var(--sp-1)] text-[length:var(--text-12)]">
      <div className="flex items-center justify-between gap-[var(--sp-2)]">
        <span className="flex min-w-0 items-center gap-[var(--sp-1-5)] text-[var(--text-primary)]">
          {flag && <span aria-hidden="true" className="shrink-0 text-[length:var(--text-13)]">{flag}</span>}
          <span className="truncate">{name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-[var(--sp-2)] font-mono text-[length:var(--text-11)]">
          <span className="font-semibold text-[var(--text-primary)] tabular">{formatNumber(count)}</span>
          <span className="w-[var(--sp-8)] text-right text-[var(--text-tertiary)] tabular">{formatNumber(percentage)}%</span>
        </span>
      </div>
      <span aria-hidden="true" className="h-[var(--sp-1-5)] w-full overflow-hidden rounded-full bg-[var(--bg-inset)]">
        <span
          className="block h-full rounded-full bg-[var(--accent)]"
          style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }}
        />
      </span>
    </div>
  )
}

/** A sub-heading inside a card, for the second list a card carries below its first. */
export function CardSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[length:var(--text-11)] font-semibold uppercase tracking-[0.075em] text-[var(--text-quaternary)]">
      {children}
    </p>
  )
}
