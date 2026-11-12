/**
 * The dashboard: the board's health, the report the reference's Stats view draws, and the two lists
 * that need acting on today.
 *
 * Every number comes from the cards the view was handed, so a filtered board reports the filtered
 * truth. The tiles are buttons where a number has a list behind it — "6 overdue" is only useful if
 * clicking it shows the six — and the report panels below are the same CSS shapes the reference uses:
 * a completion ring, one stacked status bar, priority tiles, a four-week trend and an effort summary.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { AlertTriangle, CalendarClock, CheckCircle2, LayoutDashboard, Loader, Users } from 'lucide-react'
import type { ProjectActivityEntry, ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone, projectPersonLabel, projectViewPropertyId } from '@shared/project/model'
import { projectCardDays } from '@shared/project/timeline-layout'
import { projectOptionCssColor } from '@shared/project/option-color'
import { projectEffortStats, projectPriorityBuckets, projectPriorityProperty, projectWeeklyCompletions } from '@shared/project/stats'
import { t, useLocale } from '../../../lib/i18n'
import { ViewHead, ViewShell } from './shell'
import { useProjectPeople } from '../people-context'
import { fetchBoardActivity } from '../api'

const DAY_MS = 86_400_000

/** The server logs the request it served; the reader wants the verb and the card, not the route. */
const ACTIVITY_VERB: Record<string, Parameters<typeof t>[0]> = {
  post: 'project.dashboard.act_created',
  patch: 'project.dashboard.act_updated',
  delete: 'project.dashboard.act_deleted',
  reminder: 'project.dashboard.act_reminder',
}

export interface DashboardProps {
  boardId: string
  cards: ProjectCard[]
  properties: ProjectProperty[]
  datePropertyId?: string
  onOpenCard: (id: string) => void
}

function Kpi({ label, value, note, color, icon, onClick }: {
  label: string
  value: number
  note?: string
  color: string
  icon: ReactElement
  onClick?: () => void
}): ReactElement {
  const body = (
    <>
      <span className="pv-kpi-label flex items-center gap-1.5">{icon}{label}</span>
      <span className="pv-kpi-value">{value}</span>
      {note && <span className="pv-kpi-note">{note}</span>}
    </>
  )
  return onClick
    ? <button type="button" className="pv-kpi" style={{ '--pv-kpi-color': color } as React.CSSProperties} onClick={onClick}>{body}</button>
    : <div className="pv-kpi" style={{ '--pv-kpi-color': color } as React.CSSProperties}>{body}</div>
}

function Panel({ title, children }: { title: string, children: React.ReactNode }): ReactElement {
  return (
    <section className="pv-panel" aria-label={title}>
      <h3 className="pv-panel-title">{title}</h3>
      {children}
    </section>
  )
}

export function DashboardView(props: DashboardProps): ReactElement {
  const { cards, properties, boardId } = props
  const locale = useLocale()
  const people = useProjectPeople()
  const [activity, setActivity] = useState<ProjectActivityEntry[]>([])
  const [focus, setFocus] = useState<'overdue' | 'soon' | null>(null)
  const propertyId = projectViewPropertyId(props.datePropertyId) ?? properties.find((property) => property.type === 'date')?.id
  const statusProperty = properties.find((property) => property.type === 'select')
  const personProperty = properties.find((property) => property.type === 'person' || property.type === 'multiPerson')
  const priorityProperty = useMemo(() => projectPriorityProperty(properties), [properties])
  const effortProperty = properties.find((property) => property.type === 'number')

  useEffect(() => {
    const controller = new AbortController()
    fetchBoardActivity(boardId, controller.signal).then(setActivity).catch(() => { if (!controller.signal.aborted) setActivity([]) })
    return () => controller.abort()
  }, [boardId])

  const today = useMemo(() => { const day = new Date(); day.setHours(0, 0, 0, 0); return day.getTime() }, [])
  const buckets = useMemo(() => {
    const overdue: ProjectCard[] = []
    const soon: ProjectCard[] = []
    let unscheduled = 0
    let done = 0
    for (const card of cards) {
      if (isProjectCardDone(card, properties)) { done += 1; continue }
      const days = projectCardDays(card, propertyId)
      if (!days) { unscheduled += 1; continue }
      if (days.end < today) overdue.push(card)
      else if (days.end <= today + 7 * DAY_MS) soon.push(card)
    }
    const byEnd = (left: ProjectCard, right: ProjectCard): number =>
      (projectCardDays(left, propertyId)?.end ?? 0) - (projectCardDays(right, propertyId)?.end ?? 0)
    return { overdue: overdue.sort(byEnd), soon: soon.sort(byEnd), unscheduled, done, later: cards.length - done - overdue.length - soon.length - unscheduled }
  }, [cards, properties, propertyId, today])

  const byStatus = useMemo(() => {
    if (!statusProperty) return []
    const counts = new Map<string, number>()
    for (const card of cards) {
      const key = card.values[statusProperty.id] ?? ''
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...statusProperty.options.map((option) => ({
      key: option.id,
      label: option.value,
      count: counts.get(option.id) ?? 0,
      color: projectOptionCssColor(option.color) ?? 'var(--text-quaternary)',
    })), { key: '', label: t('project.view.no_value'), count: counts.get('') ?? 0, color: 'var(--text-quaternary)' }]
  }, [cards, statusProperty])

  const priority = useMemo(() => (priorityProperty
    ? projectPriorityBuckets(cards, priorityProperty, (color) => projectOptionCssColor(color))
    : []), [cards, priorityProperty])
  const weekly = useMemo(() => projectWeeklyCompletions(cards, properties, today, 4), [cards, properties, today])
  const effort = useMemo(() => projectEffortStats(cards, effortProperty), [cards, effortProperty])
  const maxWeekly = Math.max(1, ...weekly.map((week) => week.count))

  const workload = useMemo(() => {
    if (!personProperty) return []
    const counts = new Map<string, number>()
    for (const card of cards) {
      const raw = card.values[personProperty.id]
      if (!raw) continue
      let ids = [raw]
      if (raw.trim().startsWith('[')) {
        try { ids = JSON.parse(raw) as string[] } catch { ids = [raw] }
      }
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8)
  }, [cards, personProperty])

  const percent = cards.length > 0 ? Math.round((buckets.done / cards.length) * 100) : 0
  const focusList = focus === 'overdue' ? buckets.overdue : focus === 'soon' ? buckets.soon : []

  const dueLabel = (stamp: number): string => {
    const days = Math.round((stamp - today) / DAY_MS)
    if (days === 0) return t('project.dashboard.today')
    if (days === 1) return t('project.dashboard.tomorrow')
    if (days === 2) return t('project.dashboard.day_after')
    return new Date(stamp).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
  }

  return (
    <ViewShell data-view="dashboard">
      <ViewHead
        icon={<LayoutDashboard size={15} aria-hidden="true" />}
        title={t('project.view.dashboard')}
        count={cards.length}
        note={t('project.dashboard.completion', { percent })}
      />
      <div className="pv-insights pv-scroll space-y-3" data-project-dashboard={boardId}>
        <div className="pv-kpis">
          <Kpi label={t('project.dashboard.total')} value={cards.length} color="var(--accent)" icon={<LayoutDashboard size={12} aria-hidden="true" />} />
          <Kpi label={t('project.dashboard.done')} value={buckets.done} note={`${percent}%`} color="var(--success)" icon={<CheckCircle2 size={12} aria-hidden="true" />} />
          <Kpi label={t('project.dashboard.in_progress')} value={Math.max(0, buckets.later)} color="var(--warning)" icon={<Loader size={12} aria-hidden="true" />} />
          <Kpi label={t('project.dashboard.overdue')} value={buckets.overdue.length} color="var(--danger)" icon={<AlertTriangle size={12} aria-hidden="true" />} onClick={() => setFocus(focus === 'overdue' ? null : 'overdue')} />
          <Kpi label={t('project.dashboard.due_soon')} value={buckets.soon.length} color="var(--accent)" icon={<CalendarClock size={12} aria-hidden="true" />} onClick={() => setFocus(focus === 'soon' ? null : 'soon')} />
          <Kpi label={t('project.dashboard.unscheduled')} value={buckets.unscheduled} color="var(--text-tertiary)" icon={<CalendarClock size={12} aria-hidden="true" />} />
        </div>

        {focus && (
          <Panel title={focus === 'overdue' ? t('project.dashboard.overdue_list') : t('project.dashboard.due_soon')}>
            {focusList.length === 0
              ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.dashboard.nothing_here')}</p>
              : (
                <ul className="space-y-0.5">
                  {focusList.map((card) => {
                    const days = projectCardDays(card, propertyId)
                    return (
                      <li key={card.id}>
                        <button type="button" className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-1.5 py-1 text-left text-[length:var(--text-12)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => props.onOpenCard(card.id)}>
                          <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{card.title || t('project.board.untitled_card')}</span>
                          <span className={`shrink-0 text-[length:var(--text-11)] ${days && days.end < today ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]'}`}>
                            {days ? dueLabel(days.end) : ''}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
          </Panel>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title={t('project.dashboard.completion_rate')}>
            <div className="flex items-center gap-5">
              <span className="pv-ring" style={{ background: `conic-gradient(var(--success) ${percent}%, var(--bg-sunken) ${percent}%)` }} role="img" aria-label={t('project.dashboard.completion', { percent })}>
                <span className="pv-ring-inner">{percent}%</span>
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="flex items-baseline gap-1">
                  <span className="text-[length:var(--text-28)] font-bold text-[var(--success)]">{buckets.done}</span>
                  <span className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">/ {cards.length}</span>
                </span>
                <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.dashboard.done')}</span>
              </span>
            </div>
          </Panel>

          {byStatus.length > 0 && (
            <Panel title={t('project.dashboard.by_status')}>
              <span className="pv-stack" role="img" aria-label={byStatus.map((entry) => `${entry.label} ${entry.count}`).join(', ')}>
                {byStatus.filter((entry) => entry.count > 0).map((entry) => (
                  <span key={entry.key || 'none'} className="pv-stack-seg" style={{ width: `${cards.length ? (entry.count / cards.length) * 100 : 0}%`, backgroundColor: entry.color }} title={`${entry.label}: ${entry.count}`} />
                ))}
              </span>
              <ul className="mt-2.5 space-y-1.5">
                {byStatus.map((entry) => (
                  <li key={entry.key || 'none'} className="pv-meter">
                    <span className="pv-meter-label">{entry.label}</span>
                    <span className="pv-meter-track">
                      <span className="pv-meter-fill" style={{ width: `${cards.length ? Math.round((entry.count / cards.length) * 100) : 0}%`, '--pv-meter-color': entry.color } as React.CSSProperties} />
                    </span>
                    <span className="pv-meter-value">{entry.count}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {priority.length > 0 && (
            <Panel title={t('project.dashboard.priority_dist')}>
              <div className="grid grid-cols-3 gap-2">
                {priority.map((bucket) => (
                  <div key={bucket.key} className="pv-prio-tile" style={{ '--pv-prio-color': bucket.color } as React.CSSProperties}>
                    <span className="text-[length:var(--text-20)] font-bold" style={{ color: bucket.color }}>{bucket.count}</span>
                    <span className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{bucket.label}</span>
                    <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{cards.length ? Math.round((bucket.count / cards.length) * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel title={t('project.dashboard.weekly_trend')}>
            <div className="pv-weeks">
              {weekly.map((week) => (
                <div key={week.start} className="pv-week">
                  <span className="pv-week-track">
                    <span className="pv-week-bar" style={{ height: `${(week.count / maxWeekly) * 100}%` }} />
                  </span>
                  <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">{new Date(week.start).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })}</span>
                  <span className="text-[length:var(--text-10)] font-semibold text-[var(--text-secondary)]">{week.count}</span>
                </div>
              ))}
            </div>
          </Panel>

          {effortProperty && (
            <Panel title={t('project.dashboard.effort', { name: effortProperty.name })}>
              <div className="grid grid-cols-2 gap-3">
                <span className="flex flex-col"><span className="text-[length:var(--text-20)] font-bold text-[var(--text-primary)]">{effort.total}</span><span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.dashboard.effort_total')}</span></span>
                <span className="flex flex-col"><span className="text-[length:var(--text-20)] font-bold text-[var(--text-primary)]">{effort.average.toFixed(1)}</span><span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.dashboard.effort_avg')}</span></span>
              </div>
              {effort.maxCard && (
                <button type="button" className="mt-2 flex w-full items-baseline gap-2 border-t border-[var(--border-subtle)] pt-2 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => props.onOpenCard(effort.maxCard!.id)}>
                  <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.dashboard.effort_max')}</span>
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{effort.maxCard.title} — {effort.max}</span>
                </button>
              )}
            </Panel>
          )}

          <Panel title={t('project.dashboard.due_soon')}>
            {buckets.soon.length === 0
              ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.dashboard.nothing_due')}</p>
              : (
                <ul className="space-y-1">
                  {buckets.soon.slice(0, 8).map((card) => {
                    const days = projectCardDays(card, propertyId)!
                    return (
                      <li key={card.id}>
                        <button type="button" className="pv-upcoming" style={{ '--pv-card-color': projectOptionCssColor(statusProperty?.options.find((option) => option.id === card.values[statusProperty.id])?.color ?? '') ?? 'var(--accent)' } as React.CSSProperties} onClick={() => props.onOpenCard(card.id)}>
                          <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{card.title || t('project.board.untitled_card')}</span>
                          <span className={`shrink-0 text-[length:var(--text-11)] ${days.end === today ? 'font-semibold text-[var(--danger)]' : 'text-[var(--text-tertiary)]'}`}>{dueLabel(days.end)}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
          </Panel>

          {workload.length > 0 && (
            <Panel title={t('project.dashboard.workload')}>
              <ul className="space-y-1.5">
                {workload.map(([id, count]) => (
                  <li key={id} className="pv-meter">
                    <span className="pv-meter-label"><Users size={11} aria-hidden="true" className="mr-1 inline" />{projectPersonLabel(people, id)}</span>
                    <span className="pv-meter-track"><span className="pv-meter-fill" style={{ width: `${cards.length ? Math.round((count / cards.length) * 100) : 0}%` }} /></span>
                    <span className="pv-meter-value">{count}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <Panel title={t('project.dashboard.activity')}>
          {activity.length === 0
            ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.dashboard.nothing_here')}</p>
            : (
              <ul className="space-y-1">
                {activity.slice(0, 12).map((entry) => {
                  const verb = ACTIVITY_VERB[entry.type]
                  const target = cards.find((card) => card.id === entry.targetId)
                  return (
                    <li key={entry.id} className="flex items-baseline gap-2 text-[length:var(--text-12)]">
                      <span className="shrink-0 tabular text-[var(--text-quaternary)]">{new Date(entry.createdAt).toLocaleString(locale)}</span>
                      <span className="shrink-0 text-[var(--text-tertiary)]">{verb ? t(verb) : ''}</span>
                      {target
                        ? (
                          <button type="button" className="min-w-0 flex-1 truncate text-left text-[var(--text-secondary)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => props.onOpenCard(target.id)}>
                            {target.title || t('project.board.untitled_card')}
                          </button>
                        )
                        : <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{verb ? t('project.dashboard.other_target') : entry.summary}</span>}
                    </li>
                  )
                })}
              </ul>
            )}
        </Panel>
      </div>
    </ViewShell>
  )
}
