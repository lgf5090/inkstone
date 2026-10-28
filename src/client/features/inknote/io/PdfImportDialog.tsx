/** Import a PDF as annotation pages: choose a range, watch the pages render, stop when needed. */
import { useEffect, useRef, useState } from 'react'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { Input } from '../../../components/form'
import { insertPdf } from './operations'
import { useUi } from '../../../store/ui'

const MAX_BYTES = 50 * 1024 * 1024

export function PdfImportDialog({ open, onClose, file, notebookId }: {
  open: boolean
  onClose: () => void
  file: File | null
  notebookId: string | null
}) {
  const toast = useUi((state) => state.toast)
  const [range, setRange] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!open) return
    setRange('')
    setBusy(false)
    setProgress(null)
    cancelled.current = false
  }, [open])

  const tooLarge = (file?.size ?? 0) > MAX_BYTES

  const run = async () => {
    if (!file || !notebookId || tooLarge) return
    cancelled.current = false
    setBusy(true)
    setProgress({ done: 0, total: 0 })
    try {
      const result = await insertPdf(file, notebookId, {
        range,
        onProgress: (done, total) => setProgress({ done, total }),
        isCancelled: () => cancelled.current,
      })
      if (result.cancelled) toast({ title: t('inknote.pdf_import.cancelled') })
      else if (result.noteId) {
        toast({ title: t('inknote.pdf_import.done', { count: String(result.imported) }) })
        onClose()
      }
    } catch (error) {
      toast({ title: String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => { cancelled.current = true } : onClose} title={t('inknote.pdf_import.title')} width={420}>
      <div className="space-y-3">
        <p className="truncate text-[length:var(--text-12)]" title={file?.name}>{file?.name ?? ''}</p>
        <label className="block space-y-1">
          <span className="text-[length:var(--text-12)]">{t('inknote.pdf_import.range')}</span>
          <Input value={range} onChange={(event) => setRange(event.target.value)} placeholder={t('inknote.pdf_import.range_placeholder')} aria-label={t('inknote.pdf_import.range')} disabled={busy}/>
          <span className="block text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('inknote.pdf_import.range_hint')}</span>
        </label>
        {tooLarge && <p className="text-[length:var(--text-11)] text-[var(--danger)]">{t('inknote.pdf_import.too_large')}</p>}
        {progress && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.pdf_import.progress', { done: String(progress.done), total: String(progress.total) })}</p>}
        <div className="flex justify-end gap-2">
          {busy
            ? <Button size="sm" variant="secondary" onClick={() => { cancelled.current = true }}>{t('inknote.pdf_import.cancel')}</Button>
            : <Button size="sm" variant="primary" disabled={!file || !notebookId || tooLarge} onClick={() => void run()}>{t('inknote.pdf_import.start')}</Button>}
        </div>
      </div>
    </Modal>
  )
}
