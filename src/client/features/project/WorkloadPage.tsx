import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Gauge } from 'lucide-react'
import type { ProjectWorkloadReport } from '@shared/project/model'
import { t, useLocale } from '../../lib/i18n'
import { navigateToAddress, navigateToPath } from '../../lib/app-history'
import { Avatar, Button, IconButton } from '../../components/primitives'
import { commitOnEnter, Input } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { fetchProjectWorkload } from './api'

const DAY_MS = 86_400_000

function currentWeek(now = Date.now()): { from: number, to: number } {
  const date = new Date(now)
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - ((date.getDay() + 6) % 7) * DAY_MS
  return { from, to: from + 7 * DAY_MS }
}

function minutes(value: number): string {
  const rounded = Math.max(0, Math.round(value))
  const hours = Math.floor(rounded / 60)
  return hours > 0 ? `${hours}h ${rounded % 60}m` : `${rounded}m`
}

export function WorkloadPage(): ReactElement {
  const locale = useLocale()
  const toast = useUi((state) => state.toast)
  const capacityMinutesPerWeek = useSession((state) => state.settings.project.capacityMinutesPerWeek)
  const currentUserId = useSession((state) => state.user?.id)
  const updateSettings = useSession((state) => state.updateSettings)
  const [range, setRange] = useState(currentWeek)
  const [report, setReport] = useState<ProjectWorkloadReport | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [capacityHours, setCapacityHours] = useState(String(capacityMinutesPerWeek / 60))

  useEffect(() => setCapacityHours(String(capacityMinutesPerWeek / 60)), [capacityMinutesPerWeek])
  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    setReport(null)
    fetchProjectWorkload(range.from, range.to, controller.signal)
      .then(setReport)
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [range, attempt])

  const saveCapacity = useCallback(() => {
    const hours = Number(capacityHours)
    if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
      toast({ title: t('project.workload.invalid_capacity'), tone: 'danger' })
      return
    }
    void updateSettings({ project: { capacityMinutesPerWeek: Math.round(hours * 60) } })
    setReport((current) => current && currentUserId
      ? {
          ...current,
          users: current.users.map((user) => user.userId === currentUserId
            ? { ...user, capacityMinutes: Math.round(hours * 60 * ((range.to - range.from) / (7 * DAY_MS))) }
            : user),
        }
      : current)
  }, [capacityHours, range, currentUserId, toast, updateSettings])

  const totals = useMemo(() => ({
    estimated: report?.cards.reduce((sum, card) => sum + card.estimateMinutes, 0) ?? 0,
    actual: report?.cards.reduce((sum, card) => sum + card.actualMinutes, 0) ?? 0,
    capacity: report?.users.reduce((sum, user) => sum + user.capacityMinutes, 0) ?? 0,
  }), [report])
  const rangeLabel = `${new Date(range.from).toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${new Date(range.to - 1).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-project-workload="">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('project.workload.back')} size="sm" onClick={() => navigateToPath('/project')}><ArrowLeft size={16} /></IconButton>
        <Gauge size={16} aria-hidden="true" className="text-[var(--accent)]" />
        <h1 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('project.workload.title')}</h1>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label={t('project.workload.previous')} size="sm" onClick={() => setRange((current) => ({ from: current.from - 7 * DAY_MS, to: current.to - 7 * DAY_MS }))}><ChevronLeft size={16} /></IconButton>
          <span className="min-w-40 text-center text-[length:var(--text-12)] text-[var(--text-secondary)]">{rangeLabel}</span>
          <IconButton label={t('project.workload.next')} size="sm" onClick={() => setRange((current) => ({ from: current.from + 7 * DAY_MS, to: current.to + 7 * DAY_MS }))}><ChevronRight size={16} /></IconButton>
          <Button size="sm" variant="ghost" onClick={() => setRange(currentWeek())}>{t('project.workload.this_week')}</Button>
        </div>
        <label className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {t('project.workload.my_capacity')}
          <Input className="w-24" type="number" min={0} max={168} step={0.5} value={capacityHours} aria-label={t('project.workload.my_capacity')} onChange={(event) => setCapacityHours(event.target.value)} onBlur={saveCapacity} onKeyDown={(event) => commitOnEnter(event, saveCapacity)} />
          <span>{t('project.workload.hours_per_week')}</span>
        </label>
      </header>
      <div className="pv-scroll min-h-0 flex-1 overflow-y-auto p-4">
        {failed
          ? (
              <div role="alert" className="space-y-2">
                <p className="text-[length:var(--text-13)] text-[var(--danger)]">{t('project.common.load_failed')}</p>
                <Button size="sm" onClick={() => setAttempt((current) => current + 1)}>{t('common.retry')}</Button>
              </div>
            )
          : report === null
            ? <LoadingBlock />
            : report.users.length === 0
              ? <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('project.workload.empty')}</p>
              : (
                  <div className="mx-auto w-full max-w-6xl space-y-5">
                    <section className="grid gap-3 sm:grid-cols-3" aria-label={t('project.workload.summary')}>
                      <Summary label={t('project.workload.estimated')} value={minutes(totals.estimated)} />
                      <Summary label={t('project.workload.actual')} value={minutes(totals.actual)} />
                      <Summary label={t('project.workload.capacity')} value={minutes(totals.capacity)} />
                    </section>
                    <section className="overflow-x-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                      <table className="w-full text-[length:var(--text-12)]">
                        <caption className="sr-only">{t('project.workload.title')}</caption>
                        <thead className="bg-[var(--bg-sunken)] text-[var(--text-tertiary)]">
                          <tr>
                            <th scope="col" className="px-3 py-2 text-left">{t('project.workload.person')}</th>
                            <th scope="col" className="px-3 py-2 text-right">{t('project.workload.estimated')}</th>
                            <th scope="col" className="px-3 py-2 text-right">{t('project.workload.actual')}</th>
                            <th scope="col" className="px-3 py-2 text-right">{t('project.workload.capacity')}</th>
                            <th scope="col" className="px-3 py-2 text-left">{t('project.workload.utilization')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--border-subtle)]">
                          {report.users.map((user) => {
                            const utilization = user.capacityMinutes > 0 ? user.actualMinutes / user.capacityMinutes : 0
                            return (
                              <tr key={user.userId}>
                                <td className="px-3 py-2">
                                  <span className="flex items-center gap-2"><Avatar src={user.avatarUrl} name={user.name} size={20} /><span className="text-[var(--text-primary)]">{user.name}</span></span>
                                </td>
                                <td className="px-3 py-2 text-right tabular">{minutes(user.estimatedMinutes)}</td>
                                <td className="px-3 py-2 text-right tabular">{minutes(user.actualMinutes)}</td>
                                <td className="px-3 py-2 text-right tabular">{minutes(user.capacityMinutes)}</td>
                                <td className="px-3 py-2">
                                  <span className="flex items-center gap-2">
                                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--bg-sunken)]"><span className={`block h-full ${utilization > 1 ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'}`} style={{ width: `${Math.min(100, Math.round(utilization * 100))}%` }} /></span>
                                    <span className="tabular text-[var(--text-tertiary)]">{Math.round(utilization * 100)}%</span>
                                  </span>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </section>
                    <section className="space-y-2">
                      <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('project.workload.cards')}</h2>
                      <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--r-md)] border border-[var(--border-subtle)]">
                        {report.cards.slice(0, 50).map((card) => (
                          <li key={card.cardId}>
                            <button type="button" className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)]" onClick={() => navigateToAddress(`/project/boards/${card.boardId}`, `card=${encodeURIComponent(card.cardId)}`)}>
                              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{card.title || t('project.board.untitled_card')}</span>
                              <span className="max-w-40 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{card.boardTitle}</span>
                              <span className="text-[length:var(--text-11)] tabular text-[var(--text-secondary)]">{t('project.workload.estimate_actual', { estimate: minutes(card.estimateMinutes), actual: minutes(card.actualMinutes) })}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  </div>
                )}
      </div>
    </div>
  )
}

function Summary({ label, value }: { label: string, value: string }): ReactElement {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
      <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</p>
      <p className="text-[length:var(--text-16)] font-semibold tabular text-[var(--text-primary)]">{value}</p>
    </div>
  )
}
