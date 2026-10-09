import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { decodeDataValue } from '../../../lib/markdown/data-attr'
import { parseWikiTarget } from '../../../lib/markdown/renderer'
import { renderPendingMermaid } from '../../../lib/markdown/enhance'
import { findNoteByTitle, useNotes } from '../../../store/notes'
import { useSession } from '../../../store/session'
import { getVisibleViewport } from '../../../lib/viewport'
import { MAX_HOVER_CARD_DEPTH, useLinkHover } from '../link-hover'
import { linkCardTitle, linkPreviewFromElement } from '../link-preview'
import { useNoteBacklinks, useNoteCardContent } from '../card-content'
import { placeHoverCard } from './position'
import type { PinnedWindowGeometry } from '../../../store/pinned-windows'
import type { PinnedNoteCardState, WikiLinkHoverCardState } from '../../../types/hover-card'
import type { MenuItem } from '../../../components/overlay'

const MIN_PINNED_WIDTH = 260
const MIN_PINNED_HEIGHT = 140
const CARD_WIDTH = 340
const CARD_MARGIN = 8
const HIDE_GRACE_MS = 200
const PINNED_PREVIEW_LENGTH = Number.MAX_SAFE_INTEGER
export const PINNED_BASE_Z = 280
export const PINNED_MENU_Z = 300

type Rect = { x: number, y: number, width: number, height: number }

export function hoverCardStyle(pinned: boolean, pinnedRect: Rect, position: { top: number, left: number } | null, pinnedInit: PinnedNoteCardState | undefined): CSSProperties {
  if (pinned) {
    return {
      left: pinnedRect.x,
      top: pinnedRect.y,
      width: pinnedRect.width,
      height: pinnedRect.height || undefined,
      zIndex: PINNED_BASE_Z + (pinnedInit?.z ?? 0),
    }
  }
  if (position) return { top: position.top, left: position.left }
  return { top: 0, left: 0, visibility: 'hidden' }
}

export interface WikiLinkHoverCardProps {
  card: WikiLinkHoverCardState
  path: string[]
  depth: number
  dark: boolean
  pinned?: boolean
  pinnedInit?: PinnedNoteCardState
  stackCount?: number
  stackFront?: boolean
  stackItems?: MenuItem[]
  onClose: () => void
  onEnter: () => void
  onLeave: () => void
  onPin: (card: WikiLinkHoverCardState, rect: DOMRect) => void
  onGeometryChange?: (geometry: PinnedWindowGeometry) => void
  flash?: boolean
}

function resolveNestedCandidate(link: HTMLElement, card: WikiLinkHoverCardState, depth: number, path: string[], linksEnabled: boolean): WikiLinkHoverCardState | null {
  if (depth >= MAX_HOVER_CARD_DEPTH) return null
  if (linksEnabled) {
    const preview = linkPreviewFromElement(link)
    if (preview) return { anchor: link, title: linkCardTitle(preview), noteId: null, missing: false, link: preview }
  }
  // The last branch is for `[[#heading]]`, whose target lives in that same datum. A span without one
  // is not a wiki link, and the card it used to produce only repeated the note already on screen.
  if (link.dataset.wikilink === undefined) return null
  const parsed = parseWikiTarget(decodeDataValue(link.dataset.wikilink))
  const notes = useNotes.getState().notes
  if (parsed.noteTitle) {
    const note = findNoteByTitle(parsed.noteTitle)
    if (!note) {
      return { anchor: link, title: parsed.alias ?? parsed.noteTitle, noteId: null, missing: true, headline: parsed.heading ?? parsed.noteTitle }
    }
    if (path.includes(note.id)) return null
    return { anchor: link, title: parsed.alias ?? note.title, noteId: note.id, missing: false, headline: parsed.heading ?? note.title }
  }
  if (!card.noteId) return null
  const summary = notes[card.noteId]
  if (!summary) return null
  return { anchor: link, title: parsed.alias ?? summary.title, noteId: card.noteId, missing: false, headline: parsed.heading ?? summary.title }
}

function computeHoverCardPosition(cardEl: HTMLDivElement, card: WikiLinkHoverCardState, onClose: () => void, setPosition: Dispatch<SetStateAction<{ top: number, left: number } | null>>) {
  if (!card.anchor.isConnected) {
    onClose()
    return
  }
  const anchorRect = card.anchor.getBoundingClientRect()
  const cardRect = cardEl.getBoundingClientRect()
  if (!anchorRect.width && !anchorRect.height) return
  setPosition(placeHoverCard(anchorRect, cardRect))
}

function clampWindowRect(next: Rect): Rect {
  const viewport = getVisibleViewport()
  const width = Math.max(MIN_PINNED_WIDTH, Math.min(next.width, viewport.right - next.x - CARD_MARGIN))
  const height = next.height > 0
    ? Math.max(MIN_PINNED_HEIGHT, Math.min(next.height, viewport.bottom - next.y - CARD_MARGIN))
    : 0
  const x = Math.min(Math.max(next.x, viewport.left), Math.max(viewport.left, viewport.right - width - CARD_MARGIN))
  const y = Math.min(Math.max(next.y, viewport.top), Math.max(viewport.top, viewport.bottom - Math.max(height, MIN_PINNED_HEIGHT) - CARD_MARGIN))
  return { x, y, width, height }
}

function stopEvent(event: React.MouseEvent) {
  event.stopPropagation()
  event.preventDefault()
}

function moveCardFocus(direction: 1 | -1, cardRef: RefObject<HTMLDivElement | null>) {
  const cards = [...document.querySelectorAll<HTMLElement>('[data-hover-card]')]
  const index = cards.indexOf(cardRef.current as HTMLElement)
  cards[index + direction]?.focus({ preventScroll: true })
}

function trackPointerDrag(startEvent: React.PointerEvent, update: (dx: number, dy: number) => Rect, commit: (rect: Rect) => void) {
  const move = (moveEvent: PointerEvent) => {
    commit(clampWindowRect(update(moveEvent.clientX - startEvent.clientX, moveEvent.clientY - startEvent.clientY)))
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

function useCardPositioning(card: WikiLinkHoverCardState, pinned: boolean, onClose: () => void) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number, left: number } | null>(null)

  useLayoutEffect(() => {
    if (pinned) return
    const cardEl = cardRef.current
    if (!cardEl) return
    const compute = () => computeHoverCardPosition(cardEl, card, onClose, setPosition)
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(cardEl)
    window.addEventListener('resize', compute)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', compute)
    }
  }, [card.anchor, onClose, pinned])

  useEffect(() => {
    if (!pinned) return
    cardRef.current?.focus({ preventScroll: true })
  }, [pinned])

  return { cardRef, position }
}

function useCardPinnedGeometry(pinnedInit: PinnedNoteCardState | undefined, onGeometryChange: ((geometry: PinnedWindowGeometry) => void) | undefined, cardRef: RefObject<HTMLDivElement | null>) {
  const [pinnedRect, setPinnedRect] = useState<Rect>(() => clampWindowRect({
    x: pinnedInit?.x ?? 0,
    y: pinnedInit?.y ?? 0,
    width: pinnedInit?.width ?? CARD_WIDTH,
    height: pinnedInit?.height ?? 0,
  }))
  const pinnedRectRef = useRef(pinnedRect)

  const commitRect = useCallback((rect: Rect) => {
    pinnedRectRef.current = rect
    setPinnedRect(rect)
    onGeometryChange?.(rect)
  }, [onGeometryChange])

  const beginDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    event.preventDefault()
    const origin = { ...pinnedRectRef.current }
    trackPointerDrag(event, (dx, dy) => ({ ...origin, x: origin.x + dx, y: origin.y + dy }), commitRect)
  }, [commitRect])

  const beginResize = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const origin = { ...pinnedRectRef.current }
    if (origin.height <= 0) {
      const rendered = cardRef.current?.getBoundingClientRect()
      if (rendered) origin.height = rendered.height
    }
    trackPointerDrag(event, (dx, dy) => ({ ...origin, width: origin.width + dx, height: origin.height + dy }), commitRect)
  }, [cardRef, commitRect])

  return { pinnedRect, beginDrag, beginResize }
}

function useCardAccessibility(card: WikiLinkHoverCardState) {
  const describedBy = useId()

  useEffect(() => {
    const anchor = card.anchor
    const previous = anchor.getAttribute('aria-describedby')
    anchor.setAttribute('aria-describedby', describedBy)
    return () => {
      if (anchor.getAttribute('aria-describedby') !== describedBy) return
      if (previous === null) anchor.removeAttribute('aria-describedby')
      else anchor.setAttribute('aria-describedby', previous)
    }
  }, [card.anchor, describedBy])

  return describedBy
}

function useCardActions(opts: { card: WikiLinkHoverCardState, pinned: boolean, onClose: () => void, onPin: (card: WikiLinkHoverCardState, rect: DOMRect) => void, cardRef: RefObject<HTMLDivElement | null> }) {
  const { card, pinned, onClose, onPin, cardRef } = opts

  const onCardKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (pinned && event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveCardFocus(1, cardRef)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveCardFocus(-1, cardRef)
    }
  }, [onClose, pinned, cardRef])

  const handlePin = useCallback(() => {
    const rect = cardRef.current?.getBoundingClientRect()
    if (!rect) return
    onPin(card, rect)
  }, [card, onPin, cardRef])

  const openInCurrentPane = useCallback(() => {
    if (!card.noteId) return
    void useNotes.getState().openNote(card.noteId)
    onClose()
  }, [card.noteId, onClose])

  const openInSidePane = useCallback(() => {
    if (!card.noteId) return
    void useNotes.getState().openNote(card.noteId, { pane: 'secondary' })
    onClose()
  }, [card.noteId, onClose])

  const openBacklink = useCallback((id: string) => {
    void useNotes.getState().openNote(id, { pane: 'secondary' })
    onClose()
  }, [onClose])

  return { stop: stopEvent, onCardKeyDown, handlePin, openInCurrentPane, openInSidePane, openBacklink }
}

function usePinnedMermaid(opts: {
  pinned: boolean
  status: 'loading' | 'ready' | 'missing' | 'error'
  html: string
  dark: boolean
  mermaidEnabled: boolean
  cardRef: RefObject<HTMLDivElement | null>
}): void {
  const { pinned, status, html, dark, mermaidEnabled, cardRef } = opts
  useEffect(() => {
    if (!pinned || status !== 'ready' || !html || !mermaidEnabled) return
    const body = cardRef.current?.querySelector<HTMLElement>('.wiki-hover-body')
    if (!body) return
    let cancelled = false
    const isCurrent = () => !cancelled && body.isConnected
    void renderPendingMermaid(body, dark, { isCurrent })
    return () => {
      cancelled = true
    }
  }, [pinned, status, html, dark, mermaidEnabled, cardRef])
}

export function useWikiLinkHoverCard(props: WikiLinkHoverCardProps) {
  const { card, path, depth, dark, pinned = false, pinnedInit, onClose, onPin, onGeometryChange } = props
  const preview = useSession((s) => s.settings.preview)
  const content = useNoteCardContent({ noteId: card.noteId, missing: card.missing, headline: card.headline }, dark, preview.math, pinned ? PINNED_PREVIEW_LENGTH : preview.linkPreviewLength)
  const { status, html, isTruncated } = content
  const { cardRef, position } = useCardPositioning(card, pinned, onClose)
  const describedBy = useCardAccessibility(card)
  const { pinnedRect, beginDrag, beginResize } = useCardPinnedGeometry(pinnedInit, onGeometryChange, cardRef)
  usePinnedMermaid({ pinned, status, html, dark, mermaidEnabled: preview.mermaid, cardRef })
  const resolve = useCallback((link: HTMLElement) => resolveNestedCandidate(link, card, depth, path, preview.linkHoverLinks), [card, depth, path, preview.linkHoverLinks])
  const machine = useLinkHover({
    resolve,
    delay: preview.linkHoverDelayMs,
    enabled: preview.linkHover,
    armOnNonLink: false,
    hideGraceMs: HIDE_GRACE_MS,
  })
  const actions = useCardActions({ card, pinned, onClose, onPin, cardRef })
  const [isStackMenuOpen, setIsStackMenuOpen] = useState(false)
  const stackButtonRef = useRef<HTMLButtonElement>(null)
  const backlinks = useNoteBacklinks(card.noteId && !card.missing ? card.noteId : null)
  const htmlObj = useMemo(() => ({ __html: html }), [html])

  return {
    ...props,
    pinned,
    status,
    html,
    isTruncated,
    htmlObj,
    cardRef,
    position,
    describedBy,
    pinnedRect,
    beginDrag,
    beginResize,
    machine,
    nested: machine.card,
    backlinks: backlinks.links,
    isStackMenuOpen,
    setIsStackMenuOpen,
    stackButtonRef,
    ...actions,
  }
}

export type WikiLinkHoverCardBundle = ReturnType<typeof useWikiLinkHoverCard>
