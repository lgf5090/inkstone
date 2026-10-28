/** PDF export options: page range, cover page, printed header and a cancellable progress line. */
import { useEffect, useRef, useState } from 'react'
import type { InknoteNoteMeta, InknotePage } from '@shared/inknote/types'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { Input, Switch } from '../../../components/form'
import { parsePageRange } from '../../../lib/inknote/page-range'
import { exportPdf } from './operations'
import { useUi } from '../../../store/ui'

interface Props {
  open: boolean
  onClose: () => void
  note: InknoteNoteMeta
  pages: InknotePage[]
  settings: { fontFamily: string }
}

export function ExportPdfDialog({ open, onClose, note, pages, settings }: Props) {
  const toast = useUi((state) => state.toast)
  const [range, setRange] = useState('')
  const [cover, setCover] = useState(false)
  const [header, setHeader] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    if (!open) return
    setRange('')
    setCover(false)
    setHeader(false)
    setBusy(false)
    setProgress(null)
    cancelled.current = false
  }, [open])

  const run = async () => {
    cancelled.current = false
    const selected = parsePageRange(range, pages.length)
    setBusy(true)
    setProgress({ done: 0, total: selected.length })
    try {
      const done = await exportPdf(note, pages, settings, {
        range,
        cover,
        header,
        onProgress: (value, total) => setProgress({ done: value, total }),
        isCancelled: () => cancelled.current,
      })
      if (done) toast({ title: t('inknote.pdf.done') })
      else if (cancelled.current) toast({ title: t('inknote.pdf.cancelled') })
      if (done) onClose()
    } catch (error) {
      toast({ title: String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('inknote.pdf.title')} width={440}>
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-[length:var(--text-12)]">{t('inknote.pdf.range')}</span>
          <Input value={range} onChange={(event) => setRange(event.target.value)} placeholder={`1-${pages.length}`} aria-label={t('inknote.pdf.range')} disabled={busy}/>
          <span className="block text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('inknote.pdf.range_hint')}</span>
        </label>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[length:var(--text-12)]">{t('inknote.pdf.cover')}</span>
          <Switch checked={cover} onChange={setCover} label={t('inknote.pdf.cover')} disabled={busy}/>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[length:var(--text-12)]">{t('inknote.pdf.header')}</span>
          <Switch checked={header} onChange={setHeader} label={t('inknote.pdf.header')} disabled={busy}/>
        </div>
        {progress && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.pdf.progress', { done: String(progress.done), total: String(progress.total) })}</p>}
        <div className="flex justify-end gap-2">
          {busy
            ? <Button size="sm" variant="secondary" onClick={() => { cancelled.current = true }}>{t('inknote.pdf.cancel')}</Button>
            : <Button size="sm" variant="primary" onClick={() => void run()}>{t('inknote.action.export_pdf')}</Button>}
        </div>
      </div>
    </Modal>
  )
}
