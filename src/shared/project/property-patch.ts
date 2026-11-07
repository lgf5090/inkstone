import type { ProjectProperty } from './model'

/**
 * The reference's cardProperties patch, step for step (board.go Patch): a whole-object replacement
 * matched by id, where a never-seen id is appended rather than inserted, and a deletion leaves the
 * survivors in their original relative order. Entries without a string id are skipped, not rejected.
 *
 * One guard the reference lacks: a deleted id leaves the order list immediately, so an id both deleted
 * and re-added in the same patch lands at the end exactly once. The reference keeps the deleted id in
 * the order list and would emit it twice; here a property id is a primary key, so a duplicate cannot be
 * stored and the order list must not name it twice.
 */
export function applyProjectPropertyPatch(
  current: readonly ProjectProperty[],
  updated: readonly ProjectProperty[],
  deleted: readonly string[],
): ProjectProperty[] {
  if (updated.length === 0 && deleted.length === 0) return [...current]
  const byId = new Map<string, ProjectProperty>()
  let keyOrder: string[] = []
  for (const property of current) {
    if (typeof property.id !== 'string') continue
    if (!byId.has(property.id)) keyOrder.push(property.id)
    byId.set(property.id, property)
  }
  const deletedIds = new Set(deleted)
  keyOrder = keyOrder.filter((id) => !deletedIds.has(id))
  for (const id of deletedIds) byId.delete(id)
  for (const property of updated) {
    if (typeof property.id !== 'string') continue
    if (!byId.has(property.id) && !keyOrder.includes(property.id)) keyOrder.push(property.id)
    byId.set(property.id, property)
  }
  const result: ProjectProperty[] = []
  for (const id of keyOrder) {
    const property = byId.get(id)
    if (property) result.push(property)
  }
  return result
}