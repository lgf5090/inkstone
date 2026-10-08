import { fuzzyMatch } from './fuzzy'

/**
 * What a folder query leaves of the tree.
 *
 * `nodes` is the tree to draw and `shown` how many folders are in it, so the count the panel
 * prints is the number of rows the reader can actually see — the same rule the tag filter
 * follows. `matched` is the narrower set: the folders the query itself hit, which is what
 * gets underlined. The two differ because a parent that only leads to a match has to stay on
 * screen for the child to be reachable.
 */
export interface FolderSearch<T> {
  nodes: T[]
  matched: ReadonlySet<string>
  shown: number
}

interface Filterable {
  id: string
  name: string
}

/**
 * The folder tree pruned to what the query can reach, matched by folder name only.
 *
 * A folder the query hits keeps its whole subtree, so searching `work` still shows
 * `work/meeting`; a folder that merely leads to a match is kept unmarked, at the depth the
 * reader knows it at. An empty query returns the tree as it came.
 */
export function searchFolders<T extends Filterable & { children: readonly T[] }>(nodes: readonly T[], query: string): FolderSearch<T> {
  const matched = new Set<string>()
  const needle = query.trim()
  if (!needle)
    return { nodes: [...nodes], matched, shown: countFolders(nodes) }
  const visit = (node: T): T | null => {
    if (fuzzyMatch(node.name, needle)) {
      matched.add(node.id)
      return node
    }
    const children = node.children
      .map(visit)
      .filter((child): child is T => child !== null)
    return children.length ? { ...node, children } : null
  }
  const kept = nodes.map(visit).filter((node): node is T => node !== null)
  return { nodes: kept, matched, shown: countFolders(kept) }
}

function countFolders<T extends { children: readonly T[] }>(nodes: readonly T[]): number {
  let total = 0
  for (const node of nodes) total += 1 + countFolders(node.children)
  return total
}
