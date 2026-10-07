/**
 * The archive: cards a board has finished with but must not lose. An archived card leaves every
 * view, every count and every still snapshot, and comes back only through restore — deletion, by
 * contrast, is the operation the archive exists to keep people away from.
 */
import type { KanbanItem } from './types'

/** Only a literal `true` archives a card: whatever else an author wrote is noise, not an archive. */
export function kanbanIsArchived(item: KanbanItem): boolean {
  return item.archived === true
}

/** Deletion is a second flag, not a removal: a deleted card stays in the document until it is
 *  purged for good, which is what makes the deleted list recoverable the way the archive is. */
export function kanbanIsDeleted(item: KanbanItem): boolean {
  return item.deleted === true
}

/** What every view, count, snapshot and export draws: neither filed away nor deleted. */
export function kanbanActiveItems(items: KanbanItem[]): KanbanItem[] {
  return items.filter((item) => !kanbanIsArchived(item) && !kanbanIsDeleted(item))
}

export function kanbanArchivedItems(items: KanbanItem[]): KanbanItem[] {
  return items.filter((item) => kanbanIsArchived(item) && !kanbanIsDeleted(item))
}

export function kanbanDeletedItems(items: KanbanItem[]): KanbanItem[] {
  return items.filter(kanbanIsDeleted)
}

/**
 * Archive or restore the cards named by `ids`; ids the document does not hold are ignored. A batch
 * that changes nothing returns the very same array, so a writer can commit zero steps of undo
 * instead of a rewrite that looks like an edit.
 */
export function kanbanSetArchived(
  items: KanbanItem[],
  ids: Iterable<string>,
  archived: boolean,
): KanbanItem[] {
  const wanted = new Set(ids)
  if (wanted.size === 0) return items
  let changed = false
  const next = items.map((item) => {
    if (!wanted.has(item.id) || kanbanIsArchived(item) === archived) return item
    changed = true
    if (!archived) {
      const restored: KanbanItem = { ...item }
      delete restored.archived
      return restored
    }
    return { ...item, archived: true }
  })
  return changed ? next : items
}

/** The deletion twin of `kanbanSetArchived`: one flag, one idempotent batch, zero-cost no-ops.
 *  Restoring puts the card back on the board — the deleted list is reached from the archive shelf
 *  too, and "restore" that only moved the card one shelf over would read as doing nothing. */
export function kanbanSetDeleted(
  items: KanbanItem[],
  ids: Iterable<string>,
  deleted: boolean,
): KanbanItem[] {
  const wanted = new Set(ids)
  if (wanted.size === 0) return items
  let changed = false
  const next = items.map((item) => {
    if (!wanted.has(item.id) || kanbanIsDeleted(item) === deleted) return item
    changed = true
    if (!deleted) {
      const restored: KanbanItem = { ...item }
      delete restored.deleted
      delete restored.archived
      return restored
    }
    return { ...item, deleted: true }
  })
  return changed ? next : items
}

/**
 * The irreversible half: deleted cards named by `ids` leave the document for good — every deleted
 * one when `ids` is left out. Cards that are not deleted are not the purge's to touch, so a purge
 * whose ids name live cards returns the very same array, the way a no-op archive batch does.
 */
export function kanbanPurgeDeleted(items: KanbanItem[], ids?: Iterable<string>): KanbanItem[] {
  const wanted = ids === undefined ? undefined : new Set(ids)
  const next = items.filter((item) => {
    if (!kanbanIsDeleted(item)) return true
    if (wanted === undefined) return false
    return !wanted.has(item.id)
  })
  return next.length === items.length ? items : next
}
