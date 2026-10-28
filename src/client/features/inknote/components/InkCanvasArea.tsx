/** The live page: engine mount, text overlay and the selection bar. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardCopy, Copy, FileImage, ImageUp, RotateCw, SquareDashed, Trash2, X } from 'lucide-react'
import type { InknoteNoteMeta, InknotePage, InknotePageContent, InknoteSettings, InknoteTextBox } from '@shared/inknote/types'
import { INKNOTE_LIMITS } from '@shared/inknote/constants'
import { serializePageContent } from '@shared/inknote/parse'
import { inknoteTextDefaults } from '../tool-state'
import { autoTextBoxSize, fontStackFor } from '../../../lib/inknote/text-layout'
import { t } from '../../../lib/i18n'
import { isImeComposing } from '../../../lib/ime'
import { Button, IconButton } from '../../../components/primitives'
import { InknoteEngineImpl, type InknoteEngineApi, type InknoteEngineHostExtras } from '../engine/inknote-engine'
import { renderPageToCanvas } from '../engine/renderer'
import { shareOrDownload } from '../../../lib/inknote/share'
import { safeFileName } from '../../../lib/export-note'
import { inknoteApi } from '../api'
import type { InknoteEngineHost, InknotePageMetrics, InknoteToolState } from '../engine/inknote-engine-types'
import { InkTextStyleBar } from './InkTextStyleBar'
import { useInknoteStore } from '../store'
import { useUi } from '../../../store/ui'

interface Props {
  note: InknoteNoteMeta
  page: InknotePage
  pageIndex: number
  pageCount: number
  previousPage: InknotePage | null
  nextPage: InknotePage | null
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
  /** The page as it was before the text box appeared or was edited, for one undo step. */
  before: string
  scale: number
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

function PagePreview({ page, note, settings, label, onSelect }: { page: InknotePage; note: InknoteNoteMeta; settings: InknoteSettings; label: string; onSelect: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const rendered = renderPageToCanvas(page.content, note.paper, {
      width: note.pageWidth, height: note.pageHeight, contentWidth: note.contentWidth, contentHeight: note.contentHeight,
    }, 640, cssFont(settings))
    const target = ref.current
    if (!rendered || !target) return
    target.width = rendered.width
    target.height = rendered.height
    target.getContext('2d')?.drawImage(rendered, 0, 0)
  }, [page.content, page.rev, note.paper, note.pageWidth, note.pageHeight, note.contentWidth, note.contentHeight, settings])
  return (
    <button type="button" aria-label={label} onClick={onSelect} className="block w-full overflow-hidden rounded-[2px] border border-[var(--border-subtle)] opacity-75 shadow-[var(--shadow-soft)] transition-opacity hover:opacity-100 focus-visible:opacity-100">
      <canvas ref={ref} className="block w-full bg-white"/>
    </button>
  )
}

export function InkCanvasArea({ note, page, pageIndex, pageCount, previousPage, nextPage, settings, onPrevPage, onNextPage, onEngine, tool }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<InknoteEngineApi | null>(null)
  const [zoom, setZoom] = useState(1)
  const [selection, setSelection] = useState<string[]>([])
  const replaceInput = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [ttsCue, setTtsCue] = useState<{ pageId: string; textId: string } | null>(null)
  const latest = useRef({ note, page, settings, tool })
  latest.current = { note, page, settings, tool }
  const toast = useUi((state) => state.toast)
  const touchPage = useInknoteStore((state) => state.touchPage)
  const savePage = useInknoteStore((state) => state.savePage)
  const createPage = useInknoteStore((state) => state.createPage)
  const setActivePage = useInknoteStore((state) => state.setActivePage)
  const updateSettings = useInknoteStore((state) => state.updateSettings)
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
    const before = serializePageContent(current.page.content)
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
      before,
      scale,
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
      onCommit: (before, after) => {
        touchPage()
        window.dispatchEvent(new CustomEvent('inknote:content', { detail: { pageId: latest.current.page.id, before, after, at: Date.now() } }))
      },
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
    const handler = (event: Event) => setTtsCue((event as CustomEvent<{ pageId: string; textId: string } | null>).detail ?? null)
    window.addEventListener('inknote:tts-cue', handler)
    return () => window.removeEventListener('inknote:tts-cue', handler)
  }, [])

  useEffect(() => {
    engineRef.current?.loadContent(page.content)
  }, [page.content])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('inknote:page', { detail: { pageId: page.id, to: pageIndex, at: Date.now() } }))
    if (typeof frameRef.current?.scrollIntoView === 'function') {
      const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      frameRef.current.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    }
  }, [page.id, pageIndex])

  useEffect(() => {
    const invalidate = () => engineRef.current?.invalidate()
    window.addEventListener('inknote:invalidate', invalidate)
    return () => window.removeEventListener('inknote:invalidate', invalidate)
  }, [])

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
    const after = serializePageContent(latest.current.page.content)
    engineRef.current?.commitExternal(current.before, after, 'text')
    engineRef.current?.invalidate()
    void savePage()
  }, [editing, savePage])

  const cancelText = useCallback(() => {
    const current = editing
    setEditing(null)
    if (!current) return
    try {
      const before = JSON.parse(current.before) as InknotePageContent
      const content = latest.current.page.content
      content.strokes = before.strokes
      content.texts = before.texts
      content.images = before.images
      content.bg = before.bg
    } catch (error) {
      throw new Error('The inknote text snapshot is not valid JSON', { cause: error })
    }
    engineRef.current?.invalidate()
  }, [editing])

  const patchEditing = useCallback((patch: Partial<InknoteTextBox>) => {
    setEditing((current) => {
      if (!current) return current
      Object.assign(current.item, patch)
      return { ...current }
    })
    engineRef.current?.invalidate()
  }, [])

  const savePreset = useCallback((name: string) => {
    if (!editing) return
    const item = editing.item
    const next = [
      { name, fontSize: item.fontSize, bold: item.bold, italic: item.italic, underline: item.underline },
      ...settings.textPresets.filter((preset) => preset.name !== name),
    ].slice(0, INKNOTE_LIMITS.textPresetsMax)
    void updateSettings({ textPresets: next })
  }, [editing, settings.textPresets, updateSettings])

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

  const selectedImages = selection.filter((id) => id.startsWith('i:') && page.content.images.some((image) => `i:${image.id}` === id))
  const selectedTexts = selection.filter((id) => id.startsWith('t:') && page.content.texts.some((item) => `t:${item.id}` === id))

  const copySelectedText = () => {
    const text = page.content.texts.filter((item) => selectedTexts.includes(`t:${item.id}`)).map((item) => item.text).join('\n')
    if (!text.trim()) { toast({ title: t('inknote.selection.no_text') }); return }
    void navigator.clipboard.writeText(text)
      .then(() => toast({ title: t('inknote.selection.copied') }))
      .catch((error) => toast({ title: String(error), tone: 'danger' }))
  }

  const exportSelection = async () => {
    const engine = engineRef.current
    const box = engine?.selectionBox()
    if (!engine || !box) return
    const rendered = renderPageToCanvas(page.content, note.paper, metrics, 1600, cssFont(settings))
    if (!rendered) return
    const scale = rendered.width / note.pageWidth
    const crop = document.createElement('canvas')
    crop.width = Math.max(1, Math.round(box.w * scale))
    crop.height = Math.max(1, Math.round(box.h * scale))
    const context = crop.getContext('2d')
    if (!context) return
    context.drawImage(rendered, Math.round(box.x * scale), Math.round(box.y * scale), crop.width, crop.height, 0, 0, crop.width, crop.height)
    const blob = await new Promise<Blob | null>((resolve) => crop.toBlob((value) => resolve(value), 'image/png'))
    if (blob) await shareOrDownload(blob, `${safeFileName(note.title) || 'inknote'}-selection.png`).catch((error) => toast({ title: String(error), tone: 'danger' }))
  }

  const replaceSelectedImage = async (file: File) => {
    const engine = engineRef.current
    const imageId = selectedImages[0]?.slice(2)
    if (!engine || !imageId) return
    const image = page.content.images.find((entry) => entry.id === imageId)
    if (!image) return
    const before = serializePageContent(page.content)
    try {
      const asset = await inknoteApi.uploadAsset(file, 'image', note.id)
      image.assetId = asset.id
      image.url = asset.url
      engine.commitExternal(before, serializePageContent(page.content), 'image')
      engine.renderNow()
      void savePage()
    } catch (error) {
      toast({ title: String(error), tone: 'danger' })
    }
  }

  const ttsItem = ttsCue && ttsCue.pageId === page.id ? page.content.texts.find((item) => item.id === ttsCue.textId) ?? null : null
  const ttsBox = (() => {
    const engine = engineRef.current
    if (!ttsItem || !engine) return null
    const origin = engine.worldToScreen(ttsItem.x * note.pageWidth, ttsItem.y * note.pageHeight)
    const scale = engine.getScale()
    return {
      left: origin.x,
      top: origin.y,
      width: Math.max(40, ttsItem.w * note.pageWidth * scale),
      height: Math.max(20, ttsItem.h * note.pageHeight * scale),
    }
  })()

  return (
    <div className="inknote-canvas-area relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg-sunken)]" ref={hostRef}>
      <div className="inknote-page-scroll flex min-h-0 flex-1 flex-col items-center gap-3 overflow-auto p-3 md:p-6">
        {previousPage && (
          <div style={{ aspectRatio: `${note.pageWidth} / ${note.pageHeight}`, width: 'min(100%, 860px)' }} className="shrink-0">
            <PagePreview page={previousPage} note={note} settings={settings} label={`${t('inknote.page.prev')} ${pageIndex}`} onSelect={onPrevPage}/>
          </div>
        )}
        <div ref={frameRef} className="inknote-page-frame relative shrink-0 shadow-[var(--shadow-soft)]" style={{ aspectRatio: `${note.pageWidth} / ${note.pageHeight}`, width: 'min(100%, 860px)' }}>
          <canvas ref={canvasRef} role="img" className="inknote-canvas block size-full touch-none rounded-[2px]" aria-label={t('inknote.canvas.label', { title: note.title, page: String(pageIndex + 1) })} />
          {ttsBox && (
            <div data-ink-tts-cue="" aria-hidden="true" className="pointer-events-none absolute rounded-[3px] border-2 border-[var(--accent)]" style={{ left: ttsBox.left, top: ttsBox.top, width: ttsBox.width, height: ttsBox.height, background: 'color-mix(in oklab, var(--accent) 14%, transparent)', zIndex: 'calc(var(--z-float) - 2)' }}/>
          )}
          {editing && (
            <div className="absolute inset-0 z-[var(--z-float)]" aria-hidden="true" onPointerDown={(event) => { event.preventDefault(); commitText() }} />
          )}
          {editing && (
            <InkTextStyleBar item={editing.item} presets={settings.textPresets} onChange={patchEditing} onSavePreset={savePreset} />
          )}
          {editing && (
            <textarea
              autoFocus
              aria-label={t('inknote.text.placeholder')}
              value={editing.value}
              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
              onBlur={(event) => {
                if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest('[data-ink-text-style]')) return
                commitText()
              }}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return
                if (event.key === 'Escape') { event.preventDefault(); cancelText() }
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commitText() }
              }}
              className="inknote-text-editor absolute resize-none rounded-[2px] border border-[var(--accent)] bg-transparent p-0 outline-none"
              style={{
                left: editing.screen.left,
                top: editing.screen.top,
                width: editing.screen.width,
                minHeight: editing.screen.minHeight,
                fontSize: Math.max(12, editing.item.fontSize * editing.scale),
                lineHeight: editing.item.lh,
                fontWeight: editing.item.bold ? 600 : 400,
                fontStyle: editing.item.italic ? 'italic' : 'normal',
                textDecoration: editing.item.underline ? 'underline' : 'none',
                textAlign: editing.item.align,
                color: editing.item.color,
                caretColor: editing.item.color,
                background: editing.item.hl
                  ? `color-mix(in srgb, ${editing.item.hl} 55%, transparent)`
                  : 'color-mix(in oklab, var(--bg-overlay) 88%, transparent)',
                fontFamily: cssFont(settings),
                zIndex: 'calc(var(--z-float) + 1)',
              }}
            />
          )}
        </div>
        {nextPage && (
          <div style={{ aspectRatio: `${note.pageWidth} / ${note.pageHeight}`, width: 'min(100%, 860px)' }} className="shrink-0">
            <PagePreview page={nextPage} note={note} settings={settings} label={`${t('inknote.page.next')} ${pageIndex + 2}`} onSelect={onNextPage}/>
          </div>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center justify-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <Button size="sm" variant="ghost" onClick={onPrevPage} disabled={pageIndex <= 0}>‹</Button>
        <span data-page-indicator="" aria-live="polite">{pageIndex + 1} / {pageCount}</span>
        <Button size="sm" variant="ghost" onClick={onNextPage} disabled={pageIndex >= pageCount - 1}>›</Button>
        <span className="mx-2 opacity-60">{Math.round(zoom * 100)}%</span>
      </div>
      <input ref={replaceInput} data-ink-replace-image="" type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void replaceSelectedImage(file) }}/>
      {selection.length > 0 && (
        <div className="absolute bottom-12 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]" role="toolbar" aria-label={t('inknote.action.select_all')}>
          <IconButton label={t('inknote.action.delete_selection')} size="sm" onClick={() => selectionAction('delete')}><Trash2 size={14}/></IconButton>
          <IconButton label={t('inknote.action.copy_selection')} size="sm" onClick={() => selectionAction('copy')}><Copy size={14}/></IconButton>
          {selectedTexts.length > 0 && <IconButton label={t('inknote.selection.copy_text')} size="sm" onClick={copySelectedText}><ClipboardCopy size={14}/></IconButton>}
          {selectedImages.length === 1 && <IconButton label={t('inknote.selection.replace_image')} size="sm" onClick={() => replaceInput.current?.click()}><ImageUp size={14}/></IconButton>}
          <IconButton label={t('inknote.selection.export')} size="sm" onClick={() => void exportSelection()}><FileImage size={14}/></IconButton>
          <IconButton label={t('inknote.action.rotate')} size="sm" onClick={() => selectionAction('rotate')}><RotateCw size={14}/></IconButton>
          <IconButton label={t('inknote.action.select_all')} size="sm" onClick={() => selectionAction('select-all')}><SquareDashed size={14}/></IconButton>
          <IconButton label={t('inknote.action.close_selection')} size="sm" onClick={() => selectionAction('clear')}><X size={14}/></IconButton>
        </div>
      )}
    </div>
  )
}
