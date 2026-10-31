import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { countryFlag, countryName } from '@shared/tools/shortlinks/country'
import { useShortlinksStore } from '../store'

export function BreakdownModal() {
  const open = useShortlinksStore((s) => s.breakdownModalOpen)
  const dimension = useShortlinksStore((s) => s.breakdownDimension)
  const breakdownPage = useShortlinksStore((s) => s.breakdownPage)
  const breakdownSearch = useShortlinksStore((s) => s.breakdownSearch)
  const stats = useShortlinksStore((s) => s.activeLinkStats)
  const loading = useShortlinksStore((s) => s.loadingBreakdown)
  const loadingMore = useShortlinksStore((s) => s.loadingMoreBreakdown)
  const setBreakdownSearch = useShortlinksStore((s) => s.setBreakdownSearch)
  const loadMoreBreakdown = useShortlinksStore((s) => s.loadMoreBreakdown)
  const closeBreakdown = useShortlinksStore((s) => s.closeBreakdown)

  const [draft, setDraft] = useState(breakdownSearch)

  useEffect(() => {
    setDraft(breakdownSearch)
  }, [breakdownSearch])

  useEffect(() => {
    if (draft === breakdownSearch) return
    const timer = setTimeout(() => {
      void setBreakdownSearch(draft)
    }, 250)
    return () => clearTimeout(timer)
  }, [draft, breakdownSearch, setBreakdownSearch])

  const items = breakdownPage?.items || []
  const totalClicks = stats?.total_clicks || 0

  const dimensionTitle =
    dimension === 'country' || dimension === 'countries'
      ? t('tools.shortlinks.detail.countries')
      : dimension === 'referrer' || dimension === 'referrers' || dimension === 'referrer_host' || dimension === 'referrer_hosts' || dimension === 'domain'
        ? t('tools.shortlinks.detail.referrers')
        : dimension === 'device_type' || dimension === 'devices'
          ? t('tools.shortlinks.detail.devices')
          : dimension === 'os' || dimension === 'operating_systems'
            ? t('tools.shortlinks.detail.operating_systems')
            : dimension === 'browser' || dimension === 'browsers'
              ? t('tools.shortlinks.detail.browsers')
              : dimension || ''

  const isCountry = dimension === 'country' || dimension === 'countries'

  return (
    <Modal
      open={open}
      onClose={closeBreakdown}
      title={`${t('tools.shortlinks.modal.breakdown_title')} - ${dimensionTitle}`}
      width={560}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {items.length} / {(breakdownPage?.total ?? 0).toLocaleString()}
          </span>
          <Button variant="ghost" onClick={closeBreakdown}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div className="py-2 space-y-3">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none"
          />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('tools.shortlinks.links.search_placeholder')}
            className="h-9 pl-8"
          />
        </div>

        {loading ? (
          <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
            {t('common.loading')}
          </div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
            {t('tools.shortlinks.dashboard.no_data')}
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto space-y-2 pr-1">
            <div className="grid grid-cols-12 gap-2 pb-1 border-b border-[var(--border-subtle)] text-[length:var(--text-12)] font-semibold text-[var(--text-tertiary)]">
              <span className="col-span-7">{t('tools.shortlinks.modal.breakdown_dimension')}</span>
              <span className="col-span-3 text-right">{t('tools.shortlinks.modal.breakdown_count')}</span>
              <span className="col-span-2 text-right">{t('tools.shortlinks.modal.breakdown_percentage')}</span>
            </div>
            {items.map((item, index) => {
              const pct = totalClicks > 0 ? ((item.count / totalClicks) * 100).toFixed(1) : '0.0'
              const displayName = isCountry
                ? `${countryFlag(item.name)} ${countryName(item.name)}`
                : item.name || t('tools.shortlinks.detail.direct')

              return (
                <div
                  key={`${item.name}-${index}`}
                  className="grid grid-cols-12 items-center gap-2 py-1.5 px-1 rounded hover:bg-[var(--bg-hover)] text-[length:var(--text-13)]"
                >
                  <span className="col-span-7 truncate font-medium text-[var(--text-primary)]">
                    {displayName}
                  </span>
                  <span className="col-span-3 text-right font-mono text-[var(--text-secondary)]">
                    {item.count.toLocaleString()}
                  </span>
                  <span className="col-span-2 text-right font-mono text-[var(--text-tertiary)] text-[length:var(--text-12)]">
                    {pct}%
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {breakdownPage?.has_more && !loading ? (
          <div className="flex justify-center">
            <Button variant="secondary" size="sm" onClick={() => void loadMoreBreakdown()} disabled={loadingMore}>
              {loadingMore ? t('common.loading') : t('tools.shortlinks.detail.view_all')}
            </Button>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
