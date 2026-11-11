/**
 * The dashboard: the board's health, and the two lists that need acting on today.
 *
 * Every number is computed from the cards the view was handed, so a filtered board reports the filtered
 * truth. The tiles are buttons where a number has a list behind it — "6 overdue" is only useful if
 * clicking it shows the six.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Activity, AlertTriangle, CalendarClock, CheckCircle2, LayoutDashboard, Loader, Users } from 'lucide-react'
import type { ProjectActivityEntry, ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone } from '@shared/project/model'
import { projectCardDays } from '@shared/project/timeline-layout'
import { projectOptionCssColor } from '@shared/project/option-color'
import { t, useLocale } from '../../../lib/i18n'
import { ViewHead, ViewShell } from './shell'
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

export function DashboardView(props: DashboardProps): ReactElement {
  const { cards, properties, boardId } = props
  const locale = useLocale()
  const [activity, setActivity] = useState<ProjectActivityEntry[]>([])
  const [focus, setFocus] = useState<'overdue' | 'soon' | null>(null)
  const propertyId = props.datePropertyId ?? properties.find((property) => property.type === 'date')?.id
  const statusProperty = properties.find((property) => property.type === 'select')
  const personProperty = properties.find((property) => property.type === 'person' || property.type === 'multiPerson')

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
    return { overdue: overdue.sort(byEnd), soon: soon.sort(byEnd), unscheduled, done, inProgress: cards.length - done - overdue.length - soon.length - unscheduled }
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
          <Kpi label={t('project.dashboard.in_progress')} value={Math.max(0, buckets.inProgress)} color="var(--warning)" icon={<Loader size={12} aria-hidden="true" />} />
          <Kpi label={t('project.dashboard.overdue')} value={buckets.overdue.length} color="var(--danger)" icon={<AlertTriangle size={12} aria-hidden="true" />} onClick={() => setFocus(focus === 'overdue' ? null : 'overdue')} />
          <Kpi label={t('project.dashboard.due_soon')} value={buckets.soon.length} color="var(--accent)" icon={<CalendarClock size={12} aria-hidden="true" />} onClick={() => setFocus(focus === 'soon' ? null : 'soon')} />
          <Kpi label={t('project.dashboard.unscheduled')} value={buckets.unscheduled} color="var(--text-tertiary)" icon={<CalendarClock size={12} aria-hidden="true" />} />
        </div>

        {focus && (
          <section className="pv-panel" aria-label={focus === 'overdue' ? t('project.dashboard.overdue_list') : t('project.dashboard.due_soon')}>
            <h3 className="pv-panel-title">{focus === 'overdue' ? t('project.dashboard.overdue_list') : t('project.dashboard.due_soon')}</h3>
            {focusList.length === 0
              ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.dashboard.nothing_here')}</p>
              : (
                <ul className="space-y-0.5">
                  {focusList.map((card) => {
                    const days = projectCardDays(card, propertyId)
                    const late = days ? Math.round((today - days.end) / DAY_MS) : 0
                    return (
                      <li key={card.id}>
                        <button type="button" className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-1.5 py-1 text-left text-[length:var(--text-12)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => props.onOpenCard(card.id)}>
                          <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{card.title || t('project.board.untitled_card')}</span>
                          <span className={`shrink-0 text-[length:var(--text-11)] ${late > 0 ? 'text-[var(--danger)]' : 'text-[var(--text-tertiary)]'}`}>
                            {days ? new Date(days.end).toLocaleDateString(locale) : ''}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
          </section>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          {byStatus.length > 0 && (
            <section className="pv-panel" aria-label={t('project.dashboard.by_status')}>
              <h3 className="pv-panel-title">{t('project.dashboard.by_status')}</h3>
              <ul className="space-y-1.5">
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
            </section>
          )}
          {workload.length > 0 && (
            <section className="pv-panel" aria-label={t('project.dashboard.workload')}>
              <h3 className="pv-panel-title"><Users size={13} aria-hidden="true" />{t('project.dashboard.workload')}</h3>
              <ul className="space-y-1.5">
                {workload.map(([id, count]) => (
                  <li key={id} className="pv-meter">
                    <span className="pv-meter-label">{id}</span>
                    <span className="pv-meter-track">
                      <span className="pv-meter-fill" style={{ width: `${cards.length ? Math.round((count / cards.length) * 100) : 0}%` }} />
                    </span>
                    <span className="pv-meter-value">{count}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <section className="pv-panel" aria-label={t('project.dashboard.activity')}>
          <h3 className="pv-panel-title"><Activity size={13} aria-hidden="true" />{t('project.dashboard.activity')}</h3>
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
                        : <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{verb ? '' : entry.summary}</span>}
                    </li>
                  )
                })}
              </ul>
            )}
        </section>
      </div>
    </ViewShell>
  )
}
