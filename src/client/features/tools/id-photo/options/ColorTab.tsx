import { ID_PHOTO_BG_PRESETS } from '@shared/tools/id-photo/presets'
import { parseHexColor } from '../engine/background-matting'
import { Check } from 'lucide-react'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { ColorWellField } from '../../../../components/color-field'
import { Field, Slider, Switch } from '../../../../components/form'
import { useIdPhotoStore } from '../store'
import { specLabel } from '../spec-label'

function contrastSafeInk(hex: string): string {
  const { r, g, b } = parseHexColor(hex)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#000000' : '#ffffff'
}

export function ColorTab() {
  const adjustOptions = useIdPhotoStore((s) => s.adjustOptions)
  const setAdjustOptions = useIdPhotoStore((s) => s.setAdjustOptions)
  const setBgColor = useIdPhotoStore((s) => s.setBgColor)

  const getActiveSpec = useIdPhotoStore((s) => s.getActiveSpec)
  const isGradient = adjustOptions.bgType === 'gradient'
  const recommendedColors = [...getActiveSpec().recommendedBgColors]

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
                  className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--border-strong)] shadow-xs"
                >
                  {isSelected && (
                    <Check
                      size={12}
                      strokeWidth={3}
                      className="text-[var(--accent-contrast)]"
                      style={{ color: contrastSafeInk(preset.color) }}
                    />
                  )}
                </div>
                <span className="min-w-0 truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                  {t(preset.nameKey)}
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

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[140px] flex-1">
            <ColorWellField
              label={isGradient ? t('tools.id_photo.common.top_label') : t('tools.id_photo.common.color_label')}
              value={adjustOptions.bgColor}
              onChange={(value) => setAdjustOptions({ bgColor: value })}
            />
          </div>

          {isGradient && (
            <div className="min-w-[140px] flex-1">
              <ColorWellField
                label={t('tools.id_photo.common.bottom_label')}
                value={adjustOptions.bgGradientEndColor ?? '#1E3A8A'}
                onChange={(value) => setAdjustOptions({ bgGradientEndColor: value })}
              />
            </div>
          )}
        </div>

        {recommendedColors.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.id_photo.color.recommend', { spec: specLabel(getActiveSpec()) })}
            </span>
            {recommendedColors.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={adjustOptions.bgColor.toLowerCase() === color.toLowerCase()}
                onClick={() => setBgColor(color, false)}
                style={{ backgroundColor: color }}
                className="h-6 w-6 rounded-full border border-[var(--border-strong)] transition-transform hover:scale-110"
              />
            ))}
          </div>
        )}
      </div>

      {/* Feathering Slider */}
      <Field
        label={t('tools.id_photo.color.feathering_label')}
        hint={t('tools.id_photo.color.feathering_hint')}
      >
        <Slider
          min={0}
          max={50}
          step={1}
          value={adjustOptions.feathering}
          onChange={(val) => setAdjustOptions({ feathering: val })}
        />
      </Field>
    </div>
  )
}
