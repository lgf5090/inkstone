import { useCallback, useEffect, useRef } from 'react'
import { hslToRgb, rgbToHex } from '@shared/tools/color/spaces'
import { t } from '../../../../lib/i18n'

export interface ColorWheelProps {
  hue: number // 0-360
  saturation: number // 0-100
  lightness?: number // 0-100, default 50
  size?: number
  onChange: (hue: number, saturation: number) => void
  disabled?: boolean
}

export function ColorWheel({
  hue,
  saturation,
  lightness = 50,
  size = 240,
  onChange,
  disabled = false,
}: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const isDraggingRef = useRef(false)

  // Draw the circular color disk on canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const cx = size / 2
    const cy = size / 2
    const radius = size / 2 - 2

    const imgData = ctx.createImageData(size, size)
    const data = imgData.data

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx
        const dy = y - cy
        const dist = Math.hypot(dx, dy)
        const pixelIdx = (y * size + x) * 4

        if (dist <= radius) {
          let angle = Math.atan2(dy, dx) * (180 / Math.PI)
          if (angle < 0) angle += 360
          const sat = Math.min(100, (dist / radius) * 100)
          const rgb = hslToRgb({ h: angle, s: sat, l: lightness })

          data[pixelIdx] = rgb.r
          data[pixelIdx + 1] = rgb.g
          data[pixelIdx + 2] = rgb.b
          // Anti-aliased boundary
          const edgeAlpha = Math.min(1, Math.max(0, radius - dist + 1))
          data[pixelIdx + 3] = Math.round(edgeAlpha * 255)
        } else {
          data[pixelIdx + 3] = 0
        }
      }
    }

    ctx.putImageData(imgData, 0, 0)
  }, [size, lightness])

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const cx = rect.width / 2
      const cy = rect.height / 2
      const dx = clientX - rect.left - cx
      const dy = clientY - rect.top - cy

      let angle = Math.atan2(dy, dx) * (180 / Math.PI)
      if (angle < 0) angle += 360

      const maxR = rect.width / 2 - 2
      const sat = Math.min(100, Math.max(0, (Math.hypot(dx, dy) / maxR) * 100))

      onChange(Math.round(angle), Math.round(sat))
    },
    [onChange],
  )

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    isDraggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    updateFromPointer(e.clientX, e.clientY)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || disabled) return
    updateFromPointer(e.clientX, e.clientY)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    isDraggingRef.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Ignored if capture already lost
    }
  }

  // Accessible keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const step = e.shiftKey ? 10 : 2
    let nextHue = hue
    let nextSat = saturation

    switch (e.key) {
      case 'ArrowLeft':
        nextHue = (hue - step + 360) % 360
        e.preventDefault()
        break
      case 'ArrowRight':
        nextHue = (hue + step) % 360
        e.preventDefault()
        break
      case 'ArrowUp':
        nextSat = Math.min(100, saturation + step)
        e.preventDefault()
        break
      case 'ArrowDown':
        nextSat = Math.max(0, saturation - step)
        e.preventDefault()
        break
      default:
        return
    }

    onChange(Math.round(nextHue), Math.round(nextSat))
  }

  // Thumb position
  const cx = size / 2
  const cy = size / 2
  const maxR = size / 2 - 2
  const rad = (hue * Math.PI) / 180
  const dist = (saturation / 100) * maxR
  const thumbX = cx + dist * Math.cos(rad)
  const thumbY = cy + dist * Math.sin(rad)
  const currentColorHex = rgbToHex(hslToRgb({ h: hue, s: saturation, l: lightness }), true)

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={t('tools.color.studio.subtitle')}
      aria-valuenow={Math.round(hue)}
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuetext={`Hue: ${Math.round(hue)}deg, Saturation: ${Math.round(saturation)}%`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      style={{ width: size, height: size }}
      className="relative select-none touch-none rounded-full cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size }}
        className="rounded-full shadow-inner pointer-events-none"
      />
      {/* Thumb handle */}
      <div
        style={{
          left: `${thumbX}px`,
          top: `${thumbY}px`,
          backgroundColor: currentColorHex,
        }}
        className="absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full border-2 border-white shadow-[0_2px_6px_rgba(0,0,0,0.4)] pointer-events-none transition-transform duration-75"
      />
    </div>
  )
}
