import type { QrStylingOptions } from '../../../../../shared/tools/qrcode/types'

interface TemplateThumbnailProps {
  options: QrStylingOptions
  className?: string
}

export function TemplateThumbnail({ options, className }: TemplateThumbnailProps) {
  const bg = options.backgroundOptions?.color || '#ffffff'
  const eyeColor = options.cornersSquareOptions?.color || options.dotsOptions?.color || '#000000'
  const dotColor = options.cornersDotOptions?.color || eyeColor
  const dotsColor = options.dotsOptions?.color || '#000000'
  const frame = options.frameOptions
  const hasFrame = frame && frame.type && frame.type !== 'none'
  const frameColor = frame?.color || '#e11d48'
  const frameText = frame?.text || 'SCAN ME'
  const isEyeDot = options.cornersSquareOptions?.type === 'dot' || options.cornersSquareOptions?.type === 'extra-rounded'
  const eyeRadius = isEyeDot ? 6 : 2
  const centerDotRadius = options.cornersDotOptions?.type === 'dot' ? 3 : 1

  return (
    <svg viewBox="0 0 100 100" className={className || 'h-full w-full'}>
      <rect width="100" height="100" rx="8" fill={bg} />

      {hasFrame && (
        <>
          <rect
            x="3"
            y="3"
            width="94"
            height="94"
            rx="6"
            fill="none"
            stroke={frameColor}
            strokeWidth="3"
          />
          <rect x="18" y="82" width="64" height="14" rx="4" fill={frameColor} />
          <text
            x="50"
            y="91"
            fill="#ffffff"
            fontSize="6.5"
            fontWeight="bold"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {frameText}
          </text>
        </>
      )}

      <rect x="14" y="14" width="22" height="22" rx={eyeRadius} fill={eyeColor} />
      <rect x="18" y="18" width="14" height="14" rx={eyeRadius > 3 ? 3 : 1} fill={bg} />
      <rect x="21" y="21" width="8" height="8" rx={centerDotRadius} fill={dotColor} />

      <rect x="64" y="14" width="22" height="22" rx={eyeRadius} fill={eyeColor} />
      <rect x="68" y="18" width="14" height="14" rx={eyeRadius > 3 ? 3 : 1} fill={bg} />
      <rect x="71" y="21" width="8" height="8" rx={centerDotRadius} fill={dotColor} />

      <rect x="14" y="64" width="22" height="22" rx={eyeRadius} fill={eyeColor} />
      <rect x="18" y="68" width="14" height="14" rx={eyeRadius > 3 ? 3 : 1} fill={bg} />
      <rect x="21" y="71" width="8" height="8" rx={centerDotRadius} fill={dotColor} />

      <circle cx="42" cy="20" r="2.5" fill={dotsColor} />
      <circle cx="50" cy="20" r="2.5" fill={dotsColor} />
      <circle cx="58" cy="20" r="2.5" fill={dotsColor} />
      <circle cx="20" cy="42" r="2.5" fill={dotsColor} />
      <circle cx="20" cy="50" r="2.5" fill={dotsColor} />
      <circle cx="20" cy="58" r="2.5" fill={dotsColor} />

      <circle cx="42" cy="42" r="2.5" fill={dotsColor} />
      <circle cx="50" cy="42" r="2.5" fill={dotsColor} />
      <circle cx="58" cy="42" r="2.5" fill={dotsColor} />
      <circle cx="42" cy="50" r="2.5" fill={dotsColor} />
      <circle cx="50" cy="50" r="2.5" fill={dotsColor} />
      <circle cx="58" cy="50" r="2.5" fill={dotsColor} />
      <circle cx="42" cy="58" r="2.5" fill={dotsColor} />
      <circle cx="50" cy="58" r="2.5" fill={dotsColor} />
      <circle cx="58" cy="58" r="2.5" fill={dotsColor} />

      <circle cx="70" cy="42" r="2.5" fill={dotsColor} />
      <circle cx="78" cy="42" r="2.5" fill={dotsColor} />
      <circle cx="70" cy="50" r="2.5" fill={dotsColor} />
      <circle cx="78" cy="58" r="2.5" fill={dotsColor} />
      <circle cx="42" cy="70" r="2.5" fill={dotsColor} />
      <circle cx="50" cy="70" r="2.5" fill={dotsColor} />
      <circle cx="58" cy="78" r="2.5" fill={dotsColor} />
      <circle cx="70" cy="70" r="2.5" fill={dotsColor} />
      <circle cx="78" cy="78" r="2.5" fill={dotsColor} />

      {options.logoOptions?.logoId && (
        <circle cx="50" cy="50" r="8" fill="#ffffff" stroke={eyeColor} strokeWidth="1.5" />
      )}
    </svg>
  )
}
