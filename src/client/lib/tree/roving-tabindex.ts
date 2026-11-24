import { useCallback, useRef, type RefObject } from 'react'
import { TREE_ROW_SELECTOR, visibleTreeRows } from './keyboard'

/**
 * Keep exactly one visible row in each tree in the sequential tab order. The last focused row stays
 * the stop; if folding or removal hides it, the first visible row takes over. Auxiliary controls are
 * deliberately outside this set, so toggles and row actions keep their native Tab behavior.
 */
export function syncTreeTabIndex(tree: HTMLElement, preferred?: HTMLElement | null): HTMLElement | null {
  const rows = visibleTreeRows(tree)
  const active = preferred && rows.includes(preferred) ? preferred : rows[0] ?? null
  for (const row of tree.querySelectorAll<HTMLElement>(TREE_ROW_SELECTOR))
    row.tabIndex = -1
  if (active)
    active.tabIndex = 0
  return active
}

/**
 * Attach the roving tab stop to a tree container, including rows mounted after the first render. The
 * returned callback also handles a tree that appears conditionally; an optional ref keeps a host's
 * existing scrolling and query handle pointing at the same element.
 */
export function useTreeRovingTabIndex(treeRef?: RefObject<HTMLElement | null>): (node: HTMLElement | null) => void {
  const activeRowRef = useRef<HTMLElement | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  return useCallback((tree: HTMLElement | null) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    if (treeRef)
      treeRef.current = tree
    if (!tree)
      return
    const reconcile = () => {
      activeRowRef.current = syncTreeTabIndex(tree, activeRowRef.current)
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement))
        return
      const row = event.target.closest<HTMLElement>(TREE_ROW_SELECTOR)
      if (!row || !tree.contains(row))
        return
      activeRowRef.current = row
      reconcile()
    }
    reconcile()
    tree.addEventListener('focusin', onFocusIn)
    const observer = new MutationObserver(reconcile)
    observer.observe(tree, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'inert', 'aria-hidden'],
    })
    cleanupRef.current = () => {
      observer.disconnect()
      tree.removeEventListener('focusin', onFocusIn)
    }
  }, [treeRef])
}
