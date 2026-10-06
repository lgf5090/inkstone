import { memo, useMemo } from 'react'
import { Plus } from 'lucide-react'
import { t, useLocaleRepaint } from '../../../i18n'
import {
  splitTimelineItems,
  TIMELINE_MAX_DAYS,
  type TimelineBarGeometry,
  type TimelineDayFields,
  type TimelineRange,
} from '../timeline-helpers'
import type { KanbanData, KanbanItem, KanbanView } from '../types'
import { kanbanTimelineBarMap } from '../dependencies'
import { useBarReschedule, type BarRescheduleApi } from './kanban-bar-reschedule'
import { KanbanDependencyLayer } from './kanban-dependency-layer'
import { KanbanIconBadge } from './kanban-icon-badge'
import { KanbanRenderTail, useKanbanRenderWindow } from './kanban-render-window'
import {
  TimelineClippedNotice,
  TimelineDayHeader,
  TimelineRangeControls,
  TimelineUndatedList,
  useTimelineViewState,
} from './kanban-timeline-grid'
import { useKanbanViewMemory } from './kanban-view-memory'

interface KanbanTimelineViewProps {
  data: KanbanData
  view?: KanbanView
  onOpenDetail: (item: KanbanItem) => void
  onAddItem: () => void
  /** The board's writer for a bar the reader moved: one patch, one commit, one step of undo. */
  onReschedule: (itemId: string, patch: Record<string, string>) => void
}

function TimelineTaskSidebar({
  items,
  onOpenDetail,
  onAddItem,
}: {
  items: KanbanItem[]
  onOpenDetail: (item: KanbanItem) => void
  onAddItem: () => void
}) {
  return (
    <div className='w-60 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-raised)]'>
      <div className='h-12 border-b border-[var(--border-subtle)] px-3 py-3 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
        {t('preview.kanban_task_name')}
      </div>
      <div className='divide-y divide-[var(--border-subtle)]'>
        {items.map((item) => (
          // The row is one control with nothing inside it, so it is the control (SH-110): a real button
          // is focusable, answers Enter and Space, and carries the row's own text as its name. As a
          // `div` with a click handler it was the one affordance in this view a keyboard could not
          // reach at all.
          <button
            key={item.id}
            type='button'
            onClick={() => onOpenDetail(item)}
            className='flex h-10 w-full cursor-pointer items-center gap-1.5 px-3 text-left text-[length:var(--text-13)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]'
          >
            <KanbanIconBadge icon={item.icon} size={14} />
            <span className='truncate'>{item.title}</span>
          </button>
        ))}
      </div>
      <div className='p-2'>
        <button
          type='button'
          onClick={onAddItem}
          className='flex items-center gap-1.5 rounded-[var(--r-md)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        >
          <Plus size={13} aria-hidden />
          <span>{t('preview.kanban_new_item')}</span>
        </button>
      </div>
    </div>
  )
}

function TimelineChart({
  items,
  range,
  fields,
  bars,
  scrollRef,
  reschedule,
  onOpenDetail,
  hiddenCount,
  setTailElement,
  onReveal,
}: {
  items: KanbanItem[]
  range: TimelineRange
  fields?: TimelineDayFields
  /** The bars the view already measured, shared with the dependency layer above the rows. */
  bars: ReadonlyMap<string, TimelineBarGeometry>
  scrollRef: React.RefObject<HTMLDivElement | null>
  reschedule: BarRescheduleApi
  onOpenDetail: (item: KanbanItem) => void
  hiddenCount: number
  setTailElement: React.Dispatch<React.SetStateAction<HTMLButtonElement | null>>
  onReveal: () => void
}) {
  return (
    <div ref={scrollRef} data-kanban-timeline-grid className='flex-1 overflow-x-auto'>
      <TimelineDayHeader days={range.days} dayWidth={range.dayWidth} />
      <div className='relative w-max divide-y divide-[var(--border-subtle)]'>
        <KanbanDependencyLayer items={items} range={range} fields={fields} bars={bars} />
        {items.map((item) => {
          const bar = bars.get(item.id)
          if (!bar) return null
          return (
            <div key={item.id} className='relative h-10'>
              {/* The bar is a control (it opens the item), so it is a real button rather than a painted
                  div with a click handler (SH-110). */}
              <button
                type='button'
                data-item-id={item.id}
                {...reschedule.barProps(item, () => onOpenDetail(item))}
                style={{ left: `${bar.left}px`, width: `${bar.width}px` }}
                className={`absolute top-2 flex h-6 cursor-pointer touch-none items-center justify-between gap-1 overflow-hidden rounded-[var(--r-full)] bg-[var(--accent)] px-2.5 text-left text-[length:var(--text-11)] font-medium text-[var(--accent-contrast)] shadow-[var(--shadow-xs)] transition-opacity hover:opacity-90 ${
                  bar.clippedBefore ? 'rounded-l-none' : ''
                } ${bar.clippedAfter ? 'rounded-r-none' : ''}`}
              >
                <span className='truncate'>{item.title}</span>
              </button>
            </div>
          )
        })}
        <KanbanRenderTail hiddenCount={hiddenCount} setTailElement={setTailElement} onReveal={onReveal} />
      </div>
    </div>
  )
}

export const KanbanTimelineView = memo(function KanbanTimelineView({
  data,
  view,
  onOpenDetail,
  onAddItem,
  onReschedule,
}: KanbanTimelineViewProps) {
  useLocaleRepaint()
  const startField = view?.startField
  const endField = view?.endField
  const fields: TimelineDayFields = useMemo(() => ({ startField, endField }), [startField, endField])
  const { dated, undated } = useMemo(() => splitTimelineItems(data.items, fields), [data.items, fields])
  // One window cuts both columns: the sidebar rows and the chart rows are the same items in the same
  // order, so slicing at one index keeps them side by side, and the range above still reads the full
  // list — the day header has to span every day the board holds, not just the rows on screen.
  const { visible: visibleDated, hiddenCount, setTailElement, revealMore } = useKanbanRenderWindow(dated)
  const memory = useKanbanViewMemory(view?.id)
  const { range, zoom, scrollRef, onZoomChange, onToday } = useTimelineViewState(dated, fields, memory.zoom, memory.setZoom)
  const reschedule = useBarReschedule({ dayWidth: range.dayWidth, fields, onShift: onReschedule })
  // One geometry pass feeds the rows and the dependency layer alike: the arrows need the same bar
  // edges the rows draw, and a zoom step used to pay for the whole scan twice.
  const bars = useMemo(() => kanbanTimelineBarMap(visibleDated, range, fields), [visibleDated, range, fields])

  return (
    <div data-kanban-timeline className='flex h-full w-full flex-col overflow-hidden p-4'>
      {range.clipped && <TimelineClippedNotice days={TIMELINE_MAX_DAYS} />}
      <TimelineRangeControls zoom={zoom} onZoomChange={onZoomChange} onToday={onToday} />
      <div className='flex flex-1 overflow-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]'>
        <TimelineTaskSidebar items={visibleDated} onOpenDetail={onOpenDetail} onAddItem={onAddItem} />
        <TimelineChart
          items={visibleDated}
          range={range}
          fields={fields}
          bars={bars}
          scrollRef={scrollRef}
          reschedule={reschedule}
          onOpenDetail={onOpenDetail}
          hiddenCount={hiddenCount}
          setTailElement={setTailElement}
          onReveal={revealMore}
        />
      </div>
      <TimelineUndatedList items={undated} onOpenDetail={onOpenDetail} />
      {reschedule.status}
    </div>
  )
})
