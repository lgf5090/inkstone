/** The ink tools and their palette, shared by the top, left and bottom toolbar layouts. */
import { useState } from 'react'
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
  Type,
  Undo2,
} from 'lucide-react'
import type { InknoteShapeTool, InknoteTool } from '@shared/inknote/types'
import type { InknoteToolState } from '../engine/inknote-engine-types'
import { HIGHLIGHTER_COLORS, PEN_COLORS } from '@shared/inknote/constants'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { IconButton } from '../../../components/primitives'
import { Slider } from '../../../components/form'
import type { InknoteEngineApi } from '../engine/inknote-engine'

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

export function InkToolbar({ engine, tool, onChange, onPages, onSettings, onRecord, onRead, onMarkup, onAi }: {
  engine: InknoteEngineApi | null
  tool: InknoteToolState
  onChange: (patch: Partial<InknoteToolState>) => void
  onPages: () => void
  onSettings: () => void
  onRecord: () => void
  onRead: () => void
  onMarkup: () => void
  onAi: () => void
}) {
  const [palette, setPalette] = useState<'pen' | 'highlighter' | null>(null)
  const [historyTick, setHistoryTick] = useState(0)
  const colors = palette === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS
  const activeColor = tool.tool === 'highlighter' ? tool.color : tool.color
  const undo = () => { engine?.undo(); setHistoryTick((value) => value + 1) }
  const redo = () => { engine?.redo(); setHistoryTick((value) => value + 1) }
  void historyTick
  return (
    <div className="inknote-toolbar flex min-w-0 items-center gap-0.5 overflow-x-auto px-1 py-0.5" role="toolbar" aria-label={t('inknote.settings.tools')}>
      <div className="flex shrink-0 items-center gap-0.5">
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
      <span className="mx-1 h-6 w-px shrink-0 bg-[var(--border-subtle)]" />
      <button
        type="button"
        aria-label={t('inknote.text.color')}
        className="relative flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] hover:bg-[var(--bg-hover)]"
        onClick={() => setPalette((current) => current ? null : tool.tool === 'highlighter' ? 'highlighter' : 'pen')}
      >
        <span className="size-5 rounded-full ring-1 ring-[var(--border-default)]" style={{ background: activeColor }} />
      </button>
      <IconButton label={t('inknote.action.undo')} size="sm" onClick={undo} disabled={!engine?.canUndo()}>
        <Undo2 size={16} />
      </IconButton>
      <IconButton label={t('inknote.action.redo')} size="sm" onClick={redo} disabled={!engine?.canRedo()}>
        <Redo2 size={16} />
      </IconButton>
      <span className="mx-1 h-6 w-px shrink-0 bg-[var(--border-subtle)]" />
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
      <IconButton label={t('inknote.action.ai')} size="sm" onClick={onAi}>
        <span className="text-[length:var(--text-12)]">✧</span>
      </IconButton>
      {palette && (
        <div className="absolute left-2 top-full z-[var(--z-pop)] mt-1 w-[min(92vw,430px)] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)]">
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
