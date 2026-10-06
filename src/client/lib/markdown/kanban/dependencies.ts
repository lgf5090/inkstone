import type { KanbanItem } from './types'
import {
  calculateTimelineBarGeometry,
  type TimelineBarGeometry,
  type TimelineDayFields,
  type TimelineRange,
} from './timeline-helpers'

/**
 * What one card owes another (KU-23, ADR-0006). A card's `dependsOn` names the cards that must be
 * done before it — the blockers — and the direction is the only thing the rest of the module needs
 * to agree on: an edge runs from the blocker to the card that lists it, and every read below is
 * built from that one rule. The list lives on the item in the JSON body; the outline body has no
 * slot for it, so it survives only the way views and subtasks already do — the first write from a
 * UI promotes the fence to JSON before anything is lost.
 *
 * Reads are tolerant rather than tidy: a hand-written fence may carry a list of numbers, a name for
 * a card that is not there, or the card itself. Junk is read as nothing (never a crash), and what
 * the editor writes back is always the normalized shape.
 */

/** The cards `item` waits for, read the way every reader here reads it: real ids, once, not itself. */
export function kanbanDependencyIds(item: KanbanItem): string[] {
  const raw = item.dependsOn
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || id === '' || id === item.id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** One dependency between two cards on the board: `from` blocks `to`. */
export interface KanbanDependencyEdge {
  from: string
  to: string
}

/** Every dependency the board holds, as blocker → dependent, only between cards that both exist. */
export function kanbanDependencyEdges(items: KanbanItem[]): KanbanDependencyEdge[] {
  const present = new Set(items.map((item) => item.id))
  const edges: KanbanDependencyEdge[] = []
  for (const item of items) {
    for (const dep of kanbanDependencyIds(item)) {
      if (present.has(dep)) edges.push({ from: dep, to: item.id })
    }
  }
  return edges
}

/**
 * How many cards wait on each card, read off the edges: the figure a card's footer shows so a reader
 * can see, without opening anything, that moving this card leaves work waiting behind it. Deliberately
 * structural — no done-state inference (ADR-0006), so a card keeps its count until the waiters name
 * something else.
 */
export function kanbanBlockedCounts(items: KanbanItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const edge of kanbanDependencyEdges(items)) {
    counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1)
  }
  return counts
}

/**
 * The ids a card names that no card on the board carries — a blocker that was deleted, or a fence
 * edited by hand. They draw nothing and break nothing; the detail lists them as missing rather than
 * quietly dropping them, because dropping would rewrite a document the reader did not touch.
 */
export function missingKanbanDependencyIds(items: KanbanItem[]): string[] {
  const present = new Set(items.map((item) => item.id))
  const missing = new Set<string>()
  for (const item of items) {
    for (const dep of kanbanDependencyIds(item)) {
      if (!present.has(dep)) missing.add(dep)
    }
  }
  return [...missing]
}

/**
 * Whether putting `depId` on `itemId`'s list would close a loop: it would, exactly when `itemId`
 * already waits on `depId` by way of other cards. Self-reference is the shortest loop there is.
 * The editor uses this to keep a cycle off the page — a reader is offered nothing that would not
 * stick — and the writer repeats the check against the document it actually sees.
 */
export function kanbanDependencyWouldCycle(items: KanbanItem[], itemId: string, depId: string): boolean {
  if (itemId === depId) return true
  // Walk the "waits on" edges out of the proposed blocker: if the chain of dependencies reaches
  // back to the card that would do the waiting, the new edge is the last side of a loop.
  const dependsOn = new Map<string, string[]>()
  for (const item of items) dependsOn.set(item.id, kanbanDependencyIds(item))
  const stack = [depId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === itemId) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(dependsOn.get(id) ?? []))
  }
  return false
}

/**
 * The board with `itemId` waiting on exactly `deps`, as one guarded write: junk, repeats, the card
 * itself and names for cards that are not on the board never reach the document, and a list that
 * would close a loop is refused whole — the same items come back, which the writer reads as a
 * no-op, so a refusal costs no step of undo. An empty result clears the list, which is how the
 * detail's remove buttons write.
 */
export function withKanbanDependenciesGuarded(items: KanbanItem[], itemId: string, deps: string[]): KanbanItem[] {
  const target = items.find((item) => item.id === itemId)
  if (!target) return items
  const present = new Set(items.map((item) => item.id))
  const seen = new Set<string>()
  const next: string[] = []
  for (const dep of deps) {
    if (typeof dep !== 'string' || dep === '' || dep === itemId || !present.has(dep) || seen.has(dep)) continue
    seen.add(dep)
    next.push(dep)
  }
  // The card's own old edges are replaced, not added to, so the loop check runs on a graph without
  // them: keeping a dependency that was already there must not read as a new edge that could close.
  const withoutOwnEdges = items.map((item) => (item.id === itemId ? { ...item, dependsOn: [] } : item))
  for (const dep of next) {
    if (kanbanDependencyWouldCycle(withoutOwnEdges, itemId, dep)) return items
  }
  if (next.length === 0) {
    if (target.dependsOn === undefined) return items
    const { dependsOn: _dropped, ...rest } = target
    return items.map((item) => (item.id === itemId ? rest : item))
  }
  return items.map((item) => (item.id === itemId ? { ...item, dependsOn: next } : item))
}

/**
 * Where one dependency arrow sits on a time view's grid, in the pixels the bars are drawn with.
 * The path leaves the blocker at its right edge — the day it is done — and lands on the dependent's
 * left edge — the day its wait begins — as an elbow that bows out to the right when the two bars
 * overlap; the arrowhead is a separate filled triangle because a stroked marker would scale with
 * the stroke. An end without a bar on this window (an undated card, or one clipped out) draws no
 * arrow rather than one aimed at nothing.
 */
export interface KanbanDependencyLink {
  fromId: string
  toId: string
  /** The stroked elbow, in the rows area's own pixel coordinates. */
  path: string
  /** The filled arrowhead at the dependent's edge, tip first. */
  arrow: string
}

/** Both time views draw their rows at this height (`h-[var(--sp-10)]`); the arrow's y is the row's middle. */
const LINK_ROW_HEIGHT = 40
/** How far the elbow bows past both bar edges when the arrow has to reach backwards. */
const LINK_BOW = 12
const LINK_TIP = 7
const LINK_TIP_HALF = 4.5

/**
 * Every bar on the window, keyed by its card — computed once for the view that draws the bars and
 * the dependency layer that needs their edges. Both used to run this geometry themselves, so a zoom
 * step on a ceiling-size board did the whole scan twice in one commit.
 */
export function kanbanTimelineBarMap(
  items: KanbanItem[],
  range: TimelineRange,
  fields?: TimelineDayFields,
): Map<string, TimelineBarGeometry> {
  const bars = new Map<string, TimelineBarGeometry>()
  for (const item of items) {
    const bar = calculateTimelineBarGeometry(item, range, fields)
    if (bar) bars.set(item.id, bar)
  }
  return bars
}

export function kanbanDependencyLinks(
  items: KanbanItem[],
  range: TimelineRange,
  fields?: TimelineDayFields,
  barsByItem?: ReadonlyMap<string, TimelineBarGeometry>,
): KanbanDependencyLink[] {
  const rowOf = new Map(items.map((item, index) => [item.id, index]))
  const bars = barsByItem ?? kanbanTimelineBarMap(items, range, fields)

  const links: KanbanDependencyLink[] = []
  for (const edge of kanbanDependencyEdges(items)) {
    const fromBar = bars.get(edge.from)
    const toBar = bars.get(edge.to)
    const fromRow = rowOf.get(edge.from)
    const toRow = rowOf.get(edge.to)
    if (!fromBar || !toBar || fromRow === undefined || toRow === undefined) continue
    const x1 = fromBar.left + fromBar.width
    const y1 = fromRow * LINK_ROW_HEIGHT + LINK_ROW_HEIGHT / 2
    const x2 = toBar.left
    const y2 = toRow * LINK_ROW_HEIGHT + LINK_ROW_HEIGHT / 2
    const midX = Math.max(x1, x2) + LINK_BOW
    links.push({
      fromId: edge.from,
      toId: edge.to,
      path: `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`,
      arrow: `M ${x2} ${y2} l ${LINK_TIP} -${LINK_TIP_HALF} v ${LINK_TIP_HALF * 2} Z`,
    })
  }
  return links
}
