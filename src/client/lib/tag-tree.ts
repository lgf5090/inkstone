import { fuzzyMatch } from './fuzzy'
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
    children: [],
  }
}

function rollUpCounts(node: TagTreeNode): void {
  let descendants = 0
  for (const child of node.children) {
    rollUpCounts(child)
    descendants += child.totalCount
  }
  node.totalCount = node.count + descendants
  node.children.sort(compareNodes)
}

function compareNodes(a: TagTreeNode, b: TagTreeNode): number {
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
export function searchTagTree(nodes: readonly TagTreeNode[], query: string): TagTreeSearch {
  const matched = new Set<string>()
  if (!query.trim()) return { nodes: [...nodes], matchedPaths: matched, hitCount: 0 }

  const visit = (node: TagTreeNode): TagTreeNode | null => {
    const own = fuzzyMatch(node.name, query)
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
