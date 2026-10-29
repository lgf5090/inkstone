/** The ink tools and their palette, shared by the top, left and bottom toolbar layouts. */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Circle,
  Eraser,
  Highlighter,
  LassoSelect,
  PenLine,
  PenTool,
  Redo2,
  Shapes,
  Square,
  Star,
  Type,
  Undo2,
} from 'lucide-react'
import type { InknoteFavorite, InknoteShapeTool, InknoteTool } from '@shared/inknote/types'
import type { InknoteToolState } from '../engine/inknote-engine-types'
import { HIGHLIGHTER_COLORS, PEN_COLORS } from '@shared/inknote/constants'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { Slider } from '../../../components/form'

const TOOLS: readonly { id: InknoteTool; labelKey: string; icon: typeof PenLine }[] = [
  { id: 'ballpen', labelKey: 'inknote.tool.ballpen', icon: PenLine },
  { id: 'pen', labelKey: 'inknote.tool.pen', icon: PenTool },
  { id: 'highlighter', labelKey: 'inknote.tool.highlighter', icon: Highlighter },
  { id: 'eraser', labelKey: 'inknote.tool.eraser', icon: Eraser },
  { id: 'pixelEraser', labelKey: 'inknote.tool.pixel_eraser', icon: Eraser },
  { id: 'lasso', labelKey: 'inknote.tool.lasso', icon: LassoSelect },
  { id: 'text', labelKey: 'inknote.tool.text', icon: Type },
  { id: 'shape', labelKey: 'inknote.tool.shape', icon: Shapes },
]

const SHAPES: readonly { id: InknoteShapeTool; labelKey: string; icon: typeof Square }[] = [
  { id: 'line', labelKey: 'inknote.shape.line', icon: PenLine },
  { id: 'rect', labelKey: 'inknote.shape.rect', icon: Square },
  { id: 'ellipse', labelKey: 'inknote.shape.ellipse', icon: Circle },
  { id: 'arrow', labelKey: 'inknote.shape.arrow', icon: ArrowRight },
]

export function InkToolbar({ tool, onChange, onPages, onSettings, onRecord, onRead, onMarkup, onAi, onUndo, onRedo, canUndo, canRedo, orientation = 'horizontal', favorites = [], showFavorites = false, onApplyFavorite, onSaveFavorite }: {
  tool: InknoteToolState
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onChange: (patch: Partial<InknoteToolState>) => void
  onPages: () => void
  onSettings: () => void
  onRecord: () => void
  onRead: () => void
  onMarkup: () => void
  onAi: () => void
  orientation?: 'horizontal' | 'vertical'
  favorites?: readonly InknoteFavorite[]
  showFavorites?: boolean
  onApplyFavorite?: (favorite: InknoteFavorite) => void
  onSaveFavorite?: () => void
}) {
  const [palette, setPalette] = useState<'pen' | 'highlighter' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!palette) return
    const outside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setPalette(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPalette(null) }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape) }
  }, [palette])
  const vertical = orientation === 'vertical'
  const divider = vertical ? 'my-1 h-px w-6 shrink-0 bg-[var(--border-subtle)]' : 'mx-1 h-6 w-px shrink-0 bg-[var(--border-subtle)]'
  const colors = palette === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS
  const activeColor = tool.tool === 'highlighter' ? tool.color : tool.color
  return (
    <div ref={rootRef} className={cn('inknote-toolbar flex min-w-0 items-center gap-0.5 px-1 py-0.5', vertical ? 'flex-col overflow-y-auto overflow-x-hidden' : 'overflow-x-auto')} role="toolbar" aria-label={t('inknote.settings.tools')}>
      <div className={cn('flex shrink-0 items-center gap-0.5', vertical && 'flex-col')}>
        {TOOLS.map(({ id, labelKey, icon: Icon }) => (
          <IconButton
            key={id}
            label={t(labelKey as MessageKey)}
            size="sm"
            active={tool.tool === id}
            onClick={() => {
              onChange({ tool: id })
              if (id === 'highlighter') setPalette('highlighter')
              else if (id === 'pen' || id === 'ballpen') setPalette('pen')
              else setPalette(null)
            }}
          >
            <Icon size={16} />
          </IconButton>
        ))}
      </div>
      <span className={divider} />
      <button
        type="button"
        aria-label={t('inknote.text.color')}
        className="relative flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] hover:bg-[var(--bg-hover)]"
        onClick={() => setPalette((current) => current ? null : tool.tool === 'highlighter' ? 'highlighter' : 'pen')}
      >
        <span className="size-5 rounded-full ring-1 ring-[var(--border-default)]" style={{ background: activeColor }} />
      </button>
      <IconButton label={t('inknote.action.undo')} size="sm" onClick={onUndo} disabled={!canUndo}>
        <Undo2 size={16} />
      </IconButton>
      <IconButton label={t('inknote.action.redo')} size="sm" onClick={onRedo} disabled={!canRedo}>
        <Redo2 size={16} />
      </IconButton>
      <span className={divider} />
      <IconButton label={t('inknote.action.pages')} size="sm" onClick={onPages}>
        <Square size={15} />
      </IconButton>
      <IconButton label={t('inknote.action.record')} size="sm" onClick={onRecord}>
        <span className="size-2.5 rounded-full bg-[var(--danger)]" />
      </IconButton>
      <IconButton label={t('inknote.action.read')} size="sm" onClick={onRead}>
        <span className="text-[length:var(--text-12)]">◉</span>
      </IconButton>
      <IconButton label={t('inknote.action.markup')} size="sm" onClick={onMarkup}>
        <span className="text-[length:var(--text-12)]">✦</span>
      </IconButton>
      <IconButton label={t('inknote.action.settings')} size="sm" onClick={onSettings}>
        <span className="text-[length:var(--text-14)]">⚙</span>
      </IconButton>
      <IconButton label={t('inknote.favorite.save')} size="sm" onClick={onSaveFavorite}><Star size={15}/></IconButton>
      {showFavorites && favorites.length > 0 && (
        <div className={cn('flex shrink-0 items-center gap-1 border-l border-[var(--border-subtle)] pl-1', vertical && 'flex-col border-l-0 border-t pt-1')} role="group" aria-label={t('inknote.favorite.bar')}>
          {favorites.map((favorite, index) => (
            <button
              key={`${favorite.tool}:${favorite.color}:${favorite.width}:${index}`}
              type="button"
              aria-label={t('inknote.favorite.apply', { tool: t(`inknote.tool.${favorite.tool === 'pixelEraser' ? 'pixel_eraser' : favorite.tool}` as MessageKey) })}
              onClick={() => onApplyFavorite?.(favorite)}
              className="size-6 shrink-0 rounded-full ring-1 ring-[var(--border-default)]"
              style={{ background: favorite.color }}
            />
          ))}
        </div>
      )}
      <IconButton label={t('inknote.action.ai')} size="sm" onClick={onAi}>
        <span className="text-[length:var(--text-12)]">✧</span>
      </IconButton>
      {palette && (
        <div className={cn('absolute z-[var(--z-pop)] w-[min(92vw,430px)] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]', vertical ? 'left-full top-0 ml-1' : 'left-2 top-full mt-1')}>
          <div className="flex flex-wrap gap-1.5">
            {colors.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={activeColor.toLowerCase() === color.toLowerCase()}
                onClick={() => onChange({ color })}
                className={cn('size-7 rounded-full ring-1 ring-[var(--border-default)]', activeColor.toLowerCase() === color.toLowerCase() && 'ring-2 ring-[var(--accent)]')}
                style={{ background: color }}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.settings.stroke_width')}</span>
            <Slider value={tool.width} min={1} max={30} step={0.5} onChange={(value) => onChange({ width: value })} label={t('inknote.settings.stroke_width')} className="flex-1" />
          </div>
          {tool.tool === 'shape' && (
            <div className="mt-2 flex gap-1">
              {SHAPES.map(({ id, labelKey, icon: Icon }) => (
                <IconButton key={id} label={t(labelKey as MessageKey)} size="sm" active={tool.shape === id} onClick={() => onChange({ shape: id })}>
                  <Icon size={15} />
                </IconButton>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
