import { useMemo, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { BUILTIN_ID_PHOTO_SPECS } from '@shared/tools/id-photo/specs'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { Input } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { useIdPhotoStore } from '../store'
import { specLabel } from '../spec-label'
import { filterSpecs, SPEC_CATEGORIES, type SpecCategoryFilter } from '../specs/filter-specs'

export function SpecsTab() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<SpecCategoryFilter>('all')

  const selectedSpecId = useIdPhotoStore((s) => s.selectedSpecId)
  const setSelectedSpecId = useIdPhotoStore((s) => s.setSelectedSpecId)
  const customSpecs = useIdPhotoStore((s) => s.customSpecs)
  const setCustomSpecModalOpen = useIdPhotoStore((s) => s.setCustomSpecModalOpen)

  const allSpecs = useMemo(() => {
    return [...customSpecs, ...BUILTIN_ID_PHOTO_SPECS]
  }, [customSpecs])

  const filteredSpecs = useMemo(
    () => filterSpecs(allSpecs, search, category, specLabel),
    [allSpecs, category, search],
  )

  return (
    <div className="flex flex-col gap-3">
      {/* Search and Category Filter */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <div className="relative flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tools.id_photo.spec.search_placeholder')}
            aria-label={t('tools.id_photo.spec.search_placeholder')}
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setCustomSpecModalOpen(true)}
          className="shrink-0"
        >
          <Plus size={14} className="mr-1" />
          <span>{t('tools.id_photo.spec.add_custom')}</span>
        </Button>
      </div>

      {/* Category Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {SPEC_CATEGORIES.map((c) => {
          const active = category === c.id
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              className={cn(
                'rounded-full px-2.5 py-1 text-[length:var(--text-12)] font-medium shrink-0',
                'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                active
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                  : 'bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              {t(c.labelKey)}
            </button>
          )
        })}
      </div>

      {/* Specification Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[380px] overflow-y-auto pr-1">
        {filteredSpecs.map((spec) => {
          const isSelected = selectedSpecId === spec.id
          return (
            <div
              key={spec.id}
              className={cn(
                'relative flex w-full flex-col justify-between gap-2 rounded-[var(--r-md)] border p-3 text-left cursor-pointer select-none',
                'transition-[border-color,background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                isSelected
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
              )}
            >
              <button
                type="button"
                aria-label={specLabel(spec)}
                aria-pressed={isSelected}
                onClick={() => setSelectedSpecId(spec.id)}
                className="absolute inset-0 z-[var(--z-sticky)] rounded-[var(--r-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              />
              <div className="flex items-start justify-between gap-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  {spec.flagEmoji && (
                    <span className="text-base shrink-0 leading-none" title={spec.countryCode}>
                      {spec.flagEmoji}
                    </span>
                  )}
                  <h4 className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                    {specLabel(spec)}
                  </h4>
                </div>
                {isSelected && (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]">
                    <Check size={11} strokeWidth={3} />
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                <div className="flex items-center justify-between">
                  <span>{t('tools.id_photo.spec.physical_size')}:</span>
                  <span className="font-mono text-[var(--text-secondary)] font-medium">
                    {spec.widthMm} × {spec.heightMm} {t('tools.id_photo.unit.mm')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>{t('tools.id_photo.spec.pixel_size')}:</span>
                  <span className="font-mono text-[var(--text-secondary)]">
                    {spec.widthPx} × {spec.heightPx} {t('tools.id_photo.unit.px')}
                  </span>
                </div>
                {spec.recommendedBgColors.length > 0 && (
                  <div className="flex items-center justify-between pt-0.5">
                    <span>{t('tools.id_photo.spec.recommended_bg')}:</span>
                    <div className="flex items-center gap-1">
                      {spec.recommendedBgColors.map((color, idx) => (
                        <span
                          key={idx}
                          style={{ backgroundColor: color }}
                          className="h-3 w-3 rounded-full border border-[var(--border-strong)]"
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {filteredSpecs.length === 0 && (
        <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.id_photo.spec.no_results')}
        </p>
      )}
    </div>
  )
}
