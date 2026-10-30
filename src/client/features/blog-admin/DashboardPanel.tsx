import { useState } from 'react'
import {
  CalendarClock,
  Eye,
  FileText,
  Image as ImageIcon,
  MessageSquare,
  Plus,
  TrendingUp,
  Upload,
} from 'lucide-react'
import type { BlogCommentStatus, BlogDashboard, BlogPostStatus } from '@shared/blog/model'
import { Input } from '../../components/form'
import { Badge, Button } from '../../components/primitives'
import { api } from '../../lib/api'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import {
  AdminCard,
  AdminEmpty,
  AdminError,
  AdminLoading,
  PostStatusBadge,
  formatBytes,
  formatRelative,
  useAdminResource,
} from './shared'

const COMMENT_LABELS: Record<BlogCommentStatus, 'blog.admin.comments_pending' | 'blog.admin.comments_approved' | 'blog.admin.comments_spam' | 'blog.admin.comments_trash'> = {
  pending: 'blog.admin.comments_pending',
  approved: 'blog.admin.comments_approved',
  spam: 'blog.admin.comments_spam',
  trash: 'blog.admin.comments_trash',
}


function Stat({
  label,
  value,
  hint,
  icon: Icon,
  onClick,
}: {
  label: string
  value: string | number
  hint?: string
  icon: typeof FileText
  onClick?: () => void
}) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[length:var(--text-11-5)] font-medium text-[var(--text-tertiary)]">{label}</p>
        <Icon size={15} aria-hidden="true" className="text-[var(--text-quaternary)]" />
      </div>
      <p className="mt-2 text-[length:var(--text-26)] font-semibold tabular tracking-[-0.02em] text-[var(--text-primary)]">{value}</p>
      {hint && <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{hint}</p>}
    </>
  )
  const className = 'block w-full rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 text-left transition-colors'
  if (!onClick) return <div className={className}>{content}</div>
  return (
    <button type="button" onClick={onClick} className={`${className} hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]`}>
      {content}
    </button>
  )
}

export function DashboardPanel({ siteTitle, blogUrl }: { siteTitle: string; blogUrl: string }) {
  const toast = useUi((state) => state.toast)
  const dashboard = useAdminResource<BlogDashboard>(() => api.blog.dashboard(), [])
  const health = useAdminResource(() => api.blog.health(), [])
  const [draftTitle, setDraftTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const createDraft = async () => {
    if (creating) return
    setCreating(true)
    try {
      const { createBlogDraft } = await import('../blog/publish')
      const id = await createBlogDraft('post', draftTitle.trim() || t('blog.admin.untitled_post'))
      if (id) {
        setDraftTitle('')
        navigateToPath(`/blog-admin/posts/${encodeURIComponent(id)}`)
      } else {
        toast({ title: t('blog.admin.create_failed'), tone: 'danger' })
      }
    } finally {
      setCreating(false)
    }
  }

  const data = dashboard.data
  const views = data?.viewsByDay ?? []
  const maxViews = Math.max(1, ...views.map((day) => day.views))

  return (
    <div className="mx-auto max-w-[1180px]">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[length:var(--text-20)] font-semibold tracking-[-0.015em] text-[var(--text-primary)]">{t('blog.admin.dashboard')}</h1>
          <p className="mt-1 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">
            {siteTitle ? t('blog.admin.dashboard_subtitle', { site: siteTitle }) : t('blog.admin.subtitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<Plus size={13} />} onClick={() => navigateToPath('/blog-admin/posts/new')}>{t('blog.admin.new_post')}</Button>
          <Button size="sm" icon={<Upload size={13} />} onClick={() => navigateToPath('/blog-admin/media')}>{t('blog.admin.upload_media')}</Button>
          {blogUrl && (
            <Button size="sm" variant="ghost" onClick={() => window.open(blogUrl, '_blank', 'noopener,noreferrer')}>{t('blog.admin.live_view')}</Button>
          )}
        </div>
      </header>

      {dashboard.error ? (
        <AdminError message={dashboard.error} onRetry={() => void dashboard.reload()} />
      ) : !data ? (
        <AdminLoading />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Stat label={t('blog.admin.posts_published')} value={data.overview.published} icon={FileText} onClick={() => navigateToPath('/blog-admin/posts?status=published')} />
            <Stat label={t('blog.admin.posts_drafts')} value={data.overview.drafts} icon={FileText} onClick={() => navigateToPath('/blog-admin/posts?status=draft')} />
            <Stat label={t('blog.admin.posts_scheduled')} value={data.scheduled} icon={CalendarClock} onClick={() => navigateToPath('/blog-admin/calendar')} />
            <Stat label={t('blog.admin.comments_pending')} value={data.overview.commentsPending} icon={MessageSquare} onClick={() => navigateToPath('/blog-admin/comments')} />
            <Stat label={t('blog.admin.views')} value={data.overview.views} icon={Eye} onClick={() => navigateToPath('/blog-admin/tools')} />
            <Stat label={t('blog.admin.storage')} value={formatBytes(data.storageBytes)} icon={ImageIcon} onClick={() => navigateToPath('/blog-admin/media')} />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <AdminCard className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('blog.admin.views_last_30')}</h2>
                <TrendingUp size={15} aria-hidden="true" className="text-[var(--text-quaternary)]" />
              </div>
              {views.length === 0 ? (
                <p className="mt-6 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('blog.admin.no_views_yet')}</p>
              ) : (
                <div className="mt-4 flex h-36 items-end gap-1" role="img" aria-label={t('blog.admin.views_last_30')}>
                  {views.map((day) => (
                    <div
                      key={day.day}
                      title={`${day.day} · ${day.views}`}
                      className="min-h-0 flex-1 rounded-t-[3px] bg-[var(--accent)]/70 transition-colors hover:bg-[var(--accent)]"
                      style={{ height: `${Math.max(4, (day.views / maxViews) * 100)}%` }}
                    />
                  ))}
                </div>
              )}
              <div className="mt-2 flex justify-between text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                <span>{views[0]?.day ?? ''}</span>
                <span>{views.at(-1)?.day ?? ''}</span>
              </div>
            </AdminCard>

            <AdminCard className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{t('blog.admin.quick_draft')}</h2>
                <FileText size={15} aria-hidden="true" className="text-[var(--text-quaternary)]" />
              </div>
              <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('blog.admin.quick_draft_hint')}</p>
              <div className="mt-3 flex items-center gap-2">
                <Input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder={t('blog.admin.untitled_post')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      void createDraft()
                    }
                  }}
                  className="min-w-0 flex-1"
                />
                <Button size="sm" onClick={() => void createDraft()} loading={creating}>{t('blog.admin.create')}</Button>
              </div>
              <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
                <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('blog.admin.site_health')}</h3>
                {health.error ? (
                  <p className="mt-1 text-[length:var(--text-11-5)] text-[var(--danger)]">{health.error}</p>
                ) : health.data ? (
                  <dl className="mt-2 grid grid-cols-2 gap-2 text-[length:var(--text-11-5)]">
                    <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.database')}</dt><dd className="text-[var(--success)]">{t('blog.admin.healthy')}</dd></div>
                    <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.storage')}</dt><dd className={health.data.storage ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>{health.data.storage ? t('blog.admin.healthy') : t('blog.admin.unavailable')}</dd></div>
                    <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.render_stale')}</dt><dd className="tabular">{health.data.stale}</dd></div>
                    <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.render_missing')}</dt><dd className="tabular">{health.data.missing}</dd></div>
                  </dl>
                ) : <AdminLoading />}
              </div>
            </AdminCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <AdminCard>
              <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
                <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('blog.admin.recent_posts')}</h2>
                <a href="/blog-admin/posts" onClick={(event) => { event.preventDefault(); navigateToPath('/blog-admin/posts') }} className="text-[length:var(--text-11-5)] text-[var(--accent)] hover:underline">{t('blog.admin.view_all')}</a>
              </div>
              {data.recentPosts.length === 0 ? (
                <div className="p-4"><AdminEmpty>{t('blog.admin.no_posts')}</AdminEmpty></div>
              ) : (
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {data.recentPosts.map((post) => (
                    <li key={post.id}>
                      <a
                        href={`/blog-admin/posts/${encodeURIComponent(post.noteId)}`}
                        onClick={(event) => { event.preventDefault(); navigateToPath(`/blog-admin/posts/${encodeURIComponent(post.noteId)}`) }}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--bg-hover)]"
                      >
                        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{post.title || t('blog.admin.untitled_post')}</span>
                        <PostStatusBadge status={post.status as BlogPostStatus} />
                        <span className="w-20 shrink-0 text-right text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatRelative(post.updatedAt)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </AdminCard>

            <AdminCard>
              <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
                <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('blog.admin.recent_comments')}</h2>
                <a href="/blog-admin/comments" onClick={(event) => { event.preventDefault(); navigateToPath('/blog-admin/comments') }} className="text-[length:var(--text-11-5)] text-[var(--accent)] hover:underline">{t('blog.admin.view_all')}</a>
              </div>
              {data.recentComments.length === 0 ? (
                <div className="p-4"><AdminEmpty>{t('blog.admin.no_comments')}</AdminEmpty></div>
              ) : (
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {data.recentComments.map((comment) => (
                    <li key={comment.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{comment.authorName}</span>
                        <Badge tone={comment.status === 'approved' ? 'success' : comment.status === 'pending' ? 'warning' : 'neutral'}>{t(COMMENT_LABELS[comment.status as BlogCommentStatus])}</Badge>
                        <span className="ml-auto text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{formatRelative(comment.createdAt)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{comment.content}</p>
                      {comment.postTitle && <p className="mt-0.5 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{comment.postTitle}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </AdminCard>
          </div>
        </div>
      )}
    </div>
  )
}
