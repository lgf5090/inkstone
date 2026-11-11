/**
 * The Gantt: the schedule you edit.
 *
 * Where the timeline reads, this writes. A bar moves whole or by either end, an empty stretch of a
 * lane is dragged out to create a card on those dates, a double click renames it in place, and a right
 * click moves it to another status — the card model has no free colour field, so the palette is the
 * status palette, which is the thing a reader actually means by "make this one green".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { CalendarRange, Maximize2, Plus, Settings2, Trash2, ZoomIn, ZoomOut } from 'lucide-react'
import type { ProjectCard, ProjectCardLink, ProjectProperty, ProjectScheduleScale, ProjectViewFields } from '@shared/project/model'
import { isProjectCardDone, projectViewPropertyId } from '@shared/project/model'
import { projectCardColor, projectOptionCssColor } from '@shared/project/option-color'
import { projectDayToStamp } from '@shared/project/date'
import {
  PROJECT_TIMELINE_COLUMN_PX,
  PROJECT_TIMELINE_DAY_MS,
  projectCardDays,
  projectCardProgress,
  projectScheduleConflicts,
  projectScheduleRows,
  projectTimelineBar,
  projectTimelineDays,
  projectTimelineDragRange,
  projectTimelineFitScale,
  projectTimelineWindow,
} from '@shared/project/timeline-layout'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Checkbox, Input } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { prompt } from '../../../components/overlay'
import { isImeComposing } from '../../../lib/ime'
import { createProjectCard } from '../api'
import { Legend, Seg, ViewHead, ViewShell, ViewToolbar } from './shell'
import { ScheduleFrame } from './schedule-frame'
import { DependencyEdges, RowToggle, ScheduleBar, UnscheduledTray, type BarGeometry } from './schedule-parts'

const ROW_H = 40
const BAR_H = 24
const SCALES: ProjectScheduleScale[] = ['day', 'week', 'month', 'quarter']

export interface GanttProps {
  cards: ProjectCard[]
  boardId: string
  properties: ProjectProperty[]
  links: ProjectCardLink[]
  fields: ProjectViewFields
  subtasksByParent: Map<string, ProjectCard[]>
  canEdit: boolean
  onOpenCard: (id: string) => void
  onPatchCard: (id: string, patch: Record<string, unknown>) => Promise<void>
  onPatchFields: (fields: Partial<ProjectViewFields>) => void
  onRefresh: () => Promise<void>
}

interface DragState {
  id: string
  mode: 'move' | 'start' | 'end'
  columns: number
}

export function GanttView(props: GanttProps): ReactElement {
  const { cards, properties, links, fields, subtasksByParent, canEdit } = props
  const propertyId = projectViewPropertyId(fields.dateDisplayPropertyId) ?? properties.find((property) => property.type === 'date')?.id
  const statusProperty = properties.find((property) => property.type === 'select')
  const scale = fields.scheduleScale ?? 'day'
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [drag, setDrag] = useState<DragState | null>(null)
  const [draft, setDraft] = useState<{ row: number, from: number, to: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string, value: string } | null>(null)
  const [palette, setPalette] = useState<{ id: string, x: number, y: number } | null>(null)
  const [showTray, setShowTray] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const viewport = useRef<HTMLDivElement | null>(null)
  const today = Date.now()
  const colorOf = useCallback((card: ProjectCard) => projectCardColor(card, properties), [properties])
  const isDone = useCallback((card: ProjectCard) => isProjectCardDone(card, properties), [properties])
  const planning = canEdit && Boolean(propertyId)

  const dated = useMemo(() => cards
    .map((card) => ({ card, days: projectCardDays(card, propertyId) }))
    .filter((entry): entry is { card: ProjectCard, days: { start: number, end: number } } => entry.days !== null), [cards, propertyId])
  const unscheduled = useMemo(() => cards.filter((card) => projectCardDays(card, propertyId) === null), [cards, propertyId])
  const ranges = dated.map((entry) => ({ from: entry.days.start, to: entry.days.end }))
  const axisWindow = useMemo(() => projectTimelineWindow(ranges, today), [ranges, today])
  const days = useMemo(() => projectTimelineDays(axisWindow, today), [axisWindow, today])
  const columnPx = PROJECT_TIMELINE_COLUMN_PX[scale]
  const rows = useMemo(
    () => projectScheduleRows(dated.map((entry) => entry.card), {
      groupById: fields.scheduleGroupById ?? statusProperty?.id,
      properties,
      collapsed,
      colorOf,
    }),
    [dated, fields.scheduleGroupById, statusProperty?.id, properties, collapsed, colorOf],
  )
  const daysByCard = useMemo(() => new Map(dated.map((entry) => [entry.card.id, entry.days])), [dated])
  const conflicts = useMemo(() => projectScheduleConflicts(links, daysByCard), [links, daysByCard])
  const geometry = useMemo(() => {
    const map = new Map<string, BarGeometry>()
    rows.forEach((row, index) => {
      if (!row.card) return
      const range = daysByCard.get(row.card.id)
      if (!range) return
      map.set(row.card.id, { ...projectTimelineBar({ from: range.start, to: range.end }, axisWindow), row: index })
    })
    return map
  }, [rows, daysByCard, axisWindow])

  // The overview owns the dependency picture; the planner opens on conflicts and effort instead.
  const showDeps = fields.scheduleShowDependencies === true
  const showWeekends = fields.scheduleShowWeekends !== false
  const showToday = fields.scheduleShowToday !== false
  const todayIndex = days.findIndex((day) => day.today)
  const groupable = properties.filter((property) => property.type === 'select' || property.type === 'person')
  const effortProperty = properties.find((property) => property.type === 'number')
  const laneEffort = (laneKey: string): number => (effortProperty
    ? dated.filter((entry) => (entry.card.values[fields.scheduleGroupById ?? statusProperty?.id ?? ''] ?? '') === laneKey)
      .reduce((sum, entry) => sum + (Number(entry.card.values[effortProperty.id]) || 0), 0)
    : 0)

  const writeRange = (cardId: string, from: number, to: number): void => {
    if (!propertyId) return
    const value = to === from ? { from: projectDayToStamp(new Date(from)) } : { from: projectDayToStamp(new Date(from)), to: projectDayToStamp(new Date(to)) }
    void props.onPatchCard(cardId, { values: { [propertyId]: JSON.stringify(value) } })
  }

  /** One pointer path for moving a bar and for pulling either of its ends. */
  const startBarDrag = (event: React.PointerEvent, card: ProjectCard, mode: DragState['mode']): void => {
    if (!planning || event.button !== 0) return
    event.stopPropagation()
    const range = daysByCard.get(card.id)
    if (!range) return
    const startX = event.clientX
    let columns = 0
    let moved = false
    setSelected(card.id)
    const move = (moveEvent: PointerEvent): void => {
      const delta = Math.round((moveEvent.clientX - startX) / columnPx)
      if (delta === columns && moved) return
      moved = true
      columns = delta
      setDrag({ id: card.id, mode, columns })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (!moved || columns === 0) return
      if (mode === 'move') {
        const next = projectTimelineDragRange({ from: range.start, to: range.end }, columns)
        writeRange(card.id, next.from, next.to)
        return
      }
      const shift = columns * PROJECT_TIMELINE_DAY_MS
      const from = mode === 'start' ? Math.min(range.end, range.start + shift) : range.start
      const to = mode === 'end' ? Math.max(from, range.end + shift) : range.end
      writeRange(card.id, from, to)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Dragging an empty stretch of a lane draws a ghost, then files a new card on those dates. */
  const startDraw = (event: React.PointerEvent, context: { column: number, row: number }): void => {
    if (!planning || event.button !== 0) return
    if ((event.target as HTMLElement).closest('[data-schedule-bar]') || (event.target as HTMLElement).closest('button')) return
    const row = rows[context.row]
    if (!row) return
    const node = viewport.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const columnAt = (clientX: number): number => Math.max(0, Math.min(days.length - 1, Math.floor((clientX - rect.left + node.scrollLeft) / columnPx)))
    const from = columnAt(event.clientX)
    setDraft({ row: context.row, from, to: from })
    let latest = from
    const move = (moveEvent: PointerEvent): void => {
      latest = columnAt(moveEvent.clientX)
      setDraft({ row: context.row, from, to: latest })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraft(null)
      const a = Math.min(from, latest)
      const b = Math.max(from, latest)
      void createOnSpan(row.laneKey, a, b)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const createOnSpan = async (laneKey: string, fromColumn: number, toColumn: number): Promise<void> => {
    if (!propertyId) return
    const from = days[fromColumn]?.stamp
    const to = days[toColumn]?.stamp
    if (from === undefined || to === undefined) return
    const name = await prompt({
      title: t('project.view.create_card_here'),
      description: `${new Date(from).toLocaleDateString()} → ${new Date(to).toLocaleDateString()}`,
      confirmLabel: t('common.save'),
    })
    if (!name || !name.trim()) return
    const groupProperty = properties.find((property) => property.id === (fields.scheduleGroupById ?? statusProperty?.id))
    const values: Record<string, string> = {
      [propertyId]: JSON.stringify(to === from ? { from: projectDayToStamp(new Date(from)) } : { from: projectDayToStamp(new Date(from)), to: projectDayToStamp(new Date(to)) }),
    }
    if (groupProperty && laneKey) values[groupProperty.id] = laneKey
    await createProjectCard(props.boardId, { title: name.trim(), values })
    await props.onRefresh()
  }

  const commitRename = async (): Promise<void> => {
    const current = renaming
    setRenaming(null)
    if (!current) return
    const value = current.value.trim()
    if (!value) return
    await props.onPatchCard(current.id, { title: value })
  }

  const setStatus = (cardId: string, optionId: string): void => {
    setPalette(null)
    if (!statusProperty) return
    void props.onPatchCard(cardId, { values: { [statusProperty.id]: optionId === '' ? null : optionId } })
  }

  const unschedule = (cardId: string): void => {
    if (!propertyId) return
    setSelected(null)
    void props.onPatchCard(cardId, { values: { [propertyId]: null } })
  }

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

  // Escape backs out of whatever is open; Delete takes the selected bar off the schedule rather than
  // deleting the card, because the card is still real work — only its dates were wrong.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return
      if (event.key === 'Escape') { setPalette(null); setSelected(null); setDraft(null); return }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected && planning) {
        event.preventDefault()
        unschedule(selected)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, planning, propertyId])

  useEffect(() => {
    if (!palette) return
    const onDown = (event: MouseEvent): void => {
      if (!(event.target as HTMLElement).closest('[data-bar-palette]')) setPalette(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [palette])
  const legend = useMemo(() => {
    const property = properties.find((entry) => entry.id === (fields.scheduleGroupById ?? statusProperty?.id))
    if (!property) return []
    return property.options.map((option) => ({
      key: option.id,
      label: option.value,
      color: projectOptionCssColor(option.color) ?? 'var(--text-quaternary)',
    }))
  }, [properties, fields.scheduleGroupById, statusProperty?.id])

  return (
    <ViewShell data-view="gantt">
      <ViewHead
        icon={<CalendarRange size={15} aria-hidden="true" />}
        title={t('project.view.gantt')}
        count={dated.length}
        note={t('project.view.gantt_role')}
      >
        {planning && (
          <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => { void createOnSpan('', Math.max(0, todayIndex), Math.max(0, todayIndex)) }}>
            {t('project.view.new_schedule')}
          </Button>
        )}
        {conflicts.size > 0 && (
          <span className="rounded-[var(--r-full)] bg-[var(--danger-soft)] px-2 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--danger)]" role="status">
            {t('project.view.conflicts', { count: conflicts.size })}
          </span>
        )}
        <Button size="sm" variant="secondary" onClick={jumpToday}>{t('project.view.today')}</Button>
        <Button size="sm" variant="ghost" icon={<Maximize2 size={13} />} onClick={() => props.onPatchFields({ scheduleScale: projectTimelineFitScale(ranges, viewport.current?.clientWidth ?? 900) })}>
          {t('project.view.auto_fit')}
        </Button>
        <IconButton label={t('project.view.gantt_settings')} size="sm" active={showSettings} aria-expanded={showSettings} onClick={() => setShowSettings((value) => !value)}>
          <Settings2 size={15} />
        </IconButton>
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
          value={fields.scheduleGroupById ?? statusProperty?.id ?? ''}
          label={t('project.view.group_lanes')}
          disabled={!canEdit}
          onChange={(value) => props.onPatchFields({ scheduleGroupById: value })}
          options={[{ value: '', label: t('project.view.no_value') }, ...groupable.map((property) => ({ value: property.id, label: property.name }))]}
        />
        <span className="pv-head-note">{t('project.view.gantt_hint')}</span>
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
          axis="single"
          hourTicks={scale === 'day'}
          corner={t('project.view.gantt_lanes')}
          showToday={showToday}
          showWeekends={showWeekends}
          drawEnabled={planning}
          onViewport={bindViewport}
          focusColumn={todayIndex}
          onCanvasPointerDown={startDraw}
          emptyHint={planning ? t('project.view.draw_hint') : t('project.view.no_dates')}
          canvasExtra={draft
            ? (
              <div
                className="pv-draw-preview"
                data-draw-preview=""
                style={{
                  left: `${Math.min(draft.from, draft.to) * columnPx}px`,
                  width: `${(Math.abs(draft.to - draft.from) + 1) * columnPx}px`,
                  top: `${draft.row * ROW_H + (ROW_H - BAR_H) / 2}px`,
                }}
                aria-hidden="true"
              />
            )
            : null}
          overlay={() => showDeps
            ? <DependencyEdges links={links} geometry={geometry} rowHeight={ROW_H} columnPx={columnPx} width={days.length * columnPx} height={rows.length * ROW_H} />
            : null}
          renderLeftRow={(index) => {
            const row = rows[index]!
            if (row.kind === 'lane') {
              return (
                <div key={row.id} className="pv-sched-lanehead" style={{ top: `${index * ROW_H}px`, height: `${ROW_H}px`, '--pv-lane-color': row.color } as React.CSSProperties}>
                  <RowToggle collapsed={collapsed.has(row.id)} label={row.label || t('project.view.no_value')} onToggle={() => toggle(row.id)} />
                  <span className="min-w-0 flex-1 truncate">{row.label || t('project.view.no_value')}</span>
                  {effortProperty && <span className="pv-lane-sum">{t('project.view.lane_effort', { value: laneEffort(row.laneKey) })}</span>}
                  <span className="pv-head-count">{row.childCount}</span>
                </div>
              )
            }
            const card = row.card!
            return (
              <div
                key={row.id}
                className="pv-sched-rowhead"
                data-selected={selected === card.id}
                style={{ top: `${index * ROW_H}px`, height: `${ROW_H}px`, paddingLeft: `${8 + row.depth * 14}px` }}
                data-schedule-row={card.id}
              >
                {row.childCount > 0
                  ? <RowToggle collapsed={collapsed.has(card.id)} label={t('project.card.expand_subtasks')} onToggle={() => toggle(card.id)} />
                  : <span className="size-6 shrink-0" aria-hidden="true" />}
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} aria-hidden="true" />
                <button type="button" className="pv-sched-rowtitle" onClick={() => props.onOpenCard(card.id)}>{card.title || t('project.board.untitled_card')}</button>
                {conflicts.has(card.id) && <span className="shrink-0 rounded-[var(--r-xs)] bg-[var(--danger-soft)] px-1 text-[length:var(--text-10)] text-[var(--danger)]">{t('project.view.blocked')}</span>}
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
            const active = drag?.id === card.id ? drag : null
            const shift = active?.mode === 'move' ? active.columns : 0
            const growStart = active?.mode === 'start' ? active.columns : 0
            const growEnd = active?.mode === 'end' ? active.columns : 0
            const left = (place.left + shift + growStart) * columnPx
            const width = Math.max(columnPx, (place.width - growStart + growEnd) * columnPx)
            const range = daysByCard.get(card.id)!
            const milestone = range.start === range.end && scale !== 'day'
            return (
              <div key={card.id}>
                <ScheduleBar
                  card={card}
                  color={row.color}
                  left={left}
                  width={width}
                  top={index * ROW_H + (ROW_H - BAR_H) / 2}
                  height={BAR_H}
                  done={isDone(card)}
                  progress={projectCardProgress(card, subtasksByParent.get(card.id) ?? [], isDone)}
                  conflict={conflicts.has(card.id)}
                  selected={selected === card.id}
                  draggable={planning}
                  dragging={Boolean(active)}
                  milestone={milestone}
                  onOpen={() => { if (!drag) props.onOpenCard(card.id) }}
                  onPointerDown={(event) => startBarDrag(event, card, 'move')}
                  onDoubleClick={() => { if (planning) setRenaming({ id: card.id, value: card.title }) }}
                  onContextMenu={(event) => {
                    if (!planning) return
                    event.preventDefault()
                    setSelected(card.id)
                    setPalette({ id: card.id, x: Math.min(event.clientX, window.innerWidth - 240), y: Math.min(event.clientY, window.innerHeight - 120) })
                  }}
                >
                  {planning && !milestone && (
                    <>
                      <span className="pv-bar-handle" data-side="start" data-bar-handle="start" onPointerDown={(event) => startBarDrag(event, card, 'start')} />
                      <span className="pv-bar-handle" data-side="end" data-bar-handle="end" onPointerDown={(event) => startBarDrag(event, card, 'end')} />
                    </>
                  )}
                </ScheduleBar>
                {renaming?.id === card.id && (
                  <Input
                    className="pv-rename"
                    style={{ left: `${left}px`, width: `${Math.max(160, width)}px`, top: `${index * ROW_H + (ROW_H - BAR_H) / 2}px` }}
                    autoFocus
                    value={renaming.value}
                    aria-label={t('project.view.rename_card')}
                    onChange={(event) => setRenaming({ id: card.id, value: event.target.value })}
                    onBlur={() => { void commitRename() }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !isImeComposing(event)) { event.preventDefault(); void commitRename() }
                      else if (event.key === 'Escape' && !isImeComposing(event)) { event.preventDefault(); setRenaming(null) }
                    }}
                  />
                )}
              </div>
            )
          }}
        />
        {showTray && (
          <UnscheduledTray
            cards={unscheduled}
            canEdit={planning}
            onOpen={props.onOpenCard}
            onSchedule={(id) => { const base = new Date(); base.setHours(0, 0, 0, 0); writeRange(id, base.getTime(), base.getTime()) }}
          />
        )}
      </div>
      {showSettings && (
        <div className="pv-drawer" role="group" aria-label={t('project.view.gantt_settings')} data-gantt-settings="">
          <div className="pv-drawer-row">
            <span className="pv-bar-label">{t('project.view.scale')}</span>
            <Seg
              value={scale}
              label={t('project.view.scale')}
              onChange={(next) => props.onPatchFields({ scheduleScale: next })}
              options={SCALES.map((entry) => ({ value: entry, label: t(`project.view.scale_${entry}` as Parameters<typeof t>[0]) }))}
            />
          </div>
          <Checkbox label={t('project.view.show_today_line')} checked={showToday} onChange={(checked) => props.onPatchFields({ scheduleShowToday: checked })} />
          <Checkbox label={t('project.view.show_weekends')} checked={showWeekends} onChange={(checked) => props.onPatchFields({ scheduleShowWeekends: checked })} />
          <Checkbox label={t('project.view.show_dependencies')} checked={showDeps} onChange={(checked) => props.onPatchFields({ scheduleShowDependencies: checked })} />
          <p className="pv-drawer-hint">{t('project.view.gantt_hint')}</p>
          <div className="pv-drawer-foot">
            <Button size="sm" variant="ghost" onClick={() => props.onPatchFields({ scheduleScale: 'day', scheduleShowToday: true, scheduleShowWeekends: true, scheduleShowDependencies: false })}>
              {t('project.view.reset_schedule')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowSettings(false)}>{t('common.close')}</Button>
          </div>
        </div>
      )}
      {palette && statusProperty && (
        <div className="pv-palette" style={{ left: `${palette.x}px`, top: `${palette.y}px` }} role="menu" aria-label={t('project.view.set_status')} data-bar-palette="">
          {statusProperty.options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              className="pv-palette-swatch"
              aria-label={option.value}
              title={option.value}
              aria-pressed={cards.find((card) => card.id === palette.id)?.values[statusProperty.id] === option.id}
              style={{ backgroundColor: projectOptionCssColor(option.color) ?? 'var(--text-quaternary)' }}
              onClick={() => setStatus(palette.id, option.id)}
            />
          ))}
          <button type="button" role="menuitem" className="pv-palette-swatch" aria-label={t('project.view.unschedule')} title={t('project.view.unschedule')} style={{ backgroundColor: 'var(--bg-sunken)' }} onClick={() => { setPalette(null); unschedule(palette.id) }}>
            <Trash2 size={11} aria-hidden="true" className="mx-auto text-[var(--danger)]" />
          </button>
        </div>
      )}
    </ViewShell>
  )
}
