/**
 * Which paragraph the reader is standing on.
 *
 * The focus mode dims everything else, so a wrong answer is a page of grey text with the wrong line
 * lit up. Both reading modes ask the same question in a different axis: paged reads the horizontal
 * offset of the page's left edge, scroll reads the middle of the window.
 */
export interface BlockSpan {
  start: number
  end: number
}

/** The last block that begins at or before `at`; the first block when nothing has begun yet. */
export function blockHolding(spans: BlockSpan[], at: number): number {
  let picked = 0
  for (let index = 0; index < spans.length; index += 1) {
    if (spans[index].start <= at + 1) picked = index
    else break
  }
  return picked
}

/**
 * The blocks the dimming works on: the chapter's own top-level elements.
 *
 * A nested `div` inside a section is not a paragraph to the reader, and dimming a whole section because
 * one line of it is on the page hides the rest of the chapter. So only the children of the document
 * root count, and empty ones (whitespace text nodes the publisher left behind) do not.
 */
export function blockSpans(root: Element, axis: 'x' | 'y'): BlockSpan[] {
  const spans: BlockSpan[] = []
  for (const child of Array.from(root.children)) {
    const rect = child as HTMLElement
    const start = axis === 'x' ? rect.offsetLeft : rect.offsetTop
    const size = axis === 'x' ? rect.offsetWidth : rect.offsetHeight
    if (!size && !rect.textContent?.trim()) continue
    spans.push({ start, end: start + size })
  }
  return spans
}

export const FOCUS_CLASS = 'reader-now'

/** Put the mark on one block and nowhere else. */
export function paintFocus(root: Element, index: number): void {
  Array.from(root.children).forEach((child, position) => {
    child.classList.toggle(FOCUS_CLASS, position === index)
  })
}
