import type { Query } from './query-match'
import { queryMatches } from './query-match'

/**
 * What a filter query leaves of the tree.
 *
 * `nodes` is the tree to draw and `shown` how many folders are in it, so the count the panel prints
 * is the number of rows the reader can actually see — the same rule the tag filter follows. `matched`
 * is the narrower set: the folders the query itself hit by name, which is what gets underlined. The
 * two differ because a parent that only leads to a match has to stay on screen for the child to be
 * reachable.
 *
 * `whole` holds the folders that show every note they own rather than only the notes the query
 * reached: a folder named by the query is what the reader asked for, so its contents come with it,
 * and so do the contents of everything below it. `notes` is the set of note titles the query hit,
 * which is what a folder kept only as the road to a note draws.
 */
export interface FolderSearch<T> {
  nodes: T[]
  matched: ReadonlySet<string>
  whole: ReadonlySet<string>
  notes: ReadonlySet<string>
  shown: number
  noteShown: number
}

interface Filterable {
  id: string
  name: string
}

interface Filed {
  id: string
  title: string
}

/**
 * The folder tree pruned to what the query can reach, by folder name and by the titles of the notes
 * filed inside it.
 *
 * A folder the query names keeps its whole subtree and every note in it, so searching `work` still
 * shows `work/meeting` and what that holds. A folder the query only reaches through one of its notes
 * is kept for that note: it stays at the depth the reader knows it at, unmarked, and shows nothing
 * else. An empty query returns the tree as it came.
 */
export function searchFolders<T extends Filterable & { children: readonly T[] }>(
  nodes: readonly T[],
  query: Query,
  notesOf: (folderId: string) => readonly Filed[],
): FolderSearch<T> {
  const matched = new Set<string>()
  const whole = new Set<string>()
  const notes = new Set<string>()
  if (!query.text) return { nodes: [...nodes], matched, whole, notes, shown: countFolders(nodes), noteShown: 0 }

  let noteShown = 0
  const takeWhole = (node: T): T => {
    whole.add(node.id)
    noteShown += notesOf(node.id).length
    return { ...node, children: node.children.map(takeWhole) }
  }
  const visit = (node: T): T | null => {
    if (queryMatches(query, node.name)) {
      matched.add(node.id)
      return takeWhole(node)
    }
    const children = node.children
      .map(visit)
      .filter((child): child is T => child !== null)
    let holdsMatch = false
    for (const note of notesOf(node.id)) {
      if (!queryMatches(query, note.title)) continue
      notes.add(note.id)
      noteShown += 1
      holdsMatch = true
    }
    return children.length || holdsMatch ? { ...node, children } : null
  }
  const kept = nodes.map(visit).filter((node): node is T => node !== null)
  return { nodes: kept, matched, whole, notes, shown: countFolders(kept), noteShown }
}

function countFolders<T extends { children: readonly T[] }>(nodes: readonly T[]): number {
  let total = 0
  for (const node of nodes) total += 1 + countFolders(node.children)
  return total
}
