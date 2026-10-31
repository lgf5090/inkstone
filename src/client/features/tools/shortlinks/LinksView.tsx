import { useEffect } from 'react'
import {
  Clock,
  Copy,
  Eye,
  EyeOff,
  Link2,
  Lock,
  Pencil,
  Plus,
  QrCode,
  Search,
  Trash2,
} from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { Input, Segmented } from '../../../components/form'
import { confirm } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { useUiStore } from '../../../lib/ui-store'
import type { ShortLink } from '@shared/tools/shortlinks/types'
import { useShortlinksStore } from './store'
import { shortlinksApi } from './api'
import { copyShortlinkText } from './copy'

export function LinksView() {
  const links = useShortlinksStore((s) => s.links)
  const total = useShortlinksStore((s) => s.totalLinks)
  const loading = useShortlinksStore((s) => s.loadingLinks)
  const filter = useShortlinksStore((s) => s.filter)
  const setFilter = useShortlinksStore((s) => s.setFilter)
  const fetchLinks = useShortlinksStore((s) => s.fetchLinks)
  const setCreateModalOpen = useShortlinksStore((s) => s.setCreateModalOpen)
  const openEditModal = useShortlinksStore((s) => s.openEditModal)
  const openQrModal = useShortlinksStore((s) => s.openQrModal)
  const selectLink = useShortlinksStore((s) => s.selectLink)

  useEffect(() => {
    void fetchLinks()
  }, [fetchLinks])

  const handleCopyLink = async (link: ShortLink) => {
    const slug = link.slugs.find((s) => s.is_primary)?.slug || link.slugs[0]?.slug
    if (!slug) return
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const shortUrl = `${origin}/l/${slug}`
    await copyShortlinkText(shortUrl)
  }

  const handleToggleSlugStatus = async (link: ShortLink) => {
    const primarySlug = link.slugs.find((s) => s.is_primary) || link.slugs[0]
    if (!primarySlug) return
    const isCurrentlyActive = primarySlug.disabled_at === null
    try {
      await shortlinksApi.setSlugStatus(link.id, primarySlug.slug, !isCurrentlyActive)
      useUiStore.getState().toast(t('tools.shortlinks.links.status_updated'), 'success')
      void fetchLinks()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  const handleDeleteLink = async (link: ShortLink) => {
    const hasClicks = link.total_clicks > 0
    const ok = await confirm({
      title: t('tools.shortlinks.links.delete'),
      description: hasClicks
        ? t('tools.shortlinks.links.delete_non_zero_warn')
        : t('tools.shortlinks.links.delete_confirm'),
      tone: 'danger',
      confirmLabel: t('tools.shortlinks.links.delete'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    try {
      await shortlinksApi.deleteLink(link.id)
      useUiStore.getState().toast(t('tools.shortlinks.links.deleted'), 'success')
      void fetchLinks()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 space-y-5 max-w-6xl mx-auto w-full">
      {/* Search and Filters Header */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <div className="relative flex-1">
            <Input
              value={filter.search}
              onChange={(e) => setFilter({ search: e.target.value, page: 1 })}
              placeholder={t('tools.shortlinks.links.search_placeholder')}
              className="h-9 pl-8"
            />
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Segmented
            size="sm"
            value={filter.status}
            label={t('tools.shortlinks.links.status')}
            onChange={(status) => setFilter({ status, page: 1 })}
            options={[
              { value: 'all', label: t('tools.shortlinks.links.filter_all') },
              { value: 'active', label: t('tools.shortlinks.links.filter_active') },
              { value: 'disabled', label: t('tools.shortlinks.links.filter_disabled') },
            ]}
          />

          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreateModalOpen(true)}
            className="h-9 px-3"
          >
            <Plus size={14} className="mr-1" />
            {t('tools.shortlinks.links.new_link')}
          </Button>
        </div>
      </div>

      {/* Links Table Card */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] overflow-hidden shadow-xs">
        {loading ? (
          <div className="py-16 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
            {t('common.loading')}
          </div>
        ) : (links || []).length === 0 ? (
          <div className="py-16 text-center space-y-2">
            <Link2 size={32} className="mx-auto text-[var(--text-tertiary)]" />
            <div className="text-[length:var(--text-14)] font-medium text-[var(--text-secondary)]">
              {t('tools.shortlinks.links.empty')}
            </div>
            <div className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.links.empty_desc')}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">
                  <th scope="col" className="py-2.5 px-4">{t('tools.shortlinks.links.primary_slug')}</th>
                  <th scope="col" className="py-2.5 px-4">{t('tools.shortlinks.links.target_url')}</th>
                  <th scope="col" className="py-2.5 px-4 text-center">{t('tools.shortlinks.links.status')}</th>
                  <th scope="col" className="py-2.5 px-4 text-right">{t('tools.shortlinks.links.clicks')}</th>
                  <th scope="col" className="py-2.5 px-4 text-right">{t('tools.shortlinks.links.created_at')}</th>
                  <th scope="col" className="py-2.5 px-4 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)] text-[length:var(--text-13)]">
                {links.map((link) => {
                  const primarySlugObj = link.slugs.find((s) => s.is_primary) || link.slugs[0]
                  const primarySlug = primarySlugObj?.slug || ''
                  const isSlugActive = primarySlugObj ? primarySlugObj.disabled_at === null : true
                  const isExpired =
                    link.expires_at !== null && link.expires_at <= Math.floor(Date.now() / 1000)
                  const createdDate = new Date(link.created_at * 1000).toLocaleDateString()

                  return (
                    <tr
                      key={link.id}
                      className="hover:bg-[var(--bg-hover)] transition-colors group cursor-pointer"
                      onClick={() => selectLink(link.id)}
                    >
                      <td className="py-3 px-4 font-mono">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[var(--accent)] hover:underline">
                            /{primarySlug}
                          </span>
                          {link.slugs.length > 1 && (
                            <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.2 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                              +{link.slugs.length - 1}
                            </span>
                          )}
                          {link.password_protected ? (
                            <span
                              title={t('tools.shortlinks.links.password_protected')}
                              className="text-[var(--warning)]"
                            >
                              <Lock size={12} />
                            </span>
                          ) : null}
                        </div>
                      </td>

                      <td className="py-3 px-4 max-w-xs">
                        <div className="truncate font-medium text-[var(--text-primary)]">
                          {link.label || link.url}
                        </div>
                        {link.label && (
                          <div className="truncate font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                            {link.url}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4 text-center">
                        {isExpired ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[length:var(--text-11)] bg-[var(--danger-soft)] text-[var(--danger)]">
                            <Clock size={11} />
                            {t('tools.shortlinks.links.expired')}
                          </span>
                        ) : isSlugActive ? (
                          <span className="inline-block px-2 py-0.5 rounded text-[length:var(--text-11)] bg-[var(--success-soft)] text-[var(--success)]">
                            {t('tools.shortlinks.links.filter_active')}
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded text-[length:var(--text-11)] bg-[var(--bg-inset)] text-[var(--text-tertiary)]">
                            {t('tools.shortlinks.links.filter_disabled')}
                          </span>
                        )}
                      </td>

                      <td className="py-3 px-4 text-right font-mono font-semibold text-[var(--text-secondary)]">
                        {link.total_clicks.toLocaleString()}
                      </td>

                      <td className="py-3 px-4 text-right text-[length:var(--text-12)] text-[var(--text-tertiary)] font-mono">
                        {createdDate}
                      </td>

                      <td
                        className="py-3 px-4 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-end gap-1">
                          <IconButton
                            label={t('tools.shortlinks.links.copy_shortlink')}
                            size="sm"
                            onClick={() => handleCopyLink(link)}
                          >
                            <Copy size={13} />
                          </IconButton>
                          <IconButton
                            label={t('tools.shortlinks.links.qr_code')}
                            size="sm"
                            onClick={() => openQrModal(link)}
                          >
                            <QrCode size={13} />
                          </IconButton>
                          <IconButton
                            label={t('tools.shortlinks.links.edit')}
                            size="sm"
                            onClick={() => openEditModal(link)}
                          >
                            <Pencil size={13} />
                          </IconButton>
                          <IconButton
                            label={
                              isSlugActive
                                ? t('tools.shortlinks.links.disable')
                                : t('tools.shortlinks.links.enable')
                            }
                            size="sm"
                            onClick={() => handleToggleSlugStatus(link)}
                          >
                            {isSlugActive ? <EyeOff size={13} /> : <Eye size={13} />}
                          </IconButton>
                          <IconButton
                            label={t('tools.shortlinks.links.delete')}
                            size="sm"
                            onClick={() => handleDeleteLink(link)}
                          >
                            <Trash2 size={13} className="text-[var(--danger)]" />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {total > filter.pageSize && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <div>
              {t('tools.shortlinks.links.total_count', { count: total.toLocaleString() })}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={filter.page <= 1}
                onClick={() => setFilter({ page: filter.page - 1 })}
              >
                {t('tools.shortlinks.links.page_prev')}
              </Button>
              <span className="font-mono">
                {filter.page} / {Math.ceil(total / filter.pageSize)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={filter.page >= Math.ceil(total / filter.pageSize)}
                onClick={() => setFilter({ page: filter.page + 1 })}
              >
                {t('tools.shortlinks.links.page_next')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
