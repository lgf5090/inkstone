import { memo, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Slider } from '../../../../components/form'
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

interface KanbanGanttViewProps {
  data: KanbanData
  view?: KanbanView
  onOpenDetail: (item: KanbanItem) => void
  onAddItem: () => void
  onUpdateProgress: (itemId: string, progress: number) => void
  /** The board's writer for a bar the reader moved: one patch, one commit, one step of undo. */
  onReschedule: (itemId: string, patch: Record<string, string>) => void
}

const ganttProgress = (item: KanbanItem, progressField: string) =>
  Math.min(100, Math.max(0, Number(item.properties[progressField] || 0)))

function GanttTaskRow({
  item,
  progressField,
  onOpenDetail,
  onUpdateProgress,
}: {
  item: KanbanItem
  progressField: string
  onOpenDetail: (item: KanbanItem) => void
  onUpdateProgress: (itemId: string, progress: number) => void
}) {
  // The slider answers every drag step with a change, but the board's writer costs one undo step and
  // one re-layout of the whole view, so the drag only holds a local draft; the release — pointer up,
  // the last key of a keyboard run, or the field losing focus mid-drag — is what commits once.
  const [draft, setDraft] = useState<number | null>(null)
  const commitDraft = () => {
    if (draft === null) return
    onUpdateProgress(item.id, draft)
    setDraft(null)
  }
  // The row is a container of two controls, not a control (SH-110): the title is the button that
  // opens the detail, and the progress slider beside it edits the bar without opening anything.
  // As a `div` with a click handler the row was unreachable by keyboard and was itself a hit
  // target holding a control.
  return (
    <div className='flex h-10 items-center justify-between gap-2 px-3 text-[length:var(--text-13)] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]'>
      <button
        type='button'
        onClick={() => onOpenDetail(item)}
        className='flex min-w-0 flex-1 items-center gap-1.5 text-left'
      >
        <KanbanIconBadge icon={item.icon} size={14} />
        <span className='truncate'>{item.title}</span>
      </button>
      <span className='w-36 shrink-0' onPointerUp={commitDraft} onKeyUp={commitDraft} onBlur={commitDraft}>
        <Slider
          immediate
          label={t('preview.kanban_progress')}
          value={draft ?? ganttProgress(item, progressField)}
          min={0}
          max={100}
          step={5}
          suffix='%'
          onChange={setDraft}
        />
      </span>
    </div>
  )
}

function GanttTaskSidebar({
  items,
  progressField,
  onOpenDetail,
  onAddItem,
  onUpdateProgress,
}: {
  items: KanbanItem[]
  progressField: string
  onOpenDetail: (item: KanbanItem) => void
  onAddItem: () => void
  onUpdateProgress: (itemId: string, progress: number) => void
}) {
  return (
    <div className='w-72 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-raised)]'>
      <div className='flex h-12 items-center justify-between border-b border-[var(--border-subtle)] px-3 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]'>
        <span>{t('preview.kanban_task')}</span>
        <span>{t('preview.kanban_progress')}</span>
      </div>
      <div className='divide-y divide-[var(--border-subtle)]'>
        {items.map((item) => (
          <GanttTaskRow
            key={item.id}
            item={item}
            progressField={progressField}
            onOpenDetail={onOpenDetail}
            onUpdateProgress={onUpdateProgress}
          />
        ))}
      </div>
      <div className='p-2'>
        <button
          type='button'
          onClick={onAddItem}
          className='flex items-center gap-1.5 rounded-[var(--r-md)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        >
          <Plus size={13} />
          <span>{t('preview.kanban_new_task')}</span>
        </button>
      </div>
    </div>
  )
}

function GanttBar({
  bar,
  item,
  progressField,
  reschedule,
  onOpenDetail,
}: {
  /** The bar the view already measured, one entry of the map the dependency layer reads too. */
  bar?: TimelineBarGeometry
  item: KanbanItem
  progressField: string
  reschedule: BarRescheduleApi
  onOpenDetail: (item: KanbanItem) => void
}) {
  const progress = ganttProgress(item, progressField)
  if (!bar) return null

  return (
    <div className='relative h-10'>
      {/* The bar is a control (it opens the item), so it is a real button rather than a painted div
          with a click handler (SH-110); the progress track and the label are its contents. */}
      <button
        type='button'
        data-item-id={item.id}
        {...reschedule.barProps(item, () => onOpenDetail(item))}
        style={{ left: `${bar.left}px`, width: `${bar.width}px` }}
        className='group/bar absolute top-2 h-6 cursor-pointer touch-none overflow-hidden rounded-[var(--r-md)] border border-[var(--accent)] bg-[var(--accent-softer)] text-left shadow-[var(--shadow-xs)]'
      >
        <span style={{ width: `${progress}%` }} className='block h-full bg-[var(--accent)] transition-all' />
        <span className='absolute inset-0 flex items-center justify-between gap-2 px-2 text-[length:var(--text-10)] font-semibold text-[var(--text-primary)]'>
          <span className='truncate'>{item.title}</span>
          <span>{progress}%</span>
        </span>
      </button>
    </div>
  )
}

function GanttTimelineChart({
  items,
  range,
  fields,
  bars,
  progressField,
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
  progressField: string
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
        {items.map((item) => (
          <GanttBar
            key={item.id}
            item={item}
            bar={bars.get(item.id)}
            progressField={progressField}
            reschedule={reschedule}
            onOpenDetail={onOpenDetail}
          />
        ))}
        <KanbanRenderTail hiddenCount={hiddenCount} setTailElement={setTailElement} onReveal={onReveal} />
      </div>
    </div>
  )
}

export const KanbanGanttView = memo(function KanbanGanttView({
  data,
  view,
  onOpenDetail,
  onAddItem,
  onUpdateProgress,
  onReschedule,
}: KanbanGanttViewProps) {
  useLocaleRepaint()
  const startField = view?.startField
  const endField = view?.endField
  const fields: TimelineDayFields = useMemo(() => ({ startField, endField }), [startField, endField])
  const { dated, undated } = useMemo(() => splitTimelineItems(data.items, fields), [data.items, fields])
  // One window cuts both columns, exactly as the timeline does; the range still reads the full list
  // so the day header spans every day the board holds.
  const { visible: visibleDated, hiddenCount, setTailElement, revealMore } = useKanbanRenderWindow(dated)
  const progressField = view?.progressField || 'progress'
  const memory = useKanbanViewMemory(view?.id)
  const { range, zoom, scrollRef, onZoomChange, onToday } = useTimelineViewState(dated, fields, memory.zoom, memory.setZoom)
  const reschedule = useBarReschedule({ dayWidth: range.dayWidth, fields, onShift: onReschedule })
  // One geometry pass feeds the rows and the dependency layer alike, exactly as the timeline does.
  const bars = useMemo(() => kanbanTimelineBarMap(visibleDated, range, fields), [visibleDated, range, fields])

  return (
    <div data-kanban-gantt className='flex h-full w-full flex-col overflow-hidden p-4'>
      {range.clipped && <TimelineClippedNotice days={TIMELINE_MAX_DAYS} />}
      <TimelineRangeControls zoom={zoom} onZoomChange={onZoomChange} onToday={onToday} />
      <div className='flex flex-1 overflow-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]'>
        <GanttTaskSidebar
          items={visibleDated}
          progressField={progressField}
          onOpenDetail={onOpenDetail}
          onAddItem={onAddItem}
          onUpdateProgress={onUpdateProgress}
        />
        <GanttTimelineChart
          items={visibleDated}
          range={range}
          fields={fields}
          bars={bars}
          progressField={progressField}
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
