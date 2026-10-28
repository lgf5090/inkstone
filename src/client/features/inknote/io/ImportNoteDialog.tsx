/** Import a .note/.notebook file with progress and cancel; a failed import rolls itself back. */
import { useEffect, useRef, useState } from 'react'
import { FileUp } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { importNoteFile } from './operations'
import { useUi } from '../../../store/ui'

export function ImportNoteDialog({ open, onClose, file, notebookId }: {
  open: boolean
  onClose: () => void
  file: File | null
  notebookId: string | null
}) {
  const toast = useUi((state) => state.toast)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!open) return
    setBusy(false)
    setProgress(null)
    cancelled.current = false
  }, [open])

  const run = async () => {
    if (!file || !notebookId) return
    cancelled.current = false
    setBusy(true)
    setProgress({ done: 0, total: 0 })
    try {
      const result = await importNoteFile(file, notebookId, {
        onProgress: (done, total) => setProgress({ done, total }),
        isCancelled: () => cancelled.current,
      })
      toast({ title: t('inknote.import.done', { count: String(result.notes) }) })
      onClose()
    } catch (error) {
      const cancelledMessage = error instanceof Error && error.message.includes('Import cancelled')
      toast({ title: cancelledMessage ? t('inknote.import.cancelled') : String(error), tone: cancelledMessage ? 'default' : 'danger' })
      if (cancelledMessage) setProgress(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => { cancelled.current = true } : onClose} title={t('inknote.import.title')} width={440}>
      <div className="space-y-3">
        <p className="truncate text-[length:var(--text-12)]" title={file?.name}>{file?.name ?? ''}</p>
        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.import.hint')}</p>
        {progress && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.import.progress', { done: String(progress.done), total: String(progress.total) })}</p>}
        <div className="flex justify-end gap-2">
          {busy
            ? <Button size="sm" variant="secondary" onClick={() => { cancelled.current = true }}>{t('inknote.import.cancel')}</Button>
            : <Button size="sm" variant="primary" icon={<FileUp size={13}/>} disabled={!file || !notebookId} onClick={() => void run()}>{t('inknote.import.start')}</Button>}
        </div>
      </div>
    </Modal>
  )
}
