/**
 * The aligned rows for a comparison too large for the merge view.
 *
 * `@codemirror/merge` turns its scroller into the page so both sides align, which means it renders
 * the whole document. That is fine for a file a person reads and wrong for a hundred thousand
 * lines, so past the threshold the rows are drawn as a windowed list: only the rows inside the
 * viewport (and a little either side) exist in the DOM, and scrolling stays smooth.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../../../lib/cn'
import type { DiffRow } from '@shared/tools/compare/types'

const ROW_HEIGHT = 21
const OVERSCAN = 12

export interface VirtualDiffViewProps {
  rows: readonly DiffRow[]
  label: string
  leftLabel: string
  rightLabel: string
  /** A row the keyboard just jumped to; the list scrolls so it sits in the middle. */
  focusIndex?: number | null
}

export function VirtualDiffView({ rows, label, leftLabel, rightLabel, focusIndex }: VirtualDiffViewProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [window, setWindow] = useState({ start: 0, end: Math.min(rows.length, 80) })

  const total = rows.length
  const height = total * ROW_HEIGHT

  const update = useMemo(() => () => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const start = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN)
    const visible = Math.ceil(scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2
    const end = Math.min(total, start + visible)
    setWindow((current) => (current.start === start && current.end === end ? current : { start, end }))
  }, [total])

  useEffect(() => {
    update()
    const scroller = scrollerRef.current
    if (!scroller) return
    const listener = () => update()
    scroller.addEventListener('scroll', listener, { passive: true })
    const observer = new ResizeObserver(listener)
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', listener)
      observer.disconnect()
    }
  }, [update])

  useEffect(() => {
    if (focusIndex === null || focusIndex === undefined) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const top = focusIndex * ROW_HEIGHT
    scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 2), behavior: 'smooth' })
  }, [focusIndex])

  return (
    <div
      ref={scrollerRef}
      role="region"
      aria-label={label}
      tabIndex={0}
      data-testid="compare-virtual-diff"
      className="h-full min-h-0 w-full overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] font-mono text-[length:var(--text-12)]"
    >
      <div className="sticky top-0 z-10 grid grid-cols-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] font-semibold text-[var(--text-secondary)]">
        <span className="truncate border-r border-[var(--border-subtle)] px-2 py-1">{leftLabel}</span>
        <span className="truncate px-2 py-1">{rightLabel}</span>
      </div>
      <div className="relative" style={{ height }}>
        {rows.slice(window.start, window.end).map((row, offset) => {
          const index = window.start + offset
          return (
            <div
              key={index}
              className={cn(
                'absolute inset-x-0 grid grid-cols-2',
                row.kind === 'changed' && 'bg-[var(--accent-soft)]/40',
                row.kind === 'added' && 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)]',
                row.kind === 'removed' && 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]',
              )}
              style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
            >
              <DiffCell number={row.leftNo} text={row.leftText} tone={row.kind === 'removed' || row.kind === 'changed' ? 'left' : 'plain'} />
              <DiffCell number={row.rightNo} text={row.rightText} tone={row.kind === 'added' || row.kind === 'changed' ? 'right' : 'plain'} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DiffCell({ number, text, tone }: { number: number | null; text: string; tone: 'left' | 'right' | 'plain' }) {
  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden border-r border-[var(--border-subtle)] px-2">
      <span aria-hidden="true" className="w-10 shrink-0 select-none text-right text-[var(--text-quaternary)]">
        {number ?? ''}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate whitespace-pre',
          tone === 'left' && 'text-[var(--danger)]',
          tone === 'right' && 'text-[var(--success)]',
        )}
      >
        {text}
      </span>
    </div>
  )
}
