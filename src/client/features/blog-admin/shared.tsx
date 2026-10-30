import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { BlogPostStatus } from '@shared/blog/model'
import { Badge, Button, Spinner } from '../../components/primitives'
import { Input } from '../../components/form'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'

export interface AdminResource<T> {
  data: T | null
  loading: boolean
  error: string
  reload: () => Promise<void>
}

export function useAdminResource<T>(load: () => Promise<T>, deps: unknown[] = []): AdminResource<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const loadRef = useRef(load)
  loadRef.current = load
  const epoch = useRef(0)

  const reload = useCallback(async () => {
    const current = ++epoch.current
    setLoading(true)
    setError('')
    try {
      const next = await loadRef.current()
      if (current === epoch.current) setData(next)
    } catch (cause) {
      if (current === epoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === epoch.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, deps)

  return { data, loading, error, reload }
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function formatDateTime(value: number | null | undefined): string {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return new Date(value).toISOString()
  }
}

export function formatDate(value: number | null | undefined): string {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))
  } catch {
    return new Date(value).toISOString()
  }
}

export function formatDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

const STATUS_META: Record<BlogPostStatus, { label: MessageKey; tone: 'neutral' | 'accent' | 'success' | 'warning' }> = {
  draft: { label: 'blog.admin.status_draft', tone: 'neutral' },
  pending_snapshot: { label: 'blog.admin.status_pending', tone: 'warning' },
  scheduled: { label: 'blog.admin.status_scheduled', tone: 'accent' },
  published: { label: 'blog.admin.status_published', tone: 'success' },
  withdrawn: { label: 'blog.admin.status_withdrawn', tone: 'neutral' },
}

export function PostStatusBadge({ status }: { status: BlogPostStatus }) {
  const meta = STATUS_META[status]
  return <Badge tone={meta.tone}>{t(meta.label)}</Badge>
}

export function RenderStatusBadge({ status }: { status: string }) {
  if (status === 'ready') return <Badge tone="success">{t('blog.admin.render_ready')}</Badge>
  if (status === 'stale') return <Badge tone="warning">{t('blog.admin.render_stale')}</Badge>
  if (status === 'failed') return <Badge tone="danger">{t('blog.admin.render_failed')}</Badge>
  return <Badge tone="neutral">{t('blog.admin.render_missing')}</Badge>
}

export function AdminCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]', className)}>
      {children}
    </div>
  )
}

export function AdminEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--r-lg)] border border-dashed border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 text-center text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
      {children}
    </div>
  )
}

export function AdminError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-[var(--r-lg)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-4 text-[length:var(--text-12-5)] text-[var(--danger)]">
      <p className="font-medium">{t('blog.admin.load_failed')}</p>
      <p className="mt-1 break-words opacity-80">{message}</p>
      <Button size="sm" className="mt-3" onClick={onRetry}>{t('blog.admin.retry')}</Button>
    </div>
  )
}

export function AdminLoading() {
  return (
    <div className="flex items-center gap-2 p-4 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
      <Spinner /> {t('blog.admin.loading')}
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[length:var(--text-20)] font-semibold tracking-[-0.015em] text-[var(--text-primary)]">{title}</h1>
        {description && <p className="mt-1 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function SearchField({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}) {
  return (
    <div className={cn('relative min-w-0 flex-1', className)}>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        leading={<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="m10.5 10.5 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>}
      />
    </div>
  )
}

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: string; count?: number }[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap items-center gap-1 border-b border-[var(--border-subtle)]">
      {tabs.map((tab) => {
        const active = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[length:var(--text-12-5)] font-medium transition-colors',
              active
                ? 'border-[var(--accent)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="rounded-full bg-[var(--bg-raised)] px-1.5 py-px text-[length:var(--text-10-5)] tabular text-[var(--text-tertiary)]">
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function formatRelative(value: number | null | undefined): string {
  if (!value) return '—'
  const delta = Math.round((value - Date.now()) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
  ]
  try {
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    for (const [unit, seconds] of units) {
      if (Math.abs(delta) >= seconds) return formatter.format(Math.round(delta / seconds), unit)
    }
    return formatter.format(delta, 'second')
  } catch {
    return formatDateTime(value)
  }
}
