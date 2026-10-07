import { useCallback, useRef, useState } from 'react'
import { cn } from '../../lib/cn'

/**
 * The marker a presenter draws with over the slide (PR-M13).
 *
 * Coordinates are stored as a percentage of the stage rather than as pixels: a phone that is turned
 * sideways mid-talk, or a window that is dragged across a projector's resolution, keeps the circle
 * around the same number instead of leaving it where the old glass used to end.
 *
 * The strokes are keyed by the page they were made on, which is what a talk needs and what a shared
 * whiteboard does not do: a mark drawn over the numbers slide is there when the speaker comes back to
 * it, and is nowhere else. Nothing leaves this window — the audience's link carries a position, not a
 * drawing, so what a remote viewer sees is the page, not the pen.
 */
/** The five rows the door shows for the marker: whether it is on, and the two ways to take marks away. */
export interface InkMenuProps {
  inkOn: boolean
  onToggleInk: () => void
}

export interface InkPoint {
  x: number
  y: number
}

export interface InkStroke {
  points: InkPoint[]
}

export function inkKeyFor(slide: number, subPage: number): string {
  return `${slide}:${subPage}`
}

/** The path a stroke draws: a lone tap is a dot, and a line is its points joined. */
export function strokePath(points: InkPoint[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y} L ${points[0]!.x} ${points[0]!.y}`
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
}

export interface InkBoard {
  page: string
  strokes: InkStroke[]
  /** The stroke under way, which is drawn the same way and joined to the board when the pointer lifts. */
  live: InkPoint[]
  add: (point: InkPoint) => void
  extend: (point: InkPoint) => void
  finish: () => void
  undo: () => void
  clear: () => void
  /** A page with nothing on it has nothing to take back, and the control should say so. */
  hasMarks: boolean
}

export function useInkBoard(page: string): InkBoard {
  const [board, setBoard] = useState<Record<string, InkStroke[]>>({})
  const [live, setLive] = useState<InkPoint[]>([])
  // The stroke under way is kept beside the state rather than read out of an updater: lifting it onto
  // the board is a second state write, and a write nested inside another one's updater lands in the
  // wrong order the moment a pointer gesture and an erase arrive in the same batch.
  const liveRef = useRef<InkPoint[]>([])

  const add = useCallback((point: InkPoint) => {
    liveRef.current = [point]
    setLive(liveRef.current)
  }, [])
  const extend = useCallback((point: InkPoint) => {
    liveRef.current = [...liveRef.current, point]
    setLive(liveRef.current)
  }, [])
  const finish = useCallback(() => {
    const points = liveRef.current
    if (points.length === 0) return
    liveRef.current = []
    setLive([])
    setBoard((previous) => ({ ...previous, [page]: [...(previous[page] ?? []), { points }] }))
  }, [page])
  const undo = useCallback(() => {
    setBoard((previous) => {
      const strokes = previous[page] ?? []
      if (strokes.length === 0) return previous
      return { ...previous, [page]: strokes.slice(0, -1) }
    })
  }, [page])
  const clear = useCallback(() => {
    setBoard((previous) => {
      if ((previous[page] ?? []).length === 0) return previous
      return { ...previous, [page]: [] }
    })
  }, [page])

  const strokes = board[page] ?? []
  return { page, strokes, live, add, extend, finish, undo, clear, hasMarks: strokes.length > 0 || live.length > 0 }
}

export function PresentationInkLayer({ active, strokes, live, onBegin, onExtend, onEnd }: {
  active: boolean
  strokes: InkStroke[]
  live: InkPoint[]
  onBegin: (point: InkPoint) => void
  onExtend: (point: InkPoint) => void
  onEnd: () => void
}) {
  const layerRef = useRef<HTMLDivElement>(null)
  const drawing = useRef(false)

  const pointOf = (event: { clientX: number, clientY: number }): InkPoint => {
    const box = layerRef.current?.getBoundingClientRect()
    if (!box || box.width < 1 || box.height < 1) return { x: 0, y: 0 }
    return {
      x: Number((((event.clientX - box.left) / box.width) * 100).toFixed(2)),
      y: Number((((event.clientY - box.top) / box.height) * 100).toFixed(2)),
    }
  }

  return (
    <div
      ref={layerRef}
      data-presentation-ink={active ? 'on' : 'off'}
      aria-hidden='true'
      className={cn('absolute inset-0', active ? 'touch-none cursor-crosshair' : 'pointer-events-none')}
      onPointerDown={active ? (event) => {
        drawing.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
        onBegin(pointOf(event))
      } : undefined}
      onPointerMove={active ? (event) => {
        if (drawing.current) onExtend(pointOf(event))
      } : undefined}
      onPointerUp={active ? () => {
        drawing.current = false
        onEnd()
      } : undefined}
      onPointerCancel={active ? () => {
        drawing.current = false
        onEnd()
      } : undefined}
      onClickCapture={active ? (event) => {
        // A stroke is not a page turn: the stage underneath reads a click on the slide as "next".
        event.preventDefault()
        event.stopPropagation()
      } : undefined}
    >
      <svg className='h-full w-full' viewBox='0 0 100 100' preserveAspectRatio='none'>
        {[...strokes.map((stroke) => stroke.points), live].filter((points) => points.length > 0).map((points, index) => (
          <path
            key={index}
            d={strokePath(points)}
            fill='none'
            stroke='var(--danger)'
            strokeWidth='3'
            strokeLinecap='round'
            strokeLinejoin='round'
            vectorEffect='non-scaling-stroke'
          />
        ))}
      </svg>
    </div>
  )
}
