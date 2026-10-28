/** Page thumbnails and the page-level actions that sit beside the canvas. */
import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, Copy, CopyPlus, Eraser, FileMinus, Plus, Trash2 } from 'lucide-react'
import type { InknoteNoteMeta, InknotePage } from '@shared/inknote/types'
import { t } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { fontStackFor } from '../../../lib/inknote/text-layout'
import { renderPageToCanvas } from '../engine/renderer'
import type { InknoteSettings } from '@shared/inknote/types'

function PageThumb({ page, note, settings, active, onClick }: { page: InknotePage; note: InknoteNoteMeta; settings: InknoteSettings; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = renderPageToCanvas(page.content, note.paper, {
      width: note.pageWidth,
      height: note.pageHeight,
      contentWidth: note.contentWidth,
      contentHeight: note.contentHeight,
    }, 144, fontStackFor(settings.fontFamily))
    const target = ref.current
    if (!target || !canvas) return
    target.width = canvas.width
    target.height = canvas.height
    target.getContext('2d')?.drawImage(canvas, 0, 0)
  }, [page.content, page.rev, note.paper, note.pageWidth, note.pageHeight, note.contentWidth, note.contentHeight, settings.fontFamily])
  return (
    <button type="button" onClick={onClick} aria-label={`${t('inknote.action.pages')} ${page.position + 1}`} className={`block w-full rounded-[var(--r-sm)] border p-0.5 ${active ? 'border-[var(--accent)]' : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'}`}>
      <canvas ref={ref} className="block w-full rounded-[2px] bg-white" />
      <span className="block py-0.5 text-center text-[length:var(--text-10)] text-[var(--text-tertiary)]">{page.position + 1}</span>
    </button>
  )
}

export function InkPagesPanel({ note, pages, activePageId, settings, onSelect, onAdd, onDuplicate, onDelete, onMove, onClear, onDeleteBlank, onCopyTo }: {
  note: InknoteNoteMeta
  pages: InknotePage[]
  activePageId: string | null
  settings: InknoteSettings
  onSelect: (id: string) => void
  onAdd: () => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onClear: () => void
  onDeleteBlank: () => void
  onCopyTo: () => void
}) {
  const activeIndex = pages.findIndex((page) => page.id === activePageId)
  return (
    <aside className="flex h-full min-h-0 w-[168px] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="flex items-center justify-between px-2 py-2">
        <span className="text-[length:var(--text-12)] font-semibold">{t('inknote.action.pages')}</span>
        <div className="flex items-center gap-0.5">
          <IconButton label={t('inknote.page.clear')} size="sm" onClick={onClear} disabled={!activePageId}><Eraser size={13}/></IconButton>
          <IconButton label={t('inknote.copy_page_to')} size="sm" onClick={onCopyTo} disabled={!activePageId}><CopyPlus size={13}/></IconButton>
          {pages.length > 1 && <IconButton label={t('inknote.page.delete_blank')} size="sm" onClick={onDeleteBlank}><FileMinus size={13}/></IconButton>}
          <IconButton label={t('inknote.page.add')} size="sm" onClick={onAdd}><Plus size={14}/></IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {pages.map((page) => (
          <div key={page.id} className="group relative">
            <PageThumb page={page} note={note} settings={settings} active={page.id === activePageId} onClick={() => onSelect(page.id)} />
            <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <IconButton label={t('inknote.page.duplicate')} size="xs" onClick={() => onDuplicate(page.id)}><Copy size={10}/></IconButton>
              {pages.length > 1 && <IconButton label={t('inknote.page.delete')} size="xs" onClick={() => onDelete(page.id)}><Trash2 size={10}/></IconButton>}
            </div>
            <div className="absolute bottom-1 left-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              {page.position > 0 && <IconButton label={t('inknote.page.move_up')} size="xs" onClick={() => onMove(page.id, -1)}><ArrowUp size={10}/></IconButton>}
              {page.position < pages.length - 1 && <IconButton label={t('inknote.page.move_down')} size="xs" onClick={() => onMove(page.id, 1)}><ArrowDown size={10}/></IconButton>}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--border-subtle)] px-2 py-1.5 text-center text-[length:var(--text-10)] text-[var(--text-tertiary)]">{activeIndex + 1} / {pages.length}</div>
    </aside>
  )
}
