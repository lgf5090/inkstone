/** Scan documents: take or pick several photos, review them, then make a note with one page each. */
import { useEffect, useRef, useState } from 'react'
import { Camera, Plus, ScanLine, Trash2 } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { scanImages } from './operations'
import { useUi } from '../../../store/ui'

interface Shot {
  file: File
  url: string
}

export function ScanDialog({ open, onClose, notebookId }: { open: boolean; onClose: () => void; notebookId: string | null }) {
  const toast = useUi((state) => state.toast)
  const [shots, setShots] = useState<Shot[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const cancelled = useRef(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  const albumRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setShots((current) => { for (const shot of current) URL.revokeObjectURL(shot.url); return [] })
    setBusy(false)
    setProgress(null)
    cancelled.current = false
  }, [open])

  const add = (files: FileList | null) => {
    if (!files) return
    const next = [...files].filter((file) => file.type.startsWith('image/')).map((file) => ({ file, url: URL.createObjectURL(file) }))
    setShots((current) => [...current, ...next])
  }

  const remove = (index: number) => {
    setShots((current) => {
      const shot = current[index]
      if (shot) URL.revokeObjectURL(shot.url)
      return current.filter((_, position) => position !== index)
    })
  }

  const start = async () => {
    if (!notebookId || shots.length === 0) return
    cancelled.current = false
    setBusy(true)
    setProgress({ done: 0, total: shots.length })
    try {
      const result = await scanImages(shots.map((shot) => shot.file), notebookId, {
        title: t('inknote.scan.note_title', { date: new Date().toLocaleDateString() }),
        onProgress: (done, total) => setProgress({ done, total }),
        isCancelled: () => cancelled.current,
      })
      if (result.cancelled) toast({ title: t('inknote.scan.cancelled') })
      else if (result.noteId) {
        toast({ title: t('inknote.scan.done', { count: String(result.pages) }) })
        onClose()
      }
    } catch (error) {
      toast({ title: String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => { cancelled.current = true } : onClose} title={t('inknote.scan.title')} width={560}>
      <div className="space-y-3">
        <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.scan.hint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<Camera size={13}/>} onClick={() => cameraRef.current?.click()} disabled={busy}>{t('inknote.scan.camera')}</Button>
          <Button size="sm" variant="secondary" icon={<Plus size={13}/>} onClick={() => albumRef.current?.click()} disabled={busy}>{t('inknote.scan.album')}</Button>
        </div>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(event) => { add(event.target.files); event.target.value = '' }}/>
        <input ref={albumRef} type="file" accept="image/*" multiple hidden onChange={(event) => { add(event.target.files); event.target.value = '' }}/>
        {shots.length === 0 && <p className="rounded-[var(--r-sm)] border border-dashed border-[var(--border-default)] py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.scan.empty')}</p>}
        <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
          {shots.map((shot, index) => (
            <div key={`${shot.url}:${index}`} className="relative overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)]">
              <img src={shot.url} alt={`${t('inknote.scan.page')} ${index + 1}`} className="h-24 w-full object-cover"/>
              <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[length:var(--text-10)] text-white">{index + 1}</span>
              <IconButton label={t('inknote.delete')} size="xs" className="absolute right-1 top-1 bg-black/60 text-white" onClick={() => remove(index)} disabled={busy}><Trash2 size={10}/></IconButton>
            </div>
          ))}
        </div>
        {progress && <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.scan.progress', { done: String(progress.done), total: String(progress.total) })}</p>}
        <div className="flex justify-end gap-2">
          {busy
            ? <Button size="sm" variant="secondary" onClick={() => { cancelled.current = true }}>{t('inknote.scan.cancel')}</Button>
            : <Button size="sm" variant="primary" icon={<ScanLine size={13}/>} disabled={shots.length === 0 || !notebookId} onClick={() => void start()}>{t('inknote.scan.start')}</Button>}
        </div>
      </div>
    </Modal>
  )
}
