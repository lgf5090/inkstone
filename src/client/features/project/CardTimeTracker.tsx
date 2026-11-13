import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Clock, Play, Square, Trash2 } from 'lucide-react'
import type { ProjectTimeEntry } from '@shared/project/model'
import { t, useLocale } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { deleteCardTime, fetchCardTime, startCardTimer, stopCardTimer } from './api'

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

export function CardTimeTracker({ cardId, canEdit }: { cardId: string, canEdit: boolean }): ReactElement {
  const [entries, setEntries] = useState<ProjectTimeEntry[] | null>(null)
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
    fetchCardTime(cardId, controller.signal).then(setEntries).catch(() => { if (!controller.signal.aborted) setEntries([]) })
    return () => controller.abort()
  }, [cardId])

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

  const total = (entries ?? []).reduce((sum, entry) => sum + Math.max(0, (entry.endedAt ?? now) - entry.startedAt), 0)

  return (
    <section aria-label={t('project.time.title')} className="space-y-2">
      <div className="flex items-center gap-2">
        <SectionHeading />
        <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{duration(total)}</span>
        <span className="ml-auto">
          {running
            ? <Button size="sm" variant="ghost" icon={<Square size={13} />} disabled={busy || !canEdit} onClick={() => void run(() => stopCardTimer(cardId))}>{t('project.time.stop')}</Button>
            : <Button size="sm" variant="ghost" icon={<Play size={13} />} disabled={busy || !canEdit} onClick={() => void run(() => startCardTimer(cardId))}>{t('project.time.start')}</Button>}
        </span>
      </div>
      {entries === null
        ? null
        : entries.length === 0
          ? <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('project.time.empty')}</p>
          : (
              <ul className="space-y-1">
                {entries.slice(0, 6).map((entry) => (
                  <li key={entry.id} className="flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                    <span className="tabular">{duration((entry.endedAt ?? now) - entry.startedAt)}</span>
                    <span className="text-[var(--text-tertiary)]">{new Date(entry.startedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span>
                    {entry.endedAt === null && <span className="text-[var(--accent)]">{t('project.time.running')}</span>}
                    {canEdit && entry.userId === userId && (
                      <span className="ml-auto">
                        <IconButton label={t('common.delete')} size="sm" onClick={() => void run(() => deleteCardTime(cardId, entry.id))}><Trash2 size={12} /></IconButton>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
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
