/**
 * The pieces both schedule views draw with: the dependency edges, a bar, and the tray of cards that
 * have no date yet.
 *
 * Edges are orthogonal (out right, down, in from the left) rather than curved, because a curve between
 * two nearby rows hides which end it leaves; the reference's elbow reads at a glance even when twenty
 * edges cross.
 */
import type { ReactElement } from 'react'
import { ChevronDown, ChevronRight, Link2 } from 'lucide-react'
import type { ProjectCard, ProjectCardLink } from '@shared/project/model'
import { t } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'

export interface BarGeometry {
  left: number
  width: number
  row: number
}

export function DependencyEdges({ links, geometry, rowHeight, columnPx, width, height }: {
  links: readonly ProjectCardLink[]
  geometry: ReadonlyMap<string, BarGeometry>
  rowHeight: number
  columnPx: number
  width: number
  height: number
}): ReactElement | null {
  const edges: { key: string, d: string }[] = []
  for (const link of links) {
    if (link.kind !== 'blocks') continue
    const from = geometry.get(link.fromCardId)
    const to = geometry.get(link.toCardId)
    if (!from || !to) continue
    const x1 = (from.left + from.width) * columnPx
    const y1 = from.row * rowHeight + rowHeight / 2
    const x2 = to.left * columnPx
    const y2 = to.row * rowHeight + rowHeight / 2
    const bend = Math.max(x1 + 12, (x1 + x2) / 2)
    edges.push({ key: `${link.fromCardId}-${link.toCardId}`, d: `M ${x1} ${y1} H ${bend} V ${y2} H ${x2}` })
  }
  if (edges.length === 0) return null
  return (
    <svg className="pv-sched-deps" width={width} height={height} aria-hidden="true" data-schedule-dependencies={edges.length}>
      <defs>
        <marker id="pv-dep-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 Z" fill="var(--text-quaternary)" />
        </marker>
      </defs>
      {edges.map((edge) => (
        <path key={edge.key} d={edge.d} fill="none" stroke="var(--text-quaternary)" strokeWidth="1.25" markerEnd="url(#pv-dep-arrow)" />
      ))}
    </svg>
  )
}

export function ScheduleBar({ card, color, left, width, top, height, done, progress, conflict, selected, draggable, dragging, milestone, tip, onOpen, onPointerDown, onContextMenu, onDoubleClick, children }: {
  card: ProjectCard
  color: string
  left: number
  width: number
  top: number
  height: number
  done: boolean
  progress: number
  conflict: boolean
  selected: boolean
  draggable: boolean
  dragging: boolean
  milestone: boolean
  tip?: string
  onOpen: () => void
  onPointerDown?: (event: React.PointerEvent) => void
  onContextMenu?: (event: React.MouseEvent) => void
  onDoubleClick?: () => void
  children?: React.ReactNode
}): ReactElement {
  const title = card.title || t('project.board.untitled_card')
  return (
    <button
      type="button"
      className="pv-bar"
      data-schedule-bar={card.id}
      data-timeline-bar={card.id}
      data-timeline-conflict={conflict ? '' : undefined}
      data-done={done}
      data-conflict={conflict}
      data-selected={selected}
      data-draggable={draggable}
      data-milestone={milestone}
      aria-label={title}
      title={tip ?? title}
      style={{
        left: `${left}px`,
        // A milestone is a diamond of one bar-height, decided here rather than by an !important
        // fighting the inline width.
        width: `${milestone ? height : width}px`,
        top: `${top}px`,
        height: `${height}px`,
        opacity: dragging ? 0.7 : undefined,
        '--pv-card-color': color,
      } as React.CSSProperties}
      onClick={onOpen}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      {progress > 0 && !milestone && <span className="pv-bar-progress" style={{ width: `${Math.round(progress * 100)}%` }} aria-hidden="true" />}
      {!milestone && <span className="pv-bar-label">{title}</span>}
      {children}
    </button>
  )
}

export function RowToggle({ collapsed, onToggle, label }: { collapsed: boolean, onToggle: () => void, label: string }): ReactElement {
  return (
    <IconButton label={label} size="sm" aria-expanded={!collapsed} onClick={onToggle}>
      {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
    </IconButton>
  )
}

/** Cards with no date: visible, draggable onto the axis, and never silently dropped from the view. */
export function UnscheduledTray({ cards, onOpen, onSchedule, canEdit }: {
  cards: readonly ProjectCard[]
  onOpen: (id: string) => void
  onSchedule?: (id: string) => void
  canEdit: boolean
}): ReactElement | null {
  if (cards.length === 0) return null
  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--bg-raised)]" aria-label={t('project.view.unscheduled')} data-unscheduled="">
      <h3 className="shrink-0 border-b border-[var(--border-subtle)] px-3 py-1.5 text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]">
        {t('project.view.unscheduled_count', { count: cards.length })}
      </h3>
      <ul className="pv-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
        {cards.map((card) => (
          <li key={card.id} className="flex items-center gap-1">
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded-[var(--r-xs)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              onClick={() => onOpen(card.id)}
            >
              {card.title || t('project.board.untitled_card')}
            </button>
            {canEdit && onSchedule && (
              <IconButton label={t('project.view.schedule_today', { title: card.title || t('project.board.untitled_card') })} size="sm" onClick={() => onSchedule(card.id)}>
                <Link2 size={12} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
    </aside>
  )
}
