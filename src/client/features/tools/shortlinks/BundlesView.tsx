import { useEffect, useMemo, type ReactNode } from 'react'
import {
  ArrowLeft,
  Copy,
  FolderArchive,
  Pencil,
  Plus,
  QrCode,
  Trash2,
} from 'lucide-react'
import type { ChartConfiguration } from 'chart.js'
import { ChartCanvas, withAlpha, type ChartColors } from '../../../components/chart-canvas'
import { LoadingBlock } from '../../../components/feedback'
import { Sparkline } from '../../../components/Sparkline'
import { Button, IconButton } from '../../../components/primitives'
import { confirm } from '../../../components/overlay'
import { localeTag, t } from '../../../lib/i18n'
import { useUiStore } from '../../../lib/ui-store'
import { countryFlag, countryName } from '@shared/tools/shortlinks/country'
import type { ShortLinkBundle } from '@shared/tools/shortlinks/types'
import { ACCENT_DOT } from './accents'
import { useShortlinksStore } from './store'
import { shortlinksApi } from './api'
import { copyShortlinkText } from './copy'

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
      useUiStore.getState().toast(t('tools.shortlinks.bundles.deleted'), 'success')
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
            {t('tools.shortlinks.bundles.count', { count: bundles.length })}
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
            const dot = ACCENT_DOT[bundle.accent]
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
                        style={{ backgroundColor: dot }}
                      />
                      <h3 className="font-semibold text-[length:var(--text-14)] text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors truncate">
                        {bundle.name}
                      </h3>
                    </button>
                    <div className="flex items-center gap-1 opacity-100 transition-opacity relative z-10 shrink-0">
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
                    <Sparkline values={bundle.sparkline} tone={dot} />
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

function share(count: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0
}

function BreakdownCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
      <h3 className="mb-3 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
        {title}
      </h3>
      {children}
    </div>
  )
}

function ShareRows({ items, total, nameOf }: {
  items: { name: string; count: number }[]
  total: number
  nameOf?: (name: string) => ReactNode
}) {
  if (items.length === 0) {
    return (
      <div className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        {t('tools.shortlinks.dashboard.no_data')}
      </div>
    )
  }
  return (
    <div className="space-y-2.5">
      {items.map((item, index) => {
        const pct = share(item.count, total)
        return (
          <div key={`${item.name}-${index}`} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-[length:var(--text-12)]">
              <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">
                {nameOf ? nameOf(item.name) : item.name}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">
                {item.count.toLocaleString()} ({pct}%)
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]">
              <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
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

  const chartBuilder = useMemo(() => {
    const timeline = stats?.timeline
    if (!timeline || timeline.buckets.length === 0) return null
    const labels = timeline.buckets.map((bucket) => bucket.label)
    const values = timeline.buckets.map((bucket) => bucket.count)
    return (colors: ChartColors): ChartConfiguration<'line'> => ({
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: t('tools.shortlinks.links.clicks'),
            data: values,
            borderColor: colors.palette[0] ?? colors.text,
            backgroundColor: withAlpha(colors.palette[0] ?? colors.text, 0.15),
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: labels.length > 20 ? 0 : 3,
            pointHoverRadius: 5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: colors.grid,
            titleColor: colors.text,
            bodyColor: colors.text,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: colors.text, maxTicksLimit: 7, font: { size: 11 } },
          },
          y: {
            beginAtZero: true,
            grid: { color: colors.grid },
            ticks: { color: colors.text, precision: 0, font: { size: 11 } },
          },
        },
      },
    })
  }, [stats?.timeline])

  const topLinks = useMemo(
    () => [...(stats?.per_link ?? [])].sort((a, b) => b.click_count - a.click_count).slice(0, 6),
    [stats?.per_link],
  )

  const bundle = bundles.find((b) => b.id === activeBundleId)
  if (!bundle) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 max-w-6xl mx-auto w-full space-y-4">
        <Button variant="ghost" size="sm" onClick={() => selectBundle(null)} className="-ml-2">
          <ArrowLeft size={16} className="mr-1.5" />
          {t('tools.shortlinks.bundles.title')}
        </Button>
        {loading ? <LoadingBlock /> : null}
      </div>
    )
  }

  const dot = ACCENT_DOT[bundle.accent]
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  const handleCopy = async (slug: string) => {
    await copyShortlinkText(`${origin}/l/${slug}`)
  }

  const handleRemoveLink = async (linkId: number) => {
    try {
      await shortlinksApi.removeLinkFromBundle(bundle.id, linkId)
      useUiStore.getState().toast(t('tools.shortlinks.bundles.link_removed'), 'success')
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
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="size-4 rounded-full shrink-0"
              style={{ backgroundColor: dot }}
            />
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-[var(--text-primary)]">{bundle.name}</h2>
              {bundle.description && (
                <p className="text-[length:var(--text-12)] text-[var(--text-secondary)] mt-0.5">
                  {bundle.description}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
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

        <div className="grid grid-cols-2 gap-4 pt-3 border-t border-[var(--border-subtle)] md:grid-cols-4">
          <div>
            <div className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.dashboard.total_links')}
            </div>
            <div className="mt-1 font-mono text-[length:var(--text-15)] font-bold text-[var(--text-primary)]">
              {(stats?.link_count ?? links.length).toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.dashboard.total_clicks')}
            </div>
            <div className="mt-1 font-mono text-[length:var(--text-15)] font-bold text-[var(--text-primary)]">
              {(stats?.total_clicks ?? bundle.total_clicks ?? 0).toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.bundles.clicked_links')}
            </div>
            <div className="mt-1 font-mono text-[length:var(--text-15)] font-bold text-[var(--text-primary)]">
              {(stats?.clicked_links ?? 0).toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.bundles.countries_reached')}
            </div>
            <div className="mt-1 font-mono text-[length:var(--text-15)] font-bold text-[var(--text-primary)]">
              {(stats?.countries_reached ?? 0).toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {stats ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5 md:col-span-2">
            <h3 className="mb-3 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.bundles.top_links')}
            </h3>
            {topLinks.length === 0 || stats.total_clicks === 0 ? (
              <div className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {t('tools.shortlinks.dashboard.no_data')}
              </div>
            ) : (
              <div className="space-y-3">
                {topLinks.map((link) => {
                  const pct = link.pct_of_bundle
                  return (
                    <div key={link.link_id} className="space-y-1">
                      <div className="flex items-center justify-between gap-3 text-[length:var(--text-12)]">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="shrink-0 font-mono font-semibold text-[var(--accent)]">
                            /{link.primary_slug}
                          </span>
                          {link.label && (
                            <span className="truncate font-medium text-[var(--text-primary)]">
                              {link.label}
                            </span>
                          )}
                        </div>
                        <span className="shrink-0 whitespace-nowrap font-mono text-[length:var(--text-11)] text-[var(--text-secondary)]">
                          {link.click_count.toLocaleString()} ({pct}%)
                        </span>
                      </div>
                      <div className="truncate font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                        {link.url}
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]">
                        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5 md:col-span-2">
            <h3 className="mb-4 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.dashboard.click_trends')}
            </h3>
            <div className="relative h-60 w-full">
              {chartBuilder ? (
                <ChartCanvas<'line'>
                  height="h-60"
                  label={t('tools.shortlinks.dashboard.click_trends')}
                  build={chartBuilder}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
                  {t('tools.shortlinks.dashboard.no_data')}
                </div>
              )}
            </div>
          </div>

          <BreakdownCard title={t('tools.shortlinks.detail.countries')}>
            <ShareRows
              items={stats.countries}
              total={stats.total_clicks}
              nameOf={(name) => (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span aria-hidden="true">{countryFlag(name)}</span>
                  <span className="truncate">{countryName(name, localeTag())}</span>
                </span>
              )}
            />
          </BreakdownCard>

          <BreakdownCard title={t('tools.shortlinks.detail.devices')}>
            <ShareRows
              items={stats.devices}
              total={stats.total_clicks}
              nameOf={(name) => <span className="capitalize">{name}</span>}
            />
          </BreakdownCard>

          <BreakdownCard title={t('tools.shortlinks.detail.referrers')}>
            <ShareRows
              items={stats.referrers}
              total={stats.total_clicks}
              nameOf={(name) => name || t('tools.shortlinks.detail.direct')}
            />
          </BreakdownCard>

          <BreakdownCard title={t('tools.shortlinks.bundles.link_mode')}>
            <ShareRows
              items={stats.link_modes}
              total={stats.total_clicks}
              nameOf={(name) => (
                name === 'qr'
                  ? t('tools.shortlinks.bundles.mode_qr')
                  : name === 'link'
                    ? t('tools.shortlinks.bundles.mode_link')
                    : name
              )}
            />
          </BreakdownCard>
        </div>
      ) : (
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] py-12">
          {loading ? (
            <LoadingBlock />
          ) : (
            <div className="text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.dashboard.no_data')}
            </div>
          )}
        </div>
      )}

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
                  className="p-3.5 flex flex-col gap-2 hover:bg-[var(--bg-hover)] transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <button
                    type="button"
                    onClick={() => selectLink(link.id)}
                    className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded-[var(--r-sm)]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate font-mono text-[length:var(--text-13)] font-semibold text-[var(--accent)]">
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

                  <div className="flex items-center justify-between gap-3 sm:shrink-0">
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
