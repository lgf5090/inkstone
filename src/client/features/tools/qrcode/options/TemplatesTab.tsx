import { useState } from 'react'
import { QR_PRESETS } from '../../../../../shared/tools/qrcode/presets'
import type { QrTemplateCategory } from '../../../../../shared/tools/qrcode/types'
import { useQrCodeStore } from '../store'
import { cn } from '../../../../lib/cn'
import { t, type MessageKey } from '../../../../lib/i18n'

const CATEGORIES: readonly { id: 'all' | QrTemplateCategory; labelKey: MessageKey }[] = [
  { id: 'all', labelKey: 'tools.qrcode.templates.cat_all' },
  { id: 'minimal', labelKey: 'tools.qrcode.templates.cat_minimal' },
  { id: 'frame', labelKey: 'tools.qrcode.templates.cat_frame' },
  { id: 'artistic', labelKey: 'tools.qrcode.templates.cat_artistic' },
  { id: 'scenario', labelKey: 'tools.qrcode.templates.cat_scenario' },
]

export function TemplatesTab() {
  const [selectedCat, setSelectedCat] = useState<'all' | QrTemplateCategory>('all')
  const applyPreset = useQrCodeStore((s) => s.applyPreset)
  const currentOptions = useQrCodeStore((s) => s.options)

  const filteredPresets = selectedCat === 'all'
    ? QR_PRESETS
    : QR_PRESETS.filter((p) => p.category === selectedCat)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1 border-b border-[var(--border-subtle)] pb-2">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => setSelectedCat(cat.id)}
            className={cn(
              'rounded-[var(--r-sm)] px-2.5 py-1 text-[length:var(--text-12)] font-medium transition-colors',
              selectedCat === cat.id
                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] shadow-xs'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            )}
          >
            {t(cat.labelKey)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2.5 max-h-[380px] overflow-y-auto pr-1">
        {filteredPresets.map((preset) => {
          const isSelected =
            currentOptions.frameOptions?.type === preset.options.frameOptions?.type &&
            currentOptions.dotsOptions.type === preset.options.dotsOptions.type &&
            currentOptions.dotsOptions.color === preset.options.dotsOptions.color

          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              className={cn(
                'group relative flex flex-col items-center rounded-[var(--r-md)] border p-2 text-center transition-all duration-[var(--dur-fast)]',
                'bg-[var(--bg-inset)] hover:border-[var(--accent)] hover:shadow-xs',
                isSelected
                  ? 'border-[var(--accent)] ring-1 ring-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--border-subtle)]'
              )}
            >
              <div className="flex h-24 w-full items-center justify-center overflow-hidden rounded bg-white p-1.5 shadow-xs">
                <svg viewBox="0 0 40 40" className="h-full w-full">
                  <rect width="40" height="40" fill={preset.options.backgroundOptions?.color || '#ffffff'} />
                  <rect x="4" y="4" width="10" height="10" fill={preset.options.cornersSquareOptions?.color || '#000000'} rx={preset.options.cornersSquareOptions?.type === 'dot' ? 5 : 1} />
                  <rect x="6" y="6" width="6" height="6" fill="#ffffff" rx={preset.options.cornersDotOptions?.type === 'dot' ? 3 : 0} />
                  <rect x="7" y="7" width="4" height="4" fill={preset.options.cornersDotOptions?.color || '#000000'} rx={preset.options.cornersDotOptions?.type === 'dot' ? 2 : 0} />
                  <rect x="26" y="4" width="10" height="10" fill={preset.options.cornersSquareOptions?.color || '#000000'} rx={preset.options.cornersSquareOptions?.type === 'dot' ? 5 : 1} />
                  <rect x="28" y="6" width="6" height="6" fill="#ffffff" rx={preset.options.cornersDotOptions?.type === 'dot' ? 3 : 0} />
                  <rect x="29" y="7" width="4" height="4" fill={preset.options.cornersDotOptions?.color || '#000000'} rx={preset.options.cornersDotOptions?.type === 'dot' ? 2 : 0} />
                  <rect x="4" y="26" width="10" height="10" fill={preset.options.cornersSquareOptions?.color || '#000000'} rx={preset.options.cornersSquareOptions?.type === 'dot' ? 5 : 1} />
                  <rect x="6" y="28" width="6" height="6" fill="#ffffff" rx={preset.options.cornersDotOptions?.type === 'dot' ? 3 : 0} />
                  <rect x="7" y="29" width="4" height="4" fill={preset.options.cornersDotOptions?.color || '#000000'} rx={preset.options.cornersDotOptions?.type === 'dot' ? 2 : 0} />
                  <circle cx="20" cy="10" r="1.5" fill={preset.options.dotsOptions.color || '#000000'} />
                  <circle cx="20" cy="16" r="1.5" fill={preset.options.dotsOptions.color || '#000000'} />
                  <circle cx="20" cy="22" r="1.5" fill={preset.options.dotsOptions.color || '#000000'} />
                  <circle cx="16" cy="20" r="1.5" fill={preset.options.dotsOptions.color || '#000000'} />
                  <circle cx="24" cy="20" r="1.5" fill={preset.options.dotsOptions.color || '#000000'} />
                  <circle cx="28" cy="28" r="1.5" fill={preset.options.dotsOptions.color || '#000000'} />
                  <circle cx="32" cy="32" r="1.5" fill={preset.options.dotsOptions.color || '#000000'} />
                </svg>
              </div>

              <div className="mt-2 flex w-full items-center justify-between gap-1">
                <span className="rounded bg-[var(--bg-muted)] px-1 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                  {preset.category === 'minimal' && t('tools.qrcode.templates.cat_minimal')}
                  {preset.category === 'frame' && t('tools.qrcode.templates.cat_frame')}
                  {preset.category === 'artistic' && t('tools.qrcode.templates.cat_artistic')}
                  {preset.category === 'scenario' && t('tools.qrcode.templates.cat_scenario')}
                </span>
                <span className="truncate text-[length:var(--text-11)] font-medium text-[var(--text-primary)]">
                  {preset.name}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
