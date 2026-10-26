import React, { useState } from 'react'
import type {
  QrDotType,
  QrErrorCorrectionLevel,
  QrEyeShape,
  QrToolkitMarkerInnerShape,
  QrToolkitMarkerShape,
  QrToolkitMarkerSubShape,
  QrToolkitPixelStyle,
} from '../../../../../shared/tools/qrcode/types'
import { mapEyeShapeToCornerOptions } from '../engine/qr-engine'
import { useQrCodeStore } from '../store'
import { Field, Segmented } from '../../../../components/form'
import { cn } from '../../../../lib/cn'
import { t, type MessageKey } from '../../../../lib/i18n'

const ERROR_LEVELS = [
  { value: 'L' as QrErrorCorrectionLevel, label: '7% (L)' },
  { value: 'M' as QrErrorCorrectionLevel, label: '15% (M)' },
  { value: 'Q' as QrErrorCorrectionLevel, label: '25% (Q)' },
  { value: 'H' as QrErrorCorrectionLevel, label: '30% (H)' },
]

interface ShapeOption {
  id: QrDotType | QrToolkitPixelStyle
  labelKey: MessageKey
  svg: (color: string) => React.ReactNode
}

const ELEMENT_SHAPES: readonly ShapeOption[] = [
  {
    id: 'square',
    labelKey: 'tools.qrcode.shape.square',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-6 w-6">
        <rect x="2" y="2" width="12" height="12" fill={fill} />
        <rect x="18" y="2" width="12" height="12" fill={fill} />
        <rect x="2" y="18" width="12" height="12" fill={fill} />
        <rect x="18" y="18" width="12" height="12" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'dots',
    labelKey: 'tools.qrcode.shape.dots',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-6 w-6">
        <rect x="3" y="3" width="6" height="6" fill={fill} />
        <rect x="13" y="3" width="6" height="6" fill={fill} />
        <rect x="23" y="3" width="6" height="6" fill={fill} />
        <rect x="3" y="13" width="6" height="6" fill={fill} />
        <rect x="23" y="13" width="6" height="6" fill={fill} />
        <rect x="3" y="23" width="6" height="6" fill={fill} />
        <rect x="13" y="23" width="6" height="6" fill={fill} />
        <rect x="23" y="23" width="6" height="6" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'rounded',
    labelKey: 'tools.qrcode.shape.circle',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-6 w-6">
        <circle cx="8" cy="8" r="6" fill={fill} />
        <circle cx="24" cy="8" r="6" fill={fill} />
        <circle cx="8" cy="24" r="6" fill={fill} />
        <circle cx="24" cy="24" r="6" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'classy',
    labelKey: 'tools.qrcode.shape.liquid',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-6 w-6">
        <rect x="2" y="2" width="12" height="12" rx="4" fill={fill} />
        <rect x="18" y="2" width="12" height="12" rx="4" fill={fill} />
        <rect x="2" y="18" width="12" height="12" rx="4" fill={fill} />
        <rect x="18" y="18" width="12" height="12" rx="4" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'squircle',
    labelKey: 'tools.qrcode.shape.squircle',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-6 w-6">
        <rect x="3" y="3" width="11" height="11" rx="5" fill={fill} />
        <rect x="18" y="3" width="11" height="11" rx="5" fill={fill} />
        <rect x="3" y="18" width="11" height="11" rx="5" fill={fill} />
        <rect x="18" y="18" width="11" height="11" rx="5" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'row',
    labelKey: 'tools.qrcode.shape.row',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-6 w-6">
        <rect x="2" y="4" width="28" height="8" rx="4" fill={fill} />
        <rect x="2" y="20" width="28" height="8" rx="4" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'column',
    labelKey: 'tools.qrcode.shape.column',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-6 w-6">
        <rect x="4" y="2" width="8" height="28" rx="4" fill={fill} />
        <rect x="20" y="2" width="8" height="28" rx="4" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'diamonds',
    labelKey: 'tools.qrcode.shape.diamonds',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-6 w-6">
        <polygon points="8,2 14,8 8,14 2,8" fill={fill} />
        <polygon points="24,2 30,8 24,14 18,8" fill={fill} />
        <polygon points="8,18 14,24 8,30 2,24" fill={fill} />
        <polygon points="24,18 30,24 24,30 18,24" fill={fill} />
      </svg>
    ),
  },
]

interface EyeOption {
  id: QrEyeShape | QrToolkitMarkerShape
  labelKey: MessageKey
  svg: (color: string) => React.ReactNode
}

const EYE_SHAPES: readonly EyeOption[] = [
  {
    id: 'square',
    labelKey: 'tools.qrcode.eye.square',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <rect x="2" y="2" width="28" height="28" fill="none" stroke={fill} strokeWidth="3" />
        <rect x="9" y="9" width="14" height="14" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'rounded',
    labelKey: 'tools.qrcode.eye.rounded',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <rect x="2" y="2" width="28" height="28" rx="7" fill="none" stroke={fill} strokeWidth="3" />
        <rect x="9" y="9" width="14" height="14" rx="3" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'circle',
    labelKey: 'tools.qrcode.eye.circle',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <circle cx="16" cy="16" r="13" fill="none" stroke={fill} strokeWidth="3" />
        <circle cx="16" cy="16" r="7" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'octagon',
    labelKey: 'tools.qrcode.eye.octagon',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <polygon
          points="10,2 22,2 30,10 30,22 22,30 10,30 2,22 2,10"
          fill="none"
          stroke={fill}
          strokeWidth="3"
        />
        <polygon points="12,7 20,7 25,12 25,20 20,25 12,25 7,20 7,12" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'box',
    labelKey: 'tools.qrcode.eye.box',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <rect x="2" y="2" width="28" height="28" fill="none" stroke={fill} strokeWidth="2.5" />
        <rect x="6" y="6" width="20" height="20" fill="none" stroke={fill} strokeWidth="2.5" />
        <rect x="11" y="11" width="10" height="10" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'plus',
    labelKey: 'tools.qrcode.eye.plus',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <path
          d="M10 2 L22 2 L22 10 L30 10 L30 22 L22 22 L22 30 L10 30 L10 22 L2 22 L2 10 L10 10 Z"
          fill="none"
          stroke={fill}
          strokeWidth="2.5"
        />
        <rect x="11" y="11" width="10" height="10" fill={fill} />
      </svg>
    ),
  },
  {
    id: 'pointed',
    labelKey: 'tools.qrcode.eye.pointed',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <path
          d="M2 2 L24 2 C27 2 30 5 30 8 L30 24 C30 27 27 30 24 30 L8 30 C5 30 2 27 2 24 Z"
          fill="none"
          stroke={fill}
          strokeWidth="3"
        />
        <path
          d="M8 8 L19 8 C21 8 22 9 22 11 L22 19 C22 21 21 22 19 22 L11 22 C9 22 8 21 8 19 Z"
          fill={fill}
        />
      </svg>
    ),
  },
]

const INNER_SHAPES: readonly { id: QrToolkitMarkerInnerShape; labelKey: MessageKey }[] = [
  { id: 'auto', labelKey: 'tools.qrcode.eye.inner_auto' },
  { id: 'square', labelKey: 'tools.qrcode.eye.square' },
  { id: 'circle', labelKey: 'tools.qrcode.eye.circle' },
  { id: 'plus', labelKey: 'tools.qrcode.eye.plus' },
  { id: 'diamond', labelKey: 'tools.qrcode.eye.diamond' },
  { id: 'eye', labelKey: 'tools.qrcode.eye.leaf' },
]

export function ShapeTab() {
  const options = useQrCodeStore((s) => s.options)
  const setOptions = useQrCodeStore((s) => s.setOptions)
  const setToolkitOptions = useQrCodeStore((s) => s.setToolkitOptions)
  const currentEyeShape = useQrCodeStore((s) => s.currentEyeShape)
  const setEyeShape = useQrCodeStore((s) => s.setEyeShape)

  const [independentMarkers, setIndependentMarkers] = useState(
    Boolean(options.toolkitOptions?.markers && options.toolkitOptions.markers.length > 0)
  )

  const tk = options.toolkitOptions ?? {}
  const currentPixelStyle = tk.pixelStyle || (options.dotsOptions.type as any)
  const currentInnerShape = tk.markerInnerShape || 'auto'

  const handlePixelChange = (id: string) => {
    if (['squircle', 'row', 'column'].includes(id)) {
      setToolkitOptions({ pixelStyle: id as QrToolkitPixelStyle, enabled: true })
      setOptions({ dotsOptions: { ...options.dotsOptions, type: 'square' } })
    } else {
      setToolkitOptions({ pixelStyle: id as any })
      setOptions({ dotsOptions: { ...options.dotsOptions, type: id as QrDotType } })
    }
  }

  const handleEyeChange = (shape: string) => {
    if (['octagon', 'box', 'plus'].includes(shape)) {
      setToolkitOptions({ markerShape: shape as QrToolkitMarkerShape, enabled: true })
      setEyeShape(shape as any)
    } else {
      setEyeShape(shape as QrEyeShape)
      setToolkitOptions({ markerShape: shape as any })
      const corners = mapEyeShapeToCornerOptions(
        shape as QrEyeShape,
        options.cornersSquareOptions?.color,
        options.cornersDotOptions?.color
      )
      setOptions({
        eyeShape: shape as QrEyeShape,
        cornersSquareOptions: { ...options.cornersSquareOptions, ...corners.cornersSquareOptions },
        cornersDotOptions: { ...options.cornersDotOptions, ...corners.cornersDotOptions },
      })
    }
  }

  const handleToggleIndependent = (checked: boolean) => {
    setIndependentMarkers(checked)
    if (checked) {
      setToolkitOptions({
        enabled: true,
        markers: [
          { markerShape: tk.markerShape || 'square', markerInnerShape: tk.markerInnerShape || 'auto' },
          { markerShape: tk.markerShape || 'square', markerInnerShape: tk.markerInnerShape || 'auto' },
        ],
      })
    } else {
      setToolkitOptions({ markers: [] })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Field label={t('tools.qrcode.shape.error_correction')}>
        <Segmented<QrErrorCorrectionLevel>
          value={options.errorCorrectionLevel}
          onChange={(level) => setOptions({ errorCorrectionLevel: level })}
          options={[...ERROR_LEVELS]}
        />
      </Field>

      {/* Pixel Elements */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.shape.element_shape')}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {ELEMENT_SHAPES.map((shape) => {
            const isSelected = currentPixelStyle === shape.id
            return (
              <button
                key={shape.id}
                type="button"
                title={t(shape.labelKey)}
                onClick={() => handlePixelChange(shape.id)}
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-[var(--r-md)] border p-1 transition-all',
                  'hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]',
                  isSelected
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] ring-1 ring-[var(--accent)] text-[var(--accent)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]'
                )}
              >
                {shape.svg(isSelected ? 'var(--accent)' : 'currentColor')}
              </button>
            )
          })}
        </div>
      </div>

      {/* Main Corner Markers */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('tools.qrcode.shape.eye_shape')}
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
            <input
              type="checkbox"
              checked={independentMarkers}
              onChange={(e) => handleToggleIndependent(e.target.checked)}
              className="rounded accent-[var(--accent)]"
            />
            <span>{t('tools.qrcode.shape.independent_markers')}</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {EYE_SHAPES.map((eye) => {
            const isSelected = currentEyeShape === eye.id || tk.markerShape === eye.id
            return (
              <button
                key={eye.id}
                type="button"
                title={t(eye.labelKey)}
                onClick={() => handleEyeChange(eye.id)}
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-[var(--r-md)] border p-1 transition-all',
                  'hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]',
                  isSelected
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] ring-1 ring-[var(--accent)] text-[var(--accent)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-primary)]'
                )}
              >
                {eye.svg(isSelected ? 'var(--accent)' : 'currentColor')}
              </button>
            )
          })}
        </div>
      </div>

      {/* Inner Marker Shapes */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.eye.inner_shape_title')}
        </label>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          {INNER_SHAPES.map((inner) => (
            <button
              key={inner.id}
              type="button"
              onClick={() => setToolkitOptions({ markerInnerShape: inner.id, enabled: true })}
              className={cn(
                'rounded-[var(--r-md)] border py-1.5 text-xs font-medium transition-colors',
                currentInnerShape === inner.id
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
              )}
            >
              {t(inner.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Alignment Sub Marker */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.eye.sub_marker_title')}
        </label>
        <div className="grid grid-cols-5 gap-1.5">
          {(['square', 'circle', 'box', 'random', 'plus'] as QrToolkitMarkerSubShape[]).map((sub) => (
            <button
              key={sub}
              type="button"
              onClick={() => setToolkitOptions({ markerSub: sub, enabled: true })}
              className={cn(
                'rounded-[var(--r-md)] border py-1.5 text-xs font-medium capitalize transition-colors',
                (tk.markerSub || 'square') === sub
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
              )}
            >
              {sub}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
