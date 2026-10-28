import type { CollectionNode, TagNode } from '@shared/development/api-tester/types'
import { newApiTesterId } from '@shared/development/api-tester/ids'
import { MAX_TREE_DEPTH } from '@shared/development/api-tester/limits'

export function childrenOf(nodes: readonly CollectionNode[], parentId: string | null): CollectionNode[] {
  return nodes.filter((node) => node.parentId === parentId).sort((left, right) => left.order - right.order)
}

export function ancestorIds(nodes: readonly CollectionNode[], id: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const out: string[] = []
  let current = byId.get(id)
  const seen = new Set<string>()
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId)
    out.push(current.parentId)
    current = byId.get(current.parentId)
  }
  return out
}

export function subtreeIds(nodes: readonly CollectionNode[], id: string): Set<string> {
  const children = new Map<string | null, CollectionNode[]>()
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? []
    list.push(node)
    children.set(node.parentId, list)
  }
  const out = new Set<string>([id])
  const stack = [id]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const child of children.get(current) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id)
        stack.push(child.id)
      }
    }
  }
  return out
}

export function depthOf(nodes: readonly CollectionNode[], id: string): number {
  return ancestorIds(nodes, id).length
}

export function canMove(nodes: readonly CollectionNode[], id: string, parentId: string | null): boolean {
  if (!parentId) return true
  if (parentId === id) return false
  if (subtreeIds(nodes, id).has(parentId)) return false
  const targetDepth = depthOf(nodes, parentId) + 1
  const moving = subtreeIds(nodes, id)
  let deepest = 0
  for (const nodeId of moving) deepest = Math.max(deepest, depthOf(nodes, nodeId) - depthOf(nodes, id))
  return targetDepth + deepest <= MAX_TREE_DEPTH
}

export function duplicateSubtree(nodes: readonly CollectionNode[], id: string, suffix: string): CollectionNode[] {
  const root = nodes.find((node) => node.id === id)
  if (!root) return []
  const idMap = new Map<string, string>()
  const copies: CollectionNode[] = []
  const walk = (node: CollectionNode, isRoot: boolean) => {
    const copy: CollectionNode = {
      ...node,
      id: newApiTesterId(),
      name: isRoot ? `${node.name} ${suffix}` : node.name,
      parentId: isRoot ? node.parentId : (idMap.get(node.parentId ?? '') ?? node.parentId),
      order: Date.now(),
      updatedAt: Date.now(),
    }
    idMap.set(node.id, copy.id)
    copies.push(copy)
    for (const child of childrenOf(nodes, node.id)) walk(child, false)
  }
  walk(root, true)
  return copies
}

export function reordered(nodes: readonly CollectionNode[], parentId: string | null, orderedIds: readonly string[]): CollectionNode[] {
  const order = new Map(orderedIds.map((id, index) => [id, index + 1]))
  return nodes.map((node) =>
    node.parentId === parentId && order.has(node.id) ? { ...node, order: order.get(node.id)!, updatedAt: Date.now() } : node,
  )
}

export function collectionMatches(nodes: readonly CollectionNode[], query: string): Set<string> {
  if (!query.trim()) return new Set()
  const needle = query.toLowerCase()
  const matched = new Set<string>()
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    const haystack = `${node.name} ${node.request?.url ?? node.ws?.url ?? ''} ${node.request?.method ?? ''}`.toLowerCase()
    if (!haystack.includes(needle)) continue
    matched.add(node.id)
    let current = node
    while (current.parentId) {
      matched.add(current.parentId)
      const parent = byId.get(current.parentId)
      if (!parent) break
      current = parent
    }
  }
  return matched
}

export function filterByTag(
  nodes: readonly CollectionNode[],
  tagId: string,
): { visibleNodes: CollectionNode[]; autoExpandIds: Set<string> } {
  const matched = nodes.filter((node) => node.tags.includes(tagId))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const keep = new Set<string>()
  const expand = new Set<string>()
  for (const node of matched) {
    keep.add(node.id)
    let current = node
    while (current.parentId) {
      keep.add(current.parentId)
      expand.add(current.parentId)
      const parent = byId.get(current.parentId)
      if (!parent) break
      current = parent
    }
  }
  return { visibleNodes: nodes.filter((node) => keep.has(node.id)), autoExpandIds: expand }
}

export function tagDescendantIds(tags: readonly TagNode[], id: string): Set<string> {
  const out = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const tag of tags) {
      if (tag.parentId && out.has(tag.parentId) && !out.has(tag.id)) {
        out.add(tag.id)
        changed = true
      }
    }
  }
  return out
}

export function tagCounts(tags: readonly TagNode[], nodes: readonly CollectionNode[]): Map<string, number> {
  const direct = new Map<string, number>(tags.map((tag) => [tag.id, 0]))
  for (const node of nodes) {
    for (const tagId of node.tags) direct.set(tagId, (direct.get(tagId) ?? 0) + 1)
  }
  const children = new Map<string, string[]>()
  for (const tag of tags) {
    if (!tag.parentId) continue
    const list = children.get(tag.parentId) ?? []
    list.push(tag.id)
    children.set(tag.parentId, list)
  }
  const totals = new Map<string, number>()
  const sum = (id: string): number => {
    const total = (direct.get(id) ?? 0) + (children.get(id) ?? []).reduce((value, child) => value + sum(child), 0)
    totals.set(id, total)
    return total
  }
  for (const tag of tags) {
    if (!tag.parentId || !tags.some((entry) => entry.id === tag.parentId)) sum(tag.id)
  }
  for (const tag of tags) if (!totals.has(tag.id)) sum(tag.id)
  return totals
}

export function buildTagTree(tags: readonly TagNode[]): Array<TagNode & { children: Array<TagNode & { children: unknown[] }> }> {
  type Node = TagNode & { children: Node[] }
  const byId = new Map<string, Node>(tags.map((tag) => [tag.id, { ...tag, children: [] }]))
  const roots: Node[] = []
  for (const tag of byId.values()) {
    if (tag.parentId && byId.has(tag.parentId)) byId.get(tag.parentId)!.children.push(tag)
    else roots.push(tag)
  }
  const sort = (list: Node[]) => {
    list.sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt)
    for (const node of list) sort(node.children)
  }
  sort(roots)
  return roots
}
