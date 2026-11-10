/**
 * What a drop on the category tree means.
 *
 * The tree is drawn from slash-separated names, so "nest under" is a rename of the dragged category
 * and everything below it, while "place beside" is a reorder. Both are decided here rather than in
 * the component because the two failure modes are silent: a target that is not a real category used
 * to splice at -1 and land the row second-from-last, and a nest that forgot the descendants left them
 * pointing at a path that no longer exists.
 */
import type { ProjectCategory } from '@shared/project/model'

export type CategoryDropZone = 'before' | 'inside' | 'after'

/** The third of the row the pointer is in: the middle nests, the edges place beside. */
export function categoryDropZone(offsetY: number, height: number): CategoryDropZone {
  if (!(height > 0)) return 'inside'
  const ratio = offsetY / height
  if (ratio < 0.25) return 'before'
  if (ratio > 0.75) return 'after'
  return 'inside'
}

export type CategoryDropPlan =
  | { kind: 'reorder', ids: string[] }
  | { kind: 'nest', renames: { id: string, name: string }[] }

/**
 * The writes a drop needs, or null when it means nothing.
 *
 * A synthetic group node has no id in `categories`, so it is refused outright rather than treated as
 * a position. Nesting under one's own descendant would detach a whole subtree from the tree, so that
 * is refused too.
 */
export function planCategoryDrop(
  categories: readonly ProjectCategory[],
  sourceId: string,
  targetId: string,
  zone: CategoryDropZone,
): CategoryDropPlan | null {
  const source = categories.find((entry) => entry.id === sourceId)
  const target = categories.find((entry) => entry.id === targetId)
  if (!source || !target || source.id === target.id) return null
  if (source.type === 'system' || target.type === 'system') return null

  if (zone === 'inside') {
    if (target.name === source.name || target.name.startsWith(`${source.name}/`)) return null
    const leaf = source.name.split('/').filter(Boolean).pop() ?? source.name
    const nextName = `${target.name}/${leaf}`
    if (nextName === source.name) return null
    const renames = [{ id: source.id, name: nextName }]
    for (const entry of categories) {
      if (entry.type === 'system' || !entry.name.startsWith(`${source.name}/`)) continue
      renames.push({ id: entry.id, name: `${nextName}/${entry.name.slice(source.name.length + 1)}` })
    }
    return { kind: 'nest', renames }
  }

  const ids = categories.map((entry) => entry.id).filter((id) => id !== sourceId)
  const at = ids.indexOf(targetId)
  ids.splice(zone === 'before' ? at : at + 1, 0, sourceId)
  return { kind: 'reorder', ids }
}