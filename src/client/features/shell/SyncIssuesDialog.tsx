import { useState } from 'react'
import { AlertTriangle, Copy, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '../../components/primitives'
import { Modal, confirm } from '../../components/overlay'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'

export function SyncIssuesDialog({ open, onClose }: { open: boolean, onClose: () => void }) {
  const items = useNotes((state) => state.failedOutbox)
  const notes = useNotes((state) => state.notes)
  const retry = useNotes((state) => state.retryOutboxItem)
  const discard = useNotes((state) => state.discardOutboxItem)
  const saveCopy = useNotes((state) => state.saveOutboxItemAsCopy)
  const online = useNotes((state) => state.online)
  const toast = useUi((state) => state.toast)
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    try {
      await action()
    } catch (error) {
      toast({ title: t('common.action_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('sync.issues_title')} width={560}>
      <div className="space-y-3">
        {items.length === 0
          ? <p className="py-6 text-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('sync.no_issues')}</p>
          : items.map((item) => {
            const key = `${item.id}:${item.writeId}`
            const title = notes[item.entityId]?.title || t('sync.unknown_note')
            return (
              <div key={key} className="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--danger)]"/>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{title}</div>
                    <p className="mt-1 break-words text-[length:var(--text-12)] text-[var(--text-secondary)]">{item.lastError || t('sync.unknown_error')}</p>
                    <p className="mt-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('sync.attempts_value0', { value0: item.attempts })}</p>
                  </div>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button size="sm" variant="secondary" icon={<RefreshCw size={12}/>} loading={busy === key} disabled={busy !== null || !online} onClick={() => void run(key, () => retry(item.id, item.writeId))}>{t('common.retry')}</Button>
                  <Button size="sm" variant="secondary" icon={<Copy size={12}/>} loading={busy === key} disabled={busy !== null || !online} onClick={() => void run(key, async () => { await saveCopy(item.id, item.writeId, item.entityId) })}>{t('sync.save_copy')}</Button>
                  <Button size="sm" variant="danger" icon={<Trash2 size={12}/>} loading={busy === key} disabled={busy !== null || !online} onClick={() => void run(key, async () => {
                    const accepted = await confirm({
                      title: t('sync.discard_title'),
                      description: t('sync.discard_description'),
                      confirmLabel: t('sync.discard'),
                      tone: 'danger',
                    })
                    if (accepted) await discard(item.id, item.writeId, item.entityId)
                  })}>{t('sync.discard')}</Button>
                </div>
              </div>
            )
          })}
      </div>
    </Modal>
  )
}
