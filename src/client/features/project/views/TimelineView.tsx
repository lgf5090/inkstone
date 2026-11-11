/**
 * The timeline: the whole schedule at a glance, read-only.
 *
 * It answers "what runs when, and what holds what" — so it draws every dated card, the blocking edges
 * between them and today's line, and it pans under the pointer. Changing a date is the Gantt's job;
 * keeping that split means a reader scrolling the overview cannot move a task by accident.
 */
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react'
import { Clock, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import type { ProjectCard, ProjectCardLink, ProjectProperty, ProjectScheduleScale, ProjectViewFields } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import { projectCardColor } from '@shared/project/option-color'
import {
  PROJECT_TIMELINE_COLUMN_PX,
  projectCardDays,
  projectCardProgress,
  projectScheduleRows,
  projectTimelineBar,
  projectTimelineDays,
  projectTimelineFitScale,
  projectTimelineWindow,
} from '@shared/project/timeline-layout'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { Legend, Seg, ViewHead, ViewShell, ViewToolbar } from './shell'
import { ScheduleFrame } from './schedule-frame'
import { DependencyEdges, RowToggle, ScheduleBar, UnscheduledTray, type BarGeometry } from './schedule-parts'

const ROW_H = 36
const BAR_H = 22
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
  const { cards, properties, links, fields, subtasksByParent } = props
  const propertyId = fields.dateDisplayPropertyId ?? properties.find((property) => property.type === 'date')?.id
  const scale = fields.scheduleScale ?? 'day'
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [showTray, setShowTray] = useState(true)
  const viewport = useRef<HTMLDivElement | null>(null)
  const today = Date.now()
  const colorOf = useCallback((card: ProjectCard) => projectCardColor(card, properties), [properties])
  const isDone = useCallback((card: ProjectCard) => isProjectCardDone(card, properties), [properties])

  const dated = useMemo(() => cards
    .map((card) => ({ card, days: projectCardDays(card, propertyId) }))
    .filter((entry): entry is { card: ProjectCard, days: { start: number, end: number } } => entry.days !== null), [cards, propertyId])
  const unscheduled = useMemo(() => cards.filter((card) => projectCardDays(card, propertyId) === null), [cards, propertyId])
  const ranges = dated.map((entry) => ({ from: entry.days.start, to: entry.days.end }))
  const axisWindow = useMemo(() => projectTimelineWindow(ranges, today), [ranges, today])
  const days = useMemo(() => projectTimelineDays(axisWindow, today), [axisWindow, today])
  const columnPx = PROJECT_TIMELINE_COLUMN_PX[scale]
  const rows = useMemo(
    () => projectScheduleRows(dated.map((entry) => entry.card), { groupById: fields.scheduleGroupById, properties, collapsed, colorOf }),
    [dated, fields.scheduleGroupById, properties, collapsed, colorOf],
  )
  const daysByCard = useMemo(() => new Map(dated.map((entry) => [entry.card.id, entry.days])), [dated])
  const geometry = useMemo(() => {
    const map = new Map<string, BarGeometry>()
    rows.forEach((row, index) => {
      if (!row.card) return
      const range = daysByCard.get(row.card.id)
      if (!range) return
      const bar = projectTimelineBar({ from: range.start, to: range.end }, axisWindow)
      map.set(row.card.id, { ...bar, row: index })
    })
    return map
  }, [rows, daysByCard, axisWindow])

  const showDeps = fields.scheduleShowDependencies !== false
  const showWeekends = fields.scheduleShowWeekends !== false
  const showToday = fields.scheduleShowToday !== false
  const groupable = properties.filter((property) => property.type === 'select' || property.type === 'person')
  const todayIndex = days.findIndex((day) => day.today)

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

  const legend = useMemo(() => {
    const property = properties.find((entry) => entry.id === fields.scheduleGroupById)
    if (!property) return []
    return property.options.map((option) => ({
      key: option.id,
      label: option.value,
      color: projectCardColor({ values: { [property.id]: option.id } }, properties),
    }))
  }, [properties, fields.scheduleGroupById])

  const bindViewport = useCallback((node: HTMLDivElement | null) => { viewport.current = node }, [])

  return (
    <ViewShell data-view="timeline">
      <ViewHead
        icon={<Clock size={15} aria-hidden="true" />}
        title={t('project.view.timeline')}
        count={dated.length}
        note={t('project.view.timeline_hint')}
      >
        <Button size="sm" variant="secondary" onClick={jumpToday}>{t('project.view.today')}</Button>
        <Button size="sm" variant="ghost" icon={<Maximize2 size={13} />} onClick={() => props.onPatchFields({ scheduleScale: projectTimelineFitScale(ranges, viewport.current?.clientWidth ?? 900) })}>
          {t('project.view.auto_fit')}
        </Button>
      </ViewHead>
      <ViewToolbar>
        <Seg
          value={scale}
          label={t('project.view.scale')}
          onChange={(next) => props.onPatchFields({ scheduleScale: next })}
          options={SCALES.map((entry) => ({ value: entry, label: t(`project.view.scale_${entry}` as Parameters<typeof t>[0]) }))}
        />
        <span className="pv-bar-group">
          <IconButton label={t('project.view.zoom_in')} size="sm" disabled={scale === 'day'} onClick={() => zoom(-1)}><ZoomIn size={14} /></IconButton>
          <IconButton label={t('project.view.zoom_out')} size="sm" disabled={scale === 'quarter'} onClick={() => zoom(1)}><ZoomOut size={14} /></IconButton>
        </span>
        <span className="pv-bar-sep" aria-hidden="true" />
        <SelectMenu
          className="w-36"
          size="sm"
          value={fields.scheduleGroupById ?? ''}
          label={t('project.view.group_lanes')}
          onChange={(value) => props.onPatchFields({ scheduleGroupById: value || undefined })}
          options={[{ value: '', label: t('project.view.group_lanes') }, ...groupable.map((property) => ({ value: property.id, label: property.name }))]}
        />
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
          corner={t('project.board.title_column')}
          showToday={showToday}
          showWeekends={showWeekends}
          panEnabled
          onViewport={bindViewport}
          focusColumn={todayIndex}
          emptyHint={t('project.view.no_dates')}
          overlay={() => showDeps
            ? <DependencyEdges links={links} geometry={geometry} rowHeight={ROW_H} columnPx={columnPx} width={days.length * columnPx} height={rows.length * ROW_H} />
            : null}
          renderLeftRow={(index) => {
            const row = rows[index]!
            if (row.kind === 'lane') {
              return (
                <div key={row.id} className="pv-sched-lanehead" style={{ top: `${index * ROW_H}px`, '--pv-lane-color': row.color } as React.CSSProperties}>
                  <RowToggle collapsed={collapsed.has(row.id)} label={row.label || t('project.view.no_value')} onToggle={() => toggle(row.id)} />
                  <span className="min-w-0 flex-1 truncate">{row.label || t('project.view.no_value')}</span>
                  <span className="pv-head-count">{row.childCount}</span>
                </div>
              )
            }
            const card = row.card!
            return (
              <div key={row.id} className="pv-sched-rowhead" style={{ top: `${index * ROW_H}px`, paddingLeft: `${8 + row.depth * 14}px` }} data-schedule-row={card.id}>
                {row.childCount > 0
                  ? <RowToggle collapsed={collapsed.has(card.id)} label={t('project.card.expand_subtasks')} onToggle={() => toggle(card.id)} />
                  : <span className="size-6 shrink-0" aria-hidden="true" />}
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} aria-hidden="true" />
                <button type="button" className="pv-sched-rowtitle" onClick={() => props.onOpenCard(card.id)}>{card.title || t('project.board.untitled_card')}</button>
              </div>
            )
          }}
          renderRow={(index) => {
            const row = rows[index]!
            if (row.kind === 'lane') {
              return <div key={row.id} className="pv-sched-laneband" style={{ top: `${index * ROW_H}px`, height: `${ROW_H}px`, '--pv-lane-color': row.color } as React.CSSProperties} aria-hidden="true" />
            }
            const card = row.card!
            const place = geometry.get(card.id)!
            return (
              <ScheduleBar
                key={card.id}
                card={card}
                color={row.color}
                left={place.left * columnPx}
                width={place.width * columnPx}
                top={index * ROW_H + (ROW_H - BAR_H) / 2}
                height={BAR_H}
                done={isDone(card)}
                progress={projectCardProgress(card, subtasksByParent.get(card.id) ?? [], isDone)}
                conflict={false}
                selected={false}
                draggable={false}
                dragging={false}
                milestone={false}
                onOpen={() => props.onOpenCard(card.id)}
              />
            )
          }}
        />
        {showTray && <UnscheduledTray cards={unscheduled} canEdit={false} onOpen={props.onOpenCard} />}
      </div>
    </ViewShell>
  )
}