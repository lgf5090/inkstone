import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEventHandler, type ReactNode, type RefObject } from 'react'
import { useClickOutside, useEscape } from '../../../../components/overlay'
import { placePanel, type PanelPlacement, type PanelViewport } from '../../../../components/popover-placement'
import { getVisibleViewport } from '../../../../lib/viewport'
import { cn } from '../../../../lib/cn'

/**
 * One anchored panel for the whole board: placed from the control it hangs off — right- or
 * left-aligned to it, under it, flipped above it when the room below runs out, clamped to the box it
 * may be drawn in, and never larger than that box (it scrolls instead of spilling past the edge that
 * would cut it).
 *
 * It stays in the tree rather than moving to `document.body`, and that is a decision rather than a
 * shortcut. The full screen board is a `Modal`, whose dialog focus trap cycles `Tab` inside the
 * dialog's own subtree — a panel parked in the body would be unreachable by keyboard, which is the
 * one thing the board may not lose. `position: fixed` in the same tree is no better: the overlay shell
 * carries `anim-pop`, whose settled transform becomes the containing block of a fixed child, and the
 * header's own container query adds a `contain` to that chain. So the panel keeps `position: absolute`
 * and does its own placement, which is also why the jsdom tests keep finding it exactly where they
 * did: `role`, `id` and `aria-label` all stay put and the trigger keeps `aria-controls`/`aria-expanded`.
 *
 * The offset is written against whatever box the panel turns out to be positioned in, and that box is
 * *measured* rather than asked for: `offsetParent` is not that box in every engine (`container-type`
 * on an ancestor — which the compact header carries — makes a containing block for absolute children
 * without necessarily appearing in the `offsetParent` chain). Pinning the panel to `0,0` for one
 * layout pass and reading where it landed names the box exactly, in viewport coordinates, once per
 * open. (`usePanelPlacement` in `components/popover-placement.ts` is the same algebra for callers
 * that position their panel inside a `relative` wrapper they own; this one owns no wrapper, so it has
 * to find its own origin — and clamp to everything that would clip it, see `clipPanelViewport`.)
 */

/**
 * How a form control looks inside a board panel.
 *
 * The panels are a quarter the width of a settings page, so they keep the project's `Select` (its own
 * chevron, its focus ring, its base type) and only re-state its density: the height a settings row can
 * afford is not the height a rule row can. Everything else — the border, the surface, the focus — comes
 * from the shared component, so a panel control and a settings control cannot drift apart.
 */
export const PANEL_FIELD = 'h-[var(--sp-7)] md:h-[var(--sp-7)] pl-[var(--sp-1-5)] text-[length:var(--text-11)]'

/** The gap a panel leaves between itself and its control, and the clearance it keeps from an edge. */
const PANEL_GAP = 6
const PANEL_MARGIN = 8
/** A panel is never squeezed below this, even when the room left beside its control is smaller. */
const PANEL_MIN_HEIGHT = 140

/**
 * The box a panel may be drawn inside: the viewport, cut down by every ancestor that would clip it.
 * A control can sit inside three nested scrollers at once (the note's block, the board's own scroll
 * area, the detail dialog's body), and a panel placed against the viewport alone was painted under
 * whichever of them ended first.
 */
export function clipPanelViewport(viewport: PanelViewport, clippers: PanelViewport[]): PanelViewport {
  let { top, right, bottom, left } = viewport
  for (const box of clippers) {
    top = Math.max(top, box.top)
    left = Math.max(left, box.left)
    right = Math.min(right, box.right)
    bottom = Math.min(bottom, box.bottom)
  }
  return { top, right, bottom, left }
}

/**
 * Whether this box hides what leaves it. Both spellings are read: the longhands are the answer where
 * they are computed, and the shorthand covers the engines that leave them at `visible` and only fill
 * in `overflow` (jsdom is one) — which is what lets the note's own 292px-wide board be exercised by a
 * jsdom test instead of only in a browser.
 */
function hidesOverflow(style: CSSStyleDeclaration): boolean {
  if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return true
  return style.overflow !== '' && style.overflow !== 'visible'
}

/**
 * Every ancestor of `anchor` that hides what leaves it, outermost first. Reading one computed style
 * per ancestor happens once per open — a panel is not placed per frame — and it is what keeps a
 * panel out of the scroll box it was opened in.
 */
function clippingAncestors(anchor: HTMLElement): PanelViewport[] {
  const boxes: PanelViewport[] = []
  for (let node = anchor.parentElement; node; node = node.parentElement) {
    if (!hidesOverflow(getComputedStyle(node))) continue
    const rect = node.getBoundingClientRect()
    boxes.push({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left })
  }
  return boxes
}

export interface PanelBox {
  top: number
  left: number
  maxWidth: number
  maxHeight: number
  /** The corner the panel grows from, so the pop-in animation reads as coming from its control. */
  origin: string
}

/** How tall a panel may be: the room beside its control, never more than the box itself. */
function panelRoom(placement: PanelPlacement, anchor: PanelAnchorRect, viewport: PanelViewport, ceiling: number): number {
  const beside = placement.flipped
    ? anchor.top - viewport.top - PANEL_GAP - PANEL_MARGIN
    : viewport.bottom - anchor.bottom - PANEL_GAP - PANEL_MARGIN
  return Math.max(0, Math.min(Math.max(PANEL_MIN_HEIGHT, Math.floor(beside)), ceiling))
}

interface PanelAnchorRect {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * Reads the panel's own geometry against the box it has to live in and returns where it should be.
 *
 * It measures rather than computes from classes, because both numbers it needs only exist in the
 * document: the width its own classes give it (which the box may cap), and the origin of the box it
 * is positioned in — pinned to `0,0` for this one reading. Both caps are set and lifted here, so the
 * numbers read are the panel's content against the room it actually has rather than the result of the
 * previous pass.
 */
export function resolvePanelBox(panel: HTMLElement, anchor: HTMLElement, align: 'start' | 'end'): PanelBox {
  const anchorRect = anchor.getBoundingClientRect()
  const viewport = clipPanelViewport(getVisibleViewport(), clippingAncestors(anchor))
  const width = Math.max(0, Math.floor(viewport.right - viewport.left - 2 * PANEL_MARGIN))
  const ceiling = Math.max(0, Math.floor(viewport.bottom - viewport.top - 2 * PANEL_MARGIN))

  panel.style.top = '0px'
  panel.style.left = '0px'
  panel.style.maxHeight = ''
  panel.style.maxWidth = `${width}px`
  const origin = panel.getBoundingClientRect()

  // The content height, not the drawn one: a capped panel reports the cap back as `offsetHeight`,
  // while `scrollHeight` keeps reporting what is actually inside it.
  const placement = placePanel({
    anchor: anchorRect,
    size: { width: panel.offsetWidth, height: panel.scrollHeight },
    viewport,
    align,
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })

  return {
    top: placement.top - origin.top,
    left: placement.left - origin.left,
    maxWidth: width,
    maxHeight: panelRoom(placement, anchorRect, viewport, ceiling),
    origin: placement.origin,
  }
}

/** Written imperatively: one pass is enough, and a state round trip would only be a second layout. */
function applyPanelBox(panel: HTMLElement, box: PanelBox): void {
  panel.style.top = `${box.top}px`
  panel.style.left = `${box.left}px`
  panel.style.maxWidth = `${box.maxWidth}px`
  panel.style.maxHeight = `${box.maxHeight}px`
}

function samePanelBox(a: PanelBox | null, b: PanelBox): boolean {
  return (
    a !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight
  )
}

/**
 * Keeps the panel where its control is, re-placing it on every commit (the content it draws is what
 * decides its height), when its own size changes, and when the window does.
 */
function usePanelBox(
  open: boolean,
  panelRef: RefObject<HTMLDivElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  align: 'start' | 'end',
): PanelBox | null {
  const [box, setBox] = useState<PanelBox | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setBox(null)
      return
    }
    const panel = panelRef.current
    const anchor = anchorRef.current
    if (!panel || !anchor) return
    const place = () => {
      const next = resolvePanelBox(panel, anchor, align)
      applyPanelBox(panel, next)
      setBox((prev) => (samePanelBox(prev, next) ? prev : next))
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(panel)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
    }
  })
  return box
}

interface KanbanPanelProps {
  open: boolean
  panelId: string
  label: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  /** Which side of the control the panel lines up with. */
  align?: 'start' | 'end'
  /**
   * Extra elements a click inside keeps the panel open — the control's own wrapper, where the
   * field is a box of buttons rather than one trigger.
   */
  dismissRefs?: RefObject<HTMLElement | null>[]
  onClick?: MouseEventHandler<HTMLDivElement>
  onMouseDown?: MouseEventHandler<HTMLDivElement>
  className?: string
  style?: CSSProperties
  children: ReactNode
}

export function KanbanPanel({
  open,
  panelId,
  label,
  anchorRef,
  onClose,
  align = 'end',
  dismissRefs,
  onClick,
  onMouseDown,
  className,
  style,
  children,
}: KanbanPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const box = usePanelBox(open, panelRef, anchorRef, align)
  useClickOutside([panelRef, anchorRef, ...(dismissRefs ?? [])], open, onClose)
  useEscape(open, onClose)

  if (!open) return null

  return (
    <div
      id={panelId}
      ref={panelRef}
      role='dialog'
      aria-label={label}
      data-kanban-panel=''
      onClick={onClick}
      onMouseDown={onMouseDown}
      style={{
        // Hidden until the one pass it takes to measure itself: the panel is sized by its own
        // classes, so the size the placement needs exists only once it is in the document.
        visibility: box ? undefined : 'hidden',
        transformOrigin: box?.origin,
        ...(box ? { top: box.top, left: box.left, maxWidth: box.maxWidth, maxHeight: box.maxHeight } : null),
        ...style,
      }}
      // `overflow: auto` on both axes: a panel squeezed by the box it was given scrolls its own rows
      // rather than spilling them past the edge that would clip it.
      className={cn('absolute overflow-auto overscroll-contain', className)}
    >
      {children}
    </div>
  )
}
