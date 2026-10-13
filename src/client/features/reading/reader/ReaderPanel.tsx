/**
 * A reader panel: the contents, the search box, the settings.
 *
 * It is deliberately *not* the app's `Drawer`. A drawer is modal — it locks the page behind it and takes
 * the focus — and both of those are wrong here: a reader adjusting type size has to see the page change,
 * and a reader picking a chapter out of the contents wants to preview the jump. So this is a floating
 * card over the page, closable by Escape, the backdrop or its own button, and nothing else.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '../../../components/primitives'
import { t } from '../../../lib/i18n'
import type { ReaderTheme } from '../themes'

export interface ReaderPanelProps {
  name: string
  title: string
  theme: ReaderTheme
  onClose: () => void
  children: ReactNode
}

export function ReaderPanel({ name, title, theme, onClose, children }: ReaderPanelProps) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    // A panel that raises its own field keeps the caret: the frame is focused only so Escape has somewhere
    // to come from, and stealing focus back would leave the search box needing a click to type in.
    if (document.activeElement !== document.body) return
    node.focus({ preventScroll: true })
  }, [name])

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (ref.current?.contains(target)) return
      // The HUD stays usable: closing the panel because a reader clicked the page-turn arrow would
      // make the panel feel like a trap rather than a tool.
      if ((target as Element).closest?.('.reader-hud')) return
      onClose()
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [onClose])

  return (
    <aside
      ref={ref}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      data-reader-panel={name}
      className="absolute top-[60px] bottom-[60px] right-2 z-[6] flex w-[340px] max-w-[calc(100%_-_16px)] flex-col overflow-hidden rounded-[var(--r-lg)] border shadow-[var(--shadow-pop)] outline-none"
      style={{
        // The panel is painted with the page's colours, and the app's own controls inside it read
        // theirs from these variables — so re-declaring them here is what lets a slider or a switch
        // keep its normal styling on a night page instead of going dark-on-dark.
        '--bg-surface': theme.background,
        '--bg-base': theme.background,
        '--bg-raised': `color-mix(in oklab, ${theme.foreground} 7%, ${theme.background})`,
        '--bg-hover': `color-mix(in oklab, ${theme.foreground} 12%, ${theme.background})`,
        '--text-primary': theme.foreground,
        '--text-secondary': theme.foreground,
        '--text-tertiary': theme.muted,
        '--text-quaternary': theme.muted,
        '--border-default': `color-mix(in oklab, ${theme.foreground} 22%, transparent)`,
        '--border-subtle': `color-mix(in oklab, ${theme.foreground} 12%, transparent)`,
        '--accent': theme.accent,
        background: theme.background,
        borderColor: `color-mix(in oklab, ${theme.foreground} 16%, transparent)`,
        color: theme.foreground,
      } as React.CSSProperties}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2.5" style={{ borderColor: `color-mix(in oklab, ${theme.foreground} 12%, transparent)` }}>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{title}</span>
        <IconButton label={t('common.close')} size="xs" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </aside>
  )
}
