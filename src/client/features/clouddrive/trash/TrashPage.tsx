import { useEffect, useState } from 'react'
import { RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Button, Spinner } from '../../../components/primitives'
import { confirm } from '../../../components/overlay'
import { clouddriveApi } from '../api'
import { FileIcon } from '../files/FileIcon'
import { formatEntryDate, formatEntrySize } from '../files/format'

export function TrashPage({ mountId }: { mountId: string }) {
  const toast = useToast()
  const [entries, setEntries] = useState<CloudDriveEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = async (next: string | null = null) => {
    setLoading(true)
    try {
      const result = await clouddriveApi.trash(mountId, next)
      const fetched = [...result.folders, ...result.files]
      setEntries((current) => next ? [...current, ...fetched] : fetched)
      setCursor(result.cursor)
      if (!next) setSelected(new Set())
    } catch (error) {
      toast({ title: t('clouddrive.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load(null) }, [mountId])

  const restore = async (ids: string[]) => {
    if (ids.length === 0) return
    setBusy(true)
    try {
      await clouddriveApi.restore(ids, mountId)
      toast({ title: t('clouddrive.toast.restored', { count: ids.length }) })
      await load(null)
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const purge = async (ids: string[]) => {
    if (ids.length === 0) return
    if (!await confirm({
      title: t('clouddrive.trash.purge_title'),
      description: t('clouddrive.trash.purge_body'),
      confirmLabel: t('clouddrive.trash.purge'),
      tone: 'danger',
    })) return
    setBusy(true)
    try {
      const result = await clouddriveApi.purge({ ids, mountId })
      toast({ title: t('clouddrive.toast.purged', { count: result.deleted || ids.length }) })
      await load(null)
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const empty = async () => {
    if (!await confirm({
      title: t('clouddrive.trash.empty_title'),
      description: t('clouddrive.trash.empty_body'),
      confirmLabel: t('clouddrive.trash.empty'),
      tone: 'danger',
    })) return
    setBusy(true)
    try {
      const result = await clouddriveApi.purge({ all: true, mountId })
      toast({ title: t('clouddrive.toast.purged', { count: result.deleted }) })
      await load(null)
    } catch (error) {
      toast({ title: t('clouddrive.toast.failed'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedIds = [...selected]

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2 text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
          <Trash2 size={15} className="text-[var(--text-tertiary)]" aria-hidden /> {t('clouddrive.nav.trash')}
        </h1>
        <span className="rounded-full bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{entries.length}</span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load(null)}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
          <Button size="sm" variant="danger" disabled={busy || entries.length === 0} onClick={() => void empty()}><Trash2 size={13} /> {t('clouddrive.trash.empty')}</Button>
        </div>
      </header>

      {selectedIds.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-3 py-1.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
          <span>{t('clouddrive.trash.selected', { count: selectedIds.length })}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void restore(selectedIds)}><RotateCcw size={13} /> {t('clouddrive.trash.restore_selected')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void purge(selectedIds)}><Trash2 size={13} /> {t('clouddrive.trash.purge_selected')}</Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>{t('clouddrive.action.clear_selection')}</Button>
        </div>
      )}

      {loading && entries.length === 0 ? <div className="flex h-32 items-center justify-center"><Spinner /></div> : entries.length === 0 ? (
        <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.trash.empty_state')}</p>
      ) : (
        <div className="flex min-h-0 flex-col gap-1.5">
          {entries.map((entry) => (
            <div key={entry.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <input
                type="checkbox"
                className="cd-checkbox"
                checked={selected.has(entry.id)}
                aria-label={entry.name}
                onChange={() => toggle(entry.id)}
              />
              <FileIcon entry={entry} size={16} />
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]" title={entry.name}>{entry.name}</span>
              <span className="min-w-0 max-w-[260px] truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]" title={entry.path}>
                {t('clouddrive.trash.original_path')}: {entry.path}
              </span>
              <span className="shrink-0 text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">{formatEntrySize(entry)}</span>
              <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{formatEntryDate(entry.modifiedAt)}</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void restore([entry.id])}><RotateCcw size={13} /> {t('clouddrive.trash.restore')}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void purge([entry.id])}><Trash2 size={13} /> {t('clouddrive.trash.purge')}</Button>
            </div>
          ))}
          {cursor && (
            <Button size="sm" variant="secondary" className="self-center" loading={loading} onClick={() => void load(cursor)}>
              {t('clouddrive.trash.load_more')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function useToast() {
  return useUi((state) => state.toast)
}
