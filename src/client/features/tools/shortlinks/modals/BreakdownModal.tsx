import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { countryFlag, countryName } from '@shared/tools/shortlinks/country'
import { useShortlinksStore } from '../store'

export function BreakdownModal() {
  const open = useShortlinksStore((s) => s.breakdownModalOpen)
  const dimension = useShortlinksStore((s) => s.breakdownDimension)
  const breakdownPage = useShortlinksStore((s) => s.breakdownPage)
  const loading = useShortlinksStore((s) => s.loadingBreakdown)
  const closeBreakdown = useShortlinksStore((s) => s.closeBreakdown)

  const items = breakdownPage?.items || []
  const totalClicks = items.reduce((acc, curr) => acc + curr.count, 0)

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
        <div className="flex w-full items-center justify-end">
          <Button variant="ghost" onClick={closeBreakdown}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div className="py-2">
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
                : item.name || 'Direct / None'

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
      </div>
    </Modal>
  )
}
