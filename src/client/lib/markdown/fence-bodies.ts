/**
 * P-01. Where a rich block's fence body lives while its markup travels to the DOM.
 *
 * A fence body used to ride inside a `data-*` attribute, so every preview re-render re-encoded the
 * whole board and every pass over the markup — the sanitizer's, the task pass's, the host's own
 * `innerHTML` — walked text that exactly one layer ever reads. A 200-card board pays ~17 KB of base64
 * for that one attribute, and paid it again per keystroke.
 *
 * The bodies go here instead. The renderer pushes one per block in document order, which is what
 * makes the block's own `data-kanban-index` the key back, and the host that inserts the markup
 * registers the set on the element that holds it. A body therefore lives exactly as long as the
 * nodes rendered from it: nothing to evict, nothing to expire, and nothing that can resolve to a
 * stale board.
 *
 * Nested renders (a note embed, a markdown example) share the outer document's set rather than
 * starting their own, because a markup string carries no per-subtree registration once it is
 * re-parsed: one set with document-unique indexes is the only shape that survives the trip.
 */

export interface FenceBodies {
  kanban: string[]
}

interface FenceBodiesHost {
  inkstoneFenceBodies?: FenceBodies
}

export function createFenceBodies(): FenceBodies {
  return { kanban: [] }
}

/**
 * A copy that can be appended to without touching the original. A surface that renders more blocks
 * into markup it has already prepared (a note embed, whose fence body arrives after the first
 * render) continues the numbering, and continuing it on the render's own set would leave that set
 * carrying the embeds of every pass over the same document.
 */
export function cloneFenceBodies(bodies: FenceBodies): FenceBodies {
  return { kanban: [...bodies.kanban] }
}

/**
 * Take the next block number for a family and remember its body. The position is the index the
 * renderer writes into `data-kanban-index`, so the two can never disagree.
 */
export function takeFenceIndex(bodies: FenceBodies, family: keyof FenceBodies, source: string): number {
  const list = bodies[family]
  list.push(source)
  return list.length - 1
}

/** Attach the bodies a rendered document was built from to the element now holding that markup. */
export function registerFenceBodies(root: Element, bodies: FenceBodies): void {
  asHost(root).inkstoneFenceBodies = bodies
}

/**
 * The set an element was rendered from, read back off the element chain. A surface that hands
 * markup on to another one needs this to carry the bodies along with the string it captured.
 */
export function findFenceBodies(node: Element): FenceBodies | null {
  for (let current: Element | null = node; current !== null; current = current.parentElement) {
    const bodies = asHost(current).inkstoneFenceBodies
    if (bodies) return bodies
  }
  return null
}

/**
 * Whether two renders carry the same bodies, so a host that skips work when its markup did not
 * change can still see a fence-body edit: with the bodies out of the attributes, such an edit no
 * longer changes the rendered string at all.
 */
export function sameFenceBodies(current: FenceBodies, next: FenceBodies): boolean {
  if (current === next) return true
  const a = current.kanban
  const b = next.kanban
  return a.length === b.length && a.every((body, index) => body === b[index])
}

/**
 * The body a block was rendered from, or `''` when the markup was never registered. An unregistered
 * root reads as an empty fence, which the board answers with its error state — the loud one, rather
 * than a board that silently shows another block's cards.
 */
export function fenceBody(node: Element, family: keyof FenceBodies, index: number): string {
  const bodies = findFenceBodies(node)
  return bodies ? bodies[family][index] ?? '' : ''
}

function asHost(node: Element): Element & FenceBodiesHost {
  return node as Element & FenceBodiesHost
}
