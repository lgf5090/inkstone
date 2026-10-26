import React from 'react'
import { Dices, RotateCcw, Sparkles } from 'lucide-react'
import { t } from '../../../../lib/i18n'
import { useQrCodeStore } from '../store'
import type {
  QrCanvasEffect,
  QrEffectTiming,
  QrMarginNoiseSpace,
  QrRenderPointsType,
} from '../../../../../shared/tools/qrcode/types'

export const AiEffectsTab: React.FC = () => {
  const { options, setToolkitOptions } = useQrCodeStore()
  const tk = options.toolkitOptions ?? {}

  const effect = tk.effect ?? 'none'
  const effectTiming = tk.effectTiming ?? 'before'
  const crystalizeRadius = tk.effectCrystalizeRadius ?? 8
  const liquidifyDistortRadius = tk.effectLiquidifyDistortRadius ?? 0
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

  const randomizeSeed = () => {
    setToolkitOptions({ seed: Math.floor(Math.random() * 1000000) })
  }

  return (
    <div className="space-y-6">
      {/* 1. Organic Canvas Effects */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-primary-500" />
          <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {t('tools.qrcode.ai.effects_title')}
          </h4>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 'none', labelKey: 'tools.qrcode.ai.effect_none' },
            { id: 'crystalize', labelKey: 'tools.qrcode.ai.effect_crystalize' },
            { id: 'liquidify', labelKey: 'tools.qrcode.ai.effect_liquidify' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() =>
                setToolkitOptions({
                  effect: item.id as QrCanvasEffect,
                  enabled: item.id !== 'none' || Boolean(tk.marginNoise),
                })
              }
              className={`flex items-center justify-center rounded-lg border py-2 text-xs font-medium transition-colors ${
                effect === item.id
                  ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-400 dark:bg-primary-950/40 dark:text-primary-300'
                  : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300'
              }`}
            >
              {t(item.labelKey as any)}
            </button>
          ))}
        </div>

        {effect === 'crystalize' && (
          <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50/50 p-3 dark:border-neutral-800 dark:bg-neutral-900/50">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-600 dark:text-neutral-400">
                {t('tools.qrcode.ai.crystalize_radius')}
              </span>
              <span className="font-mono text-neutral-800 dark:text-neutral-200">{`${crystalizeRadius}px`}</span>
            </div>
            <input
              type="range"
              min={1}
              max={25}
              step={0.5}
              value={crystalizeRadius}
              onChange={(e) => setToolkitOptions({ effectCrystalizeRadius: Number(e.target.value) })}
              className="h-1.5 w-full cursor-pointer accent-primary-600"
            />
          </div>
        )}

        {effect === 'liquidify' && (
          <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50/50 p-3 dark:border-neutral-800 dark:bg-neutral-900/50">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-600 dark:text-neutral-400">
                  {t('tools.qrcode.ai.liquidify_blur')}
                </span>
                <span className="font-mono text-neutral-800 dark:text-neutral-200">{`${liquidifyRadius}px`}</span>
              </div>
              <input
                type="range"
                min={1}
                max={30}
                step={1}
                value={liquidifyRadius}
                onChange={(e) => setToolkitOptions({ effectLiquidifyRadius: Number(e.target.value) })}
                className="h-1.5 w-full cursor-pointer accent-primary-600"
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-600 dark:text-neutral-400">
                  {t('tools.qrcode.ai.liquidify_distort')}
                </span>
                <span className="font-mono text-neutral-800 dark:text-neutral-200">{`${liquidifyDistortRadius}px`}</span>
              </div>
              <input
                type="range"
                min={0}
                max={30}
                step={1}
                value={liquidifyDistortRadius}
                onChange={(e) => setToolkitOptions({ effectLiquidifyDistortRadius: Number(e.target.value) })}
                className="h-1.5 w-full cursor-pointer accent-primary-600"
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-600 dark:text-neutral-400">
                  {t('tools.qrcode.ai.liquidify_threshold')}
                </span>
                <span className="font-mono text-neutral-800 dark:text-neutral-200">{`${liquidifyThreshold} / 255`}</span>
              </div>
              <input
                type="range"
                min={10}
                max={240}
                step={2}
                value={liquidifyThreshold}
                onChange={(e) => setToolkitOptions({ effectLiquidifyThreshold: Number(e.target.value) })}
                className="h-1.5 w-full cursor-pointer accent-primary-600"
              />
            </div>
          </div>
        )}

        {effect !== 'none' && (
          <div className="flex items-center justify-between pt-1 text-xs">
            <span className="text-neutral-600 dark:text-neutral-400">
              {t('tools.qrcode.ai.effect_timing')}
            </span>
            <div className="flex gap-1.5">
              {(['before', 'after'] as QrEffectTiming[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setToolkitOptions({ effectTiming: mode })}
                  className={`rounded px-2.5 py-1 text-xs ${
                    effectTiming === mode
                      ? 'bg-neutral-800 text-white dark:bg-neutral-100 dark:text-neutral-900'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400'
                  }`}
                >
                  {t(`tools.qrcode.ai.timing_${mode}` as any)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 2. 3D Perspective & Rotation */}
      <div className="space-y-3 pt-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('tools.qrcode.ai.transform_title')}
        </h4>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-600 dark:text-neutral-400">{t('tools.qrcode.ai.perspective_x')}</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-neutral-800 dark:text-neutral-200">{pX.toFixed(2)}</span>
              {pX !== 0 && (
                <button
                  type="button"
                  onClick={() => setToolkitOptions({ transformPerspectiveX: 0 })}
                  className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                  title={t('tools.qrcode.ai.reset_val')}
                >
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          </div>
          <input
            type="range"
            min={-0.45}
            max={0.45}
            step={0.01}
            value={pX}
            onChange={(e) => setToolkitOptions({ transformPerspectiveX: Number(e.target.value) })}
            className="h-1.5 w-full cursor-pointer accent-primary-600"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-600 dark:text-neutral-400">{t('tools.qrcode.ai.perspective_y')}</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-neutral-800 dark:text-neutral-200">{pY.toFixed(2)}</span>
              {pY !== 0 && (
                <button
                  type="button"
                  onClick={() => setToolkitOptions({ transformPerspectiveY: 0 })}
                  className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                  title={t('tools.qrcode.ai.reset_val')}
                >
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          </div>
          <input
            type="range"
            min={-0.45}
            max={0.45}
            step={0.01}
            value={pY}
            onChange={(e) => setToolkitOptions({ transformPerspectiveY: Number(e.target.value) })}
            className="h-1.5 w-full cursor-pointer accent-primary-600"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-600 dark:text-neutral-400">{t('tools.qrcode.ai.scale')}</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-neutral-800 dark:text-neutral-200">{`${scale.toFixed(2)}x`}</span>
              {scale !== 1 && (
                <button
                  type="button"
                  onClick={() => setToolkitOptions({ transformScale: 1 })}
                  className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                  title={t('tools.qrcode.ai.reset_val')}
                >
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          </div>
          <input
            type="range"
            min={0.5}
            max={1.8}
            step={0.02}
            value={scale}
            onChange={(e) => setToolkitOptions({ transformScale: Number(e.target.value) })}
            className="h-1.5 w-full cursor-pointer accent-primary-600"
          />
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-neutral-600 dark:text-neutral-400">{t('tools.qrcode.ai.rotate')}</span>
          <div className="flex gap-1.5">
            {([0, 90, 180, 270] as const).map((deg) => (
              <button
                key={deg}
                type="button"
                onClick={() => setToolkitOptions({ rotate: deg })}
                className={`rounded px-2.5 py-1 text-xs font-mono ${
                  rotate === deg
                    ? 'bg-primary-600 text-white'
                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300'
                }`}
              >
                {`${deg}°`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 3. Margin Noise for AI QR */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {t('tools.qrcode.ai.noise_title')}
          </h4>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={marginNoise}
              onChange={(e) => setToolkitOptions({ marginNoise: e.target.checked, enabled: true })}
              className="rounded accent-primary-600"
            />
            <span>{t('tools.qrcode.ai.noise_enable')}</span>
          </label>
        </div>

        {marginNoise && (
          <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50/50 p-3 dark:border-neutral-800 dark:bg-neutral-900/50">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-600 dark:text-neutral-400">{t('tools.qrcode.ai.noise_rate')}</span>
                <span className="font-mono text-neutral-800 dark:text-neutral-200">
                  {`${Math.round(marginNoiseRate * 100)}%`}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={marginNoiseRate}
                onChange={(e) => setToolkitOptions({ marginNoiseRate: Number(e.target.value) })}
                className="h-1.5 w-full cursor-pointer accent-primary-600"
              />
            </div>

            <div className="space-y-1.5">
              <span className="text-xs text-neutral-600 dark:text-neutral-400">
                {t('tools.qrcode.ai.noise_space')}
              </span>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { id: 'marker', label: 'Marker' },
                  { id: 'full', label: 'Full' },
                  { id: 'minimal', label: 'Minimal' },
                  { id: 'extreme', label: 'Extreme' },
                  { id: 'none', label: 'None' },
                ].map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setToolkitOptions({ marginNoiseSpace: s.id as QrMarginNoiseSpace })}
                    className={`rounded py-1 text-xs ${
                      marginNoiseSpace === s.id
                        ? 'bg-neutral-800 text-white dark:bg-neutral-100 dark:text-neutral-900'
                        : 'bg-white text-neutral-600 border border-neutral-200 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 4. Advanced Parameters & Seed */}
      <div className="space-y-3 pt-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t('tools.qrcode.ai.advanced_params')}
        </h4>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <span className="text-xs text-neutral-600 dark:text-neutral-400">{t('tools.qrcode.ai.mask_pattern')}</span>
            <select
              value={maskPattern}
              onChange={(e) => setToolkitOptions({ maskPattern: Number(e.target.value) })}
              className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
            >
              <option value={-1}>{t('tools.qrcode.ai.mask_auto')}</option>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((num) => (
                <option key={num} value={num}>
                  {`${t('tools.qrcode.ai.pattern_label')} ${num}`}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <span className="text-xs text-neutral-600 dark:text-neutral-400">{t('tools.qrcode.ai.render_type')}</span>
            <select
              value={renderPointsType}
              onChange={(e) => setToolkitOptions({ renderPointsType: e.target.value as QrRenderPointsType })}
              className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
            >
              <option value="all">{t('tools.qrcode.ai.render_all')}</option>
              <option value="data">{t('tools.qrcode.ai.render_data')}</option>
              <option value="function">{t('tools.qrcode.ai.render_function')}</option>
              <option value="guide">{t('tools.qrcode.ai.render_guide')}</option>
              <option value="marker">{t('tools.qrcode.ai.render_marker')}</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={boostECC}
              onChange={(e) => setToolkitOptions({ boostECC: e.target.checked })}
              className="rounded accent-primary-600"
            />
            <span>{t('tools.qrcode.ai.boost_ecc')}</span>
          </label>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-neutral-500 font-mono">{`${t('tools.qrcode.ai.seed_label')}: ${seed}`}</span>
            <button
              type="button"
              onClick={randomizeSeed}
              className="flex items-center gap-1 rounded border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              title={t('tools.qrcode.ai.randomize_seed')}
            >
              <Dices size={12} />
              <span>{t('tools.qrcode.ai.randomize')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
