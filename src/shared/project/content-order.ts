/**
 * A card's reading order. It interleaves content-block ids with comment ids, and a nested array
 * threads comments under one block — an order the per-row position column cannot express, so the
 * card carries it (DV-12). These helpers keep that array honest as blocks and comments come and go:
 * append on create, scrub on delete (including inside threads), and splice on move.
 */
export type ProjectContentOrder = (string | string[])[]

export function appendContentOrder(order: ProjectContentOrder, id: string): ProjectContentOrder {
  if (order.some((entry) => entry === id)) return order
  return [...order, id]
}

export function removeContentOrder(order: ProjectContentOrder, id: string): ProjectContentOrder {
  const result: ProjectContentOrder = []
  for (const entry of order) {
    if (typeof entry === 'string') {
      if (entry !== id) result.push(entry)
    } else {
      const thread = entry.filter((member) => member !== id)
      // An emptied thread carries no reading order, so it drops out rather than lingering as [].
      if (thread.length > 0) result.push(thread)
    }
  }
  return result
}

/**
 * Move a top-level block before or after another. The id is lifted out first so moving onto its own
 * neighbour cannot duplicate it; a target that is not a top-level entry leaves the block at the end,
 * which is the safe reading of an ambiguous destination rather than a silent drop.
 */
export function moveContentOrder(
  order: ProjectContentOrder,
  id: string,
  targetId: string,
  where: 'before' | 'after',
): ProjectContentOrder {
  const without = removeContentOrder(order, id)
  const index = without.findIndex((entry) => entry === targetId)
  if (index === -1) return [...without, id]
  const at = where === 'before' ? index : index + 1
  return [...without.slice(0, at), id, ...without.slice(at)]
}