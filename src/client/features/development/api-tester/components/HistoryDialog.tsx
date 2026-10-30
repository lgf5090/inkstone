import { useEffect } from 'react'
import { History as HistoryIcon, Trash2 } from 'lucide-react'
import { newApiTesterId } from '@shared/development/api-tester/ids'
import type { HistoryEntry } from '@shared/development/api-tester/types'
import { Modal, confirm } from '../../../../components/overlay'
import { LoadingBlock } from '../../../../components/feedback'
import { Button } from '../../../../components/primitives'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { clearHistory as clearHistoryRemote } from '../api'
import { useApiTesterStore } from '../store'

function statusClass(status: number): string {
  if (status < 300) return 'text-[var(--success)] border-[var(--success)]/40'
  if (status < 400) return 'text-[var(--warning)] border-[var(--warning)]/40'
  return 'text-[var(--danger)] border-[var(--danger)]/40'
}

export function HistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const history = useApiTesterStore((s) => s.state.history)
  const workspaceId = useApiTesterStore((s) => s.activeWorkspaceId)
  const addNode = useApiTesterStore((s) => s.addNode)
  const clearLocal = useApiTesterStore((s) => s.clearHistoryLocal)
  const loadHistory = useApiTesterStore((s) => s.loadHistory)
  const historyLoading = useApiTesterStore((s) => s.historyLoading)
  const historyError = useApiTesterStore((s) => s.historyError)

  // History no longer rides along with the workspace state: it is read when the dialog needs it.
  useEffect(() => {
    if (open) void loadHistory()
  }, [open, loadHistory, workspaceId])

  const restore = (entry: HistoryEntry) => {
    addNode({
      id: newApiTesterId(),
      type: 'request',
      kind: entry.kind,
      name: `${entry.name} (${t('development.apitester.restored')})`,
      parentId: null,
      order: Date.now(),
      tags: [...entry.tags],
      request: {
        ...entry.request,
        headers: entry.request.headers.map((header) => ({ ...header })),
        params: entry.request.params.map((param) => ({ ...param })),
        formFields: entry.request.formFields.map((field) => ({ ...field })),
      },
      updatedAt: Date.now(),
    })
    onClose()
  }

  const clear = async () => {
    const ok = await confirm({
      title: t('development.apitester.clear_history'),
      description: t('development.apitester.clear_history_confirm'),
      tone: 'danger',
      confirmLabel: t('common.clear'),
      cancelLabel: t('common.cancel'),
    })
    if (!ok) return
    clearLocal()
    void clearHistoryRemote(workspaceId).catch((error) => {
      console.warn('[inkstone] API Tester history could not be cleared', error)
    })
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.apitester.history_title', { count: history.length })} width={680}>
      <div className="space-y-1">
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" className="gap-1 text-[var(--danger)]" disabled={history.length === 0} onClick={() => void clear()}>
            <Trash2 size={13} /> {t('development.apitester.clear_history')}
          </Button>
        </div>
        {historyError ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-[length:var(--text-12)] text-[var(--danger)]">
            <p className="max-w-[420px] break-words">{t('development.apitester.load_failed', { msg: historyError })}</p>
            <Button size="sm" variant="secondary" onClick={() => void loadHistory()}>
              {t('development.apitester.retry')}
            </Button>
          </div>
        ) : historyLoading && history.length === 0 ? (
          <LoadingBlock label={t('development.apitester.loading')} />
        ) : history.length === 0 ? (
          <p className="py-8 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.apitester.history_empty')}</p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto overscroll-contain">
            {history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => restore(entry)}
                title={t('development.apitester.restore_history')}
                className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-11-5)] hover:bg-[var(--bg-hover)]"
              >
                <span className="w-12 shrink-0 font-mono text-[length:var(--text-10)] font-semibold text-[var(--text-secondary)]">{entry.method}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-primary)]">{entry.url || entry.name}</span>
                <span className={cn('shrink-0 rounded border px-1 font-mono text-[length:var(--text-10)]', statusClass(entry.status))}>{entry.status}</span>
                <span className="shrink-0 text-[var(--text-tertiary)]">{entry.durationMs} {t('development.apitester.ms')}</span>
                <span className="shrink-0 text-[var(--text-quaternary)]">{new Date(entry.ts).toLocaleTimeString()}</span>
              </button>
            ))}
          </div>
        )}
        <p className="flex items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"><HistoryIcon size={11} /> {t('development.apitester.history_hint')}</p>
      </div>
    </Modal>
  )
}
