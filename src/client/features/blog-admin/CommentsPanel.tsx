import { useCallback, useEffect, useState } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { AdminBlogComment, BlogCommentStatus } from '@shared/blog/model'
import { Badge, Button, Spinner } from '../../components/primitives'
import { Checkbox, Input } from '../../components/form'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'

type FilterStatus = BlogCommentStatus | 'all'

const TABS: { id: FilterStatus; label: MessageKey }[] = [
  { id: 'all', label: 'blog.admin.comments_all' },
  { id: 'pending', label: 'blog.admin.comments_pending' },
  { id: 'approved', label: 'blog.admin.comments_approved' },
  { id: 'spam', label: 'blog.admin.comments_spam' },
  { id: 'trash', label: 'blog.admin.comments_trash' },
]

const STATUS_LABEL: Record<BlogCommentStatus, MessageKey> = {
  pending: 'blog.admin.comments_pending',
  approved: 'blog.admin.comments_approved',
  spam: 'blog.admin.comments_spam',
  trash: 'blog.admin.comments_trash',
}

const STATUS_TONE: Record<BlogCommentStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending: 'warning',
  approved: 'success',
  spam: 'danger',
  trash: 'neutral',
}

const PAGE_SIZE = 20

function formatDate(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return new Date(value).toISOString()
  }
}

export function CommentsPanel() {
  const [status, setStatus] = useState<FilterStatus>('all')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<AdminBlogComment[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<BlogCommentStatus, number>>({ pending: 0, approved: 0, spam: 0, trash: 0 })
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    setSelected([])
  }, [status, search, page])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.blog.comments.list({
        status: status === 'all' ? undefined : status,
        q: search || undefined,
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
  }, [page, search, status])

  useEffect(() => {
    void load()
  }, [load])

  const applyStatus = async (ids: string[], next: BlogCommentStatus) => {
    if (ids.length === 0 || busy) return
    if (next === 'trash') {
      const ok = await confirm({
        title: t('blog.admin.comments_trash_title'),
        description: t('blog.admin.comments_trash_desc'),
        confirmLabel: t('blog.admin.comments_trash_action'),
        tone: 'danger',
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      await api.blog.comments.bulk(ids, next)
      setSelected([])
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const allSelected = items.length > 0 && selected.length === items.length
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={t('blog.admin.comments')} className="flex flex-wrap gap-1">
          {TABS.map((tab) => {
            const count = tab.id === 'all'
              ? counts.pending + counts.approved + counts.spam + counts.trash
              : counts[tab.id]
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={status === tab.id}
                onClick={() => setStatus(tab.id)}
                className={status === tab.id
                  ? 'rounded-full bg-[var(--accent-soft)] px-3 py-1.5 text-[length:var(--text-12)] font-medium text-[var(--accent-on-soft)]'
                  : 'rounded-full px-3 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}
              >
                {t(tab.label)} <span className="tabular-nums opacity-60">{count}</span>
              </button>
            )
          })}
        </div>
        <div className="w-full sm:w-64">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('blog.admin.comments_search')}
            aria-label={t('blog.admin.comments_search')}
          />
        </div>
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          <span>{t('blog.admin.comments_selected', { count: selected.length })}</span>
          <Button size="sm" variant="ghost" onClick={() => void applyStatus(selected, 'approved')} disabled={busy}>
            {t('blog.admin.comments_bulk_approve')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void applyStatus(selected, 'spam')} disabled={busy}>
            {t('blog.admin.comments_bulk_spam')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void applyStatus(selected, 'trash')} disabled={busy}>
            {t('blog.admin.comments_bulk_trash')}
          </Button>
        </div>
      )}

      {error ? (
        <div role="alert" className="rounded-[var(--r-lg)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-4 text-[length:var(--text-12-5)] text-[var(--danger)]">
          <p className="font-medium">{t('blog.admin.load_failed')}</p>
          <p className="mt-1 break-words opacity-80">{error}</p>
          <Button size="sm" className="mt-3" onClick={() => void load()}>{t('blog.admin.retry')}</Button>
        </div>
      ) : loading && items.length === 0 ? (
        <div className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]"><Spinner /> {t('blog.admin.loading')}</div>
      ) : items.length === 0 ? (
        <p className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
          {t('blog.admin.comments_empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <table className="w-full min-w-[900px] border-collapse text-left text-[length:var(--text-12-5)]">
            <caption className="sr-only">{t('blog.admin.comments')}</caption>
            <thead className="border-b border-[var(--border-subtle)] text-[length:var(--text-11)] tracking-wide text-[var(--text-tertiary)] uppercase">
              <tr>
                <th scope="col" className="w-10 px-3 py-3">
                  <Checkbox
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? [] : items.map((item) => item.id))}
                    ariaLabel={t('blog.admin.comments_select_all')}
                  />
                </th>
                <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.comments_author')}</th>
                <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.comments_content')}</th>
                <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.comments_post')}</th>
                <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.comments_date')}</th>
                <th scope="col" className="px-3 py-3 font-medium">{t('blog.admin.column_status')}</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">{t('blog.admin.comments_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-[var(--border-subtle)] align-top last:border-b-0">
                  <td className="px-3 py-3">
                    <Checkbox
                      checked={selected.includes(item.id)}
                      onChange={(next) => setSelected((current) => next ? [...current, item.id] : current.filter((id) => id !== item.id))}
                      ariaLabel={t('blog.admin.comments_select')}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <p className="font-medium text-[var(--text-primary)]">{item.authorName || '—'}</p>
                    {item.authorUrl && (
                      <a href={item.authorUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 block max-w-[180px] truncate text-[length:var(--text-11)] text-[var(--text-quaternary)] hover:text-[var(--accent)]">
                        {item.authorUrl}
                      </a>
                    )}
                  </td>
                  <td className="max-w-[360px] px-3 py-3 text-[var(--text-secondary)]">
                    <p className="line-clamp-3 whitespace-pre-wrap break-words">{item.content}</p>
                  </td>
                  <td className="max-w-[180px] px-3 py-3 text-[var(--text-tertiary)]">
                    <span className="line-clamp-2">{item.postTitle || item.postId.slice(0, 8)}</span>
                  </td>
                  <td className="px-3 py-3 text-[var(--text-tertiary)]">{formatDate(item.createdAt)}</td>
                  <td className="px-3 py-3"><Badge tone={STATUS_TONE[item.status]}>{t(STATUS_LABEL[item.status])}</Badge></td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap justify-end gap-1">
                      {item.status !== 'approved' && <Button size="sm" variant="ghost" onClick={() => void applyStatus([item.id], 'approved')} disabled={busy}>{t('blog.admin.comments_approve')}</Button>}
                      {item.status === 'approved' && <Button size="sm" variant="ghost" onClick={() => void applyStatus([item.id], 'pending')} disabled={busy}>{t('blog.admin.comments_unapprove')}</Button>}
                      {item.status !== 'spam' && <Button size="sm" variant="ghost" onClick={() => void applyStatus([item.id], 'spam')} disabled={busy}>{t('blog.admin.comments_spam_action')}</Button>}
                      {item.status !== 'trash' && <Button size="sm" variant="ghost" onClick={() => void applyStatus([item.id], 'trash')} disabled={busy}>{t('blog.admin.comments_trash_action')}</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          <Button size="sm" variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t('blog.admin.previous')}</Button>
          <span className="tabular-nums">{t('blog.admin.page_of', { current: page, total: pageCount })}</span>
          <Button size="sm" variant="ghost" disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)}>{t('blog.admin.next')}</Button>
        </div>
      )}
    </section>
  )
}
