/** Crop a selected picture: drag the box or type its four numbers, then keep the pixels inside. */
import { useEffect, useRef, useState } from 'react'
import { Crop } from 'lucide-react'
import { t } from '../../../lib/i18n'
import { Button } from '../../../components/primitives'
import { Modal } from '../../../components/overlay'
import { Input } from '../../../components/form'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const MIN_SIZE = 8

function clampRect(rect: Rect, size: { width: number; height: number }): Rect {
  const w = Math.min(size.width, Math.max(MIN_SIZE, Math.round(rect.w)))
  const h = Math.min(size.height, Math.max(MIN_SIZE, Math.round(rect.h)))
  return {
    x: Math.min(size.width - w, Math.max(0, Math.round(rect.x))),
    y: Math.min(size.height - h, Math.max(0, Math.round(rect.y))),
    w,
    h,
  }
}

export function CropDialog({ open, imageUrl, onClose, onApply }: {
  open: boolean
  imageUrl: string | null
  onClose: () => void
  onApply: (blob: Blob, size: { width: number; height: number }) => Promise<void> | void
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number; start: Rect } | null>(null)

  useEffect(() => {
    if (!open || !imageUrl) return
    setNatural(null)
    setError(null)
    setBusy(false)
    const image = new Image()
    image.onload = () => {
      const size = { width: image.naturalWidth, height: image.naturalHeight }
      imageRef.current = image
      setNatural(size)
      setRect(clampRect({ x: size.width * 0.1, y: size.height * 0.1, w: size.width * 0.8, h: size.height * 0.8 }, size))
    }
    image.onerror = () => setError(t('inknote.crop.load_failed'))
    image.src = imageUrl
    return () => { image.onload = null; image.onerror = null }
  }, [open, imageUrl])

  const update = (patch: Partial<Rect>) => {
    if (!natural) return
    setRect((current) => clampRect({ ...current, ...patch }, natural))
  }

  const point = (event: React.PointerEvent) => {
    const box = viewRef.current!.getBoundingClientRect()
    if (!natural || box.width === 0) return { x: 0, y: 0 }
    return { x: (event.clientX - box.left) / box.width * natural.width, y: (event.clientY - box.top) / box.height * natural.height }
  }

  const begin = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (event: React.PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const origin = point(event)
    drag.current = { mode, x: origin.x, y: origin.y, start: rect }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  const move = (event: React.PointerEvent) => {
    const active = drag.current
    if (!active || !natural) return
    const now = point(event)
    const dx = now.x - active.x
    const dy = now.y - active.y
    const start = active.start
    if (active.mode === 'move') update({ x: start.x + dx, y: start.y + dy })
    else update({
      x: active.mode === 'nw' || active.mode === 'sw' ? start.x + dx : start.x,
      y: active.mode === 'nw' || active.mode === 'ne' ? start.y + dy : start.y,
      w: active.mode === 'nw' || active.mode === 'sw' ? start.w - dx : start.w + dx,
      h: active.mode === 'nw' || active.mode === 'ne' ? start.h - dy : start.h + dy,
    })
  }

  const apply = async () => {
    if (!natural || !imageRef.current) return
    const canvas = document.createElement('canvas')
    canvas.width = rect.w
    canvas.height = rect.h
    const context = canvas.getContext('2d')
    if (!context) return
    context.drawImage(imageRef.current, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    setBusy(true)
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'))
      if (!blob) throw new Error(t('inknote.crop.failed'))
      await onApply(blob, { width: rect.w, height: rect.h })
      onClose()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  const percent = (value: number, total: number) => `${value / Math.max(1, total) * 100}%`

  return (
    <Modal open={open} onClose={onClose} title={t('inknote.crop.title')} width={620}>
      <div className="space-y-3">
        {error && <p className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
        {imageUrl && (
          <div ref={viewRef} className="relative mx-auto max-h-[52vh] w-fit overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)]" onPointerMove={move} onPointerUp={() => { drag.current = null }}>
            <img src={imageUrl} alt="" className="block max-h-[52vh] max-w-full select-none" draggable={false}/>
            {natural && (
              <>
                <div aria-hidden="true" className="pointer-events-none absolute bg-black/45" style={{ left: 0, top: 0, width: '100%', height: percent(rect.y, natural.height) }}/>
                <div aria-hidden="true" className="pointer-events-none absolute bg-black/45" style={{ left: 0, top: percent(rect.y + rect.h, natural.height), right: 0, bottom: 0 }}/>
                <div aria-hidden="true" className="pointer-events-none absolute bg-black/45" style={{ left: 0, top: percent(rect.y, natural.height), width: percent(rect.x, natural.width), height: percent(rect.h, natural.height) }}/>
                <div aria-hidden="true" className="pointer-events-none absolute bg-black/45" style={{ left: percent(rect.x + rect.w, natural.width), top: percent(rect.y, natural.height), right: 0, height: percent(rect.h, natural.height) }}/>
                <div
                  role="presentation"
                  className="absolute cursor-move border border-[var(--accent)]"
                  style={{ left: percent(rect.x, natural.width), top: percent(rect.y, natural.height), width: percent(rect.w, natural.width), height: percent(rect.h, natural.height) }}
                  onPointerDown={begin('move')}
                >
                  {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                    <span
                      key={corner}
                      aria-hidden="true"
                      onPointerDown={begin(corner)}
                      className="absolute size-3 rounded-full border border-white bg-[var(--accent)]"
                      style={{
                        left: corner === 'nw' || corner === 'sw' ? -6 : 'calc(100% - 6px)',
                        top: corner === 'nw' || corner === 'ne' ? -6 : 'calc(100% - 6px)',
                        cursor: `${corner}-resize`,
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([['x', 'inknote.crop.x'], ['y', 'inknote.crop.y'], ['w', 'inknote.crop.w'], ['h', 'inknote.crop.h']] as const).map(([key, label]) => (
            <label key={key} className="block space-y-1">
              <span className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t(label)}</span>
              <Input type="number" min={0} value={rect[key]} onChange={(event) => update({ [key]: Number(event.target.value) } as Partial<Rect>)} aria-label={t(label)} disabled={!natural || busy}/>
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between">
          <Button size="sm" variant="ghost" onClick={() => natural && setRect(clampRect({ x: 0, y: 0, w: natural.width, h: natural.height }, natural))} disabled={!natural || busy}>{t('inknote.crop.reset')}</Button>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>{t('inknote.crop.cancel')}</Button>
            <Button size="sm" variant="primary" icon={<Crop size={13}/>} loading={busy} disabled={!natural || rect.w < MIN_SIZE || rect.h < MIN_SIZE} onClick={() => void apply()}>{t('inknote.crop.apply')}</Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
