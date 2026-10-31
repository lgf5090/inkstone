import { useState } from 'react'
import { ExternalLink, FileText, Plus, Trash2 } from 'lucide-react'
import type { BlogSettings } from '@shared/blog/settings'
import type { BlogPageItem } from '@shared/blog/model'
import { Badge, Button, IconButton } from '../../components/primitives'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import {
  AdminCard,
  AdminEmpty,
  AdminError,
  AdminLoading,
  PageHeader,
  SearchField,
  formatDate,
  formatRelative,
  useAdminResource,
  useDebounced,
} from './shared'

export function PagesPanel() {
  const toast = useUi((state) => state.toast)
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 250)
  const [creating, setCreating] = useState(false)
  const pages = useAdminResource(() => api.blog.pages.list(), [])
  const settings = useAdminResource(() => api.blog.settings.get(), [])
  const siteUrl = typeof (settings.data as BlogSettings | null)?.site?.url === 'string'
    ? String((settings.data as BlogSettings).site.url).replace(/\/+$/, '')
    : ''
  const items = (pages.data?.items ?? []).filter((page) => {
    if (!debounced.trim()) return true
    const needle = debounced.trim().toLowerCase()
    return page.title.toLowerCase().includes(needle) || page.slug.toLowerCase().includes(needle)
  })

  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      const { createBlogDraft } = await import('../blog/publish')
      const id = await createBlogDraft('page', t('blog.admin.untitled_page'))
      if (id) navigateToPath(`/blog-admin/pages/note/${encodeURIComponent(id)}`)
      else toast({ title: t('blog.admin.create_failed'), tone: 'danger' })
    } finally {
      setCreating(false)
    }
  }

  const open = (page: BlogPageItem) => {
    navigateToPath(page.noteId
      ? `/blog-admin/pages/note/${encodeURIComponent(page.noteId)}`
      : `/blog-admin/pages/${encodeURIComponent(page.id)}`)
  }

  const remove = async (page: BlogPageItem) => {
    const ok = await confirm({
      title: t('blog.admin.page_delete_title'),
      description: t('blog.admin.page_delete_desc'),
      confirmLabel: t('blog.admin.delete_forever'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.blog.pages.remove(page.id)
      await pages.reload()
    } catch (error) {
      toast({ title: t('blog.admin.delete_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title={t('blog.admin.pages')}
        description={t('blog.admin.pages_subtitle')}
        actions={<Button size="sm" icon={<Plus size={13} />} loading={creating} onClick={() => void create()}>{t('blog.admin.new_page')}</Button>}
      />
      <div className="mb-3 flex items-center gap-2">
        <SearchField value={query} onChange={setQuery} placeholder={t('blog.admin.search_pages')} className="max-w-sm" />
      </div>

      {pages.error ? (
        <AdminError message={pages.error} onRetry={() => void pages.reload()} />
      ) : !pages.data ? (
        <AdminLoading />
      ) : items.length === 0 ? (
        <AdminEmpty>{t('blog.admin.no_pages')}</AdminEmpty>
      ) : (
        <AdminCard className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] border-collapse text-left text-[length:var(--text-12-5)]">
              <caption className="sr-only">{t('blog.admin.pages')}</caption>
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <th scope="col" className="px-3 py-2 font-medium">{t('blog.admin.column_title')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.page_kind')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_status')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_updated')}</th>
                  <th scope="col" className="w-24 px-2 py-2"><span className="sr-only">{t('blog.admin.column_actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((page) => (
                  <tr key={page.id} className="border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)]">
                    <td className="px-3 py-2.5">
                      <button type="button" onClick={() => open(page)} className="block max-w-full truncate text-left font-medium text-[var(--text-primary)] hover:text-[var(--accent)]">{page.title}</button>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                        <span>/{page.slug}</span>
                        {page.noteId && <Badge tone="accent">{t('blog.admin.note_backed')}</Badge>}
                      </p>
                    </td>
                    <td className="px-2 py-2.5 text-[var(--text-tertiary)]">{page.kind === 'about' ? t('blog.admin.page_kind_about') : t('blog.admin.page_kind_custom')}</td>
                    <td className="px-2 py-2.5">
                      <Badge tone={page.publishedAt ? 'success' : 'neutral'}>{page.publishedAt ? t('blog.admin.status_published') : t('blog.admin.status_draft')}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-[var(--text-tertiary)]" title={formatDate(page.updatedAt)}>{formatRelative(page.updatedAt)}</td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center gap-0.5">
                        <IconButton label={t('blog.admin.edit')} size="sm" onClick={() => open(page)}><FileText size={14} /></IconButton>
                        {page.publishedAt && siteUrl && (
                          <a href={`${siteUrl}/pages/${page.slug}`} target="_blank" rel="noopener noreferrer" aria-label={t('blog.admin.view_live')} className="inline-flex size-6 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                            <ExternalLink size={13} />
                          </a>
                        )}
                        <IconButton label={t('blog.admin.delete_forever')} size="sm" onClick={() => void remove(page)}><Trash2 size={14} /></IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>
      )}
    </div>
  )
}
