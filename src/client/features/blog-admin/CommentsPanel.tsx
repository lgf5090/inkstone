import { useCallback, useEffect, useState } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { AdminBlogComment, BlogCommentStatus } from '@shared/blog/model'
import { Badge, Button } from '../../components/primitives'
import { Checkbox, Textarea } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
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

type FilterStatus = BlogCommentStatus | 'all'

const TAB_LABELS: Record<FilterStatus, MessageKey> = {
  all: 'blog.admin.comments_all',
  pending: 'blog.admin.comments_pending',
  approved: 'blog.admin.comments_approved',
  spam: 'blog.admin.comments_spam',
  trash: 'blog.admin.comments_trash',
}

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

export function CommentsPanel() {
  const [status, setStatus] = useState<FilterStatus>('all')
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 300)
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<AdminBlogComment[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<BlogCommentStatus, number>>({ pending: 0, approved: 0, spam: 0, trash: 0 })
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [replyTo, setReplyTo] = useState<AdminBlogComment | null>(null)
  const [reply, setReply] = useState('')
  const [replyBusy, setReplyBusy] = useState(false)

  useEffect(() => {
    setSelected([])
    setPage(1)
  }, [status, debounced])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.blog.comments.list({
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

  const sendReply = async () => {
    if (!replyTo || !reply.trim() || replyBusy) return
    setReplyBusy(true)
    try {
      await api.blog.comments.reply(replyTo.id, reply.trim())
      setReplyTo(null)
      setReply('')
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setReplyBusy(false)
    }
  }

  const allSelected = items.length > 0 && selected.length === items.length
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const tabs = (['all', 'pending', 'approved', 'spam', 'trash'] as FilterStatus[]).map((id) => ({
    id,
    label: t(TAB_LABELS[id]),
    count: id === 'all' ? counts.pending + counts.approved + counts.spam + counts.trash : counts[id],
  }))

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader
        title={t('blog.admin.comments')}
        description={t('blog.admin.comments_subtitle')}
        actions={<SearchField value={query} onChange={setQuery} placeholder={t('blog.admin.comments_search')} className="sm:w-72" />}
      />
      <TabBar tabs={tabs} value={status} onChange={setStatus} label={t('blog.admin.comments')} />

      {selected.length > 0 && (
        <div className="my-3 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--accent)]/25 bg-[var(--accent-soft)] px-3 py-2 text-[length:var(--text-12)] text-[var(--accent-on-soft)]">
          <span>{t('blog.admin.comments_selected', { count: selected.length })}</span>
          <Button size="sm" variant="ghost" onClick={() => void applyStatus(selected, 'approved')} disabled={busy}>{t('blog.admin.comments_bulk_approve')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void applyStatus(selected, 'spam')} disabled={busy}>{t('blog.admin.comments_bulk_spam')}</Button>
          <Button size="sm" variant="ghost" onClick={() => void applyStatus(selected, 'trash')} disabled={busy}>{t('blog.admin.comments_bulk_trash')}</Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected([])}>{t('blog.admin.clear_selection')}</Button>
        </div>
      )}

      {error ? (
        <div className="mt-3"><AdminError message={error} onRetry={() => void load()} /></div>
      ) : loading && items.length === 0 ? (
        <AdminLoading />
      ) : items.length === 0 ? (
        <div className="mt-3"><AdminEmpty>{t('blog.admin.comments_empty')}</AdminEmpty></div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-[length:var(--text-12-5)]">
              <caption className="sr-only">{t('blog.admin.comments')}</caption>
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <th scope="col" className="w-9 px-3 py-2">
                    <Checkbox checked={allSelected} onChange={() => setSelected(allSelected ? [] : items.map((item) => item.id))} ariaLabel={t('blog.admin.comments_select_all')} />
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.comments_author')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.comments_content')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.comments_post')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.comments_date')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_status')}</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">{t('blog.admin.comments_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-[var(--border-subtle)] align-top last:border-b-0 hover:bg-[var(--bg-hover)]">
                    <td className="px-3 py-2.5">
                      <Checkbox checked={selected.includes(item.id)} onChange={(next) => setSelected((current) => next ? [...current, item.id] : current.filter((id) => id !== item.id))} ariaLabel={t('blog.admin.comments_select')} />
                    </td>
                    <td className="px-2 py-2.5">
                      <p className="font-medium text-[var(--text-primary)]">{item.authorName || '—'}</p>
                      {item.authorUrl && <a href={item.authorUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 block max-w-[180px] truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)] hover:text-[var(--accent)]">{item.authorUrl}</a>}
                    </td>
                    <td className="max-w-[380px] px-2 py-2.5 text-[var(--text-secondary)]">
                      <p className="line-clamp-3 whitespace-pre-wrap break-words">{item.content}</p>
                    </td>
                    <td className="max-w-[180px] px-2 py-2.5 text-[var(--text-tertiary)]"><span className="line-clamp-2">{item.postTitle || item.postId.slice(0, 8)}</span></td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-[var(--text-tertiary)]">{formatDateTime(item.createdAt)}</td>
                    <td className="px-2 py-2.5"><Badge tone={STATUS_TONE[item.status]}>{t(STATUS_LABEL[item.status])}</Badge></td>
                    <td className="px-2 py-2.5">
                      <div className="flex flex-wrap justify-end gap-0.5">
                        <Button size="sm" variant="ghost" onClick={() => { setReplyTo(item); setReply('') }} disabled={busy}>{t('blog.admin.comments_reply')}</Button>
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
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-end gap-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <Button size="sm" variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t('blog.admin.previous')}</Button>
          <span>{t('blog.admin.page_of', { current: page, total: pageCount })}</span>
          <Button size="sm" variant="ghost" disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)}>{t('blog.admin.next')}</Button>
        </div>
      )}

      <Modal
        open={Boolean(replyTo)}
        onClose={() => setReplyTo(null)}
        title={t('blog.admin.comments_reply_to', { name: replyTo?.authorName ?? '' })}
        footer={(
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setReplyTo(null)}>{t('blog.admin.cancel')}</Button>
            <Button size="sm" loading={replyBusy} disabled={!reply.trim()} onClick={() => void sendReply()}>{t('blog.admin.comments_send_reply')}</Button>
          </div>
        )}
      >
        {replyTo && <p className="mb-2 rounded-[var(--r-md)] bg-[var(--bg-inset)] p-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{replyTo.content}</p>}
        <Textarea rows={4} value={reply} onChange={(event) => setReply(event.target.value)} aria-label={t('blog.admin.comments_reply')} />
      </Modal>
    </div>
  )
}
