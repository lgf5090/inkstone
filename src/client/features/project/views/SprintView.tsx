/**
 * Iterations: one scope of cards, an ideal line and the line the board actually drew. The SVG is
 * named for a reader and backed by a table of the same numbers, so the chart is not the only way to
 * read the burn-down.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Plus, Target, Trash2 } from 'lucide-react'
import type { ProjectCard } from '@shared/project/model'
import { PROJECT_SPRINT_STATUSES, type ProjectSprintBurndown, type ProjectSprintStatus } from '@shared/project/stats'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { useUi } from '../../../store/ui'
import { ViewHead, ViewShell } from './shell'
import {
  assignCardToSprint, createProjectSprint, deleteProjectSprint, fetchProjectSprintDetail,
  fetchProjectSprints, patchProjectSprint, removeCardFromSprint,
  type ProjectSprintDetail,
} from '../api'

const DAY_MS = 86_400_000

interface SprintViewProps {
  boardId: string
  cards: ProjectCard[]
  canEdit: boolean
  onOpenCard: (id: string) => void
}

const STATUS_LABELS: Record<ProjectSprintStatus, Parameters<typeof t>[0]> = {
  planned: 'project.sprint.status_planned',
  active: 'project.sprint.status_active',
  completed: 'project.sprint.status_completed',
}

function describeFailure(reason: unknown): void {
  useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
}

function dateInput(stamp: number): string {
  return new Date(stamp).toISOString().slice(0, 10)
}

function dateStamp(value: string): number {
  return new Date(`${value}T00:00:00`).getTime()
}

function Burndown({ burndown }: { burndown: ProjectSprintBurndown }): ReactElement {
  const points = burndown.points
  const scale = Math.max(1, burndown.total)
  const x = (index: number): number => points.length <= 1 ? 300 : 20 + index * (560 / (points.length - 1))
  const y = (value: number): number => 160 - (value / scale) * 140
  const ideal = points.map((point, index) => `${x(index)},${y(point.ideal)}`).join(' ')
  const actual = points.map((point, index) => `${x(index)},${y(point.remaining)}`).join(' ')
  return (
    <div className="space-y-2">
      <svg
        viewBox="0 0 600 180"
        className="h-[180px] w-full"
        role="img"
        aria-label={t('project.sprint.chart_label', { total: burndown.total, completed: burndown.completed })}
      >
        <line x1={20} y1={160} x2={580} y2={160} stroke="var(--border-subtle)" />
        <polyline points={ideal} fill="none" stroke="var(--text-quaternary)" strokeDasharray="4 4" strokeWidth={2} />
        <polyline points={actual} fill="none" stroke="var(--accent)" strokeWidth={2} />
      </svg>
      <div className="flex gap-4 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span>{t('project.sprint.ideal')}</span>
        <span>{t('project.sprint.actual')}</span>
        <span>{t('project.sprint.velocity')}: {burndown.velocity}</span>
      </div>
      <table className="sr-only">
        <caption>{t('project.sprint.chart_label', { total: burndown.total, completed: burndown.completed })}</caption>
        <thead><tr><th scope="col">{t('project.sprint.day')}</th><th scope="col">{t('project.sprint.ideal')}</th><th scope="col">{t('project.sprint.remaining')}</th></tr></thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.day}><td>{point.dayLabel}</td><td>{point.ideal}</td><td>{point.remaining}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SprintView({ boardId, cards, canEdit, onOpenCard }: SprintViewProps): ReactElement {
  const [sprints, setSprints] = useState<{ id: string, name: string }[]>([])
  const [activeId, setActiveId] = useState('')
  const [detail, setDetail] = useState<ProjectSprintDetail | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reload, setReload] = useState(0)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [start, setStart] = useState(() => dateInput(Date.now()))
  const [end, setEnd] = useState(() => dateInput(Date.now() + 13 * DAY_MS))
  const [cardToAdd, setCardToAdd] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setStatus('loading')
    fetchProjectSprints(boardId)
      .then((list) => {
        if (!alive) return
        setSprints(list)
        setActiveId((current) => list.some((sprint) => sprint.id === current) ? current : (list[0]?.id ?? ''))
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (!alive) return
        setStatus('error')
        describeFailure(reason)
      })
    return () => { alive = false }
  }, [boardId, reload])

  useEffect(() => {
    if (!activeId) { setDetail(null); return }
    let alive = true
    fetchProjectSprintDetail(boardId, activeId)
      .then((value) => { if (alive) setDetail(value) })
      .catch((reason: unknown) => { if (alive) describeFailure(reason) })
    return () => { alive = false }
  }, [boardId, activeId, reload])

  const create = async () => {
    const startAt = dateStamp(start)
    const endAt = dateStamp(end)
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) {
      useUi.getState().toast({ title: t('project.sprint.invalid_dates'), tone: 'danger' })
      return
    }
    setBusy(true)
    try {
      const sprint = await createProjectSprint(boardId, { name: name.trim(), goal, startAt, endAt, status: 'planned' })
      setName('')
      setGoal('')
      setActiveId(sprint.id)
      setReload((value) => value + 1)
    } catch (reason) {
      describeFailure(reason)
    } finally {
      setBusy(false)
    }
  }

  const mutate = async (task: () => Promise<void>, nextActiveId = activeId) => {
    try {
      await task()
      setActiveId(nextActiveId)
      setReload((value) => value + 1)
    } catch (reason) {
      describeFailure(reason)
    }
  }

  const detailSprint = detail?.sprint
  return (
    <ViewShell data-view="sprint">
      <ViewHead icon={<Target size={14} aria-hidden="true" />} title={t('project.sprint.title')} count={sprints.length} />
      <div className="space-y-3 p-3">
        {status === 'error' && (
          <div className="flex items-center gap-2 text-[length:var(--text-12)] text-[var(--danger)]">
            <span role="status">{t('project.sprint.load_failed')}</span>
            <Button size="sm" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>
          </div>
        )}
        {status === 'loading' && <p role="status" className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('common.loading')}</p>}
        {status === 'ready' && (
          <>
            {sprints.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <SelectMenu
                  label={t('project.sprint.select')} value={activeId} onChange={setActiveId}
                  options={sprints.map((sprint) => ({ value: sprint.id, label: sprint.name }))}
                />
                {detailSprint && (
                  <>
                    <SelectMenu
                      label={t('project.sprint.status')} value={detailSprint.status}
                      onChange={(next) => void mutate(
                        () => patchProjectSprint(boardId, detailSprint.id, { status: next as ProjectSprintStatus }).then(() => undefined),
                      )}
                      options={PROJECT_SPRINT_STATUSES.map((value) => ({ value, label: t(STATUS_LABELS[value]) }))}
                    />
                    <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                      {t('project.sprint.total')}: {detail?.burndown.total} · {t('project.sprint.completed')}: {detail?.burndown.completed} · {t('project.sprint.remaining')}: {detail?.burndown.remaining}
                    </span>
                    {canEdit && <Button size="sm" onClick={() => void mutate(() => deleteProjectSprint(boardId, detailSprint.id), '')}>{t('common.delete')}</Button>}
                  </>
                )}
              </div>
            ) : (
              <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.sprint.empty')}</p>
            )}
            {detail && <Burndown burndown={detail.burndown} />}
            {detail && (
              <section className="space-y-2">
                <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('project.sprint.cards')}</h3>
                {detail.cards.length === 0 && <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.sprint.no_cards')}</p>}
                {detail.cards.map((card) => (
                  <div key={card.id} className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
                    <button type="button" className="min-w-0 flex-1 truncate text-left text-[length:var(--text-12)] text-[var(--text-secondary)]" onClick={() => onOpenCard(card.id)}>
                      {card.title || t('project.value.empty')}
                    </button>
                    {canEdit && (
                      <IconButton label={t('project.sprint.remove_card')} size="sm" onClick={() => void mutate(() => removeCardFromSprint(boardId, detail.sprint.id, card.id))}>
                        <Trash2 size={14} />
                      </IconButton>
                    )}
                  </div>
                ))}
                {canEdit && (
                  <div className="flex items-center gap-2">
                    <SelectMenu
                      label={t('project.sprint.add_card')} value={cardToAdd} onChange={setCardToAdd}
                      options={cards
                        .filter((card) => !detail.cards.some((entry) => entry.id === card.id))
                        .map((card) => ({ value: card.id, label: card.title || t('project.value.empty') }))}
                    />
                    <Button
                      size="sm" variant="primary" icon={<Plus size={14} />} disabled={!cardToAdd}
                      onClick={() => void mutate(() => assignCardToSprint(boardId, detail.sprint.id, cardToAdd))}
                    >
                      {t('project.sprint.add_card')}
                    </Button>
                  </div>
                )}
              </section>
            )}
            {canEdit && (
              <section className="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
                <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{t('project.sprint.create')}</h3>
                <Input className="w-full" value={name} aria-label={t('project.sprint.name')} placeholder={t('project.sprint.name')} onChange={(event) => setName(event.target.value)} />
                <Input className="w-full" value={goal} aria-label={t('project.sprint.goal')} placeholder={t('project.sprint.goal')} onChange={(event) => setGoal(event.target.value)} />
                <div className="flex flex-wrap gap-2">
                  <Input className="w-40" type="date" value={start} aria-label={t('project.sprint.start')} onChange={(event) => setStart(event.target.value)} />
                  <Input className="w-40" type="date" value={end} aria-label={t('project.sprint.end')} onChange={(event) => setEnd(event.target.value)} />
                </div>
                <Button variant="primary" icon={<Plus size={14} />} loading={busy} disabled={!name.trim()} onClick={() => void create()}>
                  {t('project.sprint.create')}
                </Button>
              </section>
            )}
          </>
        )}
      </div>
    </ViewShell>
  )
}
