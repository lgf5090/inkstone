import { useRef } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { buildCssGradient } from '@shared/tools/color/oklab'
import type { GradientColorStop, GradientConfig, GradientType } from '@shared/tools/color/types'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { t } from '../../../../lib/i18n'
import { useColorStudioStore } from '../store'

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

  const sortedStops = [...config.stops].sort((a, b) => a.offset - b.offset)
  const activeStop = config.stops.find((s) => s.id === activeStopId) || sortedStops[0]

  const handleTrackClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const percent = Math.min(100, Math.max(0, Math.round((clickX / rect.width) * 100)))

    // Generate unique ID
    const newId = `stop_${Date.now()}`
    const newStop: GradientColorStop = {
      id: newId,
      color: currentHex,
      offset: percent,
    }

    onChange({
      ...config,
      stops: [...config.stops, newStop],
    })
    onSelectStop(newId)
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
    if (config.stops.length <= 2) return // Keep at least 2 stops
    const updated = config.stops.filter((s) => s.id !== id)
    onChange({ ...config, stops: updated })
    const nextActive = updated[0]?.id || ''
    onSelectStop(nextActive)
  }

  const handleAddStop = () => {
    const newId = `stop_${Date.now()}`
    const offset = Math.min(100, (sortedStops[sortedStops.length - 1]?.offset || 50) + 10)
    onChange({
      ...config,
      stops: [...config.stops, { id: newId, color: currentHex, offset }],
    })
    onSelectStop(newId)
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
            className="h-7 w-full cursor-pointer rounded-full border border-[var(--border-subtle)] shadow-inner transition-transform block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]"
            style={{ backgroundImage: linearCss }}
          />

          {/* Draggable Stop Markers */}
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
                className={`absolute top-0 flex flex-col items-center -translate-x-1/2 transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] ${
                  isSelected ? 'z-20 scale-110' : 'z-10 hover:scale-105'
                }`}
                style={{ left: `${stop.offset}%` }}
                aria-label={`Color stop at ${stop.offset}%: ${stop.color}`}
              >
                <div
                  className={`h-7 w-4 rounded-full border-2 shadow-md ${
                    isSelected ? 'border-white ring-2 ring-[var(--brand-primary)]' : 'border-white/80'
                  }`}
                  style={{ backgroundColor: stop.color }}
                />
                <span
                  className={`mt-1 font-mono text-[10px] font-semibold px-1 rounded-sm ${
                    isSelected
                      ? 'bg-[var(--brand-primary)] text-white'
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
              <input
                type="text"
                value={activeStop.color}
                onChange={(e) => handleStopColorChange(activeStop.id, e.target.value)}
                className="w-24 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 font-mono text-[length:var(--text-12)] uppercase text-[var(--text-primary)]"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleStopColorChange(activeStop.id, currentHex)}
              >
                {t('tools.color.gradient.set_current_hex')}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('tools.color.gradient.offset')}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={activeStop.offset}
                onChange={(e) => handleStopOffsetChange(activeStop.id, Number(e.target.value))}
                className="h-1.5 w-24 cursor-pointer rounded-lg bg-[var(--border-subtle)] accent-[var(--brand-primary)]"
              />
              <span className="w-8 font-mono text-[length:var(--text-12)] text-[var(--text-primary)]">
                {activeStop.offset}%
              </span>
            </div>

            <div className="flex items-center gap-1.5 border-l border-[var(--border-subtle)] pl-3">
              <Tooltip label={t('tools.color.gradient.add_stop_label')}>
                <IconButton size="sm" label={t('tools.color.gradient.add_stop_label')} onClick={handleAddStop}>
                  <Plus size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label={t('tools.color.gradient.remove_stop_label')}>
                <IconButton
                  size="sm"
                  label={t('tools.color.gradient.remove_stop_label')}
                  disabled={config.stops.length <= 2}
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
                    ? 'bg-[var(--brand-primary)] text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {type}
              </button>
            ))}
          </div>

          {config.type !== 'radial' && (
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={360}
                value={config.angle}
                onChange={(e) => onChange({ ...config, angle: Number(e.target.value) })}
                className="h-1.5 w-20 cursor-pointer rounded-lg bg-[var(--border-subtle)] accent-[var(--brand-primary)]"
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
              className="h-4 w-4 rounded border-[var(--border-subtle)] text-[var(--brand-primary)] accent-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            />
            {t('tools.color.gradient.oklab_switch')}
          </label>
        </div>
      </div>
    </div>
  )
}
