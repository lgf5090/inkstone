import { useMemo, useState } from 'react'
import { Award, Plus, Trash2 } from 'lucide-react'
import { BUILTIN_ID_PHOTO_SPECS } from '@shared/tools/id-photo/specs'
import type { IdPhotoCategory } from '@shared/tools/id-photo/types'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { Input } from '../../../../components/form'
import { Button, IconButton } from '../../../../components/primitives'
import { useUi } from '../../../../store/ui'
import { useIdPhotoStore } from '../store'
import { deleteCustomSpec } from '../api'
import { CustomSpecModal } from './CustomSpecModal'

export function IdPhotoSpecsView() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<IdPhotoCategory | 'all'>('all')

  const selectedSpecId = useIdPhotoStore((s) => s.selectedSpecId)
  const setSelectedSpecId = useIdPhotoStore((s) => s.setSelectedSpecId)
  const customSpecs = useIdPhotoStore((s) => s.customSpecs)
  const loadCustomSpecs = useIdPhotoStore((s) => s.loadCustomSpecs)
  const customSpecModalOpen = useIdPhotoStore((s) => s.customSpecModalOpen)
  const setCustomSpecModalOpen = useIdPhotoStore((s) => s.setCustomSpecModalOpen)

  const allSpecs = useMemo(() => {
    return [...customSpecs, ...BUILTIN_ID_PHOTO_SPECS]
  }, [customSpecs])

  const filteredSpecs = useMemo(() => {
    return allSpecs.filter((s) => {
      const matchCat = category === 'all' || s.category === category
      const q = search.trim().toLowerCase()
      const matchSearch =
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.countryCode.toLowerCase().includes(q)
      return matchCat && matchSearch
    })
  }, [allSpecs, category, search])

  const categories = [
    { id: 'all', labelKey: 'tools.id_photo.spec.category_all' },
    { id: 'cn_standard', labelKey: 'tools.id_photo.spec.category_cn' },
    { id: 'exam_cert', labelKey: 'tools.id_photo.spec.category_exam' },
    { id: 'intl_passport', labelKey: 'tools.id_photo.spec.category_intl' },
    { id: 'visa', labelKey: 'tools.id_photo.spec.category_visa' },
    { id: 'custom', labelKey: 'tools.id_photo.spec.category_custom' },
  ] as const

  const handleDeleteSpec = async (e: React.MouseEvent, specId: string) => {
    e.stopPropagation()
    try {
      await deleteCustomSpec(specId)
      await loadCustomSpecs()
      useUi.getState().toast({ title: t('tools.id_photo.specs.delete_success'), tone: 'default' })
    } catch {
      useUi.getState().toast({ title: t('tools.id_photo.specs.delete_failed'), tone: 'danger' })
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto p-4 sm:p-6 max-w-5xl mx-auto gap-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <Award size={22} />
          </div>
          <div>
            <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">
              {t('tools.id_photo.nav.specs')}
            </h2>
            <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {allSpecs.length} {t('tools.id_photo.common.available_specs')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => setCustomSpecModalOpen(true)}
          >
            <Plus size={14} className="mr-1" />
            <span>{t('tools.id_photo.spec.add_custom')}</span>
          </Button>
        </div>
      </div>

      {/* Filter and Search */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tools.id_photo.spec.search_placeholder')}
            aria-label={t('tools.id_photo.spec.search_placeholder')}
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {categories.map((c) => {
            const active = category === c.id
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id as any)}
                className={cn(
                  'rounded-full px-3 py-1 text-[length:var(--text-12)] font-medium shrink-0',
                  active
                    ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                    : 'bg-[var(--bg-sunken)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {t(c.labelKey as any)}
              </button>
            )
          })}
        </div>
      </div>

      {/* Specifications Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filteredSpecs.map((spec) => {
          const isSelected = selectedSpecId === spec.id
          return (
            <div
              key={spec.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedSpecId(spec.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setSelectedSpecId(spec.id)
              }}
              className={cn(
                'relative flex flex-col justify-between gap-3 rounded-[var(--r-md)] border p-4 cursor-pointer select-none',
                'transition-[border-color,background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                isSelected
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-sunken)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {spec.flagEmoji && (
                    <span className="text-xl leading-none" title={spec.countryCode}>
                      {spec.flagEmoji}
                    </span>
                  )}
                  <h4 className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
                    {spec.nameKey ? t(spec.nameKey as any) : spec.name}
                  </h4>
                </div>
                {!spec.isBuiltin && (
                  <IconButton
                    size="sm"
                    variant="danger"
                    label={t('tools.id_photo.common.delete')}
                    onClick={(e) => handleDeleteSpec(e, spec.id)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </div>

              {spec.descriptionKey && (
                <p className="text-[length:var(--text-12)] text-[var(--text-secondary)] line-clamp-2">
                  {t(spec.descriptionKey as any)}
                </p>
              )}

              <div className="flex flex-col gap-1.5 border-t border-[var(--border-subtle)] pt-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                <div className="flex items-center justify-between">
                  <span>{t('tools.id_photo.spec.physical_size')}:</span>
                  <span className="font-mono text-[var(--text-primary)] font-medium">
                    {spec.widthMm} × {spec.heightMm} {t('tools.id_photo.unit.mm')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>{t('tools.id_photo.spec.pixel_size')}:</span>
                  <span className="font-mono text-[var(--text-secondary)]">
                    {spec.widthPx} × {spec.heightPx} {t('tools.id_photo.unit.px')} @ {spec.dpi} {t('tools.id_photo.unit.dpi')}
                  </span>
                </div>
                {spec.recommendedBgColors.length > 0 && (
                  <div className="flex items-center justify-between pt-0.5">
                    <span>{t('tools.id_photo.spec.recommended_bg')}:</span>
                    <div className="flex items-center gap-1.5">
                      {spec.recommendedBgColors.map((color, idx) => (
                        <span
                          key={idx}
                          style={{ backgroundColor: color }}
                          className="h-3.5 w-3.5 rounded-full border border-black/10 dark:border-white/20"
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

      <CustomSpecModal
        open={customSpecModalOpen}
        onClose={() => setCustomSpecModalOpen(false)}
      />
    </div>
  )
}
