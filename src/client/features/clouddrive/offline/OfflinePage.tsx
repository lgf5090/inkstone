import { useCallback, useEffect, useState } from 'react'
import { Download, ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../../lib/i18n'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { useUi } from '../../../store/ui'
import { getOffline, listOffline, removeOffline, type OfflineMeta } from './store'

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function OfflinePage() {
  const toast = useUi((state) => state.toast)
  const [items, setItems] = useState<OfflineMeta[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      setItems(await listOffline())
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const open = async (item: OfflineMeta) => {
    const record = await getOffline(item.id)
    if (!record) return
    const url = URL.createObjectURL(record.blob)
    window.open(url, '_blank', 'noopener,noreferrer')
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const download = async (item: OfflineMeta) => {
    const record = await getOffline(item.id)
    if (record) saveBlob(record.blob, record.name)
  }

  const remove = async (item: OfflineMeta) => {
    setBusyId(item.id)
    try {
      await removeOffline(item.id)
      await load()
    } catch (caught) {
      toast({ title: t('clouddrive.offline.remove_failed'), description: caught instanceof Error ? caught.message : '', tone: 'danger' })
    } finally {
      setBusyId(null)
    }
  }

  const total = items.reduce((sum, item) => sum + item.size, 0)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{t('clouddrive.offline.title')}</h1>
          <p className="mt-0.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('clouddrive.offline.description', { count: items.length, size: formatBytes(total) })}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={13} /> {t('clouddrive.toolbar.refresh')}</Button>
      </div>
      {status === 'loading' && <div className="flex h-32 items-center justify-center"><Spinner /></div>}
      {status === 'error' && (
        <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center">
          <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('clouddrive.offline.unavailable')}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>{t('clouddrive.retry')}</Button>
        </div>
      )}
      {status === 'ready' && items.length === 0 && (
        <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('clouddrive.offline.empty')}</p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{item.name}</span>
              <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{formatBytes(item.size)}</span>
              <span className="hidden shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)] sm:inline">{new Date(item.savedAt).toLocaleString()}</span>
              <Button size="sm" variant="ghost" onClick={() => void open(item)}><ExternalLink size={13} /> {t('clouddrive.offline.open')}</Button>
              <Button size="sm" variant="ghost" onClick={() => void download(item)}><Download size={13} /> {t('clouddrive.action.download')}</Button>
              <IconButton label={t('clouddrive.offline.remove')} disabled={busyId !== null} onClick={() => void remove(item)}><Trash2 size={13} /></IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
