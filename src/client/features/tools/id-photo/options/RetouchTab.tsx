import { RotateCcw } from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { Field, Slider } from '../../../../components/form'
import { Button } from '../../../../components/primitives'
import { useIdPhotoStore } from '../store'

export function RetouchTab() {
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const setAdjustOptions = useIdPhotoStore((s) => s.setAdjustOptions)

  const handleReset = () => {
    setAdjustOptions({
      brightness: 0,
      contrast: 0,
      whitening: 0,
      smoothness: 0,
      sharpness: 0,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between pb-1 border-b border-[var(--border-subtle)]">
        <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('tools.id_photo.common.retouch_params')}
        </span>
        <Button size="sm" variant="ghost" onClick={handleReset}>
          <RotateCcw size={12} className="mr-1" />
          <span>{t('tools.id_photo.retouch.reset')}</span>
        </Button>
      </div>

      <Field label={t('tools.id_photo.retouch.brightness')}>
        <div className="flex items-center gap-3 pt-1">
          <Slider
            min={-50}
            max={50}
            step={1}
            value={adjustOptions.brightness}
            onChange={(val) => setAdjustOptions({ brightness: val })}
            className="flex-1"
          />
          <span className="w-8 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {adjustOptions.brightness > 0 ? `+${adjustOptions.brightness}` : adjustOptions.brightness}
          </span>
        </div>
      </Field>

      <Field label={t('tools.id_photo.retouch.contrast')}>
        <div className="flex items-center gap-3 pt-1">
          <Slider
            min={-50}
            max={50}
            step={1}
            value={adjustOptions.contrast}
            onChange={(val) => setAdjustOptions({ contrast: val })}
            className="flex-1"
          />
          <span className="w-8 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {adjustOptions.contrast > 0 ? `+${adjustOptions.contrast}` : adjustOptions.contrast}
          </span>
        </div>
      </Field>

      <Field label={t('tools.id_photo.retouch.whitening')}>
        <div className="flex items-center gap-3 pt-1">
          <Slider
            min={0}
            max={100}
            step={1}
            value={adjustOptions.whitening}
            onChange={(val) => setAdjustOptions({ whitening: val })}
            className="flex-1"
          />
          <span className="w-8 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {adjustOptions.whitening}
          </span>
        </div>
      </Field>

      <Field label={t('tools.id_photo.retouch.smoothness')}>
        <div className="flex items-center gap-3 pt-1">
          <Slider
            min={0}
            max={100}
            step={1}
            value={adjustOptions.smoothness}
            onChange={(val) => setAdjustOptions({ smoothness: val })}
            className="flex-1"
          />
          <span className="w-8 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {adjustOptions.smoothness}
          </span>
        </div>
      </Field>
    </div>
  )
}
