import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import type { BlogSettings } from '@shared/blog/settings'
import type { BlogCalendarItem, BlogPostStatus } from '@shared/blog/model'
import { Button, IconButton, Badge } from '../../components/primitives'
import { Select } from '../../components/form'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { AdminCard, AdminEmpty, AdminError, AdminLoading, PageHeader, formatDateTime, formatDayKey, useAdminResource } from './shared'

type ViewMode = 'month' | 'agenda'
type StatusFilter = 'all' | 'published' | 'scheduled'

const WEEKDAY_COUNT = 7

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function monthLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date)
}

function dayKeyInZone(value: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(value))
  } catch {
    return formatDayKey(new Date(value))
  }
}

function weekdayLabels(): string[] {
  const formatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
  const sunday = new Date(2024, 0, 7)
  return Array.from({ length: WEEKDAY_COUNT }, (_, index) => formatter.format(addDays(sunday, index)))
}

function statusTone(status: BlogPostStatus): 'success' | 'accent' | 'neutral' | 'warning' {
  if (status === 'published') return 'success'
  if (status === 'scheduled') return 'accent'
  if (status === 'pending_snapshot') return 'warning'
  return 'neutral'
}

export function CalendarPanel() {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()))
  const [view, setView] = useState<ViewMode>('month')
  const [status, setStatus] = useState<StatusFilter>('all')
  const settings = useAdminResource(() => api.blog.settings.get(), [])
  const timeZone = (() => {
    const zone = (settings.data as BlogSettings | null)?.site?.timeZone
    return typeof zone === 'string' && zone ? zone : 'UTC'
  })()

  const gridStart = useMemo(() => {
    const first = startOfMonth(cursor)
    return addDays(first, -first.getDay())
  }, [cursor])
  const gridDays = useMemo(
    () => Array.from({ length: 42 }, (_, index) => addDays(gridStart, index)),
    [gridStart],
  )
  const range = useMemo(() => ({
    from: gridDays[0].getTime(),
    to: addDays(gridDays[gridDays.length - 1], 1).getTime(),
  }), [gridDays])

  const calendar = useAdminResource(() => api.blog.calendar(range.from, range.to), [range.from, range.to])
  const items = (calendar.data?.items ?? []).filter((item) => {
    if (status === 'all') return item.status === 'published' || item.status === 'scheduled'
    return item.status === status
  })
  const byDay = useMemo(() => {
    const map = new Map<string, BlogCalendarItem[]>()
    for (const item of items) {
      const key = dayKeyInZone(item.publishedAt ?? item.updatedAt, timeZone)
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    return map
  }, [items, timeZone])
  const todayKey = dayKeyInZone(Date.now(), timeZone)
  const currentMonth = cursor.getMonth()
  const labels = useMemo(() => weekdayLabels(), [])

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        title={t('blog.admin.calendar')}
        description={t('blog.admin.calendar_subtitle', { timeZone })}
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={() => navigateToPath('/blog-admin/posts/new')}>{t('blog.admin.new_post')}</Button>}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5">
          <IconButton label={t('blog.admin.previous_month')} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}><ChevronLeft size={15} /></IconButton>
          <IconButton label={t('blog.admin.next_month')} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}><ChevronRight size={15} /></IconButton>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setCursor(startOfMonth(new Date()))}>{t('blog.admin.today')}</Button>
        <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{monthLabel(cursor)}</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select aria-label={t('blog.admin.column_status')} value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} className="w-auto min-w-[120px]">
            <option value="all">{t('blog.admin.calendar_all')}</option>
            <option value="published">{t('blog.admin.status_published')}</option>
            <option value="scheduled">{t('blog.admin.status_scheduled')}</option>
          </Select>
          <div role="group" aria-label={t('blog.admin.calendar_view')} className="flex rounded-[var(--r-md)] border border-[var(--border-subtle)] p-0.5">
            <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')} className={view === 'month' ? 'rounded-[var(--r-sm)] bg-[var(--accent-soft)] px-2 py-1 text-[length:var(--text-11-5)] text-[var(--accent-on-soft)]' : 'rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]'}>{t('blog.admin.calendar_month')}</button>
            <button type="button" aria-pressed={view === 'agenda'} onClick={() => setView('agenda')} className={view === 'agenda' ? 'rounded-[var(--r-sm)] bg-[var(--accent-soft)] px-2 py-1 text-[length:var(--text-11-5)] text-[var(--accent-on-soft)]' : 'rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]'}>{t('blog.admin.calendar_agenda')}</button>
          </div>
        </div>
      </div>

      {calendar.error ? (
        <AdminError message={calendar.error} onRetry={() => void calendar.reload()} />
      ) : !calendar.data ? (
        <AdminLoading />
      ) : view === 'month' ? (
        <AdminCard className="overflow-hidden">
          <div className="grid grid-cols-7 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
            {labels.map((label) => (
              <div key={label} className="px-2 py-1.5 text-center text-[length:var(--text-10-5)] font-medium uppercase tracking-wide text-[var(--text-quaternary)]">{label}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {gridDays.map((day) => {
              const key = formatDayKey(day)
              const dayItems = byDay.get(key) ?? []
              const inMonth = day.getMonth() === currentMonth
              const isToday = key === todayKey
              return (
                <div key={key} className={`min-h-[104px] border-b border-r border-[var(--border-subtle)] p-1.5 last:border-r-0 ${inMonth ? '' : 'bg-[var(--bg-sunken)]/50'}`}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className={`inline-flex size-5 items-center justify-center rounded-full text-[length:var(--text-10-5)] tabular ${isToday ? 'bg-[var(--accent)] font-semibold text-[var(--accent-contrast)]' : inMonth ? 'text-[var(--text-secondary)]' : 'text-[var(--text-quaternary)]'}`}>{day.getDate()}</span>
                    {dayItems.length > 0 && <span className="text-[length:var(--text-9)] text-[var(--text-quaternary)]">{dayItems.length}</span>}
                  </div>
                  <div className="space-y-0.5">
                    {dayItems.slice(0, 3).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => navigateToPath(`/blog-admin/posts/${encodeURIComponent(item.noteId)}`)}
                        title={`${item.title} · ${formatDateTime(item.publishedAt)}`}
                        className={`block w-full truncate rounded-[3px] px-1 py-0.5 text-left text-[length:var(--text-10)] ${item.status === 'scheduled' ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'bg-[var(--success-soft)] text-[var(--success)]'}`}
                      >
                        {item.title || t('blog.admin.untitled_post')}
                      </button>
                    ))}
                    {dayItems.length > 3 && <p className="px-1 text-[length:var(--text-9)] text-[var(--text-quaternary)]">+{dayItems.length - 3}</p>}
                  </div>
                </div>
              )
            })}
          </div>
        </AdminCard>
      ) : items.length === 0 ? (
        <AdminEmpty>{t('blog.admin.calendar_empty')}</AdminEmpty>
      ) : (
        <AdminCard className="divide-y divide-[var(--border-subtle)]">
          {[...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, dayItems]) => (
            <div key={key} className="flex gap-3 px-4 py-2.5">
              <div className="w-24 shrink-0 text-[length:var(--text-11-5)] font-medium text-[var(--text-tertiary)]">{key}</div>
              <ul className="min-w-0 flex-1 space-y-1">
                {dayItems.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => navigateToPath(`/blog-admin/posts/${encodeURIComponent(item.noteId)}`)} className="flex w-full items-center gap-2 text-left hover:text-[var(--accent)]">
                      <Badge tone={statusTone(item.status)}>{item.status === 'scheduled' ? t('blog.admin.status_scheduled') : t('blog.admin.status_published')}</Badge>
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{item.title || t('blog.admin.untitled_post')}</span>
                      <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatDateTime(item.publishedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </AdminCard>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
        <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-full bg-[var(--success)]" />{t('blog.admin.status_published')}</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-full bg-[var(--accent)]" />{t('blog.admin.status_scheduled')}</span>
      </div>
    </div>
  )
}
