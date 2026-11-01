import { useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { buildCssGradient } from '@shared/tools/color/oklab'
import { COLOR_PALETTE_MAX_COLORS } from '@shared/tools/color/contract'
import type { GradientColorStop, GradientConfig, GradientType } from '@shared/tools/color/types'
import { Button, IconButton } from '../../../../components/primitives'
import { Input, Slider } from '../../../../components/form'
import { Tooltip } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { useColorStudioStore } from '../store'
import { parseHexInput } from '../lib/hex-input'

/** A gradient needs two ends; the ceiling is what the palette API will store. */
const MIN_STOPS = 2

export interface GradientBarControllerProps {
  config: GradientConfig
  onChange: (config: GradientConfig) => void
  activeStopId: string
  onSelectStop: (id: string) => void
}

export function GradientBarController({
  config,
  onChange,
  activeStopId,
  onSelectStop,
}: GradientBarControllerProps) {
  const trackRef = useRef<HTMLButtonElement | null>(null)
  const currentHex = useColorStudioStore((s) => s.currentHex)
  // The hex box keeps what the reader typed: writing an unfinished value into the stop would repaint the
  // gradient with black, and normalizing it silently would accept anything.
  const [hexDraft, setHexDraft] = useState<{ id: string; text: string } | null>(null)

  const sortedStops = [...config.stops].sort((a, b) => a.offset - b.offset)
  const activeStop = config.stops.find((s) => s.id === activeStopId) || sortedStops[0]
  const draftText =
    hexDraft && activeStop && hexDraft.id === activeStop.id ? hexDraft.text : (activeStop?.color ?? '')
  const draftParsed = parseHexInput(draftText)
  const atMaxStops = config.stops.length >= COLOR_PALETTE_MAX_COLORS

  const handleTrackClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const percent = Math.min(100, Math.max(0, Math.round((clickX / rect.width) * 100)))

    // A click that lands on an existing stop selects it. Without this, nudging a stop by clicking beside it
    // stacked a second stop on the same offset, and the only way to move one was the offset slider.
    const hit = config.stops.find((stop) => Math.abs(stop.offset - percent) <= 1)
    if (hit) {
      onSelectStop(hit.id)
      return
    }

    if (config.stops.length >= COLOR_PALETTE_MAX_COLORS) return

    const newStop: GradientColorStop = {
      id: crypto.randomUUID(),
      color: currentHex,
      offset: percent,
    }

    onChange({
      ...config,
      stops: [...config.stops, newStop],
    })
    onSelectStop(newStop.id)
  }

  const handleStopOffsetChange = (id: string, offset: number) => {
    const updated = config.stops.map((s) => (s.id === id ? { ...s, offset } : s))
    onChange({ ...config, stops: updated })
  }

  const handleStopColorChange = (id: string, color: string) => {
    const updated = config.stops.map((s) => (s.id === id ? { ...s, color } : s))
    onChange({ ...config, stops: updated })
  }

  const handleRemoveStop = (id: string) => {
    if (config.stops.length <= MIN_STOPS) return
    const index = sortedStops.findIndex((stop) => stop.id === id)
    const updated = config.stops.filter((stop) => stop.id !== id)
    onChange({ ...config, stops: updated })
    // Keep the selection next to where the reader was working instead of jumping to the first stop.
    const next = sortedStops[index + 1]?.id ?? sortedStops[index - 1]?.id ?? updated[0]?.id ?? ''
    onSelectStop(next)
  }

  const handleAddStop = () => {
    if (config.stops.length >= COLOR_PALETTE_MAX_COLORS) return
    const id = crypto.randomUUID()
    const last = sortedStops[sortedStops.length - 1]
    const offset = Math.min(100, (last?.offset ?? 50) + 10)
    onChange({
      ...config,
      stops: [...config.stops, { id, color: currentHex, offset }],
    })
    onSelectStop(id)
  }

  const linearCss = buildCssGradient({
    ...config,
    type: 'linear',
    angle: 90,
  })

  return (
    <div className="flex flex-col space-y-4">
      {/* Interactive track with stop markers */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[length:var(--text-12)] text-[var(--text-secondary)]">
          <span>{t('tools.color.gradient.stops_title')}</span>
          <span>{t('tools.color.gradient.click_track_hint')}</span>
        </div>

        <div className="relative pt-2 pb-6">
          {/* Gradient Track */}
          <button
            type="button"
            ref={trackRef}
            onClick={handleTrackClick}
            aria-label={t('tools.color.gradient.click_track_hint')}
            className="h-7 w-full cursor-pointer rounded-full border border-[var(--border-subtle)] shadow-inner transition-transform block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{ backgroundImage: linearCss }}
          />

          {/* Stop markers, selected by click and moved with the offset slider */}
          {config.stops.map((stop) => {
            const isSelected = stop.id === activeStop?.id
            return (
              <button
                key={stop.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectStop(stop.id)
                }}
                className={`absolute top-0 flex flex-col items-center -translate-x-1/2 transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  isSelected ? 'z-20 scale-110' : 'z-10 hover:scale-105'
                }`}
                style={{ left: `${stop.offset}%` }}
                aria-label={t('tools.color.gradient.stop_at', { offset: stop.offset, hex: stop.color })}
              >
                <div
                  className={`h-7 w-4 rounded-full border-2 shadow-md ${
                    isSelected ? 'border-white ring-2 ring-[var(--accent)]' : 'border-white/80'
                  }`}
                  style={{ backgroundColor: stop.color }}
                />
                <span
                  className={`mt-1 font-mono text-[length:var(--text-10)] font-semibold px-1 rounded-sm ${
                    isSelected
                      ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                      : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-subtle)]'
                  }`}
                >
                  {stop.offset}%
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Selected stop inspector */}
      {activeStop && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-3">
          <div className="flex items-center gap-3">
            <div
              className="h-8 w-8 rounded-[var(--radius-sm)] border border-black/10 shadow-xs"
              style={{ backgroundColor: activeStop.color }}
            />
            <div className="flex items-center gap-2">
              <Input
                value={draftText}
                onChange={(e) => {
                  const text = e.target.value
                  setHexDraft({ id: activeStop.id, text })
                  const parsed = parseHexInput(text)
                  if (parsed) handleStopColorChange(activeStop.id, parsed)
                }}
                aria-label={t('tools.color.gradient.stop_hex_label')}
                aria-invalid={draftParsed === null || undefined}
                maxLength={7}
                className="w-24 font-mono text-[length:var(--text-12)] uppercase"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setHexDraft(null)
                  handleStopColorChange(activeStop.id, currentHex)
                }}
              >
                {t('tools.color.gradient.set_current_hex')}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('tools.color.gradient.offset')}</span>
              <Slider
                value={activeStop.offset}
                min={0}
                max={100}
                onChange={(offset) => handleStopOffsetChange(activeStop.id, offset)}
                label={t('tools.color.gradient.offset')}
                className="w-24"
              />
              <span className="w-8 font-mono text-[length:var(--text-12)] text-[var(--text-primary)]">
                {activeStop.offset}%
              </span>
            </div>

            <div className="flex items-center gap-1.5 border-l border-[var(--border-subtle)] pl-3">
              <Tooltip
                label={atMaxStops ? t('tools.color.gradient.stops_max', { max: COLOR_PALETTE_MAX_COLORS }) : t('tools.color.gradient.add_stop_label')}
              >
                <IconButton
                  size="sm"
                  label={t('tools.color.gradient.add_stop_label')}
                  disabled={atMaxStops}
                  onClick={handleAddStop}
                >
                  <Plus size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label={t('tools.color.gradient.remove_stop_label')}>
                <IconButton
                  size="sm"
                  label={t('tools.color.gradient.remove_stop_label')}
                  disabled={config.stops.length <= MIN_STOPS}
                  onClick={() => handleRemoveStop(activeStop.id)}
                >
                  <Trash2 size={14} />
                </IconButton>
              </Tooltip>
            </div>
          </div>
        </div>
      )}

      {/* Global Type & OKLab Mode Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
        {/* Type & Angle */}
        <div className="flex items-center gap-3">
          <div className="flex rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-0.5 bg-[var(--bg-surface)]">
            {(['linear', 'radial', 'conic'] as GradientType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => onChange({ ...config, type })}
                className={`px-3 py-1 text-[length:var(--text-12)] font-medium capitalize rounded-[var(--radius-sm)] transition-colors ${
                  config.type === type
                    ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {t(`tools.color.gradient.type.${type}`)}
              </button>
            ))}
          </div>

          {config.type !== 'radial' && (
            <div className="flex items-center gap-2">
              <Slider
                value={config.angle}
                min={0}
                max={360}
                onChange={(angle) => onChange({ ...config, angle })}
                label={t('tools.color.gradient.angle_label')}
                className="w-20"
              />
              <span className="font-mono text-[length:var(--text-12)] text-[var(--text-primary)]">
                {config.angle}°
              </span>
            </div>
          )}
        </div>

        {/* OKLab perceptual interpolation switch */}
        <div className="flex items-center justify-end gap-2">
          <label className="flex items-center gap-2 cursor-pointer text-[length:var(--text-13)] font-medium text-[var(--text-primary)] select-none">
            <input
              type="checkbox"
              checked={!!config.useOklabInterpolation}
              onChange={(e) => onChange({ ...config, useOklabInterpolation: e.target.checked })}
              className="h-4 w-4 rounded border-[var(--border-subtle)] text-[var(--accent)] accent-[var(--accent)] focus:ring-[var(--accent)]"
            />
            {t('tools.color.gradient.oklab_switch')}
          </label>
        </div>
      </div>
    </div>
  )
}
