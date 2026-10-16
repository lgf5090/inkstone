/**
 * Finding a phrase in the thread that is already on screen.
 *
 * A reply can be hundreds of lines and the reader knows the words they are looking for, so the search is
 * over the rendered transcript rather than over the stored rows: what is highlighted is what they can
 * see, including the code block they are hunting for. The marks live in the DOM for as long as the panel
 * is open and are taken out again by walking the same nodes — nothing about this reaches the store.
 *
 * Two things are deliberately not searched: text inside an existing mark (which would double-wrap on the
 * second press) and `script`/`style` text. Everything else is, code and table cells included.
 */

const HIT_ATTRIBUTE = 'data-find-hit'
const MAX_HITS = 400

function isSkipped(node: Node): boolean {
  const parent = node.parentElement
  if (!parent) return true
  return Boolean(parent.closest(`mark[${HIT_ATTRIBUTE}]`)) || parent.closest('script, style') !== null
}

/** Takes every mark this module made back out of the tree, leaving the text as it was. */
export function clearFindMarks(root: HTMLElement): void {
  for (const mark of [...root.querySelectorAll<HTMLElement>(`mark[${HIT_ATTRIBUTE}]`)]) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
    // Adjacent text nodes left by a previous pass are merged so the next search sees whole words: two
    // half-words side by side are two nodes, and a phrase spanning them would never be found.
    parent.normalize()
  }
}

/**
 * Wraps every occurrence of `query`, and answers with the marks in the order they appear.
 *
 * The query is matched case-insensitively over each text node's own content, which means a phrase that
 * spans an element boundary — `hello **world**` — is not a hit. That is the same limitation the browser's
 * own find has on a line break, and paying for the alternative would mean rebuilding the markup.
 */
export function markFindHits(root: HTMLElement, query: string): HTMLElement[] {
  clearFindMarks(root)
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isSkipped(node) || !node.textContent?.toLowerCase().includes(needle)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT),
  })
  const targets: Text[] = []
  while (walker.nextNode()) targets.push(walker.currentNode as Text)
  const marks: HTMLElement[] = []
  for (const node of targets) {
    const text = node.textContent ?? ''
    const lowered = text.toLowerCase()
    let from = lowered.indexOf(needle)
    if (from < 0) continue
    const fragment = document.createDocumentFragment()
    let cursor = 0
    while (from >= 0 && marks.length < MAX_HITS) {
      if (from > cursor) fragment.append(document.createTextNode(text.slice(cursor, from)))
      const mark = document.createElement('mark')
      mark.setAttribute(HIT_ATTRIBUTE, '')
      mark.textContent = text.slice(from, from + needle.length)
      fragment.append(mark)
      marks.push(mark)
      cursor = from + needle.length
      from = lowered.indexOf(needle, cursor)
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)))
    node.parentNode?.replaceChild(fragment, node)
    if (marks.length >= MAX_HITS) break
  }
  return marks
}

/** Brings one hit into view and marks it as the one the count is pointing at. */
export function focusFindHit(marks: readonly HTMLElement[], index: number, scroller: HTMLElement | null): void {
  marks.forEach((mark, position) => mark.classList.toggle('is-current', position === index))
  const mark = marks[index]
  if (!mark) return
  // Scrolled inside the thread rather than with `scrollIntoView`: the browser also scrolls every
  // ancestor, which drags the page behind the overlay around when the thread is in a dialog.
  if (!scroller) return
  const box = mark.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()
  if (box.top >= view.top && box.bottom <= view.bottom) return
  scroller.scrollTop += box.top - view.top - view.height / 2 + box.height / 2
}
