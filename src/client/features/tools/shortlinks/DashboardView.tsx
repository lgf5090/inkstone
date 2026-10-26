import { useEffect, useState, useMemo } from 'react'
import {
  BarChart2,
  Copy,
  Globe,
  Link2,
  MousePointerClick,
  Plus,
  QrCode,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import type { ChartConfiguration } from 'chart.js'
import { ChartCanvas, withAlpha, type ChartColors } from '../../../components/chart-canvas'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { t } from '../../../lib/i18n'
import { copyText } from '../../../lib/clipboard'
import { useUiStore } from '../../../lib/ui-store'
import { countryFlag, countryName } from '@shared/tools/shortlinks/country'
import type { ShortLink } from '@shared/tools/shortlinks/types'
import { useShortlinksStore } from './store'
import { shortlinksApi } from './api'

export function DashboardView() {
  const stats = useShortlinksStore((s) => s.dashboardStats)
  const loading = useShortlinksStore((s) => s.loadingDashboard)
  const fetchDashboard = useShortlinksStore((s) => s.fetchDashboard)
  const fetchLinks = useShortlinksStore((s) => s.fetchLinks)
  const setCreateModalOpen = useShortlinksStore((s) => s.setCreateModalOpen)
  const openQrModal = useShortlinksStore((s) => s.openQrModal)
  const selectLink = useShortlinksStore((s) => s.selectLink)

  const [quickUrl, setQuickUrl] = useState('')
  const [shortening, setShortening] = useState(false)

  useEffect(() => {
    void fetchDashboard()
  }, [fetchDashboard])

  const handleQuickShorten = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = quickUrl.trim()
    if (!trimmed) return

    setShortening(true)
    try {
      const created = await shortlinksApi.createLink({
        url: trimmed,
        allow_duplicate: true,
      })
      setQuickUrl('')
      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      void fetchDashboard()
      void fetchLinks()

      // Prompt QR modal for convenience
      openQrModal(created)
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setShortening(false)
    }
  }

  const handleCopyLink = async (link: ShortLink) => {
    const slug = link.slugs.find((s) => s.is_primary)?.slug || link.slugs[0]?.slug
    if (!slug) return
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const shortUrl = `${origin}/l/${slug}`
    const success = await copyText(shortUrl)
    if (success) {
      useUiStore.getState().toast(t('tools.shortlinks.links.copied'), 'success')
    }
  }

  // Chart configuration builder for click trend
  const chartBuilder = useMemo(() => {
    if (!stats?.timeline) return null
    let labels: string[] = []
    let values: number[] = []

    if (Array.isArray(stats.timeline)) {
      values = stats.timeline
      labels = values.map((_, i) => `${i + 1}`)
    } else if (stats.timeline && typeof stats.timeline === 'object' && 'labels' in stats.timeline && 'values' in stats.timeline) {
      const tl = stats.timeline as { labels: string[]; values: number[] }
      labels = tl.labels
      values = tl.values
    }

    if (labels.length === 0) return null

    return (colors: ChartColors): ChartConfiguration<'line'> => ({
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: t('tools.shortlinks.dashboard.total_clicks'),
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
  }, [stats?.timeline])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 space-y-6 max-w-6xl mx-auto w-full">
      {/* Quick Shorten Bar */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4 shadow-xs">
        <div className="text-[length:var(--text-12)] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
          {t('tools.shortlinks.dashboard.quick_shorten')}
        </div>
        <form onSubmit={handleQuickShorten} className="flex flex-col sm:flex-row items-center gap-3">
          <div className="relative flex-1 w-full">
            <Input
              value={quickUrl}
              onChange={(e) => setQuickUrl(e.target.value)}
              placeholder={t('tools.shortlinks.dashboard.url_placeholder')}
              className="h-10 pr-4"
              required
            />
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
            <Button
              type="submit"
              variant="primary"
              disabled={shortening || !quickUrl.trim()}
              className="h-10 px-5 flex-1 sm:flex-initial justify-center"
            >
              <Plus size={16} className="mr-1.5" />
              {t('tools.shortlinks.dashboard.shorten_btn')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreateModalOpen(true)}
              className="h-10 px-3 shrink-0"
              title={t('tools.shortlinks.links.new_link')}
            >
              {t('tools.shortlinks.links.new_link')}
            </Button>
          </div>
        </form>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Clicks */}
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
          <div className="flex items-center justify-between text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <span>{t('tools.shortlinks.dashboard.total_clicks')}</span>
            <MousePointerClick size={16} className="text-[var(--accent)]" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-[var(--text-primary)]">
            {(stats?.total_clicks ?? 0).toLocaleString()}
          </div>
          <div className="mt-1 flex items-center gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {stats && typeof stats.delta_clicks === 'number' ? (
              stats.delta_clicks >= 0 ? (
                <span className="flex items-center text-[var(--success,#10b981)] font-medium">
                  <TrendingUp size={13} className="mr-0.5" />+{stats.delta_clicks}%
                </span>
              ) : (
                <span className="flex items-center text-[var(--danger,#ef4444)] font-medium">
                  <TrendingDown size={13} className="mr-0.5" />
                  {stats.delta_clicks}%
                </span>
              )
            ) : null}
            <span>{t('tools.shortlinks.detail.range_30d')}</span>
          </div>
        </div>

        {/* Active Links */}
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
          <div className="flex items-center justify-between text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <span>{t('tools.shortlinks.dashboard.active_links')}</span>
            <Link2 size={16} className="text-[var(--accent)]" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-[var(--text-primary)]">
            {(stats?.active_links ?? 0).toLocaleString()}
          </div>
          <div className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.links.filter_active')}
          </div>
        </div>

        {/* Total Links */}
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
          <div className="flex items-center justify-between text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <span>{t('tools.shortlinks.dashboard.total_links')}</span>
            <BarChart2 size={16} className="text-[var(--accent)]" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-[var(--text-primary)]">
            {(stats?.total_links ?? 0).toLocaleString()}
          </div>
          <div className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.links.filter_all')}
          </div>
        </div>

        {/* Avg Clicks / Day */}
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-4">
          <div className="flex items-center justify-between text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <span>{t('tools.shortlinks.dashboard.avg_per_day')}</span>
            <Globe size={16} className="text-[var(--accent)]" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono text-[var(--text-primary)]">
            {stats?.avg_clicks_per_day ?? '0.0'}
          </div>
          <div className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.detail.range_30d')}
          </div>
        </div>
      </div>

      {/* Click Trends Chart */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <BarChart2 size={18} className="text-[var(--accent)]" />
            <h3 className="text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.dashboard.click_trends')}
            </h3>
          </div>
          <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.detail.range_30d')}
          </span>
        </div>

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

      {/* Top Countries & Referrers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Top Countries with Emoji Flags */}
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.dashboard.top_countries')}
            </h3>
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.detail.countries')}
            </span>
          </div>

          {!stats || stats.top_countries.length === 0 ? (
            <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
              {t('tools.shortlinks.dashboard.no_data')}
            </div>
          ) : (
            <div className="space-y-2.5">
              {stats.top_countries.map((c, i) => {
                const total = stats.total_clicks || 1
                const pct = Math.min(100, Math.round((c.count / total) * 100))
                const countryCode = c.name || (c as { code?: string }).code || ''
                return (
                  <div key={countryCode || i} className="space-y-1">
                    <div className="flex items-center justify-between text-[length:var(--text-12)]">
                      <span className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                        <span>{countryFlag(countryCode)}</span>
                        <span>{countryName(countryCode)}</span>
                      </span>
                      <span className="font-mono text-[var(--text-secondary)] text-[length:var(--text-11)]">
                        {c.count.toLocaleString()} ({pct}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-[var(--bg-muted)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Top Referrers */}
        <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('tools.shortlinks.dashboard.top_referrers')}
            </h3>
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.detail.referrers')}
            </span>
          </div>

          {!stats || stats.top_referrers.length === 0 ? (
            <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
              {t('tools.shortlinks.dashboard.no_data')}
            </div>
          ) : (
            <div className="space-y-2.5">
              {stats.top_referrers.map((r) => {
                const total = stats.total_clicks || 1
                const pct = Math.min(100, Math.round((r.count / total) * 100))
                return (
                  <div key={r.name} className="space-y-1">
                    <div className="flex items-center justify-between text-[length:var(--text-12)]">
                      <span className="truncate font-medium text-[var(--text-primary)] max-w-[70%]">
                        {r.name || 'Direct / None'}
                      </span>
                      <span className="font-mono text-[var(--text-secondary)] text-[length:var(--text-11)]">
                        {r.count.toLocaleString()} ({pct}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-[var(--bg-muted)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Recent Links */}
      <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('tools.shortlinks.dashboard.recent_links')}
          </h3>
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.links.created_at')}
          </span>
        </div>

        {!stats || stats.recent_links.length === 0 ? (
          <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-12)]">
            {t('tools.shortlinks.links.empty')}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {stats.recent_links.map((link) => {
              const primarySlug = link.slugs.find((s) => s.is_primary)?.slug || link.slugs[0]?.slug
              return (
                <div
                  key={link.id}
                  className="py-3 flex items-center justify-between gap-4 hover:bg-[var(--bg-hover)] -mx-2 px-2 rounded-[var(--r-md)] transition-colors"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded-[var(--r-sm)]"
                    onClick={() => selectLink(link.id)}
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
                      {(link.clicks ?? 0).toLocaleString()}{' '}
                      <span className="text-[length:var(--text-11)] font-normal text-[var(--text-tertiary)]">
                        {t('tools.shortlinks.links.clicks')}
                      </span>
                    </span>
                    <div className="flex items-center gap-1">
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
