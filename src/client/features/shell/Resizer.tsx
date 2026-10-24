import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn'

interface ResizeStart {
  x: number
  value: number
}

interface VerticalResizeHandleProps {
  label: string
  value: number
  min: number
  max: number
  keyboardStep: number
  keyboardInvert?: boolean
  ariaScale?: number
  onChange: (next: number) => void
  onReset?: () => void
  resolveValue: (clientX: number, start: ResizeStart) => number
  className?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}


function VerticalResizeHandle({
  label,
  value,
  min,
  max,
  keyboardStep,
  keyboardInvert = false,
  ariaScale = 1,
  onChange,
  onReset,
  resolveValue,
  className,
}: VerticalResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  const startRef = useRef<ResizeStart>({ x: 0, value: 0 })

  const restoreDocument = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => restoreDocument, [restoreDocument])

  const finish = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      setDragging(false)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      restoreDocument()
    },
    [restoreDocument],
  )

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(value * ariaScale)}
      aria-valuemin={Math.round(min * ariaScale)}
      aria-valuemax={Math.round(max * ariaScale)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        startRef.current = { x: event.clientX, value }
        setDragging(true)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onPointerMove={(event) => {
        if (!dragging) return
        onChange(clamp(resolveValue(event.clientX, startRef.current), min, max))
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        const step = keyboardInvert ? -keyboardStep : keyboardStep
        let next: number | null = null
        if (event.key === 'ArrowLeft') next = value - step
        else if (event.key === 'ArrowRight') next = value + step
        else if (event.key === 'Home') next = min
        else if (event.key === 'End') next = max
        if (next == null) return
        event.preventDefault()
        onChange(clamp(next, min, max))
      }}
      onDoubleClick={onReset}
      className={cn(
        'group relative z-10 -mx-[4px] w-[9px] shrink-0 cursor-col-resize touch-none outline-none',
        className,
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2',
          'transition-[background-color,width] duration-[var(--dur-base)] ease-[var(--ease-out)]',
          dragging
            ? 'w-[2px] bg-[var(--accent)]'
            : 'bg-[var(--border-subtle)] group-hover:w-[2px] group-hover:bg-[var(--accent)] group-focus-visible:w-[2px] group-focus-visible:bg-[var(--accent)]',
        )}
      />
    </div>
  )
}

export function Resizer({
  label,
  value,
  min,
  max,
  onChange,
  onReset,
  invert = false,
  className,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (next: number) => void
  onReset?: () => void
  invert?: boolean
  className?: string
}) {
  return (
    <VerticalResizeHandle
      label={label}
      value={value}
      min={min}
      max={max}
      keyboardStep={8}
      keyboardInvert={invert}
      onChange={onChange}
      onReset={onReset}
      className={className}
      resolveValue={(clientX, start) =>
        start.value + (clientX - start.x) * (invert ? -1 : 1)
      }
    />
  )
}


export function SplitResizer({
  label,
  containerRef,
  ratio,
  onChange,
  onReset,
}: {
  label: string
  containerRef: React.RefObject<HTMLElement | null>
  ratio: number
  onChange: (next: number) => void
  onReset?: () => void
}) {
  return (
    <VerticalResizeHandle
      label={label}
      value={ratio}
      min={0.2}
      max={0.8}
      keyboardStep={0.02}
      ariaScale={100}
      onChange={onChange}
      onReset={onReset}
      resolveValue={(clientX) => {
        const rect = containerRef.current?.getBoundingClientRect()
        return rect && rect.width > 0 ? (clientX - rect.left) / rect.width : ratio
      }}
    />
  )
}
