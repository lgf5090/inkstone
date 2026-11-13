/**
 * The timeline: the whole schedule at a glance, read-only.
 *
 * One row per card, in the board's own parent/child order — not grouped into lanes, because the
 * question here is "what runs when, and what holds what", and a lane band answers a different one.
 * The axis is headed twice (month over every day), blocking edges are drawn between the bars, and a
 * strip under the canvas shows where the viewport sits in the whole range. Changing a date is the
 * Gantt's job; keeping that split means scrolling the overview cannot move a task by accident.
 */
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react'
import { Clock, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import type { ProjectCard, ProjectCardLink, ProjectProperty, ProjectScheduleScale, ProjectViewFields } from '@shared/project/model'
import { isProjectCardDone, projectViewPropertyId } from '@shared/project/model'
import { projectCardColorResolver, projectOptionCssColor } from '@shared/project/option-color'
import {
  PROJECT_TIMELINE_COLUMN_PX,
  projectCardDays,
  projectTimelineBar,
  projectTimelineDays,
  projectTimelineFitScale,
  projectTimelineRows,
  projectTimelineWindow,
} from '@shared/project/timeline-layout'
import { t, useLocale } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox } from '../../../components/form'
import { Legend, Seg, ViewHead, ViewShell, ViewToolbar } from './shell'
import { ScheduleFrame } from './schedule-frame'
import { DependencyEdges, RowToggle, ScheduleBar, UnscheduledTray, type BarGeometry } from './schedule-parts'

const ROW_H = 34
const BAR_H = 18
const SCALES: ProjectScheduleScale[] = ['day', 'week', 'month', 'quarter']

export interface TimelineProps {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  datePropertyId?: string
  links: ProjectCardLink[]
  fields: ProjectViewFields
  subtasksByParent: Map<string, ProjectCard[]>
  canEdit: boolean
  onOpenCard: (id: string) => void
  onPatchFields: (fields: Partial<ProjectViewFields>) => void
}

export function TimelineView(props: TimelineProps): ReactElement {
  const { cards, properties, links, fields } = props
  const locale = useLocale()
  const propertyId = projectViewPropertyId(fields.dateDisplayPropertyId) ?? properties.find((property) => property.type === 'date')?.id
  const scale = fields.scheduleScale ?? 'day'
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [showTray, setShowTray] = useState(true)
  const viewport = useRef<HTMLDivElement | null>(null)
  const today = useMemo(() => Date.now(), [])
  const colorOf = useMemo(() => projectCardColorResolver(properties), [properties])
  const isDone = useCallback((card: ProjectCard) => isProjectCardDone(card, properties), [properties])

  const dated = useMemo(() => cards
    .map((card) => ({ card, days: projectCardDays(card, propertyId) }))
    .filter((entry): entry is { card: ProjectCard, days: { start: number, end: number } } => entry.days !== null), [cards, propertyId])
  const unscheduled = useMemo(() => cards.filter((card) => projectCardDays(card, propertyId) === null), [cards, propertyId])
  const ranges = useMemo(() => dated.map((entry) => ({ from: entry.days.start, to: entry.days.end })), [dated])
  const axisWindow = useMemo(() => projectTimelineWindow(ranges, today), [ranges, today])
  const days = useMemo(() => projectTimelineDays(axisWindow, today), [axisWindow, today])
  const columnPx = PROJECT_TIMELINE_COLUMN_PX[scale]
  const rows = useMemo(() => projectTimelineRows(dated.map((entry) => entry.card), collapsed), [dated, collapsed])
  const daysByCard = useMemo(() => new Map(dated.map((entry) => [entry.card.id, entry.days])), [dated])
  const geometry = useMemo(() => {
    const map = new Map<string, BarGeometry>()
    rows.forEach((row, index) => {
      const range = daysByCard.get(row.card.id)
      if (!range) return
      map.set(row.card.id, { ...projectTimelineBar({ from: range.start, to: range.end }, axisWindow), row: index })
    })
    return map
  }, [rows, daysByCard, axisWindow])

  const showDeps = fields.scheduleShowDependencies !== false
  const showWeekends = fields.scheduleShowWeekends !== false
  const showToday = fields.scheduleShowToday !== false
  const todayIndex = days.findIndex((day) => day.today)
  const statusProperty = properties.find((property) => property.type === 'select')

  const jumpToday = (): void => {
    const node = viewport.current
    if (!node || todayIndex < 0) return
    node.scrollLeft = Math.max(0, todayIndex * columnPx - node.clientWidth / 2)
  }
  const zoom = (direction: 1 | -1): void => {
    const index = SCALES.indexOf(scale)
    const next = SCALES[Math.min(SCALES.length - 1, Math.max(0, index + direction))]
    if (next) props.onPatchFields({ scheduleScale: next })
  }
  const toggle = (id: string): void => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const bindViewport = useCallback((node: HTMLDivElement | null) => { viewport.current = node }, [])

  const legend = useMemo(() => (statusProperty?.options ?? []).map((option) => ({
    key: option.id,
    label: option.value,
    color: projectOptionCssColor(option.color) ?? 'var(--text-quaternary)',
  })), [statusProperty])

  const shortDay = (stamp: number): string => new Date(stamp).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })

  return (
    <ViewShell data-view="timeline">
      <ViewHead
        icon={<Clock size={15} aria-hidden="true" />}
        title={t('project.view.timeline')}
        count={dated.length}
        note={t('project.view.timeline_role')}
      >
        <span className="pv-head-note tabular">{ranges.length > 0 ? `${shortDay(axisWindow.start)} – ${shortDay(axisWindow.end)}` : ''}</span>
        <Button size="sm" variant="secondary" onClick={jumpToday}>{t('project.view.today')}</Button>
        <Button size="sm" variant="ghost" icon={<Maximize2 size={13} />} onClick={() => props.onPatchFields({ scheduleScale: projectTimelineFitScale(ranges, viewport.current?.clientWidth ?? 900) })}>
          {t('project.view.auto_fit')}
        </Button>
      </ViewHead>
      <ViewToolbar>
        <Seg
          value={scale}
          label={t('project.view.scale')}
          disabled={!props.canEdit}
          onChange={(next) => props.onPatchFields({ scheduleScale: next })}
          options={SCALES.map((entry) => ({ value: entry, label: t(`project.view.scale_${entry}` as Parameters<typeof t>[0]) }))}
        />
        <span className="pv-bar-group">
          <IconButton label={t('project.view.zoom_in')} size="sm" disabled={scale === 'day'} onClick={() => zoom(-1)}><ZoomIn size={14} /></IconButton>
          <IconButton label={t('project.view.zoom_out')} size="sm" disabled={scale === 'quarter'} onClick={() => zoom(1)}><ZoomOut size={14} /></IconButton>
        </span>
        <span className="pv-bar-sep" aria-hidden="true" />
        <Checkbox label={t('project.view.show_dependencies')} checked={showDeps} onChange={(checked) => props.onPatchFields({ scheduleShowDependencies: checked })} />
        <Checkbox label={t('project.view.show_weekends')} checked={showWeekends} onChange={(checked) => props.onPatchFields({ scheduleShowWeekends: checked })} />
        <Checkbox label={t('project.view.show_today_line')} checked={showToday} onChange={(checked) => props.onPatchFields({ scheduleShowToday: checked })} />
        {unscheduled.length > 0 && (
          <span className="pv-bar-spacer">
            <Button size="sm" variant="ghost" onClick={() => setShowTray((value) => !value)}>
              {t('project.view.unscheduled_count', { count: unscheduled.length })}
            </Button>
          </span>
        )}
      </ViewToolbar>
      <Legend items={legend} />
      <div className="flex min-h-0 flex-1">
        <ScheduleFrame
          days={days}
          columnPx={columnPx}
          rowCount={rows.length}
          rowHeight={ROW_H}
          axis="double"
          corner={t('project.board.title_column')}
          showToday={showToday}
          showWeekends={showWeekends}
          panEnabled
          onViewport={bindViewport}
          focusColumn={todayIndex}
          emptyHint={t('project.view.no_dates')}
          minimap={{ bars: [...geometry.entries()].map(([id, place]) => ({ id, left: place.left, width: place.width, color: colorOf(rows[place.row]!.card) })) }}
          overlay={() => showDeps
            ? <DependencyEdges links={links} geometry={geometry} rowHeight={ROW_H} columnPx={columnPx} width={days.length * columnPx} height={rows.length * ROW_H} />
            : null}
          renderLeftRow={(index) => {
            const row = rows[index]!
            const range = daysByCard.get(row.card.id)!
            return (
              <div key={row.card.id} className="pv-sched-rowhead" style={{ top: `${index * ROW_H}px`, height: `${ROW_H}px`, paddingLeft: `${8 + row.depth * 14}px` }} data-schedule-row={row.card.id}>
                {row.childCount > 0
                  ? <RowToggle collapsed={collapsed.has(row.card.id)} label={collapsed.has(row.card.id) ? t('project.card.expand_subtasks') : t('project.card.collapse_subtasks')} onToggle={() => toggle(row.card.id)} />
                  : <span className="size-6 shrink-0" aria-hidden="true" />}
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colorOf(row.card) }} aria-hidden="true" />
                <button type="button" className="pv-sched-rowtitle" onClick={() => props.onOpenCard(row.card.id)}>{row.card.title || t('project.board.untitled_card')}</button>
                <span className="shrink-0 text-[length:var(--text-10)] tabular text-[var(--text-quaternary)]">{shortDay(range.start)}–{shortDay(range.end)}</span>
              </div>
            )
          }}
          renderRow={(index) => {
            const row = rows[index]!
            const place = geometry.get(row.card.id)!
            return (
              <ScheduleBar
                key={row.card.id}
                card={row.card}
                color={colorOf(row.card)}
                left={place.left * columnPx}
                width={place.width * columnPx}
                top={index * ROW_H + (ROW_H - BAR_H) / 2}
                height={BAR_H}
                done={isDone(row.card)}
                progress={0}
                conflict={false}
                selected={false}
                draggable={false}
                dragging={false}
                milestone={false}
                tip={`${row.card.title || t('project.board.untitled_card')}\n${shortDay(daysByCard.get(row.card.id)!.start)} → ${shortDay(daysByCard.get(row.card.id)!.end)}`}
                onOpen={() => props.onOpenCard(row.card.id)}
              />
            )
          }}
        />
        {showTray && <UnscheduledTray cards={unscheduled} canEdit={false} onOpen={props.onOpenCard} />}
      </div>
    </ViewShell>
  )
}
