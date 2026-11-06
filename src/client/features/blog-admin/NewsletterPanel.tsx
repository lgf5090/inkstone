import { useCallback, useEffect, useState } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { BlogNewsletterStatus } from '@shared/blog/model'
import { Badge, Button } from '../../components/primitives'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import {
  AdminEmpty,
  AdminError,
  AdminLoading,
  PageHeader,
  SearchField,
  TabBar,
  formatDateTime,
  useDebounced,
} from './shared'

type FilterStatus = BlogNewsletterStatus | 'all'

const TAB_LABELS: Record<FilterStatus, MessageKey> = {
  all: 'blog.admin.newsletter_all',
  pending: 'blog.admin.newsletter_pending',
  confirmed: 'blog.admin.newsletter_confirmed',
  unsubscribed: 'blog.admin.newsletter_unsubscribed',
}

const STATUS_LABEL: Record<BlogNewsletterStatus, MessageKey> = {
  pending: 'blog.admin.newsletter_pending',
  confirmed: 'blog.admin.newsletter_confirmed',
  unsubscribed: 'blog.admin.newsletter_unsubscribed',
}

const STATUS_TONE: Record<BlogNewsletterStatus, 'neutral' | 'success' | 'warning'> = {
  pending: 'warning',
  confirmed: 'success',
  unsubscribed: 'neutral',
}

const PAGE_SIZE = 20

export function NewsletterPanel() {
  const toast = useUi((state) => state.toast)
  const [status, setStatus] = useState<FilterStatus>('all')
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 300)
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.blog.newsletter.list>>['items']>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<BlogNewsletterStatus, number>>({ pending: 0, confirmed: 0, unsubscribed: 0 })
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setPage(1)
  }, [status, debounced])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.blog.newsletter.list({
        status: status === 'all' ? undefined : status,
        q: debounced || undefined,
        page,
        limit: PAGE_SIZE,
      })
      setItems(result.items)
      setTotal(result.total)
      setCounts(result.counts)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [page, debounced, status])

  useEffect(() => {
    void load()
  }, [load])

  const copyConfirmLink = async (id: string) => {
    if (busyId) return
    setBusyId(id)
    try {
      const { url } = await api.blog.newsletter.confirmLink(id)
      await navigator.clipboard.writeText(url)
      toast({ title: t('blog.admin.newsletter_link_ready'), description: url, tone: 'success' })
      await load()
    } catch (cause) {
      toast({ title: t('blog.admin.newsletter_link_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    } finally {
      setBusyId('')
    }
  }

  const exportCsv = async () => {
    if (exporting) return
    setExporting(true)
    try {
      await api.blog.newsletter.exportCsv({
        status: status === 'all' ? undefined : status,
        q: debounced || undefined,
      })
      toast({ title: t('blog.admin.newsletter_export_ready'), tone: 'success' })
    } catch (cause) {
      toast({ title: t('blog.admin.newsletter_export_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    } finally {
      setExporting(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const tabs = (['all', 'pending', 'confirmed', 'unsubscribed'] as FilterStatus[]).map((id) => ({
    id,
    label: t(TAB_LABELS[id]),
    count: id === 'all' ? counts.pending + counts.confirmed + counts.unsubscribed : counts[id],
  }))

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader
        title={t('blog.admin.newsletter')}
        description={t('blog.admin.newsletter_subtitle')}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2 sm:justify-end">
        <SearchField value={query} onChange={setQuery} placeholder={t('blog.admin.newsletter_search')} className="w-full sm:w-64" />
        <Button size="sm" variant="secondary" loading={exporting} onClick={() => void exportCsv()} className="w-full sm:w-auto">
          {t('blog.admin.newsletter_export')}
        </Button>
      </div>
      <TabBar tabs={tabs} value={status} onChange={setStatus} label={t('blog.admin.newsletter')} />

      {error ? (
        <div className="mt-3"><AdminError message={error} onRetry={() => void load()} /></div>
      ) : loading && items.length === 0 ? (
        <AdminLoading />
      ) : items.length === 0 ? (
        <div className="mt-3"><AdminEmpty>{t('blog.admin.newsletter_empty')}</AdminEmpty></div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <ul className="divide-y divide-[var(--border-subtle)] xl:hidden">
            {items.map((item) => (
              <li key={item.id} className="px-3 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">{item.email}</span>
                  <Badge tone={STATUS_TONE[item.status]}>{t(STATUS_LABEL[item.status])}</Badge>
                </div>
                <p className="mt-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                  {item.source || '—'} · {formatDateTime(item.createdAt)}
                </p>
                {item.status === 'pending' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-1.5"
                    loading={busyId === item.id}
                    onClick={() => void copyConfirmLink(item.id)}
                  >
                    {t('blog.admin.newsletter_copy_link')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto xl:block">
            <table className="w-full min-w-[860px] border-collapse text-left text-[length:var(--text-12-5)]">
              <caption className="sr-only">{t('blog.admin.newsletter')}</caption>
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <th scope="col" className="px-3 py-2 font-medium">{t('blog.admin.newsletter_email')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_status')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.newsletter_source')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.newsletter_created')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.newsletter_confirmed_at')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.newsletter_unsubscribed_at')}</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">{t('blog.admin.newsletter_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-[var(--border-subtle)] align-top last:border-b-0 hover:bg-[var(--bg-hover)]">
                    <td className="max-w-[260px] truncate px-3 py-2.5 font-medium text-[var(--text-primary)]">{item.email}</td>
                    <td className="px-2 py-2.5"><Badge tone={STATUS_TONE[item.status]}>{t(STATUS_LABEL[item.status])}</Badge></td>
                    <td className="px-2 py-2.5 text-[var(--text-tertiary)]">{item.source || '—'}</td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-[var(--text-tertiary)]">{formatDateTime(item.createdAt)}</td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-[var(--text-tertiary)]">{formatDateTime(item.confirmedAt)}</td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-[var(--text-tertiary)]">{formatDateTime(item.unsubscribedAt)}</td>
                    <td className="px-2 py-2.5">
                      <div className="flex justify-end">
                        {item.status === 'pending' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busyId === item.id}
                            onClick={() => void copyConfirmLink(item.id)}
                          >
                            {t('blog.admin.newsletter_copy_link')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-end gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <Button size="sm" variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            {t('blog.admin.previous')}
          </Button>
          <span>{t('blog.admin.page_of', { current: page, total: pageCount })}</span>
          <Button size="sm" variant="ghost" disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)}>
            {t('blog.admin.next')}
          </Button>
        </div>
      )}
    </div>
  )
}
