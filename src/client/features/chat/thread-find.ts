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
/** How many occurrences are marked on a page. Exported so the panel can say when the count is a ceiling. */
export const MAX_FIND_HITS = 400

/** What one search pass left behind: the marks in document order, and whether it had to stop early. */
export interface FindResult {
  marks: HTMLElement[]
  truncated: boolean
}

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
 * Wraps every occurrence of `query`, and answers with the marks in the order they appear plus whether it
 * had to stop.
 *
 * The query is matched case-insensitively over each text node's own content, which means a phrase that
 * spans an element boundary — `hello **world**` — is not a hit. That is the same limitation the browser's
 * own find has on a line break, and paying for the alternative would mean rebuilding the markup.
 *
 * The match is the literal phrase and nothing more: no wildcard, no pattern, and no reading of a Chinese
 * run. That is the same rule the conversation search on the server answers with — a `LIKE` whose wildcards
 * are escaped, matching the stored body — and the app's pinyin readings are written down as being for
 * titles, headings and tags, never for a body. A box that quietly read `a.c` as a pattern would find words
 * the reader never typed, and one that read `ysms` as a body's initials would find things the list they
 * came from does not.
 */
export function markFindHits(root: HTMLElement, query: string): FindResult {
  clearFindMarks(root)
  const needle = query.trim().toLowerCase()
  if (!needle) return { marks: [], truncated: false }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isSkipped(node) || !node.textContent?.toLowerCase().includes(needle)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT),
  })
  const targets: Text[] = []
  while (walker.nextNode()) targets.push(walker.currentNode as Text)
  const marks: HTMLElement[] = []
  let stopped = false
  for (const [position, node] of targets.entries()) {
    const text = node.textContent ?? ''
    const lowered = text.toLowerCase()
    let from = lowered.indexOf(needle)
    if (from < 0) continue
    const fragment = document.createDocumentFragment()
    let cursor = 0
    while (from >= 0 && marks.length < MAX_FIND_HITS) {
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
    if (marks.length >= MAX_FIND_HITS) {
      // Whether anything was left behind, rather than whether the number came out even: a page that holds
      // exactly the ceiling was searched whole, and calling that a ceiling is its own lie.
      stopped = from >= 0 || position < targets.length - 1
      break
    }
  }
  // Stopping at the ceiling is only honest if it is said: a count that ends at the cap reads as the whole
  // total, and the reader stops looking for a hit they were told does not exist.
  return { marks, truncated: stopped }
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
