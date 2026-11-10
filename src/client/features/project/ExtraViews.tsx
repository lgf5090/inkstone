/**
 * The four added views (X-1): a compact list, a timeline and Gantt laid over the cards' date range,
 * and a distribution chart. They reuse the same filtered/sorted cards and the shared grouping; the
 * Gantt additionally surfaces blocking dependencies as a badge rather than drawn edges.
 */
import { Fragment, useMemo, useState, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight, CornerDownRight, Plus, Trash2 } from 'lucide-react'
import type { ProjectCard, ProjectCardLink, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import type { ProjectCardBadges } from '@shared/project/badges'
import { groupProjectCards, projectPropertyDisplayText } from '@shared/project/view-eval'
import { PROJECT_TIMELINE_COLUMN_PX, projectCardDays, projectTimelineBar, projectTimelineDays, projectTimelineRows, projectTimelineWindow, type ProjectTimelineScale } from '@shared/project/timeline-layout'
import { t, useLocale } from '../../lib/i18n'
import { Segmented } from '../../components/form'
import { Button } from '../../components/primitives'
import { Checkbox } from '../../components/form'
import { IconButton } from '../../components/primitives'
import { CardBadges, OptionChip } from './CardBadges'

export function ListView({
  cards,
  properties,
  canEdit = false,
  badgesFor,
  onOpenCard,
  onCardContextMenu,
  onAddSubtask,
  onToggleCardDone,
  onDeleteCard,
}: {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  canEdit?: boolean
  badgesFor?: (cardId: string) => ProjectCardBadges
  onOpenCard: (id: string) => void
  onCardContextMenu?: (event: MouseEvent, card: ProjectCard) => void
  onAddSubtask?: (parentCardId: string) => Promise<void>
  onToggleCardDone?: (card: ProjectCard, checked: boolean) => Promise<void>
  onDeleteCard?: (id: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const cardIds = useMemo(() => new Set(cards.map((c) => c.id)), [cards])
  const subtasksByParent = useMemo(() => {
    const map = new Map<string, ProjectCard[]>()
    for (const card of cards) {
      if (card.parentId && cardIds.has(card.parentId)) {
        const list = map.get(card.parentId)
        if (list) list.push(card)
        else map.set(card.parentId, [card])
      }
    }
    return map
  }, [cards, cardIds])

  const rootCards = useMemo(() => cards.filter((c) => !c.parentId || !cardIds.has(c.parentId)), [cards, cardIds])

  const renderPropertyCell = (card: ProjectCard, property: ProjectProperty) => {
    if (property.type === 'select' && card.values[property.id]) {
      return <OptionChip property={property} value={card.values[property.id]!} />
    }
    return projectPropertyDisplayText(card, property)
  }

  return (
    <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
      {rootCards.map((card) => {
        const cardSubtasks = subtasksByParent.get(card.id) ?? []
        const hasSubtasks = cardSubtasks.length > 0
        const isExpanded = expanded.has(card.id)
        const isDone = isProjectCardDone(card, properties)
        const doneCount = cardSubtasks.filter((s) => isProjectCardDone(s, properties)).length
        const cardBadges = badgesFor ? badgesFor(card.id) : undefined

        return (
          <Fragment key={card.id}>
            <li
              className="group/listitem hover:bg-[var(--bg-hover)] transition-colors"
              onContextMenu={(event) => onCardContextMenu?.(event, card)}
            >
              <div className="flex w-full items-center gap-2 px-3 py-1.5">
                {hasSubtasks ? (
                  <button
                    type="button"
                    aria-label={isExpanded ? t('project.card.collapse_subtasks') : t('project.card.expand_subtasks')}
                    aria-expanded={isExpanded}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                    onClick={() => toggleExpand(card.id)}
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                ) : (
                  <span className="w-5 shrink-0" aria-hidden="true" />
                )}
                {onToggleCardDone && (
                  <Checkbox
                    ariaLabel={card.title || t('project.board.untitled_card')}
                    checked={isDone}
                    disabled={!canEdit}
                    onChange={(checked) => {
                      void onToggleCardDone(card, checked)
                    }}
                  />
                )}
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  onClick={() => onOpenCard(card.id)}
                >
                  <span className={`min-w-0 flex-1 truncate text-[length:var(--text-12)] ${isDone ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]'}`}>
                    {card.title || t('project.board.untitled_card')}
                  </span>
                  {cardBadges && <CardBadges badges={cardBadges} />}
                  {hasSubtasks && (
                    <span className="shrink-0 rounded bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[length:var(--text-11)] font-medium text-[var(--text-tertiary)]">
                      {doneCount}/{cardSubtasks.length}
                    </span>
                  )}
                  {properties.slice(0, 3).map((property) => (
                    <span key={property.id} className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {renderPropertyCell(card, property)}
                    </span>
                  ))}
                </button>
                {canEdit && onAddSubtask && (
                  <IconButton
                    label={t('project.card.add_subtask')}
                    size="sm"
                    className="opacity-0 group-hover/listitem:opacity-100 transition-opacity"
                    onClick={() => void onAddSubtask(card.id)}
                  >
                    <Plus size={13} />
                  </IconButton>
                )}
                {canEdit && onDeleteCard && (
                  <IconButton
                    label={t('project.board.delete_card')}
                    size="sm"
                    className="opacity-0 group-hover/listitem:opacity-100 transition-opacity"
                    onClick={() => onDeleteCard(card.id)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </div>
            </li>
            {hasSubtasks && isExpanded && cardSubtasks.map((subtask) => {
              const subtaskDone = isProjectCardDone(subtask, properties)
              const subtaskBadges = badgesFor ? badgesFor(subtask.id) : undefined
              return (
                <li
                  key={subtask.id}
                  className="group/subitem bg-[var(--bg-sunken)]/40 hover:bg-[var(--bg-hover)] transition-colors"
                  onContextMenu={(event) => onCardContextMenu?.(event, subtask)}
                >
                  <div className="flex w-full items-center gap-2 py-1.5 pl-9 pr-3">
                    <CornerDownRight size={13} className="shrink-0 text-[var(--text-tertiary)]" />
                    {onToggleCardDone && (
                      <Checkbox
                        ariaLabel={subtask.title || t('project.board.untitled_card')}
                        checked={subtaskDone}
                        disabled={!canEdit}
                        onChange={(checked) => {
                          void onToggleCardDone(subtask, checked)
                        }}
                      />
                    )}
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      onClick={() => onOpenCard(subtask.id)}
                    >
                      <span className={`min-w-0 flex-1 truncate text-[length:var(--text-12)] ${subtaskDone ? 'text-[var(--text-tertiary)] line-through' : 'text-[var(--text-primary)]'}`}>
                        {subtask.title || t('project.board.untitled_card')}
                      </span>
                      {subtaskBadges && <CardBadges badges={subtaskBadges} />}
                      {properties.slice(0, 3).map((property) => (
                        <span key={property.id} className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                          {renderPropertyCell(subtask, property)}
                        </span>
                      ))}
                    </button>
                    {canEdit && onDeleteCard && (
                      <IconButton
                        label={t('project.board.delete_card')}
                        size="sm"
                        className="opacity-0 group-hover/subitem:opacity-100 transition-opacity"
                        onClick={() => onDeleteCard(subtask.id)}
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    )}
                  </div>
                </li>
              )
            })}
          </Fragment>
        )
      })}
    </ul>
  )
}

export function TimelineView({ cards, properties, datePropertyId, links, gantt, onOpenCard }: {
  cards: ProjectCard[]
  properties: ProjectProperty[]
  datePropertyId?: string
  links: ProjectCardLink[]
  gantt: boolean
  onOpenCard: (id: string) => void
}) {
  const locale = useLocale()
  const [scale, setScale] = useState<ProjectTimelineScale>('day')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [showUnscheduled, setShowUnscheduled] = useState(true)
  const propertyId = datePropertyId ?? properties.find((property) => property.type === 'date')?.id
  const today = Date.now()
  const dated = cards
    .map((card) => ({ card, days: projectCardDays(card, propertyId) }))
    .filter((entry): entry is { card: ProjectCard, days: { start: number, end: number } } => entry.days !== null)
  const unscheduled = cards.filter((card) => projectCardDays(card, propertyId) === null)
  const window = projectTimelineWindow(dated.map((entry) => ({ from: entry.days.start, to: entry.days.end })), today)
  const days = projectTimelineDays(window, today)
  const columnPx = PROJECT_TIMELINE_COLUMN_PX[scale]
  const rows = projectTimelineRows(dated.map((entry) => entry.card), collapsed)
  const daysByCard = new Map(dated.map((entry) => [entry.card.id, entry.days]))
  const blocked = new Set(links.filter((link) => link.kind === 'blocks').map((link) => link.toCardId))
  const todayColumn = days.findIndex((entry) => entry.today)
  const monthRuns: { label: string, span: number }[] = []
  for (const entry of days) {
    const label = new Date(entry.stamp).toLocaleDateString(locale, { year: 'numeric', month: 'short' })
    const last = monthRuns[monthRuns.length - 1]
    if (last && last.label === label) last.span += 1
    else monthRuns.push({ label, span: 1 })
  }
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-project-timeline="">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
        <Segmented
          value={scale}
          onChange={setScale}
          size="sm"
          label={t('project.view.scale')}
          options={[
            { value: 'day', label: t('project.view.scale_day') },
            { value: 'week', label: t('project.view.scale_week') },
            { value: 'month', label: t('project.view.scale_month') },
          ]}
        />
        <span className="ml-auto text-[length:var(--text-12)] text-[var(--text-tertiary)]">
          {t('project.view.unscheduled_count', { count: unscheduled.length })}
        </span>
        {unscheduled.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowUnscheduled((value) => !value)}>
            {t('project.view.unscheduled')}
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto">
        <div className="sticky left-0 z-10 w-56 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-base)]">
          <div className="flex h-12 items-center border-b border-[var(--border-subtle)] px-3 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('project.board.title_column')}
          </div>
          {rows.map(({ card, depth, childCount }) => (
            <div key={card.id} className="flex h-9 items-center gap-1 border-b border-[var(--border-subtle)] px-2" style={{ paddingLeft: `${8 + depth * 14}px` }}>
              {childCount > 0 ? (
                <button
                  type="button"
                  aria-label={collapsed.has(card.id) ? t('project.card.expand_subtasks') : t('project.card.collapse_subtasks')}
                  aria-expanded={!collapsed.has(card.id)}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  onClick={() => toggle(card.id)}
                >
                  {collapsed.has(card.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
              ) : <span className="size-5 shrink-0" aria-hidden="true" />}
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                onClick={() => onOpenCard(card.id)}
              >
                {card.title || t('project.board.untitled_card')}
              </button>
              {gantt && blocked.has(card.id) && <span className="shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-hover)] px-1 text-[length:var(--text-10)] text-[var(--text-secondary)]">{t('project.view.blocked')}</span>}
            </div>
          ))}
        </div>
        <div className="relative min-w-0" style={{ width: `${days.length * columnPx}px` }}>
          <div className="sticky top-0 z-[1] h-12 border-b border-[var(--border-subtle)] bg-[var(--bg-base)]">
            <div className="flex h-6">
              {monthRuns.map((run) => (
                <div key={run.label} className="truncate border-r border-[var(--border-subtle)] px-1 text-center text-[length:var(--text-11)] font-medium text-[var(--text-secondary)]" style={{ width: `${run.span * columnPx}px` }}>
                  {run.label}
                </div>
              ))}
            </div>
            <div className="flex h-6">
              {days.map((entry) => (
                <div
                  key={entry.stamp}
                  className={`flex shrink-0 items-center justify-center text-[length:var(--text-10)] ${entry.today ? 'font-bold text-[var(--accent)]' : 'text-[var(--text-tertiary)]'}`}
                  style={{ width: `${columnPx}px` }}
                >
                  {scale === 'day' || entry.monthStart ? new Date(entry.stamp).getDate() : ''}
                </div>
              ))}
            </div>
          </div>
          <div className="relative">
            <div className="pointer-events-none absolute inset-0 flex" aria-hidden="true">
              {days.map((entry) => (
                <div key={entry.stamp} className={`shrink-0 border-r border-[var(--border-subtle)] ${entry.weekend ? 'bg-[var(--bg-sunken)]' : ''}`} style={{ width: `${columnPx}px` }} />
              ))}
            </div>
            {todayColumn >= 0 && (
              <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--danger)]" style={{ left: `${todayColumn * columnPx}px` }} aria-hidden="true" data-timeline-today="" />
            )}
            {rows.map(({ card }) => {
              const range = daysByCard.get(card.id)!
              const bar = projectTimelineBar({ from: range.start, to: range.end }, window)
              return (
                <div key={card.id} className="relative h-9 border-b border-[var(--border-subtle)]" data-timeline-row={card.id}>
                  <button
                    type="button"
                    aria-label={card.title || t('project.board.untitled_card')}
                    className={`absolute top-1.5 h-6 rounded-[var(--r-sm)] text-left text-[length:var(--text-10)] ${isProjectCardDone(card, properties) ? 'bg-[var(--bg-hover)] text-[var(--text-tertiary)]' : 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'} focus-visible:outline-2 focus-visible:outline-[var(--accent)]`}
                    style={{ left: `${bar.left * columnPx}px`, width: `${bar.width * columnPx}px` }}
                    onClick={() => onOpenCard(card.id)}
                  >
                    <span className="block truncate px-1.5 leading-6">{card.title || t('project.board.untitled_card')}</span>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
        {showUnscheduled && unscheduled.length > 0 && (
          <aside className="ml-auto w-52 shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2" aria-label={t('project.view.unscheduled')}>
            <h3 className="mb-1 px-1 text-[length:var(--text-11)] font-semibold uppercase text-[var(--text-tertiary)]">{t('project.view.unscheduled')}</h3>
            <ul className="space-y-0.5">
              {unscheduled.map((card) => (
                <li key={card.id}>
                  <button type="button" className="w-full truncate rounded-[var(--r-sm)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpenCard(card.id)}>
                    {card.title || t('project.board.untitled_card')}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  )
}

export function ChartView({ cards, properties }: { cards: ProjectCard[], properties: ProjectProperty[] }) {
  const groupProperty = properties.find((p) => p.type === 'select') ?? properties[0]
  const groups = groupProjectCards(cards, groupProperty?.id, properties)
  const entries = [...groups.entries()]
  const max = entries.reduce((acc, [, list]) => Math.max(acc, list.length), 1)
  return (
    <div className="flex min-h-0 flex-1 items-end gap-3 overflow-x-auto p-4">
      {entries.map(([key, list]) => (
        <div key={key || 'empty'} className="flex w-24 shrink-0 flex-col items-center gap-1">
          <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{list.length}</span>
          <div className="w-full rounded-t-[var(--r-sm)] bg-[var(--accent-soft)]" style={{ height: `${(list.length / max) * 160}px` }} />
          <span className="w-full truncate text-center text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {key === '' ? t('project.view.no_value') : groupProperty?.options.find((o) => o.id === key)?.value ?? key}
          </span>
        </div>
      ))}
    </div>
  )
}