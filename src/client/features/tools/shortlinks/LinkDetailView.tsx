import { useMemo } from 'react'
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  Pencil,
  Plus,
  QrCode,
  Star,
  Trash2,
} from 'lucide-react'
import type { ChartConfiguration } from 'chart.js'
import { ChartCanvas, withAlpha, type ChartColors } from '../../../components/chart-canvas'
import { LoadingBlock } from '../../../components/feedback'
import { Button, IconButton } from '../../../components/primitives'
import { confirm } from '../../../components/overlay'
import { t, type MessageKey } from '../../../lib/i18n'
import { useUiStore } from '../../../lib/ui-store'
import { countryFlag, countryName } from '@shared/tools/shortlinks/country'
import type { TimelineRange } from '@shared/tools/shortlinks/types'
import { useShortlinksStore } from './store'
import { shortlinksApi } from './api'
import { copyShortlinkText } from './copy'

const RANGES: { id: TimelineRange; labelKey: MessageKey }[] = [
  { id: '24h', labelKey: 'tools.shortlinks.detail.range_24h' },
  { id: '7d', labelKey: 'tools.shortlinks.detail.range_7d' },
  { id: '30d', labelKey: 'tools.shortlinks.detail.range_30d' },
  { id: '90d', labelKey: 'tools.shortlinks.detail.range_90d' },
  { id: 'all', labelKey: 'tools.shortlinks.detail.range_all' },
]

function share(count: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0
}

export function LinkDetailView() {
  const link = useShortlinksStore((s) => s.activeLink)
  const stats = useShortlinksStore((s) => s.activeLinkStats)
  const timeline = useShortlinksStore((s) => s.activeLinkTimeline)
  const range = useShortlinksStore((s) => s.activeTimelineRange)
  const loading = useShortlinksStore((s) => s.loadingDetail)
  const selectLink = useShortlinksStore((s) => s.selectLink)
  const setTimelineRange = useShortlinksStore((s) => s.setTimelineRange)
  const refreshActiveLink = useShortlinksStore((s) => s.refreshActiveLink)
  const fetchLinks = useShortlinksStore((s) => s.fetchLinks)
  const openEditModal = useShortlinksStore((s) => s.openEditModal)
  const openQrModal = useShortlinksStore((s) => s.openQrModal)
  const openAddSlugModal = useShortlinksStore((s) => s.openAddSlugModal)
  const openBreakdown = useShortlinksStore((s) => s.openBreakdown)

  // Chart configuration builder (placed before conditional return to uphold Rules of Hooks)
  const chartBuilder = useMemo(() => {
    if (!timeline) return null
    const labels = timeline.buckets.map((b) => b.label)
    const values = timeline.buckets.map((b) => b.count)
    if (labels.length === 0) return null

    return (colors: ChartColors): ChartConfiguration<'line'> => ({
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: t('tools.shortlinks.links.clicks'),
            data: values,
            borderColor: colors.palette[0] || 'var(--accent)',
            backgroundColor: withAlpha(colors.palette[0] || '#3b82f6', 0.15),
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
            ticks: {
              color: colors.text,
              maxTicksLimit: 7,
              font: { size: 11 },
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: colors.grid },
            ticks: {
              color: colors.text,
              precision: 0,
              font: { size: 11 },
            },
          },
        },
      },
    })
  }, [timeline])

  if (!link) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 max-w-6xl mx-auto w-full">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => selectLink(null)}
          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] -ml-2 mb-4"
        >
          <ArrowLeft size={16} className="mr-1.5" />
          {t('tools.shortlinks.detail.back')}
        </Button>
        {loading ? (
          <LoadingBlock />
        ) : (
          <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] py-16 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
            {t('tools.shortlinks.links.empty')}
          </div>
        )}
      </div>
    )
  }

  const primarySlugObj = link.slugs.find((s) => s.is_primary) || link.slugs[0]
  const primarySlug = primarySlugObj?.slug || ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const shortUrl = `${origin}/l/${primarySlug}`

  const handleCopy = async (text: string) => {
    await copyShortlinkText(text)
  }

  const handleSetPrimarySlug = async (slug: string) => {
    try {
      await shortlinksApi.setPrimarySlug(link.id, slug)
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void refreshActiveLink()
      void fetchLinks()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  const handleToggleSlugStatus = async (slug: string, currentActive: boolean) => {
    try {
      await shortlinksApi.setSlugStatus(link.id, slug, !currentActive)
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void refreshActiveLink()
      void fetchLinks()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  const handleDeleteSlug = async (slug: string) => {
    if (link.slugs.length <= 1) {
      useUiStore.getState().toast('Cannot delete the last slug', 'error')
      return
    }
    const ok = await confirm({
      title: t('tools.shortlinks.links.delete'),
      description: `Delete slug /${slug}?`,
      tone: 'danger',
      confirmLabel: t('tools.shortlinks.links.delete'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    try {
      await shortlinksApi.deleteSlug(link.id, slug)
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void refreshActiveLink()
      void fetchLinks()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    }
  }

  const handleDeleteLink = async () => {
    const ok = await confirm({
      title: t('tools.shortlinks.links.delete'),
      description: t('tools.shortlinks.links.delete_confirm'),
      tone: 'danger',
      confirmLabel: t('tools.shortlinks.links.delete'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return

    try {
      await shortlinksApi.deleteLink(link.id)
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void selectLink(null)
      void fetchLinks()
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
          onClick={() => selectLink(null)}
          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] -ml-2"
        >
          <ArrowLeft size={16} className="mr-1.5" />
          {t('tools.shortlinks.detail.back')}
        </Button>
      </div>

      {/* Header card with link metadata and actions */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xl md:text-2xl font-bold text-[var(--accent)]">
                /{primarySlug}
              </span>
              {link.password_protected ? (
                <span
                  title={t('tools.shortlinks.links.password_protected')}
                  className="rounded-full bg-[var(--warning-soft,#fef9c3)] p-1 text-[var(--warning,#ca8a04)]"
                >
                  <Lock size={14} />
                </span>
              ) : null}
            </div>
            {link.label && (
              <h2 className="text-[length:var(--text-15)] font-medium text-[var(--text-primary)]">
                {link.label}
              </h2>
            )}
            <div className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)] font-mono">
              <span className="truncate max-w-md">{link.url}</span>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="hover:text-[var(--accent)]"
                title={link.url}
              >
                <ExternalLink size={13} />
              </a>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleCopy(shortUrl)}
              className="h-8.5"
            >
              <Copy size={14} className="mr-1.5" />
              {t('tools.shortlinks.links.copy_shortlink')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openQrModal(link)}
              className="h-8.5"
            >
              <QrCode size={14} className="mr-1.5" />
              {t('tools.shortlinks.links.qr_code')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openEditModal(link)}
              className="h-8.5"
            >
              <Pencil size={14} className="mr-1.5" />
              {t('tools.shortlinks.links.edit')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleDeleteLink}
              className="h-8.5"
            >
              <Trash2 size={14} className="mr-1.5" />
              {t('tools.shortlinks.links.delete')}
            </Button>
          </div>
        </div>

        {/* Range picker bar */}
        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] pt-4">
          <span className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('tools.shortlinks.detail.title')}
          </span>
          <div className="flex items-center bg-[var(--bg-sunken)] p-0.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] text-[length:var(--text-11)] font-medium">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setTimelineRange(r.id)}
                className={`px-2.5 py-1 rounded-[var(--r-sm)] transition-colors ${
                  range === r.id
                    ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {t(r.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Stats KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
          <div className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('tools.shortlinks.links.clicks')}
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-[var(--text-primary)]">
            {(stats?.total_clicks ?? 0).toLocaleString()}
          </div>
        </div>

        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
          <div className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('tools.shortlinks.dashboard.avg_per_day')}
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-[var(--text-primary)]">
            {stats?.avg_clicks_per_day ?? '0.0'}
          </div>
        </div>

        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
          <div className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('tools.shortlinks.links.expires_at')}
          </div>
          <div className="mt-2 text-[length:var(--text-14)] font-mono font-medium text-[var(--text-primary)]">
            {link.expires_at
              ? new Date(link.expires_at * 1000).toLocaleDateString()
              : t('tools.shortlinks.links.never_expires')}
          </div>
        </div>

        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
          <div className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {t('tools.shortlinks.links.created_at')}
          </div>
          <div className="mt-2 text-[length:var(--text-14)] font-mono font-medium text-[var(--text-primary)]">
            {new Date(link.created_at * 1000).toLocaleDateString()}
          </div>
        </div>
      </div>

      {/* Click Timeline Chart */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)] mb-4">
          {t('tools.shortlinks.dashboard.click_trends')}
        </h3>
        <div className="h-60 w-full relative">
          {chartBuilder ? (
            <ChartCanvas<'line'>
              height="h-60"
              label={t('tools.shortlinks.dashboard.click_trends')}
              build={chartBuilder}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
              {loading ? t('common.loading') : t('tools.shortlinks.dashboard.no_data')}
            </div>
          )}
        </div>
      </div>

      {/* Slugs Management Table */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.detail.slug_manager')}
            </h3>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {link.slugs.length} {t('tools.shortlinks.links.aliases')}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openAddSlugModal(link.id)}
          >
            <Plus size={14} className="mr-1" />
            {t('tools.shortlinks.links.add_alias')}
          </Button>
        </div>

        <div className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-[var(--r-md)] overflow-hidden">
          {link.slugs.map((s) => {
            const isSlugActive = s.disabled_at === null
            return (
              <div
                key={s.slug}
                className="flex items-center justify-between p-3 bg-[var(--bg-base)] text-[length:var(--text-13)]"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-[var(--text-primary)]">
                    /{s.slug}
                  </span>
                  {s.is_primary ? (
                    <span className="inline-flex items-center gap-1 rounded bg-[var(--accent-soft)] px-2 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--accent-on-soft)]">
                      <Star size={11} className="fill-current" />
                      {t('tools.shortlinks.links.primary_slug')}
                    </span>
                  ) : null}
                  {!isSlugActive ? (
                    <span className="rounded bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                      {t('tools.shortlinks.links.filter_disabled')}
                    </span>
                  ) : null}
                </div>

                <div className="flex items-center gap-1">
                  <IconButton
                    label={t('tools.shortlinks.links.copy_shortlink')}
                    size="sm"
                    onClick={() => handleCopy(`${origin}/l/${s.slug}`)}
                  >
                    <Copy size={13} />
                  </IconButton>
                  {!s.is_primary && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSetPrimarySlug(s.slug)}
                      className="text-[length:var(--text-11)] h-7 px-2"
                    >
                      {t('tools.shortlinks.detail.set_primary')}
                    </Button>
                  )}
                  <IconButton
                    label={
                      isSlugActive
                        ? t('tools.shortlinks.links.disable')
                        : t('tools.shortlinks.links.enable')
                    }
                    size="sm"
                    onClick={() => handleToggleSlugStatus(s.slug, isSlugActive)}
                  >
                    {isSlugActive ? <EyeOff size={13} /> : <Eye size={13} />}
                  </IconButton>
                  {link.slugs.length > 1 && !s.is_primary && (
                    <IconButton
                      label={t('tools.shortlinks.links.delete')}
                      size="sm"
                      onClick={() => handleDeleteSlug(s.slug)}
                    >
                      <Trash2 size={13} className="text-[var(--danger)]" />
                    </IconButton>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Analytics Breakdown Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Countries with Emoji Flags */}
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.detail.countries')}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openBreakdown('countries')}
              className="text-[length:var(--text-11)] h-6 px-1.5 text-[var(--accent)]"
            >
              {t('tools.shortlinks.detail.view_all')}
            </Button>
          </div>

          {!stats || stats.countries.length === 0 ? (
            <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
              {t('tools.shortlinks.dashboard.no_data')}
            </div>
          ) : (
            <div className="space-y-2">
              {stats.countries.slice(0, 6).map((c) => {
                const pct = share(c.count, stats.total_clicks)
                return (
                  <div key={c.name} className="flex items-center justify-between text-[length:var(--text-12)]">
                    <span className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                      <span>{countryFlag(c.name)}</span>
                      <span>{countryName(c.name)}</span>
                    </span>
                    <span className="font-mono text-[var(--text-secondary)] text-[length:var(--text-11)]">
                      {c.count.toLocaleString()} ({pct}%)
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Referrers */}
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.detail.referrers')}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openBreakdown('referrer_hosts')}
              className="text-[length:var(--text-11)] h-6 px-1.5 text-[var(--accent)]"
            >
              {t('tools.shortlinks.detail.view_all')}
            </Button>
          </div>

          {!stats || stats.referrer_hosts.length === 0 ? (
            <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
              {t('tools.shortlinks.dashboard.no_data')}
            </div>
          ) : (
            <div className="space-y-2">
              {stats.referrer_hosts.slice(0, 6).map((r) => {
                const pct = share(r.count, stats.total_clicks)
                return (
                  <div key={r.name} className="flex items-center justify-between text-[length:var(--text-12)]">
                    <span className="truncate font-medium text-[var(--text-primary)] max-w-[70%]">
                      {r.name || 'Direct / None'}
                    </span>
                    <span className="font-mono text-[var(--text-secondary)] text-[length:var(--text-11)]">
                      {r.count.toLocaleString()} ({pct}%)
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Devices */}
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.detail.devices')}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openBreakdown('devices')}
              className="text-[length:var(--text-11)] h-6 px-1.5 text-[var(--accent)]"
            >
              {t('tools.shortlinks.detail.view_all')}
            </Button>
          </div>

          {!stats || stats.devices.length === 0 ? (
            <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
              {t('tools.shortlinks.dashboard.no_data')}
            </div>
          ) : (
            <div className="space-y-2">
              {stats.devices.map((d) => {
                const pct = share(d.count, stats.total_clicks)
                return (
                  <div key={d.name} className="flex items-center justify-between text-[length:var(--text-12)]">
                    <span className="capitalize font-medium text-[var(--text-primary)]">
                      {d.name}
                    </span>
                    <span className="font-mono text-[var(--text-secondary)] text-[length:var(--text-11)]">
                      {d.count.toLocaleString()} ({pct}%)
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Operating Systems */}
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.detail.operating_systems')}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openBreakdown('operating_systems')}
              className="text-[length:var(--text-11)] h-6 px-1.5 text-[var(--accent)]"
            >
              {t('tools.shortlinks.detail.view_all')}
            </Button>
          </div>

          {!stats || stats.operating_systems.length === 0 ? (
            <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
              {t('tools.shortlinks.dashboard.no_data')}
            </div>
          ) : (
            <div className="space-y-2">
              {stats.operating_systems.slice(0, 6).map((os) => {
                const pct = share(os.count, stats.total_clicks)
                return (
                  <div key={os.name} className="flex items-center justify-between text-[length:var(--text-12)]">
                    <span className="font-medium text-[var(--text-primary)]">
                      {os.name}
                    </span>
                    <span className="font-mono text-[var(--text-secondary)] text-[length:var(--text-11)]">
                      {os.count.toLocaleString()} ({pct}%)
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Browsers */}
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.detail.browsers')}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openBreakdown('browsers')}
              className="text-[length:var(--text-11)] h-6 px-1.5 text-[var(--accent)]"
            >
              {t('tools.shortlinks.detail.view_all')}
            </Button>
          </div>

          {!stats || !stats.browsers || stats.browsers.length === 0 ? (
            <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
              {t('tools.shortlinks.dashboard.no_data')}
            </div>
          ) : (
            <div className="space-y-2">
              {stats.browsers.slice(0, 6).map((b) => {
                const pct = share(b.count, stats.total_clicks)
                return (
                  <div key={b.name} className="flex items-center justify-between text-[length:var(--text-12)]">
                    <span className="font-medium text-[var(--text-primary)]">
                      {b.name}
                    </span>
                    <span className="font-mono text-[var(--text-secondary)] text-[length:var(--text-11)]">
                      {b.count.toLocaleString()} ({pct}%)
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
