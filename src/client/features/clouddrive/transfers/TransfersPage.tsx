import { useCallback, useEffect, useState } from 'react'
import { Download, Server, Upload, X } from 'lucide-react'
import { formatBytes } from '@shared/byte-format'
import { useSession } from '../../../store/session'
import { Button, IconButton } from '../../../components/primitives'
import { clouddriveApi } from '../api'
import { ct } from '../media-i18n'
import { useTransferStore, type TransferItem } from './useTransferStore'

interface ServerTask {
  id: string
  type: string
  status: string
  progress: Record<string, unknown>
  error: string | null
  createdAt: number
  finishedAt: number | null
}

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

  const [tasks, setTasks] = useState<ServerTask[]>([])
  const [tasksFailed, setTasksFailed] = useState(false)
  const loadTasks = useCallback(async () => {
    try {
      const result = await clouddriveApi.tasks()
      setTasks(result.tasks)
      setTasksFailed(false)
    } catch {
      setTasksFailed(true)
    }
  }, [])
  useEffect(() => {
    void loadTasks()
    const timer = window.setInterval(() => { void loadTasks() }, 5000)
    return () => { window.clearInterval(timer) }
  }, [loadTasks])

  const taskStatusKey = (status: string): Parameters<typeof ct>[0] => {
    if (status === 'queued') return 'clouddrive.transfers.status_queued'
    if (status === 'running') return 'clouddrive.transfers.status_running'
    if (status === 'completed') return 'clouddrive.tasks.status_completed'
    if (status === 'failed') return 'clouddrive.tasks.status_failed'
    return 'clouddrive.transfers.status_cancelled'
  }

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
      <section>
        <h2 className="mb-1 flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <Server size={12} aria-hidden /> {ct('clouddrive.tasks.server_section')} ({tasks.length})
        </h2>
        {tasksFailed && <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{ct('clouddrive.failed')}</p>}
        {!tasksFailed && tasks.length === 0 && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{ct('clouddrive.tasks.empty')}</p>}
        {tasks.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {tasks.map((task) => {
              const done = Number(task.progress.done) || 0
              const total = Number(task.progress.total) || 0
              const activeTask = task.status === 'queued' || task.status === 'running'
              return (
                <li key={task.id} className="flex min-w-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
                  <Server size={14} className="text-[var(--text-tertiary)]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
                    {task.type === 'reindex' ? ct('clouddrive.tasks.type_reindex') : task.type}
                  </span>
                  <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                    {ct(taskStatusKey(task.status))}{total > 0 ? ` · ${done}/${total}` : ''}
                  </span>
                  <span className="shrink-0 text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">{new Date(task.createdAt).toLocaleString()}</span>
                  {activeTask && (
                    <Button size="sm" variant="ghost" onClick={() => { void clouddriveApi.cancelTask(task.id).then(loadTasks).catch(() => setTasksFailed(true)) }}>
                      {ct('clouddrive.transfers.cancel')}
                    </Button>
                  )}
                  {task.error && <span className="max-w-[220px] truncate text-[length:var(--text-10)] text-[var(--danger)]" title={task.error}>{task.error}</span>}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
