/**
 * Keeping a parent's tick in step with its children.
 *
 * A parent with subtasks is done when every subtask is done — that is what the fraction on its row
 * already claims. Ticking the last child therefore ticks the parent, and reopening one child reopens
 * the parent, all the way up. A card with no children is never touched: its tick is the reader's own.
 */
import type { ProjectCard, ProjectProperty } from './model'
import { isProjectCardDone, projectDonePatch } from './model'

export interface ParentDonePatch {
  id: string
  values: Record<string, string | null>
}

/**
 * The ancestor writes a child's new state implies, nearest parent first.
 *
 * `cards` is the board as it will read after the child's own write, so the caller passes the child
 * with its new values already applied. Each ancestor is judged against the state the walk has just
 * decided for its own children, which is what makes a three-level tree settle in one pass.
 */
export function projectParentDonePatches(
  cards: readonly ProjectCard[],
  properties: readonly ProjectProperty[],
  changedCardId: string,
): ParentDonePatch[] {
  const patch = projectDonePatch(properties, true)
  if (!patch) return []
  const byId = new Map(cards.map((card) => [card.id, card]))
  const childrenOf = new Map<string, ProjectCard[]>()
  for (const card of cards) {
    if (!card.parentId) continue
    const list = childrenOf.get(card.parentId)
    if (list) list.push(card)
    else childrenOf.set(card.parentId, [card])
  }
  const decided = new Map<string, boolean>()
  const doneOf = (card: ProjectCard): boolean => decided.get(card.id) ?? isProjectCardDone(card, properties)
  const out: ParentDonePatch[] = []
  const seen = new Set<string>([changedCardId])
  let current = byId.get(changedCardId)
  while (current?.parentId) {
    const parent = byId.get(current.parentId)
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    const children = childrenOf.get(parent.id) ?? []
    if (children.length === 0) break
    const want = children.every(doneOf)
    decided.set(parent.id, want)
    if (want !== isProjectCardDone(parent, properties)) {
      const values = projectDonePatch(properties, want)
      if (values) out.push({ id: parent.id, values })
    }
    current = parent
  }
  return out
}
