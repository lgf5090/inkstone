import { useCallback } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { collapseOrLeave, expandOrReveal, focusTreeEdge, moveTreeFocus } from './keyboard'

export interface TreeKeyboardOptions {
  /**
   * Keys beyond the arrows and Home/End that a host owns — F2 to rename, Delete to remove. Return
   * true when the event was handled, which is what makes the handler prevent the browser default.
   */
  onKey?: (event: ReactKeyboardEvent<HTMLElement>) => boolean
}

/**
 * The shared tree keyboard: ArrowDown/ArrowUp walk the visible rows, ArrowRight expands or steps
 * into a branch, ArrowLeft collapses or returns to the parent, Home/End jump to the ends. The
 * handler reads the rendered DOM (see `./keyboard`), so a row only has to carry `data-tree-row`
 * and its fold control `data-tree-toggle`. Modifier chords and IME composition are left alone.
 */
export function useTreeKeyboard(options: TreeKeyboardOptions = {}): (event: ReactKeyboardEvent<HTMLElement>) => void {
  const { onKey } = options
  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey)
      return
    const target = event.currentTarget
    switch (event.key) {
      case 'ArrowDown':
        if (moveTreeFocus(target, 1)) event.preventDefault()
        return
      case 'ArrowUp':
        if (moveTreeFocus(target, -1)) event.preventDefault()
        return
      case 'ArrowRight':
        if (expandOrReveal(target)) event.preventDefault()
        return
      case 'ArrowLeft':
        if (collapseOrLeave(target)) event.preventDefault()
        return
      case 'Home':
        if (focusTreeEdge(target, 'first')) event.preventDefault()
        return
      case 'End':
        if (focusTreeEdge(target, 'last')) event.preventDefault()
        return
    }
    if (onKey?.(event))
      event.preventDefault()
  }, [onKey])
}
