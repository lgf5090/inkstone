import { ID_PHOTO_BG_PRESETS } from '@shared/tools/id-photo/presets'
import { Check } from 'lucide-react'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { Field, Slider, Switch } from '../../../../components/form'
import { useIdPhotoStore } from '../store'

export function ColorTab() {
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const setAdjustOptions = useIdPhotoStore((s) => s.setAdjustOptions)
  const setBgColor = useIdPhotoStore((s) => s.setBgColor)

  const isGradient = adjustOptions.bgType === 'gradient'

  return (
    <div className="flex flex-col gap-4">
      {/* Official Color Presets */}
      <div className="flex flex-col gap-2">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.id_photo.color.preset_title')}
        </label>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {ID_PHOTO_BG_PRESETS.map((preset) => {
            const isSelected =
              adjustOptions.bgColor.toLowerCase() === preset.color.toLowerCase() &&
              Boolean(preset.isGradient) === isGradient

            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => setBgColor(preset.color, preset.isGradient, preset.endColor)}
                className={cn(
                  'flex items-center gap-2 rounded-[var(--r-md)] border p-2 text-left',
                  'transition-[border-color,background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                  isSelected
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <div
                  style={{
                    background: preset.isGradient && preset.endColor
                      ? `linear-gradient(to bottom, ${preset.color}, ${preset.endColor})`
                      : preset.color,
                  }}
                  className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-black/10 dark:border-white/20 shadow-xs"
                >
                  {isSelected && (
                    <Check
                      size={12}
                      strokeWidth={3}
                      className={preset.color === '#ffffff' ? 'text-black' : 'text-white'}
                    />
                  )}
                </div>
                <span className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                  {t(preset.nameKey as any)}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Custom Color & Gradient Options */}
      <div className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
        <div className="flex items-center justify-between">
          <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.id_photo.color.gradient_toggle')}
          </label>
          <Switch
            checked={isGradient}
            onChange={(checked: boolean) =>
              setAdjustOptions({
                bgType: checked ? 'gradient' : 'solid',
                bgGradientEndColor: checked
                  ? adjustOptions.bgGradientEndColor ?? '#1E3A8A'
                  : undefined,
              })
            }
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="flex flex-1 items-center gap-2">
            <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
              {isGradient ? t('tools.id_photo.common.top_label') : t('tools.id_photo.common.color_label')}:
            </span>
            <input
              type="color"
              value={adjustOptions.bgColor}
              onChange={(e) => setAdjustOptions({ bgColor: e.target.value })}
              className="h-8 w-14 cursor-pointer rounded border border-[var(--border-subtle)] bg-transparent p-0.5"
            />
            <span className="font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
              {adjustOptions.bgColor}
            </span>
          </div>

          {isGradient && (
            <div className="flex flex-1 items-center gap-2">
              <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                {t('tools.id_photo.common.bottom_label')}:
              </span>
              <input
                type="color"
                value={adjustOptions.bgGradientEndColor ?? '#000000'}
                onChange={(e) => setAdjustOptions({ bgGradientEndColor: e.target.value })}
                className="h-8 w-14 cursor-pointer rounded border border-[var(--border-subtle)] bg-transparent p-0.5"
              />
              <span className="font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
                {adjustOptions.bgGradientEndColor}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Feathering Slider */}
      <Field
        label={t('tools.id_photo.color.feathering_label')}
        hint={t('tools.id_photo.color.feathering_hint')}
      >
        <div className="flex items-center gap-3 pt-1">
          <Slider
            min={0}
            max={50}
            step={1}
            value={adjustOptions.feathering}
            onChange={(val) => setAdjustOptions({ feathering: val })}
            className="flex-1"
          />
          <span className="w-8 text-right font-mono text-[length:var(--text-12)] text-[var(--text-secondary)]">
            {adjustOptions.feathering}
          </span>
        </div>
      </Field>
    </div>
  )
}
