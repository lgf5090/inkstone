import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Clock, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react'
import type { ProjectTimeEntry } from '@shared/project/model'
import { t, useLocale } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Textarea } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { Modal } from '../../components/overlay'
import { createCardTime, deleteCardTime, fetchCardTime, startCardTimer, stopCardTimer, updateCardTime } from './api'

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

function toLocalInput(stamp: number): string {
  const date = new Date(stamp)
  return new Date(stamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function CardTimeTracker({ cardId, canEdit }: { cardId: string, canEdit: boolean }): ReactElement {
  const [entries, setEntries] = useState<ProjectTimeEntry[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [editor, setEditor] = useState<ProjectTimeEntry | 'new' | null>(null)
  const [note, setNote] = useState('')
  const [startedAt, setStartedAt] = useState('')
  const [endedAt, setEndedAt] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const userId = useSession((state) => state.user?.id)
  const toast = useUi((state) => state.toast)
  const locale = useLocale()

  const load = useCallback(async () => {
    setEntries(await fetchCardTime(cardId))
  }, [cardId])

  useEffect(() => {
    const controller = new AbortController()
    setEntries(null)
    setError(false)
    fetchCardTime(cardId, controller.signal)
      .then(setEntries)
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [cardId, attempt])

  const running = entries?.find((entry) => entry.endedAt === null)
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [running])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      await load()
    } catch (reason) {
      toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const openEditor = (entry: ProjectTimeEntry | 'new'): void => {
    const now = Date.now()
    setEditor(entry)
    setNote(entry === 'new' ? '' : entry.note)
    setStartedAt(toLocalInput(entry === 'new' ? now - 30 * 60_000 : entry.startedAt))
    setEndedAt(toLocalInput(entry === 'new' ? now : entry.endedAt ?? now))
  }

  const saveEntry = async (): Promise<void> => {
    const start = Date.parse(startedAt)
    const end = Date.parse(endedAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      toast({ title: t('project.time.invalid_range'), tone: 'danger' })
      return
    }
    await run(async () => {
      if (editor === 'new') await createCardTime(cardId, { note, startedAt: start, endedAt: end })
      else if (editor) await updateCardTime(cardId, editor.id, { note, startedAt: start, endedAt: end })
    })
    setEditor(null)
  }

  const total = (entries ?? []).reduce((sum, entry) => sum + Math.max(0, (entry.endedAt ?? now) - entry.startedAt), 0)

  return (
    <section aria-label={t('project.time.title')} className="space-y-2">
      <div className="flex items-center gap-2">
        <SectionHeading />
        <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{error ? t('project.common.load_failed') : entries === null ? t('common.loading') : duration(total)}</span>
        <span className="ml-auto flex items-center gap-1">
          {canEdit && <IconButton label={t('project.time.add')} size="sm" disabled={busy} onClick={() => openEditor('new')}><Plus size={13} /></IconButton>}
          {running
            ? <Button size="sm" variant="ghost" icon={<Square size={13} />} disabled={busy || !canEdit || entries === null || error} onClick={() => void run(() => stopCardTimer(cardId))}>{t('project.time.stop')}</Button>
            : <Button size="sm" variant="ghost" icon={<Play size={13} />} disabled={busy || !canEdit || entries === null || error} onClick={() => void run(() => startCardTimer(cardId))}>{t('project.time.start')}</Button>}
        </span>
      </div>
      {error
        ? (
            <div role="alert" className="space-y-1 text-[length:var(--text-11)] text-[var(--danger)]">
              <p>{t('project.common.load_failed')}</p>
              <p>{t('project.common.load_failed_hint')}</p>
              <Button size="sm" variant="ghost" onClick={() => setAttempt((current) => current + 1)}>{t('project.common.retry')}</Button>
            </div>
          )
        : entries === null
          ? null
          : entries.length === 0
          ? <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.time.empty')}</p>
          : (
              <ul className="space-y-1">
                {(expanded ? entries : entries.slice(0, 6)).map((entry) => (
                  <li key={entry.id} className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                    <span className="tabular">{duration((entry.endedAt ?? now) - entry.startedAt)}</span>
                    <span className="text-[var(--text-tertiary)]">{new Date(entry.startedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span>
                    {entry.note && <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{entry.note}</span>}
                    {entry.endedAt === null && <span className="text-[var(--accent)]">{t('project.time.running')}</span>}
                    {canEdit && (
                      <span className="ml-auto flex items-center">
                        <IconButton label={t('project.time.edit')} size="sm" disabled={busy || entry.endedAt === null} onClick={() => openEditor(entry)}><Pencil size={12} /></IconButton>
                        {entry.userId === userId && <IconButton label={t('common.delete')} size="sm" disabled={busy} onClick={() => void run(() => deleteCardTime(cardId, entry.id))}><Trash2 size={12} /></IconButton>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
      {entries && entries.length > 6 && (
        <Button size="sm" variant="ghost" onClick={() => setExpanded((current) => !current)}>
          {expanded ? t('project.time.show_less') : t('project.time.show_all', { count: entries.length })}
        </Button>
      )}
      {editor && (
        <Modal open onClose={() => setEditor(null)} title={t(editor === 'new' ? 'project.time.add' : 'project.time.edit')} width={420}>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void saveEntry() }}>
            <label className="block space-y-1">
              <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('project.time.note')}</span>
              <Textarea className="w-full" rows={2} value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
            </label>
            <div className="space-y-1">
              <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('project.time.start_at')}</span>
              <DatePicker className="w-full" label={t('project.time.start_at')} withTime value={startedAt} onChange={setStartedAt} />
            </div>
            <div className="space-y-1">
              <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('project.time.end_at')}</span>
              <DatePicker className="w-full" label={t('project.time.end_at')} withTime value={endedAt} onChange={setEndedAt} />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditor(null)}>{t('common.cancel')}</Button>
              <Button type="submit" variant="primary" loading={busy} disabled={busy}>{t('common.save')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  )
}

function SectionHeading(): ReactElement {
  return (
    <span className="flex items-center gap-1.5 text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
      <Clock size={14} aria-hidden="true" />
      {t('project.time.title')}
    </span>
  )
}
