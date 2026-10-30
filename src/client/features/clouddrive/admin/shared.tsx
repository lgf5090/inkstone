/**
 * Small pieces every owner console page shares: the page frame, the three load states, a metric
 * tile and the date/size formatting that has to agree across the five pages.
 *
 * The translation helper is typed against the admin catalogue even though the shell registers that
 * catalogue later. A type-only import gives the compiler the key list without pulling any strings
 * into the bundle or into `t`'s runtime registry.
 */
import { useId, type ReactNode } from 'react'
import { AlertTriangle, LockKeyhole } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { EN_US_CLOUDDRIVE_ADMIN } from '@shared/locales/en-US-clouddrive-admin'
import { localeTag, t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { Button, Spinner } from '../../../components/primitives'
import { useSession } from '../../../store/session'
import { useCloudDriveStore } from '../store'

export type CloudDriveAdminMessageKey = keyof typeof EN_US_CLOUDDRIVE_ADMIN
type Params = Record<string, string | number | boolean | null | undefined>

/** `t` for admin copy: existing shell keys still work, new keys are checked against the shard. */
export function adminT(key: CloudDriveAdminMessageKey | MessageKey, params?: Params): string {
  return t(key as MessageKey, params)
}

export function useAdminOwner(): boolean {
  const sessionRole = useSession((state) => state.user?.role)
  const bootstrapRole = useCloudDriveStore((state) => state.bootstrap?.user.role)
  return sessionRole === 'owner' || bootstrapRole === 'owner'
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const dayFormatters = new Map<string, Intl.DateTimeFormat>()
const hourFormatters = new Map<string, Intl.DateTimeFormat>()

function cachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`
  const found = cache.get(key)
  if (found) return found
  const formatter = new Intl.DateTimeFormat(locale, options)
  cache.set(key, formatter)
  return formatter
}

/** A local timestamp, with a dash for "never" rather than an epoch date. */
export function formatAdminDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return cachedFormatter(dateTimeFormatters, localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

/** A day label for a chart axis: `2026-10-30` in, a short local month/day out. */
export function formatAdminDay(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return cachedFormatter(dayFormatters, localeTag(), { month: 'short', day: 'numeric' }).format(date)
}

/** The hour a 24-hour activity bucket starts at. */
export function formatAdminHour(timestamp: number): string {
  return cachedFormatter(hourFormatters, localeTag(), { hour: '2-digit' }).format(timestamp)
}

export function formatAdminNumber(value: number): string {
  return value.toLocaleString(localeTag())
}

export function formatAdminDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`
  return `${(minutes / 60).toFixed(1)} h`
}

export function AdminPage({ title, description, actions, children }: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-2 border-b border-[var(--border-subtle)] px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[length:var(--text-15)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{title}</h1>
          {description && <p className="mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{description}</p>}
        </div>
        {actions && <div className="flex min-w-0 flex-wrap items-center gap-1.5">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">{children}</div>
    </div>
  )
}

export function AdminLoading({ label }: { label?: string }) {
  return (
    <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
      <Spinner />
      <span>{label ?? t('clouddrive.loading')}</span>
    </div>
  )
}

export function AdminError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div role="alert" className="flex min-h-52 flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangle size={24} className="text-[var(--danger)]" aria-hidden />
      <p className="text-[length:var(--text-13)] text-[var(--text-secondary)]">{t('clouddrive.failed')}</p>
      {message && <p className="max-w-[520px] text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{message}</p>}
      <Button variant="secondary" onClick={onRetry}>{t('clouddrive.retry')}</Button>
    </div>
  )
}

export function AdminEmpty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-1.5 rounded-[var(--r-lg)] border border-dashed border-[var(--border-subtle)] p-6 text-center">
      <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{title}</p>
      {hint && <p className="max-w-[480px] text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{hint}</p>}
    </div>
  )
}

export function AdminForbidden() {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <LockKeyhole size={24} className="text-[var(--text-tertiary)]" aria-hidden />
      <p className="text-[length:var(--text-14)] font-medium text-[var(--text-primary)]">{adminT('clouddrive.admin.not_owner')}</p>
      <p className="max-w-[420px] text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{adminT('clouddrive.admin.not_owner_hint')}</p>
    </div>
  )
}

export function AdminCard({ title, hint, actions, children, className }: {
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 sm:p-4', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {title && <h2 className="min-w-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{title}</h2>}
          {actions && <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {hint && <p className="mb-3 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{hint}</p>}
      {children}
    </section>
  )
}

export function AdminStat({ label, value, detail, icon }: {
  label: string
  value: ReactNode
  detail?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="min-w-0 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <div className="flex items-center justify-between gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span className="truncate">{label}</span>
        {icon && <span className="shrink-0 text-[var(--accent)]" aria-hidden>{icon}</span>}
      </div>
      <div className="mt-1 text-[length:var(--text-20)] font-semibold tabular text-[var(--text-primary)]">{value}</div>
      {detail && <div className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{detail}</div>}
    </div>
  )
}

export function AdminNotice({ tone = 'info', children }: { tone?: 'info' | 'warning'; children: ReactNode }) {
  return (
    <div
      role="note"
      className={cn(
        'rounded-[var(--r-md)] border px-2.5 py-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-secondary)]',
        tone === 'warning'
          ? 'border-[color-mix(in_oklab,var(--warning)_35%,var(--border-subtle))] bg-[var(--warning-soft)]'
          : 'border-[var(--border-subtle)] bg-[var(--bg-sunken)]',
      )}
    >
      {children}
    </div>
  )
}

/** A quota meter. Without a quota the caller should not render this at all. */
export function AdminMeter({ ratio, label, valueText }: { ratio: number; label: string; valueText: string }) {
  const id = useId()
  const percent = Math.min(100, Math.max(0, ratio * 100))
  return (
    <div
      id={id}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={valueText}
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]"
    >
      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${percent}%` }} />
    </div>
  )
}
