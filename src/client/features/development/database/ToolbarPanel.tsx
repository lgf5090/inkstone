import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../../lib/cn'
import { useClickOutside, useEscape } from '../../../components/overlay'

export interface ToolbarPanelProps {
  open: boolean
  onClose: () => void
  anchor: RefObject<HTMLElement | null>
  label: string
  children: ReactNode
  width?: number
  align?: 'start' | 'end'
  className?: string
}

export function ToolbarPanel({
  open,
  onClose,
  anchor,
  label,
  children,
  width = 320,
  align = 'end',
  className,
}: ToolbarPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  useEscape(open, onClose)
  useClickOutside([panelRef, anchor], open, onClose)

  useLayoutEffect(() => {
    if (!open) return
    const rect = anchor.current?.getBoundingClientRect()
    if (!rect) return
    const margin = 8
    const maxLeft = window.innerWidth - width - margin
    const left = align === 'end' ? rect.right - width : rect.left
    const panelHeight = panelRef.current?.offsetHeight ?? 320
    const top = rect.bottom + 6 + panelHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - panelHeight - 6)
      : rect.bottom + 6
    setPosition({ top, left: Math.min(Math.max(margin, left), maxLeft) })
  }, [open, anchor, align, width])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    first?.focus({ preventScroll: true })
    return () => previous?.focus?.({ preventScroll: true })
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      className={cn(
        'fixed z-[var(--z-pop)] max-h-[min(520px,calc(100dvh-16px))] overflow-y-auto overscroll-contain',
        'rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-3 shadow-[var(--shadow-pop)]',
        className,
      )}
      style={{ top: position.top, left: position.left, width }}
    >
      {children}
    </div>,
    document.body,
  )
}
