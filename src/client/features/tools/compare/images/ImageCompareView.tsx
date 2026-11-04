/**
 * Two images compared as pictures.
 *
 * Four ways to look at the same pair: side by side, blended, as a mask of the pixels that differ,
 * and behind a movable seam. The diff is computed on a downscaled copy — the highlight a reader
 * needs is "where", not "every one of four million pixels" — so a phone photo pair does not allocate
 * two full-resolution buffers twice.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Image as ImageIcon, RotateCcw, Upload, X } from 'lucide-react'
import type { ImageViewMode } from '@shared/tools/compare/types'
import { diffPercent, diffPixels, type PixelDiff } from '@shared/tools/compare/image'
import { Button, IconButton } from '../../../../components/primitives'
import { Slider } from '../../../../components/form'
import { Tabs } from '../../../../components/tabs'
import { Tooltip } from '../../../../components/overlay'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import { useUi } from '../../../../store/ui'
import { compareApi } from '../api'
import { SaveDialog } from '../components/SaveDialog'
import { formatBytes } from '../files/FileCompareView'

const MAX_DIFF_EDGE = 1600
const MAX_BYTES = 20 * 1024 * 1024

interface ImageSide {
  file: File
  url: string
  width: number
  height: number
}

async function openImage(file: File): Promise<ImageSide> {
  if (file.size > MAX_BYTES) throw new Error('too-large')
  const bitmap = await createImageBitmap(file)
  const side: ImageSide = { file, url: URL.createObjectURL(file), width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return side
}

export function ImageCompareView() {
  const [left, setLeft] = useState<ImageSide | null>(null)
  const [right, setRight] = useState<ImageSide | null>(null)
  const [mode, setMode] = useState<ImageViewMode>('side_by_side')
  const [opacity, setOpacity] = useState(50)
  const [seam, setSeam] = useState(50)
  const [zoom, setZoom] = useState(100)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [diff, setDiff] = useState<PixelDiff | null>(null)
  const [diffSize, setDiffSize] = useState<{ width: number, height: number } | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const dragRef = useRef<{ x: number, y: number, panX: number, panY: number } | null>(null)
  const diffCanvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    setDiff(null)
    setDiffSize(null)
    if (!left || !right) return
    if (left.width !== right.width || left.height !== right.height) return
    const scale = Math.min(1, MAX_DIFF_EDGE / Math.max(left.width, left.height))
    const width = Math.max(1, Math.round(left.width * scale))
    const height = Math.max(1, Math.round(right.height * scale))
    void (async () => {
      const [leftBitmap, rightBitmap] = await Promise.all([createImageBitmap(left.file), createImageBitmap(right.file)])
      const canvasLeft = new OffscreenCanvas(width, height)
      const canvasRight = new OffscreenCanvas(width, height)
      const contextLeft = canvasLeft.getContext('2d')
      const contextRight = canvasRight.getContext('2d')
      if (!contextLeft || !contextRight) return
      contextLeft.drawImage(leftBitmap, 0, 0, width, height)
      contextRight.drawImage(rightBitmap, 0, 0, width, height)
      leftBitmap.close()
      rightBitmap.close()
      const dataLeft = contextLeft.getImageData(0, 0, width, height)
      const dataRight = contextRight.getImageData(0, 0, width, height)
      const result = diffPixels(dataLeft.data, dataRight.data, 12)
      if (cancelled) return
      setDiff(result)
      setDiffSize({ width, height })
    })().catch(() => {
      if (!cancelled) useUi.getState().toast({ title: t('tools.compare.image.diff_failed'), tone: 'danger' })
    })
    return () => { cancelled = true }
  }, [left, right])

  useEffect(() => {
    if (!diff || !diffSize || !diffCanvas.current) return
    const canvas = diffCanvas.current
    canvas.width = diffSize.width
    canvas.height = diffSize.height
    const context = canvas.getContext('2d')
    if (!context) return
    const image = new ImageData(new Uint8ClampedArray(diff.mask), diffSize.width, diffSize.height)
    context.putImageData(image, 0, 0)
  }, [diff, diffSize])

  useEffect(() => () => {
    if (left) URL.revokeObjectURL(left.url)
  }, [left])
  useEffect(() => () => {
    if (right) URL.revokeObjectURL(right.url)
  }, [right])

  const tabs = useMemo(() => ([
    { id: 'side_by_side' as ImageViewMode, label: t('tools.compare.image.mode.side_by_side') },
    { id: 'overlay' as ImageViewMode, label: t('tools.compare.image.mode.overlay') },
    { id: 'difference' as ImageViewMode, label: t('tools.compare.image.mode.difference') },
    { id: 'slider' as ImageViewMode, label: t('tools.compare.image.mode.slider') },
  ]), [])

  const save = async (name: string) => {
    if (!left || !right) return
    setSaving(true)
    try {
      const [leftAsset, rightAsset] = await Promise.all([
        compareApi.uploadAsset('image', left.file),
        compareApi.uploadAsset('image', right.file),
      ])
      await compareApi.createProject({
        name,
        kind: 'image',
        left_label: left.file.name,
        right_label: right.file.name,
        summary: {
          image: {
            width: left.width,
            height: left.height,
            differing: diff?.differing ?? 0,
            total: diff?.total ?? left.width * left.height,
          },
        },
        left_asset_id: leftAsset.id,
        right_asset_id: rightAsset.id,
      })
      useUi.getState().toast({ title: t('tools.compare.save.saved'), tone: 'success' })
      setSaveOpen(false)
    } catch {
      useUi.getState().toast({ title: t('tools.compare.save.failed'), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  const beginPan = (event: ReactPointerEvent) => {
    if (zoom <= 100 || mode === 'slider') return
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const movePan = (event: ReactPointerEvent) => {
    const start = dragRef.current
    if (!start) return
    setPan({ x: start.panX + (event.clientX - start.x), y: start.panY + (event.clientY - start.y) })
  }
  const endPan = (event: ReactPointerEvent) => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const mismatch = left && right && (left.width !== right.width || left.height !== right.height)
  const both = left && right

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto p-3 sm:p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--text-16)] font-semibold text-[var(--text-primary)]">{t('tools.compare.image.title')}</h2>
          <p className="mt-1 text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('tools.compare.image.desc')}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setSaveOpen(true)} disabled={!both}>
          {t('tools.compare.save.open')}
        </Button>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs label={t('tools.compare.image.mode.label')} value={mode} onChange={setMode} items={tabs} />
        <div className="flex items-center gap-2">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('tools.compare.image.zoom')}</span>
          <Slider value={zoom} min={100} max={400} step={10} onChange={setZoom} suffix="%" label={t('tools.compare.image.zoom')} className="w-[130px]" />
          <Tooltip label={t('tools.compare.image.reset_view')}>
            <IconButton size="sm" label={t('tools.compare.image.reset_view')} onClick={() => { setZoom(100); setPan({ x: 0, y: 0 }); setSeam(50); setOpacity(50) }}>
              <RotateCcw size={13} />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      {mode === 'overlay' && (
        <div className="flex items-center gap-3">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('tools.compare.image.opacity')}</span>
          <Slider value={opacity} min={0} max={100} step={1} onChange={setOpacity} suffix="%" label={t('tools.compare.image.opacity')} className="w-[200px]" />
        </div>
      )}
      {mode === 'slider' && (
        <div className="flex items-center gap-3">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('tools.compare.image.seam')}</span>
          <Slider value={seam} min={0} max={100} step={1} onChange={setSeam} suffix="%" label={t('tools.compare.image.seam')} className="w-[240px]" />
        </div>
      )}

      {mismatch && (
        <p className="rounded-[var(--r-sm)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2 py-1 text-[length:var(--text-11)] text-[var(--warning)]">
          {t('tools.compare.image.size_mismatch', { left: `${left?.width}×${left?.height}`, right: `${right?.width}×${right?.height}` })}
        </p>
      )}

      {!both ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ImageCard label={t('tools.compare.text.left')} side={left} onFile={(file) => void load(file, setLeft)} onClear={() => setLeft(null)} />
          <ImageCard label={t('tools.compare.text.right')} side={right} onFile={(file) => void load(file, setRight)} onClear={() => setRight(null)} />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <span>{left.file.name} · {left.width}×{left.height} · {formatBytes(left.file.size)}</span>
            <span aria-hidden="true">↔</span>
            <span>{right.file.name} · {right.width}×{right.height} · {formatBytes(right.file.size)}</span>
            {diff && diffSize && (
              <span className="text-[var(--text-secondary)]">
                {t('tools.compare.image.pixels', { percent: diffPercent(diff), differing: diff.differing, total: diff.total })}
              </span>
            )}
          </div>

          <div
            className={cn(
              'relative flex min-h-[360px] flex-1 items-center justify-center overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[repeating-conic-gradient(var(--bg-sunken)_0_25%,var(--bg-base)_0_50%)] bg-[length:20px_20px]',
              zoom > 100 && mode !== 'slider' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
            )}
            onPointerDown={beginPan}
            onPointerMove={movePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
          >
            <div
              className="relative flex max-h-full max-w-full items-center justify-center"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`, transformOrigin: 'center' }}
            >
              {mode === 'side_by_side' && (
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <img src={left.url} alt={left.file.name} className="max-h-[52vh] max-w-[45%] rounded-[var(--r-sm)] object-contain shadow-[var(--shadow-pop)]" />
                  <img src={right.url} alt={right.file.name} className="max-h-[52vh] max-w-[45%] rounded-[var(--r-sm)] object-contain shadow-[var(--shadow-pop)]" />
                </div>
              )}
              {mode === 'overlay' && (
                <div className="relative">
                  <img src={left.url} alt={left.file.name} className="max-h-[60vh] max-w-full rounded-[var(--r-sm)] object-contain shadow-[var(--shadow-pop)]" />
                  <img
                    src={right.url}
                    alt={right.file.name}
                    className="absolute inset-0 h-full w-full rounded-[var(--r-sm)] object-contain"
                    style={{ opacity: opacity / 100 }}
                  />
                </div>
              )}
              {mode === 'difference' && (
                diff && diffSize ? (
                  <canvas
                    ref={diffCanvas}
                    role="img"
                    aria-label={t('tools.compare.image.difference_canvas')}
                    className="max-h-[60vh] max-w-full rounded-[var(--r-sm)] bg-[var(--bg-base)] shadow-[var(--shadow-pop)]"
                  />
                ) : (
                  <p className="p-8 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
                    {mismatch ? t('tools.compare.image.need_same_size') : t('tools.compare.image.computing')}
                  </p>
                )
              )}
              {mode === 'slider' && (
                <div className="relative select-none">
                  <img src={right.url} alt={right.file.name} className="max-h-[60vh] max-w-full rounded-[var(--r-sm)] object-contain shadow-[var(--shadow-pop)]" />
                  <img
                    src={left.url}
                    alt={left.file.name}
                    className="absolute inset-0 h-full w-full rounded-[var(--r-sm)] object-contain"
                    style={{ clipPath: `inset(0 ${100 - seam}% 0 0)` }}
                  />
                  <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--accent)]" style={{ left: `${seam}%` }} />
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <SaveDialog
        open={saveOpen}
        defaultName={left && right ? `${left.file.name} ↔ ${right.file.name}` : t('tools.compare.save.default_name')}
        busy={saving}
        onClose={() => setSaveOpen(false)}
        onSave={(name) => void save(name)}
      />
    </div>
  )
}

async function load(file: File, apply: (value: ImageSide) => void): Promise<void> {
  try {
    apply(await openImage(file))
  } catch (error) {
    useUi.getState().toast({
      title: error instanceof Error && error.message === 'too-large' ? t('tools.compare.text.file_too_large') : t('tools.compare.image.load_failed'),
      tone: 'danger',
    })
  }
}

function ImageCard({ label, side, onFile, onClear }: {
  label: string
  side: ImageSide | null
  onFile: (file: File) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <section
      aria-label={label}
      onDragOver={(event) => { event.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const file = event.dataTransfer.files?.[0]
        if (file) onFile(file)
      }}
      className={cn(
        'flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-[var(--r-md)] border-2 border-dashed p-3 text-center',
        over ? 'border-[var(--accent)] bg-[var(--bg-hover)]' : 'border-[var(--border-subtle)] bg-[var(--bg-sunken)]',
      )}
    >
      <div className="flex items-center justify-between self-stretch">
        <h3 className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{label}</h3>
        {side && (
          <Tooltip label={t('tools.compare.text.clear')}>
            <IconButton size="sm" label={t('tools.compare.text.clear')} onClick={onClear}><X size={13} /></IconButton>
          </Tooltip>
        )}
      </div>
      {side ? (
        <img src={side.url} alt={side.file.name} className="max-h-[160px] max-w-full rounded-[var(--r-sm)] object-contain" />
      ) : (
        <ImageIcon size={28} aria-hidden="true" className="text-[var(--text-quaternary)]" />
      )}
      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        {side ? `${side.file.name} · ${side.width}×${side.height}` : t('tools.compare.image.hint')}
      </span>
      <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
        <span className="flex items-center gap-1"><Upload size={13} aria-hidden="true" />{t('tools.compare.image.pick')}</span>
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={label}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
          event.target.value = ''
        }}
      />
    </section>
  )
}
