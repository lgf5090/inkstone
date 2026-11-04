/**
 * Two directory manifests compared by path and content hash.
 *
 * The browser cannot read a whole tree server-side, so each side is reduced to a manifest of
 * `path → size + sha256` while the reader picks the folder. Comparing those is exact for "same" and
 * "different", cheap enough for thousands of entries, and small enough to store as one JSON file.
 */
import type {
  DirCompareResult,
  DirCompareRow,
  DirEntry,
  DirManifest,
  DirStatus,
  DirTreeNode,
} from './types'

/** Normalises a manifest path so `a//b` and `a/b` can never read as two different files. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

function entryMap(manifest: DirManifest): Map<string, DirEntry> {
  const map = new Map<string, DirEntry>()
  for (const entry of manifest.entries) {
    const path = normalizePath(entry.path)
    if (!path) continue
    map.set(path, { ...entry, path })
  }
  return map
}

/** Every path either side has, with the bucket it belongs to. */
export function compareDirectories(left: DirManifest, right: DirManifest): DirCompareResult {
  const leftMap = entryMap(left)
  const rightMap = entryMap(right)
  const paths = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort((a, b) => a.localeCompare(b))

  const rows: DirCompareRow[] = []
  const counts = { same: 0, different: 0, leftOnly: 0, rightOnly: 0 }

  for (const path of paths) {
    const leftEntry = leftMap.get(path) ?? null
    const rightEntry = rightMap.get(path) ?? null
    let status: DirStatus
    if (leftEntry && rightEntry) {
      status = leftEntry.sha256 === rightEntry.sha256 && leftEntry.size === rightEntry.size
        ? 'same'
        : 'different'
    } else if (leftEntry) {
      status = 'left_only'
    } else {
      status = 'right_only'
    }
    if (status === 'same') counts.same++
    else if (status === 'different') counts.different++
    else if (status === 'left_only') counts.leftOnly++
    else counts.rightOnly++
    rows.push({ path, status, left: leftEntry, right: rightEntry })
  }

  return { rows, tree: buildTree(rows), counts }
}

function emptyCounts(): DirTreeNode['counts'] {
  return { same: 0, different: 0, leftOnly: 0, rightOnly: 0 }
}

function bump(counts: DirTreeNode['counts'], status: DirStatus): void {
  if (status === 'same') counts.same++
  else if (status === 'different') counts.different++
  else if (status === 'left_only') counts.leftOnly++
  else counts.rightOnly++
}

/** The union of both trees, so a folder expands to show what either side holds under it. */
export function buildTree(rows: readonly DirCompareRow[]): DirTreeNode[] {
  const root: DirTreeNode = { name: '', path: '', depth: 0, status: 'same', isFile: false, children: [], counts: emptyCounts() }
  const directories = new Map<string, DirTreeNode>([['', root]])

  const ensureDirectory = (path: string): DirTreeNode => {
    const existing = directories.get(path)
    if (existing) return existing
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const parent = ensureDirectory(parentPath)
    const node: DirTreeNode = {
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      depth: parent.depth + 1,
      status: 'same',
      isFile: false,
      children: [],
      counts: emptyCounts(),
    }
    parent.children.push(node)
    directories.set(path, node)
    return node
  }

  for (const row of rows) {
    const parentPath = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : ''
    const parent = ensureDirectory(parentPath)
    parent.children.push({
      name: row.path.slice(row.path.lastIndexOf('/') + 1),
      path: row.path,
      depth: parent.depth + 1,
      status: row.status,
      isFile: true,
      children: [],
      counts: emptyCounts(),
    })
  }

  const finish = (node: DirTreeNode): void => {
    for (const child of node.children) {
      if (!child.isFile) finish(child)
      else bump(node.counts, child.status)
      if (child.isFile) continue
      node.counts.same += child.counts.same
      node.counts.different += child.counts.different
      node.counts.leftOnly += child.counts.leftOnly
      node.counts.rightOnly += child.counts.rightOnly
    }
    if (node.isFile) return
    const differs = node.counts.different + node.counts.leftOnly + node.counts.rightOnly
    node.status = differs === 0 ? 'same' : 'different'
    node.children.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
      return a.name.localeCompare(b.name)
    })
  }
  finish(root)
  return root.children
}
