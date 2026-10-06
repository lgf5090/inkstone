import { memo, useEffect, useMemo, useRef } from 'react'
import { t } from '../../lib/i18n'
import { useThemeDark } from '../../lib/hooks'
import type { MenuItem } from '../../components/overlay'
import { usePinnedWindows, type PersistedPinnedWindow } from '../../store/pinned-windows'
import { withPinnedWindowSize } from '../../lib/pinned-window-size'
import { WikiLinkHoverCard, type WikiLinkHoverCardState } from './wiki-link-hover-card'

const anchorCache = new Map<number, HTMLElement>()

function anchorFor(id: number): HTMLElement {
  let anchor = anchorCache.get(id)
  if (!anchor) {
    anchor = document.createElement('span')
    anchorCache.set(id, anchor)
  }
  return anchor
}

function releaseAnchors(kept: PersistedPinnedWindow[]): void {
  const live = new Set(kept.map((item) => item.id))
  for (const id of anchorCache.keys()) {
    if (!live.has(id)) anchorCache.delete(id)
  }
}

function itemToCard(item: PersistedPinnedWindow): WikiLinkHoverCardState {
  return {
    anchor: anchorFor(item.id),
    title: item.title,
    noteId: item.noteId,
    missing: item.missing,
    headline: item.headline,
  }
}
export const PinnedWindowsLayer = memo(function PinnedWindowsLayer() {
  const state = usePinnedWindowState()
  if (!state.items.length) return null
  return (
    <>
      {state.cards.map(({ item, card }) => (
        <WikiLinkHoverCard
          key={item.id}
          card={card}
          path={card.noteId ? [card.noteId] : []}
          depth={1}
          dark={state.isDark}
          pinned
          pinnedInit={item}
          stackCount={state.items.length}
          stackFront={item.id === state.frontId}
          stackItems={state.stackItems}
          onClose={() => state.close(item.id)}
          onEnter={() => {}}
          onLeave={() => {}}
          onPin={(cardState, rect) => state.pin(cardState, withPinnedWindowSize(rect))}
          onGeometryChange={(geometry) => state.updateGeometry(item.id, geometry)}
          flash={state.flashId === item.id}
        />
      ))}
    </>
  )
})

function usePinnedWindowState() {
  const items = usePinnedWindows((s) => s.items)
  const flashId = usePinnedWindows((s) => s.flashId)
  const pin = usePinnedWindows((s) => s.pin)
  const close = usePinnedWindows((s) => s.close)
  const bringToFront = usePinnedWindows((s) => s.bringToFront)
  const closeAll = usePinnedWindows((s) => s.closeAll)
  const closeFront = usePinnedWindows((s) => s.closeFront)
  const updateGeometry = usePinnedWindows((s) => s.updateGeometry)
  const isDark = useThemeDark()
  useMenuEscape(closeFront)
  useEffect(() => {
    releaseAnchors(items)
  }, [items])

  const cards = useMemo(() => items.map((item) => ({
    item,
    card: itemToCard(item),
  })), [items])

  const frontId = items.reduce<PersistedPinnedWindow | null>((top, item) => !top || item.z > top.z ? item : top, null)?.id ?? null

  const stackItems: MenuItem[] = useMemo(() => [
    ...items.map((item) => ({
      id: `pin-${item.id}`,
      label: item.title || t('preview.untitled'),
      checked: item.id === frontId,
      onSelect: () => bringToFront(item.id),
    })),
    {
      id: 'close-all',
      label: t('preview.close_all_pinned'),
      tone: 'danger' as const,
      separatorBefore: true,
      onSelect: () => closeAll(),
    },
  ], [bringToFront, closeAll, frontId, items])

  return { items, flashId, pin, close, bringToFront, closeAll, closeFront, updateGeometry, isDark, cards, frontId, stackItems }
}

function useMenuEscape(closeFront: () => void): void {
  const handleEscapeRef = useRef(closeFront)
  handleEscapeRef.current = closeFront
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as Element | null
      if (target && typeof target.closest === 'function' && target.closest('[role="menu"]')) {
        handleEscapeRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
