import { useState } from 'react'
import { Copy, Link2, ExternalLink } from 'lucide-react'
import type { BlogPostAdminDetail } from '@shared/blog/model'
import type { BlogSettings } from '@shared/blog/settings'
import { Button, SectionLabel, Badge } from '../../components/primitives'
import { Input } from '../../components/form'
import { api } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { formatDateTime, useAdminResource } from './shared'

const STATUS_KEYS = {
  active: 'blog.admin.preview_status_active',
  used: 'blog.admin.preview_status_used',
  expired: 'blog.admin.preview_status_expired',
  revoked: 'blog.admin.preview_status_revoked',
} as const

const STATUS_TONES = {
  active: 'success',
  used: 'accent',
  expired: 'neutral',
  revoked: 'danger',
} as const

/**
 * The draft's preview links.
 *
 * A generated token is shown once, because only its hash is stored; the list below is what survives
 * a reload, and its revoke action is what makes a leaked link stop working before its hour is up.
 */
export function PreviewLinkSection({ post }: { post: BlogPostAdminDetail }) {
  const toast = useUi((state) => state.toast)
  const settings = useAdminResource(() => api.blog.settings.get(), [])
  const tokens = useAdminResource(() => api.blog.previewTokens(post.id), [post.id])
  const [created, setCreated] = useState<{ token: string; hash: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState('')

  const siteUrl = typeof (settings.data as BlogSettings | null)?.site?.url === 'string'
    ? String((settings.data as BlogSettings).site.url).replace(/\/+$/, '')
    : ''
  const previewUrl = created
    ? `${siteUrl}/preview/${created.token}`
    : ''

  const generate = async () => {
    setBusy('generate')
    try {
      const result = await api.blog.createPreviewToken(post.id)
      setCreated({ token: result.token, hash: result.hash, expiresAt: result.expiresAt })
      await tokens.reload()
    } catch (error) {
      toast({
        title: t('blog.admin.preview_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setBusy('')
    }
  }

  const revoke = async (hash: string) => {
    setBusy(hash)
    try {
      await api.blog.revokePreviewToken(post.id, hash)
      if (created?.hash === hash) setCreated(null)
      await tokens.reload()
      toast({ title: t('blog.admin.preview_revoked'), tone: 'success' })
    } catch (error) {
      toast({
        title: t('blog.admin.preview_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setBusy('')
    }
  }

  const copy = async () => {
    if (!previewUrl) return
    const ok = await copyText(previewUrl)
    toast({
      title: ok ? t('blog.admin.preview_copied') : t('blog.admin.preview_copy_failed'),
      tone: ok ? 'success' : 'danger',
    })
  }

  const items = tokens.data?.items ?? []

  return (
    <section aria-label={t('blog.admin.preview_title')}>
      <SectionLabel>{t('blog.admin.preview_title')}</SectionLabel>
      <div className="space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('blog.admin.preview_desc')}</p>
        <Button size="sm" icon={<Link2 size={12} />} loading={busy === 'generate'} onClick={() => void generate()}>
          {t('blog.admin.preview_generate')}
        </Button>
        {created && previewUrl && (
          <div className="space-y-1.5 border-t border-[var(--border-subtle)] pt-2">
            <label className="text-[length:var(--text-10-5)] font-medium text-[var(--text-tertiary)]" htmlFor="blog-preview-url">
              {t('blog.admin.preview_url')}
            </label>
            <div className="flex items-center gap-1.5">
              <Input id="blog-preview-url" readOnly value={previewUrl} onFocus={(event) => event.currentTarget.select()} />
              <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void copy()} aria-label={t('blog.admin.preview_copy')}>
                {t('blog.admin.preview_copy')}
              </Button>
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex size-7 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
                aria-label={t('blog.admin.preview_open')}
                title={t('blog.admin.preview_open')}
              >
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            </div>
            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {t('blog.admin.preview_expires', { time: formatDateTime(created.expiresAt) })}
            </p>
          </div>
        )}
        {tokens.error ? (
          <p className="text-[length:var(--text-11)] text-[var(--danger)]" role="alert">{tokens.error}</p>
        ) : items.length === 0 ? (
          <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('blog.admin.preview_empty')}</p>
        ) : (
          <ul className="space-y-1 border-t border-[var(--border-subtle)] pt-2">
            {items.map((item) => (
              <li key={item.hash} className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-10-5)]">
                <Badge tone={STATUS_TONES[item.status]}>{t(STATUS_KEYS[item.status])}</Badge>
                <span className="text-[var(--text-quaternary)]">{formatDateTime(item.createdAt)}</span>
                <span className="text-[var(--text-quaternary)]">· {t('blog.admin.preview_expires', { time: formatDateTime(item.expiresAt) })}</span>
                {item.status === 'active' || item.status === 'used' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    loading={busy === item.hash}
                    onClick={() => void revoke(item.hash)}
                  >
                    {t('blog.admin.preview_revoke')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
