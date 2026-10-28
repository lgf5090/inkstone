/** The live page: engine mount, text overlay and the selection bar. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, RotateCw, SquareDashed, Trash2, X } from 'lucide-react'
import type { InknoteNoteMeta, InknotePage, InknoteSettings, InknoteTextBox } from '@shared/inknote/types'
import { inknoteTextDefaults } from '../tool-state'
import { autoTextBoxSize, fontStackFor } from '../../../lib/inknote/text-layout'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { InknoteEngineImpl, type InknoteEngineApi, type InknoteEngineHostExtras } from '../engine/inknote-engine'
import type { InknoteEngineHost, InknotePageMetrics, InknoteToolState } from '../engine/inknote-engine-types'
import { useInknoteStore } from '../store'
import { useUi } from '../../../store/ui'

interface Props {
  note: InknoteNoteMeta
  page: InknotePage
  pageIndex: number
  pageCount: number
  settings: InknoteSettings
  onSelectPage: (id: string) => void
  onPrevPage: () => void
  onNextPage: () => void
  onEngine: (engine: InknoteEngineApi | null) => void
  tool: InknoteToolState
}

interface Editing {
  id: string
  item: InknoteTextBox
  value: string
  screen: { left: number; top: number; width: number; minHeight: number; fontSize: number; color: string }
}

function cssFont(settings: InknoteSettings): string {
  return fontStackFor(settings.fontFamily)
}

function measureWithCanvas(): (text: string, fontSpec: string) => number {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  return (text, fontSpec) => {
    if (!context) return text.length
    context.font = fontSpec
    return context.measureText(text).width
  }
}

export function InkCanvasArea({ note, page, pageIndex, pageCount, settings, onPrevPage, onNextPage, onEngine, tool }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<InknoteEngineApi | null>(null)
  const [zoom, setZoom] = useState(1)
  const [selection, setSelection] = useState<string[]>([])
  const [editing, setEditing] = useState<Editing | null>(null)
  const latest = useRef({ note, page, settings, tool })
  latest.current = { note, page, settings, tool }
  const toast = useUi((state) => state.toast)
  const touchPage = useInknoteStore((state) => state.touchPage)
  const savePage = useInknoteStore((state) => state.savePage)
  const createPage = useInknoteStore((state) => state.createPage)
  const setActivePage = useInknoteStore((state) => state.setActivePage)
  const metrics: InknotePageMetrics = useMemo(() => ({
    width: note.pageWidth,
    height: note.pageHeight,
    contentWidth: note.contentWidth,
    contentHeight: note.contentHeight,
  }), [note.pageWidth, note.pageHeight, note.contentWidth, note.contentHeight])

  const openTextEditor = useCallback((world: { x: number; y: number }) => {
    const engine = engineRef.current
    if (!engine) return
    const hit = engine.hitText(world)
    const existing = hit ?? null
    const current = latest.current
    const item: InknoteTextBox = existing ?? {
      ...inknoteTextDefaults(),
      x: Math.max(0.02, Math.min(0.82, world.x / current.note.pageWidth)),
      y: Math.max(0.02, Math.min(0.9, world.y / current.note.pageHeight)),
    }
    if (!existing) {
      current.page.content.texts.push(item)
      engine.invalidate()
    }
    const topLeft = engine.worldToScreen(item.x * current.note.pageWidth, item.y * current.note.pageHeight)
    const scale = engine.getScale()
    setEditing({
      id: item.id,
      item,
      value: item.text,
      screen: {
        left: topLeft.x,
        top: topLeft.y,
        width: Math.max(120, item.w * current.note.pageWidth * scale),
        minHeight: Math.max(32, item.fontSize * (item.lh || 1.3) * scale),
        fontSize: Math.max(12, item.fontSize * scale),
        color: item.color,
      },
    })
    touchPage()
  }, [touchPage])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !hostRef.current) return
    const engine = new InknoteEngineImpl()
    engineRef.current = engine
    const host: InknoteEngineHost & InknoteEngineHostExtras = {
      getPage: () => latest.current.page.content,
      getPaper: () => latest.current.note.paper,
      getPageMetrics: () => ({
        width: latest.current.note.pageWidth,
        height: latest.current.note.pageHeight,
        contentWidth: latest.current.note.contentWidth,
        contentHeight: latest.current.note.contentHeight,
      }),
      getFont: () => cssFont(latest.current.settings),
      getTool: () => latest.current.tool,
      onContentChange: () => touchPage(),
      onCommit: () => touchPage(),
      onTextTap: (world) => openTextEditor(world),
      onSelectionChange: (ids) => setSelection(ids),
      onGesture: (action) => {
        if (action === 'undo') engine.undo()
        else if (action === 'redo') engine.redo()
        else {
          const state = useInknoteStore.getState()
          const index = state.activePageIndex + (action === 'page-next' ? 1 : -1)
          const target = state.pages[index]
          if (target) setActivePage(target.id)
        }
      },
      onAutoPage: () => {
        const state = useInknoteStore.getState()
        if (state.activePageIndex < state.pages.length - 1) setActivePage(state.pages[state.activePageIndex + 1]!.id)
        else void createPage()
      },
      onViewportChange: (nextZoom) => setZoom(nextZoom),
      getSettings: () => ({
        fingerDraw: latest.current.settings.fingerDraw,
        autoPage: latest.current.settings.autoPage,
        twoFingerAction: latest.current.settings.twoFingerAction,
        threeFingerAction: latest.current.settings.threeFingerAction,
      }),
      onShapeRecognized: (kind) => {
        toast({ title: t('inknote.shape.recognized', { shape: t(`inknote.shape.${kind}` as never) }) })
      },
    }
    engine.mount(canvas, host)
    onEngine(engine)
    engine.setPage(page.content, note.paper, metrics)
    engine.setTool(tool)
    engine.setFont(cssFont(settings))
    engine.fitView()
    return () => {
      engine.destroy()
      engineRef.current = null
      onEngine(null)
    }
    // The engine is mounted once; page/tool changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.setPage(page.content, note.paper, metrics)
    engine.setFont(cssFont(settings))
    engine.setTool(tool)
    engine.fitView()
  }, [note.id, page.id, note.paper, metrics, settings.fontFamily])

  useEffect(() => {
    engineRef.current?.setTool(tool)
  }, [tool])

  const commitText = useCallback(() => {
    const current = editing
    setEditing(null)
    if (!current) return
    const text = current.value.replace(/\n+$/g, '')
    const item = current.item
    if (!text.trim()) {
      latest.current.page.content.texts = latest.current.page.content.texts.filter((entry) => entry.id !== item.id)
    } else {
      item.text = text
      const measure = measureWithCanvas()
      const size = autoTextBoxSize(text, item, measure, {
        pageWidth: latest.current.note.pageWidth,
        pageHeight: latest.current.note.pageHeight,
        font: cssFont(latest.current.settings),
      })
      item.w = Math.max(0.12, size.w / latest.current.note.pageWidth)
      item.h = Math.max(0.04, size.h / latest.current.note.pageHeight)
    }
    engineRef.current?.invalidate()
    touchPage()
    void savePage()
  }, [editing, savePage, touchPage])

  const cancelText = useCallback(() => {
    const current = editing
    setEditing(null)
    if (!current) return
    if (!current.item.text) {
      latest.current.page.content.texts = latest.current.page.content.texts.filter((entry) => entry.id !== current.item.id)
      engineRef.current?.invalidate()
      touchPage()
    }
  }, [editing, touchPage])

  const selectionAction = (action: 'delete' | 'copy' | 'select-all' | 'rotate' | 'clear') => {
    const engine = engineRef.current
    if (!engine) return
    if (action === 'delete') engine.deleteSelection()
    else if (action === 'copy') engine.copySelection()
    else if (action === 'select-all') engine.selectAll()
    else if (action === 'rotate') engine.rotateSelection()
    else engine.clearSelection()
    engine.renderNow()
    touchPage()
  }

  return (
    <div className="inknote-canvas-area relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-sunken)]" ref={hostRef}>
      <div className="inknote-page-scroll flex min-h-0 flex-1 items-start justify-center overflow-auto p-3 md:p-6">
        <div className="inknote-page-frame relative shadow-[var(--shadow-md)]" style={{ aspectRatio: `${note.pageWidth} / ${note.pageHeight}`, width: 'min(100%, 860px)' }}>
          <canvas ref={canvasRef} className="inknote-canvas block size-full touch-none rounded-[2px]" aria-label={t('inknote.tool.pen')} />
          {editing && (
            <div className="absolute inset-0 z-[var(--z-float)]" aria-hidden="true" onPointerDown={(event) => { event.preventDefault(); commitText() }} />
          )}
          {editing && (
            <textarea
              autoFocus
              aria-label={t('inknote.text.placeholder')}
              value={editing.value}
              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
              onBlur={commitText}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); cancelText() }
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commitText() }
              }}
              className="inknote-text-editor absolute resize-none rounded-[2px] border border-[var(--accent)] bg-transparent p-0 outline-none"
              style={{
                left: editing.screen.left,
                top: editing.screen.top,
                width: editing.screen.width,
                minHeight: editing.screen.minHeight,
                fontSize: editing.screen.fontSize,
                lineHeight: 1.3,
                color: editing.screen.color,
                fontFamily: cssFont(settings),
                background: 'color-mix(in oklab, var(--bg-overlay) 88%, transparent)',
                zIndex: 'calc(var(--z-float) + 1)',
              }}
            />
          )}
        </div>
      </div>
      <div className="flex h-9 shrink-0 items-center justify-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <Button size="sm" variant="ghost" onClick={onPrevPage} disabled={pageIndex <= 0}>‹</Button>
        <span data-page-indicator="">{pageIndex + 1} / {pageCount}</span>
        <Button size="sm" variant="ghost" onClick={onNextPage} disabled={pageIndex >= pageCount - 1}>›</Button>
        <span className="mx-2 opacity-60">{Math.round(zoom * 100)}%</span>
      </div>
      {selection.length > 0 && (
        <div className="absolute bottom-12 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-md)]" role="toolbar" aria-label={t('inknote.action.select_all')}>
          <IconButton label={t('inknote.action.delete_selection')} size="sm" onClick={() => selectionAction('delete')}><Trash2 size={14}/></IconButton>
          <IconButton label={t('inknote.action.copy_selection')} size="sm" onClick={() => selectionAction('copy')}><Copy size={14}/></IconButton>
          <IconButton label={t('inknote.action.rotate')} size="sm" onClick={() => selectionAction('rotate')}><RotateCw size={14}/></IconButton>
          <IconButton label={t('inknote.action.select_all')} size="sm" onClick={() => selectionAction('select-all')}><SquareDashed size={14}/></IconButton>
          <IconButton label={t('inknote.action.close_selection')} size="sm" onClick={() => selectionAction('clear')}><X size={14}/></IconButton>
        </div>
      )}
    </div>
  )
}
