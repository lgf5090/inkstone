import { type KeyboardEvent, type RefObject } from 'react'
import type { NoteTemplate } from '@shared/types'

interface GalleryKeyboardDeps {
  editing: unknown
  renaming: unknown
  moving: unknown
  categoryDialog: unknown
  isImportOpen: boolean
  isBatchMoving: boolean
  publishing: unknown
  isHelpOpen: boolean
  isMoreOpen: boolean
  setIsHelpOpen: (value: boolean) => void
  toggleSelectMode: () => void
  searchRef: RefObject<HTMLInputElement | null>
  query: string
  setQuery: (value: string) => void
  selectMode: boolean
  setSelectMode: (value: boolean) => void
  visible: NoteTemplate[]
  setSelectedIds: (value: ReadonlySet<string>) => void
  toggleSelectAll: () => void
  focusedId: string | null
  gridRef: RefObject<HTMLDivElement | null>
  toggleSelect: (id: string) => void
  setFocusedId: (id: string | null) => void
}

function activeTemplateId(deps: Pick<GalleryKeyboardDeps, 'focusedId'>): string | null | undefined {
  return deps.focusedId ?? (document.activeElement instanceof HTMLElement
    ? document.activeElement.closest('[data-template-id]')?.getAttribute('data-template-id')
    : null)
}

/** True while a dialog, a menu, or a text field owns the keyboard. */
function galleryKeyGuard(deps: GalleryKeyboardDeps, event: KeyboardEvent): boolean {
  if (deps.editing || deps.renaming || deps.moving || deps.categoryDialog || deps.isImportOpen ||
    deps.isBatchMoving || deps.publishing || deps.isHelpOpen || deps.isMoreOpen)
    return true
  const target = event.target as HTMLElement
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
}

/** Non-arrow shortcut keys; returns true once the event was consumed. */
function handleGalleryModifiers(deps: GalleryKeyboardDeps, event: KeyboardEvent): boolean {
  if (event.key === '?') {
    event.preventDefault()
    deps.setIsHelpOpen(true)
    return true
  }
  if (event.key === '/') {
    event.preventDefault()
    deps.searchRef.current?.focus()
    return true
  }
  if (event.key === 's' || event.key === 'S') {
    event.preventDefault()
    deps.toggleSelectMode()
    return true
  }
  if (event.key === 'a' || event.key === 'A') {
    event.preventDefault()
    if (!deps.selectMode) {
      deps.setSelectMode(true)
      deps.setSelectedIds(new Set(deps.visible.map((item) => item.id)))
    }
    else {
      deps.toggleSelectAll()
    }
    return true
  }
  if (event.key === ' ' && deps.selectMode) {
    const activeId = activeTemplateId(deps)
    if (activeId) {
      event.preventDefault()
      deps.toggleSelect(activeId)
    }
    return true
  }
  return false
}

function nextGalleryIndex(key: string, currentIndex: number, columns: number, count: number): number {
  if (key === 'ArrowRight') return currentIndex < 0 ? 0 : Math.min(count - 1, currentIndex + 1)
  if (key === 'ArrowDown') return currentIndex < 0 ? 0 : Math.min(count - 1, currentIndex + columns)
  if (key === 'ArrowLeft') return currentIndex < 0 ? count - 1 : Math.max(0, currentIndex - 1)
  if (key === 'ArrowUp') return currentIndex < 0 ? count - 1 : Math.max(0, currentIndex - columns)
  return -1
}

/**
 * Moves the focus ring across the grid. The column count is read from the laid-out
 * grid rather than assumed, because the same panel is one column on a phone and
 * three on a wide desktop.
 */
function handleGalleryArrows(deps: GalleryKeyboardDeps, event: KeyboardEvent): boolean {
  if (deps.visible.length === 0) return false
  const columns = deps.gridRef.current
    ? getComputedStyle(deps.gridRef.current).gridTemplateColumns.split(' ').filter(Boolean).length
    : 1
  const activeId = activeTemplateId(deps)
  const currentIndex = activeId ? deps.visible.findIndex((item) => item.id === activeId) : -1
  const nextIndex = nextGalleryIndex(event.key, currentIndex, columns, deps.visible.length)
  if (nextIndex < 0) return false
  event.preventDefault()
  const next = deps.visible[nextIndex]
  if (!next) return false
  focusTemplateCard(deps, next.id)
  return true
}

/** Template ids are opaque and can start with a digit, which is not a bare CSS attribute value. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/"/g, '\\"')
}

/**
 * Land the ring and the real focus on one card.
 *
 * The ring alone would not make the printed `Enter use` true: the activation is a
 * button, and a button only answers Enter when the document holds it.
 */
function focusTemplateCard(deps: Pick<GalleryKeyboardDeps, 'gridRef' | 'setFocusedId'>, id: string): void {
  deps.setFocusedId(id)
  requestAnimationFrame(() => {
    const card = deps.gridRef.current?.querySelector<HTMLElement>(`[data-template-id="${cssEscape(id)}"]`)
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    ;(card?.querySelector<HTMLElement>('button') ?? card)?.focus({ preventScroll: true })
  })
}

/**
 * Keys the search box owns.
 *
 * The panel opens with the caret in the search field, so without these the shortcut
 * row printed under the header described keys that could not be pressed: Escape had
 * to give back one step (clear the query) before it gives up the dialog, and ArrowDown
 * is how the caret walks out of the field and into the grid.
 */
function handleGallerySearchKeys(deps: GalleryKeyboardDeps, event: KeyboardEvent): boolean {
  if (event.target !== deps.searchRef.current) return false
  if (event.key === 'Escape') {
    if (!deps.query) return false
    event.preventDefault()
    deps.setQuery('')
    return true
  }
  if (event.key === 'ArrowDown' && deps.visible.length > 0) {
    event.preventDefault()
    focusTemplateCard(deps, (deps.focusedId && deps.visible.some((item) => item.id === deps.focusedId)
      ? deps.focusedId
      : deps.visible[0]!.id))
    return true
  }
  return false
}

export function useGalleryKeyboard(deps: GalleryKeyboardDeps): (event: KeyboardEvent) => void {
  return (event) => {
    if (handleGallerySearchKeys(deps, event)) return
    if (galleryKeyGuard(deps, event)) return
    if (handleGalleryModifiers(deps, event)) return
    handleGalleryArrows(deps, event)
  }
}
