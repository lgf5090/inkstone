import { useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn'

export function SplitPane({
  orientation = 'horizontal',
  ratio,
  onChange,
  first,
  second,
  label,
  min = 0.2,
  max = 0.8,
  className,
}: {
  orientation?: 'horizontal' | 'vertical'
  ratio: number
  onChange: (ratio: number) => void
  first: ReactNode
  second: ReactNode
  label: string
  min?: number
  max?: number
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const horizontal = orientation === 'horizontal'

  const clamp = (value: number) => Math.min(max, Math.max(min, value))
  const update = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const next = horizontal ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height
    onChange(clamp(next))
  }

  return (
    <div
      ref={containerRef}
      data-split-orientation={orientation}
      className={cn('flex h-full min-h-0 min-w-0', horizontal ? 'flex-row' : 'flex-col', className)}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={horizontal ? { width: `${ratio * 100}%` } : { height: `${ratio * 100}%` }}
      >
        {first}
      </div>
      <div
        role="separator"
        aria-label={label}
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => {
          if (dragging) update(event.clientX, event.clientY)
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          setDragging(false)
        }}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => onChange(0.5)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.08 : 0.02
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault()
            onChange(clamp(ratio - step))
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault()
            onChange(clamp(ratio + step))
          } else if (event.key === 'Home') {
            event.preventDefault()
            onChange(min)
          } else if (event.key === 'End') {
            event.preventDefault()
            onChange(max)
          }
        }}
        className={cn(
          'group relative shrink-0 touch-none select-none bg-[var(--border-subtle)] transition-colors',
          'hover:bg-[var(--accent)] focus-visible:bg-[var(--accent)] focus-visible:outline-none',
          horizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
          dragging && 'bg-[var(--accent)]',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute rounded-full bg-[var(--border-strong)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
            horizontal ? 'top-1/2 left-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2' : 'top-1/2 left-1/2 h-0.5 w-8 -translate-x-1/2 -translate-y-1/2',
            dragging && 'opacity-100',
          )}
        />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{second}</div>
    </div>
  )
}
