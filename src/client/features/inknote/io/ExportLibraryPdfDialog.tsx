/** Export the notes of one notebook as a PDF with a cover page each, with progress and cancel. */
import { useEffect, useRef, useState } from 'react'
import type { InknoteNoteMeta } from '@shared/inknote/types'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { exportLibraryPdf } from './operations'
import { useUi } from '../../../store/ui'

export function ExportLibraryPdfDialog({ open, onClose, notes, settings }: {
  open: boolean
  onClose: () => void
  notes: InknoteNoteMeta[]
  settings: { fontFamily: string }
}) {
  const toast = useUi((state) => state.toast)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!open) return
    setBusy(false)
    setProgress(null)
    setError(null)
    cancelled.current = false
  }, [open])

  const run = async () => {
    cancelled.current = false
    setBusy(true)
    setError(null)
    try {
      const done = await exportLibraryPdf(notes, settings, {
        title: t('inknote.export.library_title', { date: new Date().toLocaleDateString() }),
        onProgress: (value, total) => setProgress({ done: value, total }),
        isCancelled: () => cancelled.current,
      })
      if (done) {
        toast({ title: t('inknote.export.library_done') })
        onClose()
      } else if (cancelled.current) {
        toast({ title: t('inknote.export.cancelled') })
      }
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => { cancelled.current = true } : onClose} title={t('inknote.export.library_pdf')} width={460}>
      <div className="space-y-3">
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.export.library_hint', { count: String(notes.length) })}</p>
        {error && <p className="text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
        {progress && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.export.progress', { done: String(progress.done), total: String(progress.total) })}</p>}
        <div className="flex justify-end gap-2">
          {busy
            ? <Button size="sm" variant="secondary" onClick={() => { cancelled.current = true }}>{t('inknote.export.cancel')}</Button>
            : <Button size="sm" variant="primary" disabled={notes.length === 0} onClick={() => void run()}>{t('inknote.export.library_pdf')}</Button>}
        </div>
      </div>
    </Modal>
  )
}
