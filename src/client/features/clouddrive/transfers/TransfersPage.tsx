import { useEffect } from 'react'
import { Download, Upload, X } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { useSession } from '../../../store/session'
import { Button, IconButton } from '../../../components/primitives'
import { ct } from '../media-i18n'
import { useTransferStore, type TransferItem } from './useTransferStore'

function statusKey(item: TransferItem): Parameters<typeof ct>[0] {
  if (item.status === 'queued') return 'clouddrive.transfers.status_queued'
  if (item.status === 'running') return 'clouddrive.transfers.status_running'
  if (item.status === 'success') return 'clouddrive.transfers.status_success'
  if (item.status === 'error') return 'clouddrive.transfers.status_error'
  return 'clouddrive.transfers.status_cancelled'
}

export function TransfersPage() {
  const userId = useSession((state) => state.user?.id ?? '')
  const items = useTransferStore((state) => state.items)
  const hydrate = useTransferStore((state) => state.hydrate)
  const cancel = useTransferStore((state) => state.cancel)
  const retry = useTransferStore((state) => state.retry)
  const remove = useTransferStore((state) => state.remove)
  const clearFinished = useTransferStore((state) => state.clearFinished)
  useEffect(() => { if (userId) hydrate(userId) }, [hydrate, userId])
  const active = items.filter((item) => item.status === 'queued' || item.status === 'running')
  const history = items.filter((item) => item.status !== 'queued' && item.status !== 'running')

  const row = (item: TransferItem) => {
    const percent = item.size > 0 ? Math.min(100, Math.round((item.transferred / item.size) * 100)) : 0
    return (
      <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
        {item.kind === 'upload' ? <Upload size={14} className="text-[var(--text-tertiary)]" aria-hidden /> : <Download size={14} className="text-[var(--text-tertiary)]" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">{item.name}</span>
        <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{ct(statusKey(item))}{item.status === 'running' ? ` · ${percent}%` : ''}</span>
        <span className="shrink-0 text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">{formatBytes(item.size)}</span>
        {(item.status === 'queued' || item.status === 'running') && <IconButton label={ct('clouddrive.transfers.cancel')} onClick={() => cancel(item.id)}><X size={13} /></IconButton>}
        {item.status === 'error' && <Button size="sm" variant="ghost" onClick={() => retry(item.id)}>{ct('clouddrive.transfers.retry')}</Button>}
        {item.status !== 'queued' && item.status !== 'running' && <IconButton label={ct('clouddrive.transfers.remove')} onClick={() => remove(item.id)}><X size={13} /></IconButton>}
      </li>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">{ct('clouddrive.transfers.title')}</h1>
        {history.length > 0 && <Button className="ml-auto" size="sm" variant="ghost" onClick={clearFinished}>{ct('clouddrive.transfers.clear_finished')}</Button>}
      </div>
      <section>
        <h2 className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{ct('clouddrive.transfers.active_section')} ({active.length})</h2>
        {active.length ? <ul className="flex flex-col gap-1.5">{active.map(row)}</ul> : <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{ct('clouddrive.transfers.empty')}</p>}
      </section>
      <section>
        <h2 className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{ct('clouddrive.transfers.history_section')}</h2>
        {history.length ? <ul className="flex flex-col gap-1.5">{history.map(row)}</ul> : <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{ct('clouddrive.transfers.empty_hint')}</p>}
      </section>
    </div>
  )
}
