import type { QrDotType, QrErrorCorrectionLevel, QrEyeShape } from '../../../../../shared/tools/qrcode/types'
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
  id: QrDotType
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
  id: QrEyeShape
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
    id: 'leaf',
    labelKey: 'tools.qrcode.eye.leaf',
    svg: (fill) => (
      <svg viewBox="0 0 32 32" className="h-7 w-7">
        <path
          d="M2 14 C2 6 6 2 14 2 L26 2 C28 2 30 4 30 6 L30 18 C30 26 26 30 18 30 L6 30 C4 30 2 28 2 26 Z"
          fill="none"
          stroke={fill}
          strokeWidth="3"
        />
        <path
          d="M9 16 C9 11 11 9 16 9 L21 9 C22 9 23 10 23 11 L23 16 C23 21 21 23 16 23 L11 23 C10 23 9 22 9 21 Z"
          fill={fill}
        />
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

export function ShapeTab() {
  const options = useQrCodeStore((s) => s.options)
  const setOptions = useQrCodeStore((s) => s.setOptions)
  const currentEyeShape = useQrCodeStore((s) => s.currentEyeShape)
  const setEyeShape = useQrCodeStore((s) => s.setEyeShape)

  const handleEyeChange = (shape: QrEyeShape) => {
    setEyeShape(shape)
    const corners = mapEyeShapeToCornerOptions(
      shape,
      options.cornersSquareOptions?.color,
      options.cornersDotOptions?.color
    )
    setOptions({
      eyeShape: shape,
      cornersSquareOptions: { ...options.cornersSquareOptions, ...corners.cornersSquareOptions },
      cornersDotOptions: { ...options.cornersDotOptions, ...corners.cornersDotOptions },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('tools.qrcode.shape.error_correction')}>
        <Segmented<QrErrorCorrectionLevel>
          value={options.errorCorrectionLevel}
          onChange={(level) => setOptions({ errorCorrectionLevel: level })}
          options={[...ERROR_LEVELS]}
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.shape.element_shape')}
        </label>
        <div className="flex items-center gap-2">
          {ELEMENT_SHAPES.map((shape) => {
            const isSelected = options.dotsOptions.type === shape.id
            return (
              <button
                key={shape.id}
                type="button"
                title={t(shape.labelKey)}
                onClick={() =>
                  setOptions({
                    dotsOptions: { ...options.dotsOptions, type: shape.id },
                  })
                }
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

      <div className="flex flex-col gap-1.5">
        <label className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('tools.qrcode.shape.eye_shape')}
        </label>
        <div className="flex items-center gap-2">
          {EYE_SHAPES.map((eye) => {
            const isSelected = currentEyeShape === eye.id
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
    </div>
  )
}
