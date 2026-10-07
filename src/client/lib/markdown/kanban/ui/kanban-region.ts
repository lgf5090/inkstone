import { useEffect, type RefObject } from 'react'
import { t, useLocale } from '../../../i18n'
import { KANBAN_CANVAS_SELECTOR } from '../view'

/**
 * The board's landmark name, kept in the language the reader is using.
 *
 * The region is the canvas element the host creates — not this tree's root — so its name is written
 * by hand, once, and then never again: a note's preview is markup React did not make, and nothing in
 * the app tree re-renders the block when the language changes. The one string on that element that is
 * a translation therefore froze at whatever the language was when the block first mounted, and a
 * screen reader kept announcing the old one after the reader switched (found in the UI review of
 * 2026-09-23).
 *
 * The tree is the part that hears about the change, so the tree writes it: this hook subscribes to the
 * locale and re-writes the attribute when it moves. `closest` rather than a ref, because the canvas is
 * the mounted root's own parent and the tree has no handle on it — in the overlay the same element is
 * moved to the overlay's stage, and it stays the region in both hosts.
 */
export function useKanbanRegionLabel(containerRef: RefObject<HTMLElement | null>): void {
  const locale = useLocale()
  useEffect(() => {
    const canvas = containerRef.current?.closest(KANBAN_CANVAS_SELECTOR)
    if (canvas) canvas.setAttribute('aria-label', t('preview.kanban'))
  }, [containerRef, locale])
}
