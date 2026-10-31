import { useEffect } from 'react'
import {
  ArrowLeft,
  Copy,
  FolderArchive,
  Pencil,
  Plus,
  QrCode,
  Trash2,
} from 'lucide-react'
import { Button, IconButton } from '../../../components/primitives'
import { confirm } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUiStore } from '../../../lib/ui-store'
import { Sparkline } from '../../todos/stats-charts'
import type { BundleAccent, ShortLinkBundle } from '@shared/tools/shortlinks/types'
import { useShortlinksStore } from './store'
import { shortlinksApi } from './api'

const ACCENT_COLORS: Record<BundleAccent, { dot: string }> = {
  orange: { dot: 'var(--kanban-tag-orange-fg)' },
  red: { dot: 'var(--danger, #ef4444)' },
  green: { dot: 'var(--success, #10b981)' },
  blue: { dot: 'var(--accent, #3b82f6)' },
  purple: { dot: 'var(--kanban-tag-purple-fg)' },
}

export function BundlesView() {
  const bundles = useShortlinksStore((s) => s.bundles)
  const loading = useShortlinksStore((s) => s.loadingBundles)
  const activeBundleId = useShortlinksStore((s) => s.activeBundleId)
  const fetchBundles = useShortlinksStore((s) => s.fetchBundles)
  const selectBundle = useShortlinksStore((s) => s.selectBundle)
  const openBundleModal = useShortlinksStore((s) => s.openBundleModal)

  useEffect(() => {
    void fetchBundles()
  }, [fetchBundles])

  if (activeBundleId !== null) {
    return <BundleDetailView />
  }

  const handleDeleteBundle = async (bundle: ShortLinkBundle) => {
    const ok = await confirm({
      title: t('tools.shortlinks.bundles.delete'),
      description: t('tools.shortlinks.bundles.delete_confirm'),
      tone: 'danger',
      confirmLabel: t('tools.shortlinks.bundles.delete'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    try {
      await shortlinksApi.deleteBundle(bundle.id)
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void fetchBundles()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 space-y-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            {t('tools.shortlinks.bundles.title')}
          </h2>
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {bundles.length} {t('tools.shortlinks.bundles.title')}
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => openBundleModal(null)}>
          <Plus size={14} className="mr-1" />
          {t('tools.shortlinks.bundles.new_bundle')}
        </Button>
      </div>

      {/* Bundles Grid */}
      {loading ? (
        <div className="py-16 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
          {t('common.loading')}
        </div>
      ) : bundles.length === 0 ? (
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] py-16 text-center space-y-2">
          <FolderArchive size={32} className="mx-auto text-[var(--text-tertiary)]" />
          <div className="text-[length:var(--text-14)] font-medium text-[var(--text-secondary)]">
            {t('tools.shortlinks.bundles.empty')}
          </div>
          <div className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.bundles.empty_desc')}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {bundles.map((bundle) => {
            const colors = ACCENT_COLORS[bundle.accent] || ACCENT_COLORS.blue
            return (
              <div
                key={bundle.id}
                className="group relative rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5 hover:border-[var(--accent)] hover:shadow-xs transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => selectBundle(bundle.id)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded-[var(--r-sm)] before:absolute before:inset-0 before:z-0"
                    >
                      <span
                        className="size-3 rounded-full shrink-0"
                        style={{ backgroundColor: colors.dot }}
                      />
                      <h3 className="font-semibold text-[length:var(--text-14)] text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors truncate">
                        {bundle.name}
                      </h3>
                    </button>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity relative z-10 shrink-0">
                      <IconButton
                        label={t('tools.shortlinks.bundles.edit')}
                        size="sm"
                        onClick={() => openBundleModal(bundle)}
                      >
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton
                        label={t('tools.shortlinks.bundles.delete')}
                        size="sm"
                        onClick={() => handleDeleteBundle(bundle)}
                      >
                        <Trash2 size={12} className="text-[var(--danger)]" />
                      </IconButton>
                    </div>
                  </div>

                  {bundle.description && (
                    <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-secondary)] line-clamp-2">
                      {bundle.description}
                    </p>
                  )}
                </div>

                <div className="mt-4 pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between text-[length:var(--text-12)] text-[var(--text-tertiary)] font-mono">
                  <span>
                    {t('tools.shortlinks.bundles.links_count', { count: bundle.link_count ?? 0 })}
                  </span>
                  <span>
                    {(bundle.total_clicks ?? 0).toLocaleString()} {t('tools.shortlinks.links.clicks')}
                  </span>
                </div>

                {bundle.sparkline && bundle.sparkline.length > 1 && (
                  <div className="mt-2 flex justify-end">
                    <Sparkline values={bundle.sparkline} tone={colors.dot} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function BundleDetailView() {
  const activeBundleId = useShortlinksStore((s) => s.activeBundleId)
  const bundles = useShortlinksStore((s) => s.bundles)
  const links = useShortlinksStore((s) => s.activeBundleLinks)
  const stats = useShortlinksStore((s) => s.activeBundleStats)
  const loading = useShortlinksStore((s) => s.loadingBundleDetail)
  const selectBundle = useShortlinksStore((s) => s.selectBundle)
  const setManageModalOpen = useShortlinksStore((s) => s.setManageBundleLinksModalOpen)
  const openQrModal = useShortlinksStore((s) => s.openQrModal)
  const openBundleModal = useShortlinksStore((s) => s.openBundleModal)
  const selectLink = useShortlinksStore((s) => s.selectLink)

  const bundle = bundles.find((b) => b.id === activeBundleId)
  if (!bundle) return null

  const colors = ACCENT_COLORS[bundle.accent] || ACCENT_COLORS.blue
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  const handleCopy = async (slug: string) => {
    const success = await copyText(`${origin}/l/${slug}`)
    if (success) {
      useUiStore.getState().toast(t('tools.shortlinks.links.copied'), 'success')
    }
  }

  const handleRemoveLink = async (linkId: number) => {
    try {
      await shortlinksApi.removeLinkFromBundle(bundle.id, linkId)
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void selectBundle(bundle.id)
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 space-y-6 max-w-6xl mx-auto w-full">
      {/* Back button */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => selectBundle(null)}
          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] -ml-2"
        >
          <ArrowLeft size={16} className="mr-1.5" />
          {t('tools.shortlinks.bundles.title')}
        </Button>
      </div>

      {/* Bundle Header Card */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-6 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className="size-4 rounded-full shrink-0"
              style={{ backgroundColor: colors.dot }}
            />
            <div>
              <h2 className="text-xl font-bold text-[var(--text-primary)]">{bundle.name}</h2>
              {bundle.description && (
                <p className="text-[length:var(--text-12)] text-[var(--text-secondary)] mt-0.5">
                  {bundle.description}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openBundleModal(bundle)}
            >
              <Pencil size={13} className="mr-1.5" />
              {t('tools.shortlinks.bundles.edit')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setManageModalOpen(true)}
            >
              <Plus size={13} className="mr-1.5" />
              {t('tools.shortlinks.bundles.manage_links')}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-6 pt-3 border-t border-[var(--border-subtle)] text-[length:var(--text-13)]">
          <div>
            <span className="text-[var(--text-tertiary)]">{t('tools.shortlinks.dashboard.total_links')}: </span>
            <span className="font-mono font-bold text-[var(--text-primary)]">{links.length}</span>
          </div>
          <div>
            <span className="text-[var(--text-tertiary)]">{t('tools.shortlinks.dashboard.total_clicks')}: </span>
            <span className="font-mono font-bold text-[var(--text-primary)]">
              {(stats?.total_clicks ?? bundle.total_clicks ?? 0).toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* Included Links List */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] overflow-hidden">
        <div className="p-4 border-b border-[var(--border-subtle)] flex items-center justify-between">
          <h3 className="font-semibold text-[length:var(--text-14)] text-[var(--text-primary)]">
            {t('tools.shortlinks.bundles.manage_links')}
          </h3>
          <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)] font-mono">
            {links.length}
          </span>
        </div>

        {loading ? (
          <div className="py-12 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
            {t('common.loading')}
          </div>
        ) : links.length === 0 ? (
          <div className="py-12 text-center space-y-2">
            <div className="text-[length:var(--text-13)] text-[var(--text-secondary)]">
              {t('tools.shortlinks.bundles.empty_desc')}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setManageModalOpen(true)}
            >
              <Plus size={13} className="mr-1" />
              {t('tools.shortlinks.bundles.add_link')}
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {links.map((link) => {
              const primarySlug = link.slugs.find((s) => s.is_primary)?.slug || link.slugs[0]?.slug || ''
              return (
                <div
                  key={link.id}
                  className="p-3.5 flex items-center justify-between gap-4 hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => selectLink(link.id)}
                    className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded-[var(--r-sm)]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[length:var(--text-13)] font-semibold text-[var(--accent)]">
                        /{primarySlug}
                      </span>
                      {link.label && (
                        <span className="truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
                          {link.label}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)] font-mono mt-0.5">
                      {link.url}
                    </div>
                  </button>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
                      {link.total_clicks.toLocaleString()} {t('tools.shortlinks.links.clicks')}
                    </span>
                    <div className="flex items-center gap-1">
                      <IconButton
                        label={t('tools.shortlinks.links.copy_shortlink')}
                        size="sm"
                        onClick={() => handleCopy(primarySlug)}
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
                        label={t('tools.shortlinks.bundles.remove_link')}
                        size="sm"
                        onClick={() => handleRemoveLink(link.id)}
                      >
                        <Trash2 size={13} className="text-[var(--danger)]" />
                      </IconButton>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
