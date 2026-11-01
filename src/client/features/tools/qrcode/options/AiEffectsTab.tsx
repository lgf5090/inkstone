import { Dices, RotateCcw, Sparkles } from 'lucide-react'
import { t, type MessageKey } from '../../../../lib/i18n'
import { useQrCodeStore } from '../store'
import { Field, Segmented, Select, SettingRow, Slider, Switch } from '../../../../components/form'
import { IconButton, SectionLabel } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import type {
  QrCanvasEffect,
  QrMarginNoiseSpace,
  QrRenderPointsType,
} from '../../../../../shared/tools/qrcode/types'

const EFFECT_OPTIONS: ReadonlyArray<{ value: QrCanvasEffect; labelKey: MessageKey }> = [
  { value: 'none', labelKey: 'tools.qrcode.ai.effect_none' },
  { value: 'crystalize', labelKey: 'tools.qrcode.ai.effect_crystalize' },
  { value: 'liquidify', labelKey: 'tools.qrcode.ai.effect_liquidify' },
]

const NOISE_SPACE_OPTIONS: ReadonlyArray<{ value: QrMarginNoiseSpace; labelKey: MessageKey }> = [
  { value: 'marker', labelKey: 'tools.qrcode.ai.space_marker' },
  { value: 'full', labelKey: 'tools.qrcode.ai.space_full' },
  { value: 'minimal', labelKey: 'tools.qrcode.ai.space_minimal' },
  { value: 'extreme', labelKey: 'tools.qrcode.ai.space_extreme' },
  { value: 'none', labelKey: 'tools.qrcode.ai.space_none' },
]

const RENDER_TYPE_OPTIONS: ReadonlyArray<{ value: QrRenderPointsType; labelKey: MessageKey }> = [
  { value: 'all', labelKey: 'tools.qrcode.ai.render_all' },
  { value: 'data', labelKey: 'tools.qrcode.ai.render_data' },
  { value: 'function', labelKey: 'tools.qrcode.ai.render_function' },
  { value: 'guide', labelKey: 'tools.qrcode.ai.render_guide' },
  { value: 'marker', labelKey: 'tools.qrcode.ai.render_marker' },
]

const ROTATE_DEGREES = [0, 90, 180, 270] as const

const ROTATE_OPTIONS = ROTATE_DEGREES.map((deg) => ({ value: String(deg), label: `${deg}°` }))

export function AiEffectsTab() {
  const tk = useQrCodeStore((s) => s.options.toolkitOptions) ?? {}
  const setToolkitOptions = useQrCodeStore((s) => s.setToolkitOptions)

  const effect: QrCanvasEffect = tk.effect ?? 'none'
  const crystalizeRadius = tk.effectCrystalizeRadius ?? 8
  const liquidifyRadius = tk.effectLiquidifyRadius ?? 6
  const liquidifyThreshold = tk.effectLiquidifyThreshold ?? 128
  const pX = tk.transformPerspectiveX ?? 0
  const pY = tk.transformPerspectiveY ?? 0
  const scale = tk.transformScale ?? 1
  const rotate = tk.rotate ?? 0
  const marginNoise = Boolean(tk.marginNoise)
  const marginNoiseRate = tk.marginNoiseRate ?? 0.5
  const marginNoiseSpace: QrMarginNoiseSpace = tk.marginNoiseSpace ?? 'marker'
  const maskPattern = tk.maskPattern ?? -1
  const boostECC = Boolean(tk.boostECC)
  const renderPointsType: QrRenderPointsType = tk.renderPointsType ?? 'all'
  const seed = tk.seed ?? 12345

  const setEffect = (next: QrCanvasEffect) =>
    setToolkitOptions({ effect: next, enabled: next !== 'none' || Boolean(tk.marginNoise) })

  const setNoise = (checked: boolean) => setToolkitOptions({ marginNoise: checked, enabled: checked })

  /** One affordance per knob that has a non-default value, rather than a reset per row. */
  const ResetButton = ({ onReset }: { onReset: () => void }) => (
    <Tooltip label={t('tools.qrcode.ai.reset_val')}>
      <IconButton size="sm" label={t('tools.qrcode.ai.reset_val')} onClick={onReset}>
        <RotateCcw size={12} />
      </IconButton>
    </Tooltip>
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-[var(--accent)]" />
          <SectionLabel className="px-0">{t('tools.qrcode.ai.effects_title')}</SectionLabel>
        </div>
        <Segmented<QrCanvasEffect>
          value={effect}
          onChange={setEffect}
          size="sm"
          options={EFFECT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        />

        {effect === 'crystalize' && (
          <Field label={t('tools.qrcode.ai.crystalize_radius')}>
            <Slider
              value={crystalizeRadius}
              min={1}
              max={25}
              step={0.5}
              suffix="px"
              onChange={(val) => setToolkitOptions({ effectCrystalizeRadius: val })}
            />
          </Field>
        )}

        {effect === 'liquidify' && (
          <div className="flex flex-col gap-3">
            <Field label={t('tools.qrcode.ai.liquidify_blur')}>
              <Slider
                value={liquidifyRadius}
                min={1}
                max={30}
                suffix="px"
                onChange={(val) => setToolkitOptions({ effectLiquidifyRadius: val })}
              />
            </Field>
            <Field label={t('tools.qrcode.ai.liquidify_threshold')}>
              <Slider
                value={liquidifyThreshold}
                min={10}
                max={240}
                step={2}
                onChange={(val) => setToolkitOptions({ effectLiquidifyThreshold: val })}
              />
            </Field>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel className="px-0">{t('tools.qrcode.ai.transform_title')}</SectionLabel>

        <div className="flex items-end gap-2">
          <Field label={t('tools.qrcode.ai.perspective_x')} className="min-w-0 flex-1">
            <Slider
              value={pX}
              min={-0.45}
              max={0.45}
              step={0.01}
              onChange={(val) => setToolkitOptions({ transformPerspectiveX: val })}
            />
          </Field>
          {pX !== 0 && (
            <ResetButton onReset={() => setToolkitOptions({ transformPerspectiveX: 0 })} />
          )}
        </div>

        <div className="flex items-end gap-2">
          <Field label={t('tools.qrcode.ai.perspective_y')} className="min-w-0 flex-1">
            <Slider
              value={pY}
              min={-0.45}
              max={0.45}
              step={0.01}
              onChange={(val) => setToolkitOptions({ transformPerspectiveY: val })}
            />
          </Field>
          {pY !== 0 && (
            <ResetButton onReset={() => setToolkitOptions({ transformPerspectiveY: 0 })} />
          )}
        </div>

        <div className="flex items-end gap-2">
          <Field label={t('tools.qrcode.ai.scale')} className="min-w-0 flex-1">
            <Slider
              value={scale}
              min={0.5}
              max={1.8}
              step={0.02}
              suffix="x"
              onChange={(val) => setToolkitOptions({ transformScale: val })}
            />
          </Field>
          {scale !== 1 && <ResetButton onReset={() => setToolkitOptions({ transformScale: 1 })} />}
        </div>

        <Field label={t('tools.qrcode.ai.rotate')}>
          <Segmented
            value={String(rotate)}
            size="sm"
            onChange={(val) => setToolkitOptions({ rotate: Number(val) as 0 | 90 | 180 | 270 })}
            options={ROTATE_OPTIONS}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel className="px-0">{t('tools.qrcode.ai.noise_title')}</SectionLabel>
        <SettingRow title={t('tools.qrcode.ai.noise_enable')} controlId="qr-noise-enable">
          <Switch
            id="qr-noise-enable"
            checked={marginNoise}
            onChange={setNoise}
          />
        </SettingRow>

        {marginNoise && (
          <div className="flex flex-col gap-3">
            <Field label={t('tools.qrcode.ai.noise_rate')}>
              <Slider
                value={Math.round(marginNoiseRate * 100)}
                min={0}
                max={100}
                suffix="%"
                onChange={(val) => setToolkitOptions({ marginNoiseRate: val / 100 })}
              />
            </Field>
            <Field label={t('tools.qrcode.ai.noise_space')}>
              <Segmented<QrMarginNoiseSpace>
                value={marginNoiseSpace}
                size="sm"
                onChange={(space) => setToolkitOptions({ marginNoiseSpace: space })}
                options={NOISE_SPACE_OPTIONS.map((o) => ({
                  value: o.value,
                  label: t(o.labelKey),
                }))}
              />
            </Field>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-3">
        <SectionLabel className="px-0">{t('tools.qrcode.ai.advanced_params')}</SectionLabel>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('tools.qrcode.ai.mask_pattern')}>
            <Select
              value={String(maskPattern)}
              onChange={(e) => setToolkitOptions({ maskPattern: Number(e.target.value) })}
            >
              <option value={-1}>{t('tools.qrcode.ai.mask_auto')}</option>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((num) => (
                <option key={num} value={num}>
                  {`${t('tools.qrcode.ai.pattern_label')} ${num}`}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('tools.qrcode.ai.render_type')}>
            <Select
              value={renderPointsType}
              onChange={(e) =>
                setToolkitOptions({ renderPointsType: e.target.value as QrRenderPointsType })
              }
            >
              {RENDER_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <SettingRow title={t('tools.qrcode.ai.boost_ecc')} controlId="qr-boost-ecc">
          <Switch
            id="qr-boost-ecc"
            checked={boostECC}
            onChange={(checked) => setToolkitOptions({ boostECC: checked })}
          />
        </SettingRow>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {`${t('tools.qrcode.ai.seed_label')}: ${seed}`}
          </span>
          <Tooltip label={t('tools.qrcode.ai.randomize_seed')}>
            <IconButton
              size="sm"
              label={t('tools.qrcode.ai.randomize')}
              onClick={() => setToolkitOptions({ seed: Math.floor(Math.random() * 1_000_000) })}
            >
              <Dices size={13} />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
