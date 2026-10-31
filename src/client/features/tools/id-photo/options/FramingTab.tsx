import { Crosshair } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { t } from '../../../../lib/i18n'
import { Field, Slider } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { MAX_ZOOM } from '../engine/framing'
import { useIdPhotoStore } from '../store'

const ZOOM_MIN = 100
const ZOOM_MAX = MAX_ZOOM * 100

function zoomToSliderPercent(zoom: number): number {
  return Math.round(ZOOM_MIN + (zoom / 100) * (ZOOM_MAX - ZOOM_MIN))
}

function sliderPercentToZoom(value: number): number {
  return ((value - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100
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
        <Slider
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={1}
          suffix="%"
          value={zoomToSliderPercent(crop.zoom)}
          onChange={(val) => setCropPercents(sliderPercentToZoom(val), crop.x, crop.y)}
        />
      </Field>

      <Field label={t('tools.id_photo.framing.horizontal')}>
        <Slider
          min={0}
          max={100}
          step={1}
          suffix="%"
          value={crop.x}
          onChange={(val) => setCropPercents(crop.zoom, val, crop.y)}
        />
      </Field>

      <Field label={t('tools.id_photo.framing.vertical')}>
        <Slider
          min={0}
          max={100}
          step={1}
          suffix="%"
          value={crop.y}
          onChange={(val) => setCropPercents(crop.zoom, crop.x, val)}
        />
      </Field>

      <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {t('tools.id_photo.framing.drag_hint')}
      </p>
    </div>
  )
}
