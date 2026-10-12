/**
 * The bar that follows a selection.
 *
 * It is placed by measuring the selection's own rectangle and clamping it into the viewport, because a
 * bar that lands off-screen at the top of a page — or over the reader's thumb on a phone — is worse than
 * no bar. The first action is the reader's usual colour, so the common case is one tap.
 */
import { useEffect, useRef, useState } from 'react'
import { Copy, MessageSquarePlus, Languages } from 'lucide-react'
import { Tooltip } from '../../../components/overlay'
import { t, type MessageKey } from '../../../lib/i18n'
import { DEFAULT_HIGHLIGHT_PAINT } from '../themes'
import { HIGHLIGHT_COLORS, type HighlightColor } from '../types'
import type { ReaderSettings } from '../store/reader-settings'
import type { StageSelection } from './EpubStage'

export interface SelectionToolbarProps {
  selection: StageSelection
  settings: ReaderSettings
  onHighlight: (color: HighlightColor) => void
  onComment: () => void
  onCopy: () => void
  onTranslate: () => void
}

const BAR_HEIGHT = 40
const GAP = 8

export function SelectionToolbar({ selection, settings, onHighlight, onComment, onCopy, onTranslate }: SelectionToolbarProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    const rect = selection.rect
    const width = ref.current?.offsetWidth ?? 240
    const height = ref.current?.offsetHeight ?? BAR_HEIGHT
    const above = rect.top - height - GAP
    const viewportHeight = window.innerHeight
    const top = above > 8 ? above : Math.min(viewportHeight - height - 8, rect.bottom + GAP)
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))
    setPlace({ left, top })
  }, [selection])

  const colors = HIGHLIGHT_COLORS.slice(0, 4)
  const rest = HIGHLIGHT_COLORS.slice(4)

  return (
    <div
      ref={ref}
      className="reader-selection-bar"
      role="toolbar"
      aria-label={t('reading.selection_actions')}
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999, visibility: place ? 'visible' : 'hidden' }}
    >
      <Tooltip label={t('reading.highlight_value0', { value0: t(HIGHLIGHT_LABEL[settings.defaultHighlightColor]) })} side="top">
        <button
          type="button"
          aria-label={t('reading.highlight')}
          onClick={() => onHighlight(settings.defaultHighlightColor)}
          className="inline-flex items-center justify-center"
        >
          <span className="reader-swatch" style={{ background: DEFAULT_HIGHLIGHT_PAINT[settings.defaultHighlightColor] }} />
        </button>
      </Tooltip>
      {colors.filter((color) => color !== settings.defaultHighlightColor).map((color) => (
        <Tooltip key={color} label={t(HIGHLIGHT_LABEL[color])} side="top">
          <button type="button" aria-label={t(HIGHLIGHT_LABEL[color])} onClick={() => onHighlight(color)} className="inline-flex items-center justify-center">
            <span className="reader-swatch" style={{ background: DEFAULT_HIGHLIGHT_PAINT[color] }} />
          </button>
        </Tooltip>
      ))}
      {rest.length ? <OtherColors colors={rest} onPick={onHighlight} /> : null}
      <span className="mx-0.5 h-5 w-px bg-[var(--border-subtle)]" aria-hidden="true" />
      {settings.translateEnabled ? (
        <Tooltip label={t('reading.translate')} side="top">
          <button type="button" aria-label={t('reading.translate')} onClick={onTranslate} className="inline-flex items-center justify-center">
            <Languages size={14} />
          </button>
        </Tooltip>
      ) : null}
      <Tooltip label={t('reading.copy')} side="top">
        <button type="button" aria-label={t('reading.copy')} onClick={onCopy} className="reader-labeled inline-flex items-center justify-center gap-1">
          <Copy size={14} />
          <span className="reader-action-label">{t('reading.copy')}</span>
        </button>
      </Tooltip>
      <Tooltip label={t('reading.add_comment')} side="top">
        <button type="button" aria-label={t('reading.add_comment')} onClick={onComment} className="reader-labeled inline-flex items-center justify-center gap-1">
          <MessageSquarePlus size={14} />
          <span className="reader-action-label">{t('reading.add_comment')}</span>
        </button>
      </Tooltip>
    </div>
  )
}

/** The colours that did not fit the bar. They are one tap away, not hidden behind a second gesture. */
function OtherColors({ colors, onPick }: { colors: readonly HighlightColor[]; onPick: (color: HighlightColor) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <Tooltip label={t('reading.more_colors')} side="top">
        <button type="button" aria-label={t('reading.more_colors')} aria-expanded={open} onClick={() => setOpen((current) => !current)} className="inline-flex items-center justify-center text-[13px] font-semibold">
          ⋯
        </button>
      </Tooltip>
      {open ? (
        <div className="absolute top-full left-1/2 mt-1 flex -translate-x-1/2 gap-1 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 shadow-[var(--shadow-pop)]">
          {colors.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={t(HIGHLIGHT_LABEL[color])}
              onClick={() => {
                setOpen(false)
                onPick(color)
              }}
              className="reader-swatch"
              style={{ background: DEFAULT_HIGHLIGHT_PAINT[color] }}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

const HIGHLIGHT_LABEL: Record<HighlightColor, MessageKey> = {
  yellow: 'reading.color_yellow',
  green: 'reading.color_green',
  blue: 'reading.color_blue',
  pink: 'reading.color_pink',
  red: 'reading.color_red',
  purple: 'reading.color_purple',
}
