import { ATTIRE_PRESETS } from '@shared/tools/id-photo/presets'
import { Ban, Check } from 'lucide-react'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { Field, Slider } from '../../../../components/form'
import { useIdPhotoStore } from '../store'

export function AttireTab() {
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const setAdjustOptions = useIdPhotoStore((s) => s.setAdjustOptions)

  const selectedAttireId = adjustOptions.attireId

  return (
    <div className="flex flex-col gap-4">
      {/* Attire Template Selection */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {/* None / Original option */}
        <button
          type="button"
          onClick={() => setAdjustOptions({ attireId: undefined })}
          className={cn(
            'flex flex-col items-center justify-center gap-1.5 rounded-[var(--r-md)] border p-3 text-center',
            'transition-[border-color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
            !selectedAttireId
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
              : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:bg-[var(--bg-hover)]',
          )}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[var(--text-tertiary)]">
            <Ban size={20} />
          </div>
          <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
            {t('tools.id_photo.attire.none')}
          </span>
        </button>

        {/* Attire presets */}
        {ATTIRE_PRESETS.map((preset) => {
          const isSelected = selectedAttireId === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => setAdjustOptions({ attireId: preset.id })}
              className={cn(
                'flex flex-col items-center justify-between gap-1.5 rounded-[var(--r-md)] border p-2 text-center',
                'transition-[border-color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                isSelected
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:bg-[var(--bg-hover)]',
              )}
            >
              <div
                className="h-12 w-full flex items-center justify-center overflow-hidden"
                dangerouslySetInnerHTML={{ __html: preset.previewSvg }}
              />
              <div className="flex items-center gap-1">
                <span className="truncate text-[length:var(--text-11)] font-medium text-[var(--text-primary)]">
                  {t(preset.nameKey as any)}
                </span>
                {isSelected && <Check size={11} className="text-[var(--accent)]" />}
              </div>
            </button>
          )
        })}
      </div>

      {/* Attire Positioning Sliders */}
      {selectedAttireId && (
        <div className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
          <Field label={t('tools.id_photo.attire.scale')}>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                min={0.8}
                max={1.4}
                step={0.02}
                value={adjustOptions.attireScale ?? 1.0}
                onChange={(val) => setAdjustOptions({ attireScale: val })}
                className="flex-1"
              />
              <span className="w-10 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
                {Math.round((adjustOptions.attireScale ?? 1.0) * 100)}%
              </span>
            </div>
          </Field>

          <Field label={t('tools.id_photo.attire.offset_y')}>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                min={-40}
                max={40}
                step={1}
                value={adjustOptions.attireOffsetY ?? 0}
                onChange={(val) => setAdjustOptions({ attireOffsetY: val })}
                className="flex-1"
              />
              <span className="w-10 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
                {adjustOptions.attireOffsetY ?? 0} {t('tools.id_photo.unit.px')}
              </span>
            </div>
          </Field>
        </div>
      )}
    </div>
  )
}
