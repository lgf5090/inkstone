/** A full-screen page viewer with keyboard/touch paging and optional auto-play. */
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { InknoteNoteMeta, InknotePage } from '@shared/inknote/types'
import { t } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { fontStackFor } from '../../../lib/inknote/text-layout'
import { renderPageToCanvas } from '../engine/renderer'

export function PresentationOverlay({ note, pages, initialIndex, onClose }: {
  note: InknoteNoteMeta
  pages: InknotePage[]
  initialIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, pages.length - 1)))
  const [playing, setPlaying] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const page = pages[index]
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !page) return
    const rendered = renderPageToCanvas(page.content, note.paper, {
      width: note.pageWidth, height: note.pageHeight, contentWidth: note.contentWidth, contentHeight: note.contentHeight,
    }, 1600, fontStackFor('system'))
    if (!rendered) return
    canvas.width = rendered.width; canvas.height = rendered.height
    canvas.getContext('2d')?.drawImage(rendered, 0, 0)
  }, [note, page])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowRight' || event.key === ' ') setIndex((value) => Math.min(pages.length - 1, value + 1))
      if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1))
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose, pages.length])
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => setIndex((value) => value >= pages.length - 1 ? 0 : value + 1), 5000)
    return () => window.clearInterval(timer)
  }, [playing, pages.length])
  if (!page) return null
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex flex-col bg-black">
      <div className="flex h-11 items-center gap-2 bg-black/60 px-3 text-white">
        <span className="text-[length:var(--text-12)]">{index + 1} / {pages.length}</span>
        <span className="flex-1" />
        <button type="button" className="rounded px-2 py-1 text-[length:var(--text-12)] hover:bg-white/15" onClick={() => setPlaying((value) => !value)}>{playing ? t('inknote.presentation.pause' as never) : t('inknote.presentation.play' as never)}</button>
        <IconButton label={t('inknote.presentation.exit' as never)} size="sm" onClick={onClose}><X size={16}/></IconButton>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4" onClick={() => setIndex((value) => Math.min(pages.length - 1, value + 1))}>
        <canvas ref={canvasRef} className="max-h-full max-w-full bg-white shadow-2xl" />
      </div>
      <div className="flex h-12 items-center justify-center gap-4 bg-black/60 text-white">
        <IconButton label={t('inknote.page.prev' as never)} size="sm" onClick={() => setIndex((value) => Math.max(0, value - 1))}><ChevronLeft size={18}/></IconButton>
        <span>{note.title}</span>
        <IconButton label={t('inknote.page.next' as never)} size="sm" onClick={() => setIndex((value) => Math.min(pages.length - 1, value + 1))}><ChevronRight size={18}/></IconButton>
      </div>
    </div>
  )
}
