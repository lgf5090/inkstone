/**
 * The table primitives every Cloudflare screen composes.
 *
 * A native `<table>` rather than a grid: these screens are tabular data, and a table is what gives a
 * screen reader the column a cell belongs to. The scroll container is focusable and named so a
 * keyboard reader can scroll a wide table without a mouse.
 */
import type { ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import { nextSortDir, type SortState } from '../lib/sort'

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <table className={cn('w-full border-collapse text-left text-[length:var(--text-12-5)]', className)}>
      {children}
    </table>
  )
}

export function TableScroll({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        'overflow-x-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-[var(--bg-sunken)]">{children}</thead>
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>
}

export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr className={cn('border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)]', className)}>
      {children}
    </tr>
  )
}

export function Th({ children, className, sort, title }: { children: ReactNode; className?: string; sort?: 'ascending' | 'descending' | 'none'; title?: string }) {
  return (
    <th
      scope="col"
      title={title}
      aria-sort={sort}
      className={cn(
        'px-2.5 py-2 text-[length:var(--text-11-5)] font-medium whitespace-nowrap text-[var(--text-tertiary)]',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function Td({ children, className, colSpan, title }: { children: ReactNode; className?: string; colSpan?: number; title?: string }) {
  return <td colSpan={colSpan} title={title} className={cn('px-2.5 py-2 align-middle text-[var(--text-primary)]', className)}>{children}</td>
}

/**
 * A header that sorts. The button fills the cell so the whole header is the target, and the direction
 * is the cell's `aria-sort`, not an arrow glyph a screen reader never hears.
 */
export function SortableHead({
  label,
  sortKey,
  sort,
  onToggle,
  className,
}: {
  label: ReactNode
  sortKey: string
  sort: SortState
  onToggle: (key: string) => void
  className?: string
}) {
  const active = sort.key === sortKey && sort.dir !== null
  const direction = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
  return (
    <Th sort={direction} className={className}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          'inline-flex w-full items-center gap-1 rounded-[var(--r-xs)] text-left',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
          active && 'text-[var(--text-primary)]',
        )}
      >
        <span>{label}</span>
        <span aria-hidden="true" className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </Th>
  )
}

/** The next direction a click on `key` would switch to; exported for tests and header hints. */
export function nextDirection(sort: SortState, key: string) {
  return sort.key === key ? nextSortDir(sort.dir) : 'asc'
}
