import { useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import type { BlogAuditEntry, BlogHealth } from '@shared/blog/model'
import { Badge, Button } from '../../components/primitives'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { AdminCard, AdminEmpty, AdminError, AdminLoading, PageHeader, formatBytes, formatDateTime, useAdminResource } from './shared'

const RENDER_LABEL: Record<string, MessageKey> = {
  ready: 'blog.admin.render_ready',
  stale: 'blog.admin.render_stale',
  missing: 'blog.admin.render_missing',
  failed: 'blog.admin.render_failed',
}

export function ToolsPanel() {
  const toast = useUi((state) => state.toast)
  const health = useAdminResource<BlogHealth>(() => api.blog.health(), [])
  const queue = useAdminResource(() => api.blog.tools.renderQueue(), [])
  const audit = useAdminResource(() => api.blog.audit(60), [])
  const [rebuilding, setRebuilding] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 })
  const [purging, setPurging] = useState(false)

  const rebuildAll = async () => {
    const items = queue.data?.items ?? []
    if (items.length === 0 || rebuilding) return
    setRebuilding(true)
    setProgress({ done: 0, total: items.length, failed: 0 })
    try {
      const { refreshBlogSnapshot } = await import('../blog/publish')
      let failed = 0
      for (const item of items) {
        const ok = await refreshBlogSnapshot(item.noteId)
        if (!ok) failed += 1
        setProgress((current) => ({ ...current, done: current.done + 1, failed }))
      }
      toast({
        title: failed === 0 ? t('blog.admin.rebuild_done') : t('blog.admin.rebuild_partial', { failed }),
        tone: failed === 0 ? 'success' : 'warning',
      })
      await Promise.all([queue.reload(), health.reload()])
    } finally {
      setRebuilding(false)
    }
  }

  const purge = async () => {
    setPurging(true)
    try {
      const result = await api.blog.tools.purge()
      toast({
        title: result.purged ? t('blog.admin.purge_done') : t('blog.admin.purge_unconfigured'),
        description: result.message,
        tone: result.purged ? 'success' : 'warning',
      })
    } catch (error) {
      toast({ title: t('blog.admin.purge_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setPurging(false)
    }
  }

  const data = health.data

  return (
    <div className="mx-auto max-w-[1080px]">
      <PageHeader
        title={t('blog.admin.tools')}
        description={t('blog.admin.tools_subtitle')}
        actions={(
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} loading={purging} onClick={() => void purge()}>{t('blog.admin.purge_cache')}</Button>
            <Button size="sm" icon={<RefreshCw size={13} />} loading={rebuilding} disabled={(queue.data?.items.length ?? 0) === 0} onClick={() => void rebuildAll()}>
              {rebuilding ? t('blog.admin.rebuild_progress', { done: progress.done, total: progress.total }) : t('blog.admin.rebuild_all')}
            </Button>
          </div>
        )}
      />

      {health.error ? (
        <AdminError message={health.error} onRetry={() => void health.reload()} />
      ) : !data ? (
        <AdminLoading />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('blog.admin.database')} value={data.database ? t('blog.admin.healthy') : t('blog.admin.unavailable')} tone={data.database ? 'success' : 'danger'} />
            <Stat label={t('blog.admin.storage')} value={data.storage ? t('blog.admin.healthy') : t('blog.admin.unavailable')} tone={data.storage ? 'success' : 'danger'} />
            <Stat label={t('blog.admin.storage_used')} value={formatBytes(data.storageBytes)} />
            <Stat label={t('blog.admin.last_published')} value={data.lastPublishedAt ? formatDateTime(data.lastPublishedAt) : '—'} />
            <Stat label={t('blog.admin.posts_published')} value={String(data.published)} />
            <Stat label={t('blog.admin.posts_scheduled')} value={String(data.scheduled)} />
            <Stat label={t('blog.admin.render_stale')} value={String(data.stale)} tone={data.stale > 0 ? 'warning' : undefined} />
            <Stat label={t('blog.admin.render_missing')} value={String(data.missing)} tone={data.missing > 0 ? 'warning' : undefined} />
          </div>

          <AdminCard>
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-3">
              <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('blog.admin.render_queue')}</h2>
              <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('blog.admin.render_queue_hint')}</span>
            </div>
            {!queue.data ? (
              <AdminLoading />
            ) : queue.data.items.length === 0 ? (
              <p className="p-4 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('blog.admin.render_queue_empty')}</p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {queue.data.items.map((item) => (
                  <li key={item.noteId} className="flex items-center gap-2 px-4 py-2">
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{item.title || t('blog.admin.untitled_post')}</span>
                    <Badge tone={item.renderStatus === 'failed' ? 'danger' : 'warning'}>{t(RENDER_LABEL[item.renderStatus] ?? 'blog.admin.render_missing')}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>

          <AdminCard>
            <div className="border-b border-[var(--border-subtle)] px-4 py-3">
              <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('blog.admin.audit_log')}</h2>
            </div>
            {!audit.data ? (
              <AdminLoading />
            ) : audit.data.items.length === 0 ? (
              <div className="p-4"><AdminEmpty>{t('blog.admin.audit_empty')}</AdminEmpty></div>
            ) : (
              <ul className="max-h-80 divide-y divide-[var(--border-subtle)] overflow-y-auto">
                {audit.data.items.map((entry: BlogAuditEntry) => (
                  <li key={entry.id} className="flex items-center gap-2 px-4 py-1.5 text-[length:var(--text-11-5)]">
                    <span className="font-mono text-[var(--text-secondary)]">{entry.action}</span>
                    <span className="truncate text-[var(--text-quaternary)]">{entry.entity} · {entry.entityId}</span>
                    <span className="ml-auto shrink-0 text-[var(--text-quaternary)]">{formatDateTime(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' | 'warning' }) {
  const className = tone === 'success' ? 'text-[var(--success)]' : tone === 'danger' ? 'text-[var(--danger)]' : tone === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--text-primary)]'
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</p>
      <p className={`mt-1 truncate text-[length:var(--text-14)] font-semibold ${className}`}>{value}</p>
    </div>
  )
}
