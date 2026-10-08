import type { Query } from './query-match'
import { queryMatches } from './query-match'
import type { Tag } from '@shared/types'
import { compareTagNames } from '@shared/markdown-utils'

export const TAG_PATH_SEPARATOR = '/'

export interface TagTreeNode {
  fullPath: string
  name: string
  depth: number
  tag: Tag
  count: number
  totalCount: number
  isVirtual: boolean
  isPinned: boolean
  children: TagTreeNode[]
}

export function buildTagTree(tags: readonly Tag[]): TagTreeNode[] {
  const roots: TagTreeNode[] = []
  const nodes = new Map<string, TagTreeNode>()

  for (const tag of tags) {
    const segments = tag.name.split(TAG_PATH_SEPARATOR).filter(Boolean)
    if (!segments.length) continue
    let path = ''
    let siblings = roots
    for (let depth = 0; depth < segments.length; depth++) {
      const segment = segments[depth]!
      path = depth ? `${path}${TAG_PATH_SEPARATOR}${segment}` : segment
      const isLeaf = depth === segments.length - 1
      let node = nodes.get(path)
      if (!node) {
        node = createNode(path, segment, depth, isLeaf ? tag : null)
        nodes.set(path, node)
        siblings.push(node)
      } else if (isLeaf) {
        node.tag = tag
        node.count = tag.count
        node.isVirtual = false
        node.isPinned = Boolean(tag.isPinned)
      }
      siblings = node.children
    }
  }

  for (const root of roots) rollUpCounts(root)
  roots.sort(compareNodes)
  return roots
}

function createNode(fullPath: string, name: string, depth: number, tag: Tag | null): TagTreeNode {
  return {
    fullPath,
    name,
    depth,
    tag: tag ?? { id: `virtual:${fullPath}`, name: fullPath, color: null, count: 0, createdAt: 0 },
    count: tag?.count ?? 0,
    totalCount: tag?.count ?? 0,
    isVirtual: tag === null,
    isPinned: Boolean(tag?.isPinned),
    children: [],
  }
}

function rollUpCounts(node: TagTreeNode): void {
  let descendants = 0
  for (const child of node.children) {
    rollUpCounts(child)
    descendants += child.totalCount
    if (child.isPinned) node.isPinned = true
  }
  node.totalCount = node.count + descendants
  node.children.sort(compareNodes)
}

function compareNodes(a: TagTreeNode, b: TagTreeNode): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
  return b.totalCount - a.totalCount || compareTagNames(a.name, b.name)
}

export function flattenTagTree(
  nodes: readonly TagTreeNode[],
  expandedPaths: ReadonlySet<string>,
): TagTreeNode[] {
  const out: TagTreeNode[] = []
  const walk = (list: readonly TagTreeNode[]): void => {
    for (const node of list) {
      out.push(node)
      if (node.children.length && expandedPaths.has(node.fullPath)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

export function collectParentPaths(nodes: readonly TagTreeNode[]): string[] {
  const out: string[] = []
  const walk = (list: readonly TagTreeNode[]): void => {
    for (const node of list) {
      if (!node.children.length) continue
      out.push(node.fullPath)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

export interface TagTreeSearch {
  nodes: TagTreeNode[]
  matchedPaths: ReadonlySet<string>
  hitCount: number
}

/**
 * A parent that matches on its own keeps its whole subtree, so `work` still shows `work/meeting`;
 * a parent that only leads to a match is kept unhighlighted so the child stays reachable.
 */
export function searchTagTree(nodes: readonly TagTreeNode[], query: Query): TagTreeSearch {
  const matched = new Set<string>()
  if (!query.text) return { nodes: [...nodes], matchedPaths: matched, hitCount: 0 }

  const visit = (node: TagTreeNode): TagTreeNode | null => {
    const own = queryMatches(query, node.name)
    if (own) {
      matched.add(node.fullPath)
      return { ...node, children: node.children.map(keepAll) }
    }
    const children = node.children
      .map(visit)
      .filter((child): child is TagTreeNode => child !== null)
    return children.length ? { ...node, children } : null
  }

  const result = nodes.map(visit).filter((node): node is TagTreeNode => node !== null)
  return { nodes: result, matchedPaths: matched, hitCount: countRealTags(result) }
}

function countRealTags(nodes: readonly TagTreeNode[]): number {
  let total = 0
  for (const node of nodes) total += (node.isVirtual ? 0 : 1) + countRealTags(node.children)
  return total
}

function keepAll(node: TagTreeNode): TagTreeNode {
  return { ...node, children: node.children.map(keepAll) }
}

/**
 * A tree row edits one segment, so committing it has to re-attach the parent path — sending the
 * bare segment would silently move the tag to the top level.
 */
/**
 * Paths of the siblings sharing `fullPath`'s parent that themselves have children — the rows a
 * "toggle this level" action has to touch.
 */
export function siblingParentPaths(nodes: readonly TagTreeNode[], fullPath: string): string[] {
  const cut = fullPath.lastIndexOf(TAG_PATH_SEPARATOR)
  const parent = cut < 0 ? '' : fullPath.slice(0, cut)
  const siblings = (parent ? findNode(nodes, parent)?.children : nodes) ?? []
  return siblings
    .filter((node) => node.children.length && node.fullPath !== fullPath)
    .map((node) => node.fullPath)
}

function findNode(nodes: readonly TagTreeNode[], fullPath: string): TagTreeNode | null {
  for (const node of nodes) {
    if (node.fullPath === fullPath) return node
    const nested = findNode(node.children, fullPath)
    if (nested) return nested
  }
  return null
}

export function renameTagSegment(fullPath: string, nextSegment: string): string {
  const leaf = nextSegment.trim().replace(/^#+/, '').replace(/^\/+/, '')
  const cut = fullPath.lastIndexOf(TAG_PATH_SEPARATOR)
  if (cut < 0) return leaf
  return leaf ? `${fullPath.slice(0, cut + 1)}${leaf}` : fullPath
}

export function childTagPath(parent: string, name: string): string {
  const leaf = name.trim().replace(/^#+/, '').replace(/^\/+/, '')
  return leaf ? `${parent}${TAG_PATH_SEPARATOR}${leaf}` : parent
}
