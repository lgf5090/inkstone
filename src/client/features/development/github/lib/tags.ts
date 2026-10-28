export interface TagLike {
  id: string
  name: string
  color: string
  parentId: string | null
  sortOrder: number
  createdAt: number
}

export type TagTreeNode<T extends TagLike = TagLike> = T & { children: TagTreeNode<T>[] }

const MAX_TAG_DEPTH = 10

function createsCycle(tagsById: ReadonlyMap<string, TagLike>, tag: TagLike): boolean {
  const seen = new Set<string>([tag.id])
  let cursor = tag.parentId
  while (cursor) {
    if (seen.has(cursor)) return true
    seen.add(cursor)
    const parent = tagsById.get(cursor)
    if (!parent) return false
    cursor = parent.parentId
  }
  return false
}

export function buildTagTree<T extends TagLike>(tags: readonly T[]): TagTreeNode<T>[] {
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]))
  const nodesById = new Map<string, TagTreeNode<T>>()
  for (const tag of tags) nodesById.set(tag.id, { ...tag, children: [] })

  const roots: TagTreeNode<T>[] = []
  for (const tag of tags) {
    const node = nodesById.get(tag.id)!
    const parentId = tag.parentId
    if (!parentId || parentId === tag.id || !tagsById.has(parentId) || createsCycle(tagsById, tag)) {
      roots.push(node)
      continue
    }
    nodesById.get(parentId)!.children.push(node)
  }

  const sortLevel = (level: TagTreeNode<T>[]) => {
    level.sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt)
    for (const node of level) sortLevel(node.children)
  }
  sortLevel(roots)
  return roots
}

export function collectTagDescendants<T extends TagLike>(tags: readonly T[], rootId: string): string[] {
  const children = new Map<string, string[]>()
  for (const tag of tags) {
    if (!tag.parentId) continue
    const list = children.get(tag.parentId)
    if (list) list.push(tag.id)
    else children.set(tag.parentId, [tag.id])
  }
  const collected = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const child of children.get(current) ?? []) {
      if (collected.has(child)) continue
      collected.add(child)
      queue.push(child)
    }
  }
  return Array.from(collected)
}

export function tagDepth<T extends TagLike>(tags: readonly T[], tag: T): number {
  const tagsById = new Map(tags.map((entry) => [entry.id, entry]))
  const seen = new Set<string>()
  let depth = 0
  let current: T | undefined = tag
  while (current?.parentId && !seen.has(current.id) && depth < MAX_TAG_DEPTH) {
    seen.add(current.id)
    const parent = tagsById.get(current.parentId)
    if (!parent) break
    current = parent
    depth += 1
  }
  return depth
}

export function tagCounts<T extends TagLike>(
  tags: readonly T[],
  items: readonly { tagIds: readonly string[] }[],
): Map<string, number> {
  const counts = new Map<string, number>(tags.map((tag) => [tag.id, 0]))
  for (const item of items) {
    for (const tagId of item.tagIds) {
      const current = counts.get(tagId)
      if (current !== undefined) counts.set(tagId, current + 1)
    }
  }
  return counts
}
