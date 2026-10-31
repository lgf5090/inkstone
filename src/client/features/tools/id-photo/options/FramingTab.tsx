import { Crosshair } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { t } from '../../../../lib/i18n'
import { Field, Slider } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { MAX_ZOOM } from '../engine/framing'
import { useIdPhotoStore } from '../store'

function zoomLabel(percent: number): string {
  return `${Math.round((1 + (percent / 100) * (MAX_ZOOM - 1)) * 100)}%`
}

export function FramingTab() {
  const imageSrc = useIdPhotoStore((s) => s.imageSrc)
  const crop = useIdPhotoStore(useShallow((s) => s.cropPercents()))
  const setCropPercents = useIdPhotoStore((s) => s.setCropPercents)
  const resetCrop = useIdPhotoStore((s) => s.resetCrop)

  if (!imageSrc) {
    return (
      <p className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
        <Crosshair size={14} aria-hidden />
        <span>{t('tools.id_photo.framing.need_photo')}</span>
      </p>
    )
  }

  if (!crop) return null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between pb-1 border-b border-[var(--border-subtle)]">
        <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.id_photo.common.framing_params')}
        </span>
        <Button size="sm" variant="ghost" onClick={resetCrop}>
          <Crosshair size={12} className="mr-1" aria-hidden />
          <span>{t('tools.id_photo.framing.auto_align')}</span>
        </Button>
      </div>

      <Field label={t('tools.id_photo.framing.zoom')}>
        <div className="flex items-center gap-3 pt-1">
          <Slider
            min={0}
            max={100}
            step={1}
            value={crop.zoom}
            label={t('tools.id_photo.framing.zoom')}
            onChange={(val) => setCropPercents(val, crop.x, crop.y)}
            className="flex-1"
          />
          <span className="w-12 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {zoomLabel(crop.zoom)}
          </span>
        </div>
      </Field>

      <Field label={t('tools.id_photo.framing.horizontal')}>
        <div className="flex items-center gap-3 pt-1">
          <Slider
            min={0}
            max={100}
            step={1}
            value={crop.x}
            label={t('tools.id_photo.framing.horizontal')}
            onChange={(val) => setCropPercents(crop.zoom, val, crop.y)}
            className="flex-1"
          />
          <span className="w-12 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {crop.x}%
          </span>
        </div>
      </Field>

      <Field label={t('tools.id_photo.framing.vertical')}>
        <div className="flex items-center gap-3 pt-1">
          <Slider
            min={0}
            max={100}
            step={1}
            value={crop.y}
            label={t('tools.id_photo.framing.vertical')}
            onChange={(val) => setCropPercents(crop.zoom, crop.x, val)}
            className="flex-1"
          />
          <span className="w-12 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {crop.y}%
          </span>
        </div>
      </Field>

      <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {t('tools.id_photo.framing.drag_hint')}
      </p>
    </div>
  )
}
