import { useState } from 'react'
import type { QrGradient } from '../../../../../shared/tools/qrcode/types'
import { useQrCodeStore } from '../store'
import { ColorWheelTrigger } from '../../../../components/color-field'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'

const SOLID_COLORS = [
  '#e11d48',
  '#f43f5e',
  '#ea580c',
  '#0d9488',
  '#0284c7',
  '#2563eb',
  '#9333ea',
  '#7c3aed',
  '#475569',
]

const GRADIENT_PRESETS: readonly { id: string; gradient: QrGradient }[] = [
  {
    id: 'red-dark',
    gradient: {
      type: 'linear',
      rotation: 45,
      colorStops: [{ offset: 0, color: '#b91c1c' }, { offset: 1, color: '#450a0a' }],
    },
  },
  {
    id: 'rose-pink',
    gradient: {
      type: 'linear',
      rotation: 45,
      colorStops: [{ offset: 0, color: '#f43f5e' }, { offset: 1, color: '#e11d48' }],
    },
  },
  {
    id: 'orange-sunset',
    gradient: {
      type: 'linear',
      rotation: 45,
      colorStops: [{ offset: 0, color: '#ea580c' }, { offset: 1, color: '#c2410c' }],
    },
  },
  {
    id: 'teal-ocean',
    gradient: {
      type: 'linear',
      rotation: 45,
      colorStops: [{ offset: 0, color: '#0d9488' }, { offset: 1, color: '#0f766e' }],
    },
  },
  {
    id: 'sky-blue',
    gradient: {
      type: 'linear',
      rotation: 45,
      colorStops: [{ offset: 0, color: '#0284c7' }, { offset: 1, color: '#1d4ed8' }],
    },
  },
  {
    id: 'royal-blue',
    gradient: {
      type: 'linear',
      rotation: 45,
      colorStops: [{ offset: 0, color: '#2563eb' }, { offset: 1, color: '#1e3a8a' }],
    },
  },
  {
    id: 'violet-pink',
    gradient: {
      type: 'linear',
      rotation: 45,
      colorStops: [{ offset: 0, color: '#d946ef' }, { offset: 1, color: '#9333ea' }],
    },
  },
  {
    id: 'purple-dream',
    gradient: {
      type: 'linear',
      rotation: 45,
      colorStops: [{ offset: 0, color: '#9333ea' }, { offset: 1, color: '#581c87' }],
    },
  },
  {
    id: 'dark-slate',
    gradient: {
      type: 'linear',
      rotation: 45,
      colorStops: [{ offset: 0, color: '#475569' }, { offset: 1, color: '#1e293b' }],
    },
  },
]

export function ColorTab() {
  const options = useQrCodeStore((s) => s.options)
  const setOptions = useQrCodeStore((s) => s.setOptions)

  const [colorMode, setColorMode] = useState<'solid' | 'gradient'>(
    options.dotsOptions.gradient ? 'gradient' : 'solid'
  )

  const handleSolidColorSelect = (color: string) => {
    setColorMode('solid')
    setOptions({
      dotsOptions: {
        ...options.dotsOptions,
        color,
        gradient: undefined,
      },
    })
  }

  const handleGradientSelect = (gradient: QrGradient) => {
    setColorMode('gradient')
    setOptions({
      dotsOptions: {
        ...options.dotsOptions,
        gradient,
      },
      cornersSquareOptions: {
        ...options.cornersSquareOptions,
        gradient,
      },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.color.solid_palette')}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {SOLID_COLORS.map((c) => {
            const isSelected = colorMode === 'solid' && options.dotsOptions.color === c && !options.dotsOptions.gradient
            return (
              <button
                key={c}
                type="button"
                style={{ backgroundColor: c }}
                onClick={() => handleSolidColorSelect(c)}
                className={cn(
                  'h-7 w-7 rounded-[var(--r-sm)] border transition-all shadow-xs',
                  isSelected
                    ? 'border-white ring-2 ring-[var(--accent)] scale-110'
                    : 'border-transparent hover:scale-105'
                )}
              />
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-between py-1">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.color.custom_color')}
        </label>
        <ColorWheelTrigger
          value={options.dotsOptions.color || '#000000'}
          label={t('tools.qrcode.color.custom_color')}
          onChange={(color) => handleSolidColorSelect(color)}
          onCommit={(color) => handleSolidColorSelect(color)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.color.gradient_palette')}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {GRADIENT_PRESETS.map((p) => {
            const bgGrad = `linear-gradient(${p.gradient.rotation || 45}deg, ${p.gradient.colorStops[0].color}, ${p.gradient.colorStops[1].color})`
            const isSelected =
              colorMode === 'gradient' &&
              options.dotsOptions.gradient?.colorStops?.[0]?.color === p.gradient.colorStops[0].color

            return (
              <button
                key={p.id}
                type="button"
                style={{ background: bgGrad }}
                onClick={() => handleGradientSelect(p.gradient)}
                className={cn(
                  'h-7 w-7 rounded-[var(--r-sm)] border transition-all shadow-xs',
                  isSelected
                    ? 'border-white ring-2 ring-[var(--accent)] scale-110'
                    : 'border-transparent hover:scale-105'
                )}
              />
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-between py-1 border-t border-[var(--border-subtle)] pt-3">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.color.eye_outer')}
        </label>
        <ColorWheelTrigger
          value={options.cornersSquareOptions?.color || options.dotsOptions.color || '#000000'}
          label={t('tools.qrcode.color.eye_outer')}
          onChange={(color) =>
            setOptions({
              cornersSquareOptions: {
                ...options.cornersSquareOptions,
                color,
              },
            })
          }
          onCommit={(color) =>
            setOptions({
              cornersSquareOptions: {
                ...options.cornersSquareOptions,
                color,
              },
            })
          }
        />
      </div>

      <div className="flex items-center justify-between py-1">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.color.eye_inner')}
        </label>
        <ColorWheelTrigger
          value={options.cornersDotOptions?.color || options.dotsOptions.color || '#000000'}
          label={t('tools.qrcode.color.eye_inner')}
          onChange={(color) =>
            setOptions({
              cornersDotOptions: {
                ...options.cornersDotOptions,
                color,
              },
            })
          }
          onCommit={(color) =>
            setOptions({
              cornersDotOptions: {
                ...options.cornersDotOptions,
                color,
              },
            })
          }
        />
      </div>

      <div className="flex items-center justify-between py-1">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.color.background_color')}
        </label>
        <ColorWheelTrigger
          value={options.backgroundOptions?.color || '#ffffff'}
          label={t('tools.qrcode.color.background_color')}
          onChange={(color) =>
            setOptions({
              backgroundOptions: {
                ...options.backgroundOptions,
                color,
              },
            })
          }
          onCommit={(color) =>
            setOptions({
              backgroundOptions: {
                ...options.backgroundOptions,
                color,
              },
            })
          }
        />
      </div>
    </div>
  )
}
