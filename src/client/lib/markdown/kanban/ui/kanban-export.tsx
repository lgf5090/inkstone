/**
 * KU-24. The view on screen, as a file: a PNG of exactly what the reader is looking at — the same
 * live canvas the screen draws, rasterized by the shared element-to-PNG layer (`lib/element-image.ts`)
 * — and the browser's own print pipeline for PDF, over an off-screen sheet that carries the view's
 * markup at 1:1. The picture is of the *view*, filters and all, because that is the thing the reader
 * aimed at; the door itself follows the CSV door's shape: one trigger, one panel, answers that stay.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FileJson, Image as ImageIcon, Printer } from 'lucide-react'
import { Button } from '../../../../components/primitives'
import { collectDocumentCss, renderElementPng, saveImage } from '../../../element-image'
import { downloadTextFile } from '../../../export-note'
import { settleWithin } from '../../../async'
import { t, useLocaleRepaint } from '../../../i18n'
import { serializeKanban } from '../body'
import type { KanbanData } from '../types'
import { KanbanPanel } from './kanban-panel'

/** Pictures and webfonts are what a sheet needs before it can print, and both may be slow. */
const SHEET_SETTLE_TIMEOUT_MS = 3000
/** A last beat on the main thread: the print dialog blocks it, so an unpainted sheet prints empty. */
const SHEET_PAINT_DELAY_MS = 250

/** The exported image is twice the view's own box, on the shared layer's scale. */
const SNAPSHOT_MAX_EDGE = 4000

function kanbanExportFilename(title: string, viewType: string, extension: string): string {
  const safe = title.replace(/[^\p{L}\p{N}_-]+/gu, '').trim()
  return `${safe || 'board'}-${viewType}.${extension}`
}

/** The live view panel's own box, clamped to what an SVG image can reasonably carry. */
function viewGeometry(panel: HTMLElement): { width: number; height: number } {
  const width = Math.max(1, Math.min(SNAPSHOT_MAX_EDGE, Math.round(panel.scrollWidth || panel.clientWidth)))
  const height = Math.max(1, Math.min(SNAPSHOT_MAX_EDGE, Math.round(panel.scrollHeight || panel.clientHeight)))
  return { width, height }
}

async function snapshotViewPng(panel: HTMLElement): Promise<Blob> {
  const css = await collectDocumentCss()
  return await renderElementPng(panel, viewGeometry(panel), css)
}

/** Waits for the sheet's own pictures and fonts, then a beat for the paint they triggered. */
async function waitForSheet(root: HTMLElement): Promise<void> {
  const decoded = [...root.querySelectorAll('img')].map((image) =>
    typeof image.decode === 'function' ? image.decode() : Promise.resolve(),
  )
  await settleWithin(
    Promise.allSettled([...decoded, document.fonts?.ready]),
    SHEET_SETTLE_TIMEOUT_MS,
  )
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, SHEET_PAINT_DELAY_MS)
  })
}

/** What a printed view needs around it: a page that fits the board and colors that survive paper. */
function kanbanPrintCss(width: number, height: number): string {
  return `@page { size: ${width}px ${height}px; margin: 0; }\n.kanban-print-page { width: ${width}px; height: ${height}px; }`
}

/**
 * The paper: the live view's markup at 1:1, off-screen while the dialog runs and everything else
 * hidden by the shared print rules (the same cascade the deck and the bento sheets join). The
 * caller keeps it mounted until `afterprint` says the reader is done.
 */
function KanbanPrintSheet({ panel, onDone }: { panel: HTMLElement; onDone: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const width = Math.max(1, Math.round(panel.scrollWidth || panel.clientWidth))
  const height = Math.max(1, Math.round(panel.scrollHeight || panel.clientHeight))

  // The clone, not the live node: the live canvas is mounted where the screen needs it, and moving
  // it would blank the board the reader is looking at while the dialog is up. Cloned as a node
  // rather than re-parsed out of `outerHTML`: the markup then never passes a second HTML parser
  // between the sanitized tree and the page, so there is no re-serialization to disagree with it.
  useEffect(() => {
    pageRef.current?.replaceChildren(panel.cloneNode(true))
  }, [panel])

  useEffect(() => {
    const root = sheetRef.current
    if (!root) return
    let cancelled = false
    const run = async (): Promise<void> => {
      await waitForSheet(root)
      if (cancelled) return
      window.print()
    }
    window.addEventListener('afterprint', onDone)
    void run()
    return () => {
      cancelled = true
      window.removeEventListener('afterprint', onDone)
    }
  }, [onDone])

  return createPortal(
    <div
      ref={sheetRef}
      data-kanban-print
      aria-hidden='true'
      inert
      className='kanban-print-sheet'
    >
      <style>{kanbanPrintCss(width, height)}</style>
      <div ref={pageRef} className='kanban-print-page' />
    </div>,
    document.body,
  )
}

export interface KanbanExportEntry {
  title: string
  viewType: string
  /** The live view panel, as the thing both doors rasterize or print. */
  panelRef: React.RefObject<HTMLElement | null>
  /**
   * The whole board as its own fence format, serialized on demand: the JSON door is a round trip
   * (the file a board writes is a board), so it carries views, columns and archived cards — more
   * than any one view could draw. Built lazily, so a board that is never exported never pays for it.
   */
  serializeJson: () => string
}

/** The doors: what each writes, and the last thing either one answered. */
export function useExportDoors(entry: KanbanExportEntry) {
  const { title, viewType, panelRef, serializeJson } = entry
  const [feedback, setFeedback] = useState<string[]>([])
  const [printPanel, setPrintPanel] = useState<HTMLElement | null>(null)

  const handlePng = useCallback(async () => {
    const panel = panelRef.current
    if (!panel) {
      setFeedback([t('preview.kanban_export_failed')])
      return
    }
    try {
      const blob = await snapshotViewPng(panel)
      saveImage(blob, kanbanExportFilename(title, viewType, 'png'))
      setFeedback([t('preview.kanban_export_png_done')])
    }
    catch (error: unknown) {
      console.warn('[inkstone] kanban view export failed', error)
      setFeedback([t('preview.kanban_export_failed')])
    }
  }, [panelRef, title, viewType])

  const handleJson = useCallback(() => {
    downloadTextFile(
      kanbanExportFilename(title, viewType, 'json'),
      serializeJson(),
      'application/json;charset=utf-8',
    )
    setFeedback([t('preview.kanban_export_json_done')])
  }, [serializeJson, title, viewType])

  const handlePrint = useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    setPrintPanel(panel)
  }, [panelRef])

  const finishPrint = useCallback(() => setPrintPanel(null), [])

  return { feedback, printPanel, handlePng, handleJson, handlePrint, finishPrint }
}

function ExportRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='flex items-center gap-1.5 rounded-[var(--r-xs)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

interface KanbanExportPanelProps {
  open: boolean
  panelId: string
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onPng: () => void
  onJson: () => void
  onPrint: () => void
  feedback: string[]
}

export function KanbanExportPanel({ open, panelId, anchorRef, onClose, onPng, onJson, onPrint, feedback }: KanbanExportPanelProps) {
  return (
    <KanbanPanel
      open={open}
      panelId={panelId}
      label={t('preview.kanban_export')}
      anchorRef={anchorRef}
      onClose={onClose}
      // The board reads a press anywhere as "stop what you were doing"; a press that meant one of
      // these rows is the panel's, not the board's.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className='z-[var(--z-popover)] flex w-64 flex-col gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]'
    >
      <ExportRow
        icon={<ImageIcon size={13} aria-hidden />}
        label={t('preview.kanban_export_png')}
        onClick={onPng}
      />
      <ExportRow
        icon={<FileJson size={13} aria-hidden />}
        label={t('preview.kanban_export_json')}
        onClick={onJson}
      />
      <ExportRow
        icon={<Printer size={13} aria-hidden />}
        label={t('preview.kanban_export_print')}
        onClick={onPrint}
      />
      {feedback.length > 0 && (
        <p role='status' className='text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
          {feedback.map((line) => (
            <span key={line} className='block'>{line}</span>
          ))}
        </p>
      )}
    </KanbanPanel>
  )
}

/** The panel plus the print sheet it can raise, without its own trigger — the compact menu's shape. */
export function KanbanExportDoor({
  entry,
  open,
  panelId,
  anchorRef,
  onClose,
}: {
  entry: KanbanExportEntry
  open: boolean
  panelId: string
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const { feedback, printPanel, handlePng, handleJson, handlePrint, finishPrint } = useExportDoors(entry)
  return (
    <>
      <KanbanExportPanel
        open={open}
        panelId={panelId}
        anchorRef={anchorRef}
        onClose={onClose}
        onPng={() => void handlePng()}
        onJson={handleJson}
        onPrint={() => {
          onClose()
          handlePrint()
        }}
        feedback={feedback}
      />
      {printPanel && <KanbanPrintSheet panel={printPanel} onDone={finishPrint} />}
    </>
  )
}

/** The board's export door, shaped like the CSV door: one trigger, one panel, answers that stay. */
export function KanbanExportAction({ entry }: { entry: KanbanExportEntry }) {
  useLocaleRepaint()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  return (
    <>
      <Button
        ref={btnRef}
        size='sm'
        variant='ghost'
        data-kanban-export
        icon={<ImageIcon size={13} aria-hidden />}
        onClick={() => setOpen((o) => !o)}
        className={open ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : undefined}
        aria-label={t('preview.kanban_export')}
        aria-haspopup='dialog'
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
      >
        <span className='hidden @4xl:inline'>{t('preview.kanban_export')}</span>
      </Button>
      <KanbanExportDoor
        entry={entry}
        open={open}
        panelId={panelId}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/**
 * The entry the header hands down. It moves when the board does — the JSON door writes the live
 * board, so its serializer has to see the current one — at the same pace the CSV door's entry
 * already does, which is one identity per commit rather than one per render.
 */
export function useKanbanExportEntry(
  data: KanbanData,
  viewType: string,
  panelRef: React.RefObject<HTMLElement | null>,
): KanbanExportEntry {
  return useMemo(
    () => ({
      title: data.title ?? '',
      viewType,
      panelRef,
      serializeJson: () => serializeKanban(data, 'json'),
    }),
    [data, viewType, panelRef],
  )
}
