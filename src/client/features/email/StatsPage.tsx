import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import {
  EMAIL_ATTACHMENT_QUOTA_BYTES,
  isEmailSystemFolder,
  type EmailDailyCount,
  type EmailFolder,
  type EmailMailboxStats,
} from '@shared/email/model'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Button } from '../../components/primitives'
import { navigateToPath } from '../../lib/app-history'
import { t } from '../../lib/i18n'
import { formatBytes, formatDateKey, formatNumber } from '../../lib/time'
import { Donut, Sparkline, type StatSlice } from '../todos/stats-charts'
import { emailFolderPath } from './email-address'
import { SYSTEM_FOLDER_LABEL_KEYS } from './format'
import { useEmailStore } from './store'

function folderLabelOf(folderId: string, folders: readonly EmailFolder[]): string {
  if (isEmailSystemFolder(folderId)) return t(SYSTEM_FOLDER_LABEL_KEYS[folderId])
  return folders.find((folder) => folder.id === folderId)?.name ?? t('email.stats.unknown_folder')
}

function folderSlices(stats: EmailMailboxStats, folders: readonly EmailFolder[]): StatSlice[] {
  let paletteIndex = 0
  return stats.folders.map((entry) => {
    const folder = folders.find((candidate) => candidate.id === entry.folderId)
    const color = folder?.color ?? ORGANIZER_COLORS[paletteIndex++ % ORGANIZER_COLORS.length]
    return {
      key: entry.folderId,
      label: folderLabelOf(entry.folderId, folders),
      value: entry.total,
      color,
    }
  })
}

function weekRange(days: readonly EmailDailyCount[]): string | null {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return null
  return t('email.stats.week_range', { from: formatDateKey(first.date), to: formatDateKey(last.date) })
}

function KpiCard({ id, label, value, hint }: {
  id: string
  label: string
  value: string
  hint?: string
}) {
  return (
    <div data-stats-kpi={id} className="flex min-w-0 flex-col gap-1 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <dt className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</dt>
      <dd className="m-0 text-[length:var(--text-22)] leading-none font-semibold tabular text-[var(--text-primary)]">{value}</dd>
      {hint && <dd className="m-0 text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">{hint}</dd>}
    </div>
  )
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 md:p-4">
      <h2 className="m-0 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{title}</h2>
      {hint && <p className="m-0 mt-1 text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  )
}

function WeekFigure({ id, label, days, tone }: {
  id: string
  label: string
  days: readonly EmailDailyCount[]
  tone: string
}) {
  const values = days.map((day) => day.count)
  const total = values.reduce((sum, value) => sum + value, 0)
  return (
    <section data-stats-week={id} aria-label={label} className="min-w-0 rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</span>
        <span className="text-[length:var(--text-16)] font-semibold tabular text-[var(--text-primary)]">{formatNumber(total)}</span>
      </div>
      <div className="mt-1">
        <Sparkline values={values} tone={tone} />
      </div>
      <ul className="sr-only">
        {days.map((day) => (
          <li key={day.date}>
            {t('email.stats.week_day', { date: formatDateKey(day.date), count: formatNumber(day.count) })}
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatsBody({ stats, folders }: { stats: EmailMailboxStats; folders: readonly EmailFolder[] }) {
  const slices = folderSlices(stats, folders)
  const range = weekRange(stats.receivedLast7Days.length > 0 ? stats.receivedLast7Days : stats.sentLast7Days)
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        <KpiCard id="total" label={t('email.stats.kpi.total')} value={formatNumber(stats.total)} hint={t('email.stats.kpi.total_hint')} />
        <KpiCard id="unread" label={t('email.stats.kpi.unread')} value={formatNumber(stats.unread)} />
        <KpiCard id="starred" label={t('email.stats.kpi.starred')} value={formatNumber(stats.starred)} />
        <KpiCard id="sent" label={t('email.folder.sent')} value={formatNumber(stats.sent)} />
        <KpiCard id="draft" label={t('email.folder.draft')} value={formatNumber(stats.draft)} />
        <KpiCard id="trash" label={t('email.folder.trash')} value={formatNumber(stats.trash)} />
        <KpiCard
          id="attachments"
          label={t('email.stats.kpi.attachments')}
          value={formatBytes(stats.attachmentBytes)}
          hint={t('email.stats.kpi.attachments_hint', { quota: formatBytes(EMAIL_ATTACHMENT_QUOTA_BYTES) })}
        />
      </dl>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title={t('email.stats.folders')} hint={t('email.stats.folders_hint')}>
          <div data-stats-folders="">
            {slices.length > 0
              ? <Donut slices={slices} caption={t('email.stats.folders_caption')} totalLabel={t('email.stats.donut_total')} />
              : <p className="m-0 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('email.stats.folders_empty')}</p>}
          </div>
        </Card>
        <Card title={t('email.stats.week')}>
          <div className="flex flex-col gap-2">
            {range && <p className="m-0 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">{range}</p>}
            <WeekFigure id="received" label={t('email.stats.week_received')} days={stats.receivedLast7Days} tone="var(--accent)" />
            <WeekFigure id="sent" label={t('email.folder.sent')} days={stats.sentLast7Days} tone="var(--success)" />
          </div>
        </Card>
      </div>
    </div>
  )
}

export function StatsPage({ accountId, onBack }: { accountId: string; onBack?: () => void }) {
  const account = useEmailStore((state) => state.accounts.find((entry) => entry.id === accountId) ?? null)
  const stats = useEmailStore((state) => state.stats)
  const statsStatus = useEmailStore((state) => state.statsStatus)
  const statsError = useEmailStore((state) => state.statsError)
  const loadStats = useEmailStore((state) => state.loadStats)
  const folders = useEmailStore((state) => state.folders)
  const loadFolders = useEmailStore((state) => state.loadFolders)
  const [requested, setRequested] = useState<string | null>(null)

  useEffect(() => {
    setRequested(accountId)
    void loadStats(accountId)
  }, [accountId, loadStats])

  useEffect(() => {
    if (useEmailStore.getState().foldersAccountId === accountId) return
    void loadFolders(accountId)
  }, [accountId, loadFolders])

  const current = requested === accountId
  const empty = current && statsStatus === 'ready' && stats !== null && stats.total === 0 && stats.trash === 0
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 md:px-3">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowLeft size={14} />}
          onClick={() => { if (onBack) onBack(); else navigateToPath(emailFolderPath(accountId, 'inbox')) }}
        >
          {t('email.header.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('email.stats.title')}
          </h1>
          {account && (
            <p className="m-0 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {account.displayName ? `${account.displayName} · ${account.address}` : account.address}
            </p>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] px-3 pb-10 pt-3 md:px-6">
          {(!current || statsStatus === 'loading' || statsStatus === 'idle' || (!stats && statsStatus === 'ready')) && (
            <LoadingBlock />
          )}
          {current && statsStatus === 'error' && (
            <div role="alert" className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
              <p className="m-0 text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('email.stats.error')}</p>
              {statsError && <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{statsError}</p>}
              <Button size="sm" className="mt-3" onClick={() => { void loadStats(accountId) }}>{t('common.retry')}</Button>
            </div>
          )}
          {empty && (
            <Empty art="archive" title={t('email.stats.empty')} description={t('email.stats.empty_hint')} />
          )}
          {current && stats && !empty && statsStatus === 'ready' && <StatsBody stats={stats} folders={folders} />}
        </div>
      </div>
    </div>
  )
}
