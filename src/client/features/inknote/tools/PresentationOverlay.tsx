/** Full-screen presentation: paging, laser pointer, annotation strokes and timed autoplay. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Eraser, Highlighter, MousePointer2, X } from 'lucide-react'
import type { InknoteNoteMeta, InknotePage } from '@shared/inknote/types'
import { HIGHLIGHTER_COLORS } from '@shared/inknote/constants'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { IconButton } from '../../../components/primitives'
import { confirm } from '../../../components/overlay'
import { fontStackFor } from '../../../lib/inknote/text-layout'
import { randomLocalId } from '../../../lib/random-id'
import { renderPageToCanvas } from '../engine/renderer'
import { useInknoteStore } from '../store'
import { useUi } from '../../../store/ui'

const INTERVALS = [3, 5, 10] as const
const ANNOTATION_COLORS = HIGHLIGHTER_COLORS.slice(0, 5)

interface AnnotationPoint { x: number; y: number }

export function PresentationOverlay({ note, pages, initialIndex, onClose }: {
  note: InknoteNoteMeta
  pages: InknotePage[]
  initialIndex: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, pages.length - 1)))
  const [playing, setPlaying] = useState(false)
  const [interval, setIntervalSeconds] = useState<(typeof INTERVALS)[number]>(5)
  const [progress, setProgress] = useState(0)
  const [tool, setTool] = useState<'laser' | 'annotate'>('laser')
  const [color, setColor] = useState(ANNOTATION_COLORS[0]!)
  const [annotations, setAnnotations] = useState<AnnotationPoint[][]>([])
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const stroke = useRef<AnnotationPoint[] | null>(null)
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const toast = useUi((state) => state.toast)
  const page = pages[index]

  const changePage = useCallback((next: number) => {
    setIndex((current) => {
      const value = Math.max(0, Math.min(pages.length - 1, next))
      if (value !== current) setProgress(0)
      return value
    })
  }, [pages.length])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

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
    const canvas = overlayRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    const rect = stage.getBoundingClientRect()
    const dpr = Math.min(2.5, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, rect.width, rect.height)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = color
    context.globalAlpha = 0.45
    context.lineWidth = 14
    for (const line of annotations) {
      if (line.length === 0) continue
      context.beginPath()
      context.moveTo(line[0]!.x, line[0]!.y)
      for (const point of line.slice(1)) context.lineTo(point.x, point.y)
      if (line.length === 1) context.lineTo(line[0]!.x + 0.1, line[0]!.y + 0.1)
      context.stroke()
    }
    if (laser) {
      context.globalAlpha = 1
      const gradient = context.createRadialGradient(laser.x, laser.y, 0, laser.x, laser.y, 18)
      gradient.addColorStop(0, color)
      gradient.addColorStop(0.4, `${color}99`)
      gradient.addColorStop(1, 'transparent')
      context.fillStyle = gradient
      context.beginPath()
      context.arc(laser.x, laser.y, 18, 0, Math.PI * 2)
      context.fill()
    }
  }, [annotations, laser, color])

  useEffect(() => {
    if (!playing) { setProgress(0); return }
    let started = performance.now()
    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - started) / 1000
      if (elapsed >= interval) {
        started = performance.now()
        setProgress(0)
        setIndex((value) => value >= pages.length - 1 ? 0 : value + 1)
      } else {
        setProgress(elapsed / interval)
      }
    }, 100)
    return () => window.clearInterval(timer)
  }, [playing, interval, pages.length])

  const requestClose = useCallback(async () => {
    if (annotations.length === 0) { onClose(); return }
    const leave = await confirm({ title: t('inknote.presentation.exit'), description: t('inknote.presentation.discard'), confirmLabel: t('inknote.presentation.exit') })
    if (leave) onClose()
  }, [annotations.length, onClose])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); void requestClose(); return }
      if (event.key === 'ArrowRight' || event.key === ' ') { event.preventDefault(); changePage(index + 1) }
      if (event.key === 'ArrowLeft') { event.preventDefault(); changePage(index - 1) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [changePage, index, requestClose])

  const pointFromEvent = (event: React.PointerEvent): AnnotationPoint => {
    const rect = stageRef.current!.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const saveAnnotations = async () => {
    if (annotations.length === 0) { toast({ title: t('inknote.presentation.no_annotation') }); return }
    const stage = stageRef.current
    if (!stage || !page) return
    const rect = stage.getBoundingClientRect()
    const width = rect.width || 1
    const store = useInknoteStore.getState()
    const content = page.content
    const strokes = annotations.filter((line) => line.length > 0).map((line) => ({
      id: randomLocalId(),
      tool: 'highlighter' as const,
      style: 'normal' as const,
      shape: null,
      color,
      width: Math.max(1, 14 * note.contentWidth / width),
      points: line.map((point) => ({
        x: Math.max(0, Math.min(note.contentWidth, point.x / width * note.contentWidth)),
        y: Math.max(0, Math.min(note.contentHeight, point.y / (rect.height || 1) * note.contentHeight)),
        p: 0.6,
      })),
    }))
    store.replacePageContent(page.id, { ...content, strokes: [...content.strokes, ...strokes] })
    await store.savePage(page.id)
    setAnnotations([])
    toast({ title: t('inknote.presentation.saved') })
  }

  if (!page) return null
  return (
    <div ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('inknote.action.presentation')} data-presentation-index={index} data-presentation-playing={playing} data-presentation-progress={Math.round(progress * 100)} className="fixed inset-0 z-[var(--z-modal)] flex flex-col bg-black outline-none">
      <div className="flex h-11 items-center gap-2 bg-black/60 px-3 text-white">
        <span className="text-[length:var(--text-12)] tabular-nums">{index + 1} / {pages.length}</span>
        <span className="mx-2 h-1 w-32 overflow-hidden rounded-full bg-white/20">
          <span className="block h-full origin-left bg-white transition-[width] duration-100" style={{ width: `${Math.round(progress * 100)}%` }}/>
        </span>
        <div className="flex items-center gap-0.5" role="group" aria-label={t('inknote.presentation.interval')}>
          {INTERVALS.map((seconds) => (
            <button key={seconds} type="button" aria-pressed={interval === seconds} onClick={() => setIntervalSeconds(seconds)} className={cn('rounded px-1.5 py-0.5 text-[length:var(--text-11)]', interval === seconds ? 'bg-white/25' : 'hover:bg-white/15')}>{`${seconds}s`}</button>
          ))}
        </div>
        <button type="button" className="rounded px-2 py-1 text-[length:var(--text-12)] hover:bg-white/15" onClick={() => setPlaying((value) => !value)}>{playing ? t('inknote.presentation.pause') : t('inknote.presentation.play')}</button>
        <span className="flex-1" />
        <IconButton label={t('inknote.presentation.laser')} size="sm" active={tool === 'laser'} onClick={() => setTool('laser')}><MousePointer2 size={15}/></IconButton>
        <IconButton label={t('inknote.presentation.annotate')} size="sm" active={tool === 'annotate'} onClick={() => setTool('annotate')}><Highlighter size={15}/></IconButton>
        <div className="flex items-center gap-1" role="group" aria-label={t('inknote.presentation.color')}>
          {ANNOTATION_COLORS.map((value) => (
            <button key={value} type="button" aria-label={value} aria-pressed={color === value} onClick={() => setColor(value)} className={cn('size-4 rounded-full', color === value && 'ring-2 ring-white')} style={{ background: value }}/>
          ))}
        </div>
        <IconButton label={t('inknote.presentation.save')} size="sm" onClick={() => void saveAnnotations()} disabled={annotations.length === 0}><span className="text-[length:var(--text-11)]">✓</span></IconButton>
        <IconButton label={t('inknote.presentation.clear')} size="sm" onClick={() => setAnnotations([])} disabled={annotations.length === 0}><Eraser size={15}/></IconButton>
        <IconButton label={t('inknote.presentation.exit')} size="sm" onClick={() => void requestClose()}><X size={16}/></IconButton>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
        onPointerDown={(event) => {
          swipe.current = { x: event.clientX, y: event.clientY }
          if (tool === 'annotate') {
            const point = pointFromEvent(event)
            stroke.current = [point]
            setAnnotations((current) => [...current, [point]])
            event.currentTarget.setPointerCapture(event.pointerId)
          }
        }}
        onPointerMove={(event) => {
          const rect = stageRef.current!.getBoundingClientRect()
          const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
          if (tool === 'laser') setLaser(point)
          if (tool === 'annotate' && stroke.current) {
            stroke.current.push(point)
            setAnnotations((current) => [...current.slice(0, -1), [...stroke.current!]])
          }
        }}
        onPointerUp={(event) => {
          if (stroke.current) {
            const line = stroke.current
            stroke.current = null
            if (line.length === 1) setAnnotations((current) => [...current.slice(0, -1), [line[0]!, { x: line[0]!.x + 0.1, y: line[0]!.y }]])
            return
          }
          const start = swipe.current
          swipe.current = null
          if (!start) return
          const dx = event.clientX - start.x
          const dy = event.clientY - start.y
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) changePage(index + (dx < 0 ? 1 : -1))
        }}
        onPointerLeave={() => setLaser(null)}
        onDoubleClick={(event) => { if (event.target === event.currentTarget) void requestClose() }}
        style={{ cursor: tool === 'annotate' ? 'crosshair' : 'default' }}
      >
        <div ref={stageRef} className="relative max-h-full max-w-full" style={{ aspectRatio: `${note.pageWidth} / ${note.pageHeight}`, width: 'min(100%, 1400px)' }}>
          <canvas ref={canvasRef} className="block size-full bg-white shadow-2xl" aria-label={note.title}/>
          <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 size-full"/>
        </div>
      </div>
      <div className="flex h-12 items-center justify-center gap-4 bg-black/60 text-white">
        <IconButton label={t('inknote.page.prev')} size="sm" onClick={() => changePage(index - 1)}><ChevronLeft size={18}/></IconButton>
        <span>{note.title}</span>
        <IconButton label={t('inknote.page.next')} size="sm" onClick={() => changePage(index + 1)}><ChevronRight size={18}/></IconButton>
      </div>
    </div>
  )
}
