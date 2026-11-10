/**
 * The board at a glance, and the files it carries.
 *
 * Both read only what the bundle already holds, so neither adds a round trip to a screen the reader
 * opened to look rather than to edit. The dashboard's counts come from the same filter/sort the view
 * was handed, so a filtered board reports the filtered truth rather than the whole board's.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Upload } from 'lucide-react'
import type { ProjectActivityEntry, ProjectAttachment, ProjectAttachmentCategory, ProjectCard, ProjectProperty } from '@shared/project/model'
import { isProjectCardDone, PROJECT_ATTACHMENT_CATEGORIES } from '@shared/project/model'
import { projectCardDays } from '@shared/project/timeline-layout'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { useUi } from '../../store/ui'
import { fetchBoardActivity, listBoardFiles, projectFileUrl, uploadBoardFile } from './api'

function StatTile({ label, value, tone }: { label: string, value: number, tone?: 'danger' }): ReactElement {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
      <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</p>
      <p className={`mt-1 text-[length:var(--text-20)] font-semibold ${tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'}`}>{value}</p>
    </div>
  )
}

export function DashboardView({ boardId, cards, properties, datePropertyId, onOpenCard }: {
  boardId: string
  cards: ProjectCard[]
  properties: ProjectProperty[]
  datePropertyId?: string
  onOpenCard: (id: string) => void
}): ReactElement {
  const [activity, setActivity] = useState<ProjectActivityEntry[]>([])
  const propertyId = datePropertyId ?? properties.find((property) => property.type === 'date')?.id
  const statusProperty = properties.find((property) => property.type === 'select')

  useEffect(() => {
    const controller = new AbortController()
    fetchBoardActivity(boardId, controller.signal).then(setActivity).catch(() => { if (!controller.signal.aborted) setActivity([]) })
    return () => controller.abort()
  }, [boardId])

  const today = useMemo(() => { const day = new Date(); day.setHours(0, 0, 0, 0); return day.getTime() }, [])
  const weekAhead = today + 7 * 86_400_000
  const buckets = useMemo(() => {
    const overdue: ProjectCard[] = []
    let dueSoon = 0
    let unscheduled = 0
    let done = 0
    for (const card of cards) {
      if (isProjectCardDone(card, properties)) { done += 1; continue }
      const days = projectCardDays(card, propertyId)
      if (!days) { unscheduled += 1; continue }
      if (days.end < today) overdue.push(card)
      else if (days.end <= weekAhead) dueSoon += 1
    }
    return { overdue, dueSoon, unscheduled, done }
  }, [cards, properties, propertyId, today, weekAhead])

  const byStatus = useMemo(() => {
    if (!statusProperty) return []
    const counts = new Map<string, number>()
    for (const card of cards) {
      const key = card.values[statusProperty.id] ?? ''
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...statusProperty.options.map((option) => ({ label: option.value, count: counts.get(option.id) ?? 0 })), { label: t('project.view.no_value'), count: counts.get('') ?? 0 }]
  }, [cards, statusProperty])

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3" data-project-dashboard={boardId}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
        <StatTile label={t('project.dashboard.total')} value={cards.length} />
        <StatTile label={t('project.dashboard.done')} value={buckets.done} />
        <StatTile label={t('project.dashboard.overdue')} value={buckets.overdue.length} tone="danger" />
        <StatTile label={t('project.dashboard.due_soon')} value={buckets.dueSoon} />
        <StatTile label={t('project.dashboard.unscheduled')} value={buckets.unscheduled} />
      </div>
      {byStatus.length > 0 && (
        <section aria-label={t('project.dashboard.by_status')} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
          <h3 className="mb-2 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('project.dashboard.by_status')}</h3>
          <ul className="space-y-1">
            {byStatus.map((entry) => (
              <li key={entry.label} className="flex items-center gap-2 text-[length:var(--text-12)]">
                <span className="w-28 shrink-0 truncate text-[var(--text-secondary)]">{entry.label}</span>
                <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
                  <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${cards.length ? Math.round((entry.count / cards.length) * 100) : 0}%` }} />
                </span>
                <span className="w-8 shrink-0 text-right text-[var(--text-primary)]">{entry.count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {buckets.overdue.length > 0 && (
        <section aria-label={t('project.dashboard.overdue_list')} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
          <h3 className="mb-2 text-[length:var(--text-12)] font-semibold text-[var(--danger)]">{t('project.dashboard.overdue_list')}</h3>
          <ul className="space-y-0.5">
            {buckets.overdue.map((card) => (
              <li key={card.id}>
                <button type="button" className="w-full truncate rounded-[var(--r-sm)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => onOpenCard(card.id)}>
                  {card.title || t('project.board.untitled_card')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label={t('project.dashboard.activity')} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
        <h3 className="mb-2 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('project.dashboard.activity')}</h3>
        {activity.length === 0
          ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">—</p>
          : (
            <ul className="space-y-1">
              {activity.slice(0, 10).map((entry) => (
                <li key={entry.id} className="flex items-baseline gap-2 text-[length:var(--text-12)]">
                  <span className="shrink-0 text-[var(--text-tertiary)]">{new Date(entry.createdAt).toLocaleString()}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{entry.summary}</span>
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}

export function CollectionView({ boardId, canEdit, onOpenCard }: { boardId: string, canEdit: boolean, onOpenCard: (id: string) => void }): ReactElement {
  const [files, setFiles] = useState<ProjectAttachment[] | null>(null)
  const [category, setCategory] = useState<ProjectAttachmentCategory | ''>('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const toast = useUi((state) => state.toast)

  const load = useCallback(async () => { setFiles(await listBoardFiles(boardId)) }, [boardId])
  useEffect(() => { void load().catch(() => setFiles([])) }, [load])

  const shown = (files ?? []).filter((file) => !category || fileCategory(file.mime) === category)
  const upload = async (file: File) => {
    setBusy(true)
    try {
      await uploadBoardFile(boardId, file)
      await load()
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-project-collection={boardId}>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-1.5">
        <Button size="sm" variant={category === '' ? 'primary' : 'ghost'} onClick={() => setCategory('')}>{t('project.collection.all')}</Button>
        {PROJECT_ATTACHMENT_CATEGORIES.map((entry) => (
          <Button key={entry} size="sm" variant={category === entry ? 'primary' : 'ghost'} onClick={() => setCategory(entry)}>{entry}</Button>
        ))}
        {canEdit && (
          <span className="ml-auto">
            <input ref={input} type="file" className="hidden" onChange={(event) => { const picked = event.target.files?.[0]; if (picked) void upload(picked); event.target.value = '' }} />
            <Button size="sm" icon={<Upload size={14} />} disabled={busy} onClick={() => input.current?.click()}>{t('project.collection.upload')}</Button>
          </span>
        )}
      </div>
      {files !== null && shown.length === 0
        ? <p className="p-3 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.collection.empty')}</p>
        : (
          <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
            {shown.map((file) => (
              <li key={file.id} className="flex items-center gap-2 px-3 py-2">
                <a className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--accent)]" href={projectFileUrl(file.id)} target="_blank" rel="noreferrer">{file.filename}</a>
                <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{fileCategory(file.mime)}</span>
                <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{`${Math.max(1, Math.round(file.size / 1024))} KB`}</span>
                {file.cardId && (
                  <Button size="sm" variant="ghost" onClick={() => onOpenCard(file.cardId!)}>{t('project.card.open')}</Button>
                )}
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

/** The same buckets the server files uploads under, read from the mime the row carries. */
function fileCategory(mime: string): ProjectAttachmentCategory {
  if (mime.startsWith('image/')) return 'images'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'txt'
  if (mime.includes('word') || mime.includes('document')) return 'docx'
  if (mime.includes('sheet') || mime.includes('excel')) return 'sheets'
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'slides'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed')) return 'archives'
  return 'other'
}