/** The ink tools and their palette, shared by the top, left and bottom toolbar layouts. */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Circle,
  CircleDashed,
  Eraser,
  Files,
  Highlighter,
  LassoSelect,
  Layers,
  Mic,
  PenLine,
  PenTool,
  Pencil,
  Redo2,
  Settings,
  Shapes,
  Sparkles,
  Square,
  Star,
  Type,
  Undo2,
  Volume2,
} from 'lucide-react'
import type { InknoteFavorite, InknoteShapeTool, InknoteTool } from '@shared/inknote/types'
import type { InknoteToolState } from '../engine/inknote-engine-types'
import { HIGHLIGHTER_COLORS, PEN_COLORS } from '@shared/inknote/constants'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { Slider } from '../../../components/form'
import { TooltipIconButton } from '../../../components/tooltip-icon-button'
import { Tooltip } from '../../../components/overlay'

const TOOLS: readonly { id: InknoteTool; labelKey: string; icon: typeof PenLine; group: 'draw' | 'erase' | 'select' }[] = [
  { id: 'ballpen', labelKey: 'inknote.tool.ballpen', icon: PenLine, group: 'draw' },
  { id: 'pen', labelKey: 'inknote.tool.pen', icon: PenTool, group: 'draw' },
  { id: 'highlighter', labelKey: 'inknote.tool.highlighter', icon: Highlighter, group: 'draw' },
  { id: 'eraser', labelKey: 'inknote.tool.eraser', icon: Eraser, group: 'erase' },
  { id: 'pixelEraser', labelKey: 'inknote.tool.pixel_eraser', icon: CircleDashed, group: 'erase' },
  { id: 'lasso', labelKey: 'inknote.tool.lasso', icon: LassoSelect, group: 'select' },
  { id: 'text', labelKey: 'inknote.tool.text', icon: Type, group: 'select' },
  { id: 'shape', labelKey: 'inknote.tool.shape', icon: Shapes, group: 'select' },
]

const SHAPES: readonly { id: InknoteShapeTool; labelKey: string; icon: typeof Square }[] = [
  { id: 'line', labelKey: 'inknote.shape.line', icon: PenLine },
  { id: 'rect', labelKey: 'inknote.shape.rect', icon: Square },
  { id: 'ellipse', labelKey: 'inknote.shape.ellipse', icon: Circle },
  { id: 'arrow', labelKey: 'inknote.shape.arrow', icon: ArrowRight },
]

function toolLabel(tool: InknoteTool): string {
  const entry = TOOLS.find((item) => item.id === tool)
  return t((entry?.labelKey ?? 'inknote.tool.ballpen') as MessageKey)
}

export function InkToolbar({ tool, onChange, onPages, onLayers, onSettings, onRecord, onRead, onMarkup, onAi, onUndo, onRedo, canUndo, canRedo, orientation = 'horizontal', favorites = [], showFavorites = false, onApplyFavorite, onSaveFavorite }: {
  tool: InknoteToolState
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onChange: (patch: Partial<InknoteToolState>) => void
  onPages: () => void
  onLayers: () => void
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
  const activeColor = tool.color
  const widthValue = tool.tool === 'eraser' || tool.tool === 'pixelEraser' ? tool.eraserSize : tool.width
  const summary = tool.tool === 'eraser' || tool.tool === 'pixelEraser'
    ? `${toolLabel(tool.tool)} · ${widthValue}px`
    : t('inknote.toolbar.current', { tool: toolLabel(tool.tool), width: String(widthValue) })
  const groupTools = (group: 'draw' | 'erase' | 'select') => TOOLS.filter((entry) => entry.group === group)
  return (
    <div ref={rootRef} className={cn('inknote-toolbar relative flex min-w-0 items-center gap-0.5 px-1 py-0.5', vertical ? 'flex-col overflow-y-auto overflow-x-hidden' : 'overflow-x-auto')} role="toolbar" aria-label={t('inknote.settings.tools')}>
      <div className={cn('flex shrink-0 items-center gap-0.5', vertical && 'flex-col')} role="group" aria-label={t('inknote.toolbar.group.history')}>
        <TooltipIconButton label={t('inknote.action.undo')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onUndo} disabled={!canUndo}><Undo2 size={16} /></TooltipIconButton>
        <TooltipIconButton label={t('inknote.action.redo')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onRedo} disabled={!canRedo}><Redo2 size={16} /></TooltipIconButton>
      </div>
      <span className={divider} />
      <div className={cn('flex shrink-0 items-center gap-0.5', vertical && 'flex-col')} role="group" aria-label={t('inknote.toolbar.group.draw')}>
        {groupTools('draw').map(({ id, labelKey, icon: Icon }) => (
          <TooltipIconButton
            key={id}
            label={t(labelKey as MessageKey)}
            size="sm"
            tooltipSide={vertical ? 'right' : 'bottom'}
            active={tool.tool === id}
            onClick={() => {
              onChange({ tool: id })
              if (id === 'highlighter') setPalette('highlighter')
              else setPalette('pen')
            }}
          >
            <Icon size={16} />
          </TooltipIconButton>
        ))}
      </div>
      <div className={cn('flex shrink-0 items-center gap-0.5', vertical && 'flex-col')} role="group" aria-label={t('inknote.toolbar.group.erase')}>
        {groupTools('erase').map(({ id, labelKey, icon: Icon }) => (
          <TooltipIconButton key={id} label={t(labelKey as MessageKey)} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} active={tool.tool === id} onClick={() => { onChange({ tool: id }); setPalette(null) }}>
            <Icon size={16} />
          </TooltipIconButton>
        ))}
      </div>
      <span className={divider} />
      <div className={cn('flex shrink-0 items-center gap-0.5', vertical && 'flex-col')} role="group" aria-label={t('inknote.toolbar.group.select')}>
        {groupTools('select').map(({ id, labelKey, icon: Icon }) => (
          <TooltipIconButton key={id} label={t(labelKey as MessageKey)} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} active={tool.tool === id} onClick={() => { onChange({ tool: id }); setPalette(null) }}>
            <Icon size={16} />
          </TooltipIconButton>
        ))}
      </div>
      <span className={divider} />
      <Tooltip label={t('inknote.color.current')} side={vertical ? 'right' : 'bottom'}>
        <button
          type="button"
          aria-label={t('inknote.color.current')}
          aria-pressed={palette !== null}
          className={cn('relative flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] transition-colors hover:bg-[var(--bg-hover)]', palette !== null && 'bg-[var(--accent-soft)]')}
          onClick={() => setPalette((current) => current ? null : tool.tool === 'highlighter' ? 'highlighter' : 'pen')}
        >
          <span className="size-5 rounded-full ring-1 ring-[var(--border-default)]" style={{ background: activeColor }} />
        </button>
      </Tooltip>
      <span className="hidden shrink-0 whitespace-nowrap px-1 text-[length:var(--text-10)] text-[var(--text-tertiary)] lg:inline" aria-live="polite">{summary}</span>
      <span className={divider} />
      <div className={cn('flex shrink-0 items-center gap-0.5', vertical && 'flex-col')} role="group" aria-label={t('inknote.toolbar.group.page')}>
        <TooltipIconButton label={t('inknote.action.pages')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onPages}><Files size={15} /></TooltipIconButton>
        <TooltipIconButton label={t('inknote.action.layers')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onLayers}><Layers size={15} /></TooltipIconButton>
        <TooltipIconButton label={t('inknote.action.record')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onRecord}><Mic size={15} /></TooltipIconButton>
        <TooltipIconButton label={t('inknote.action.read')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onRead}><Volume2 size={15} /></TooltipIconButton>
        <TooltipIconButton label={t('inknote.action.markup')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onMarkup}><Pencil size={15} /></TooltipIconButton>
      </div>
      <span className={divider} />
      <div className={cn('flex shrink-0 items-center gap-0.5', vertical && 'flex-col')} role="group" aria-label={t('inknote.toolbar.group.note')}>
        <TooltipIconButton label={t('inknote.action.settings')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onSettings}><Settings size={15} /></TooltipIconButton>
        <TooltipIconButton label={t('inknote.favorite.save')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onSaveFavorite}><Star size={15}/></TooltipIconButton>
        <TooltipIconButton label={t('inknote.action.ai')} size="sm" tooltipSide={vertical ? 'right' : 'bottom'} onClick={onAi}><Sparkles size={15} /></TooltipIconButton>
      </div>
      {showFavorites && favorites.length > 0 && (
        <div className={cn('flex shrink-0 items-center gap-1 border-l border-[var(--border-subtle)] pl-1', vertical && 'flex-col border-l-0 border-t pt-1')} role="group" aria-label={t('inknote.favorite.bar')}>
          {favorites.map((favorite, index) => (
            <Tooltip key={`${favorite.tool}:${favorite.color}:${favorite.width}:${index}`} label={t('inknote.favorite.apply', { tool: toolLabel(favorite.tool) })} side={vertical ? 'right' : 'bottom'}>
              <button
                type="button"
                aria-label={t('inknote.favorite.apply', { tool: toolLabel(favorite.tool) })}
                onClick={() => onApplyFavorite?.(favorite)}
                className="size-6 shrink-0 rounded-full ring-1 ring-[var(--border-default)]"
                style={{ background: favorite.color }}
              />
            </Tooltip>
          ))}
        </div>
      )}
      {palette && (
        <div className={cn('absolute z-[var(--z-pop)] w-[min(92vw,430px)] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]', vertical ? 'left-full top-0 ml-1' : 'start-2 top-full mt-1')} role="group" aria-label={palette === 'highlighter' ? t('inknote.tool.highlighter') : t('inknote.text.color')}>
          <div className="mb-1 text-[length:var(--text-10)] font-medium text-[var(--text-tertiary)]">{palette === 'highlighter' ? t('inknote.tool.highlighter') : t('inknote.text.color')}</div>
          <div className="flex flex-wrap gap-1.5">
            {colors.map((color) => (
              <Tooltip key={color} label={color} side="bottom">
                <button
                  type="button"
                  aria-label={color}
                  aria-pressed={activeColor.toLowerCase() === color.toLowerCase()}
                  onClick={() => onChange({ color })}
                  className={cn('size-7 rounded-full ring-1 ring-[var(--border-default)]', activeColor.toLowerCase() === color.toLowerCase() && 'ring-2 ring-[var(--accent)]')}
                  style={{ background: color }}
                />
              </Tooltip>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('inknote.settings.stroke_width')}</span>
            <Slider value={tool.width} min={1} max={30} step={0.5} onChange={(value) => onChange({ width: value })} label={t('inknote.settings.stroke_width')} className="flex-1" />
            <span className="w-9 shrink-0 text-end text-[length:var(--text-10)] tabular-nums text-[var(--text-tertiary)]">{tool.width}{t('inknote.unit.px')}</span>
          </div>
          {tool.tool === 'shape' && (
            <div className="mt-2 flex gap-1" role="group" aria-label={t('inknote.tool.shape')}>
              {SHAPES.map(({ id, labelKey, icon: Icon }) => (
                <TooltipIconButton key={id} label={t(labelKey as MessageKey)} size="sm" active={tool.shape === id} onClick={() => onChange({ shape: id })}>
                  <Icon size={15} />
                </TooltipIconButton>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
