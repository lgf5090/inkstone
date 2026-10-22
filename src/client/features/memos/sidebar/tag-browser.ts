import { compareTagNames } from '@shared/markdown-utils'
import type { Tag } from '@shared/types'
import { buildTagTree, type TagTreeNode } from '../../../lib/tag-tree'

export const MEMO_TAG_BROWSER_STORAGE_KEY = 'inkstone.memos.tags'

export type MemoTagViewMode = 'tree' | 'flat'

export interface MemoTagBrowserPrefs {
  mode: MemoTagViewMode
  expanded: string[]
}

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function defaultPrefs(): MemoTagBrowserPrefs {
  return { mode: 'tree', expanded: [] }
}

function tagViewMode(value: unknown): MemoTagViewMode {
  return value === 'flat' ? 'flat' : 'tree'
}

export function loadMemoTagBrowserPrefs(storage: Storage | null = readStorage()): MemoTagBrowserPrefs {
  if (!storage) return defaultPrefs()
  try {
    const raw = storage.getItem(MEMO_TAG_BROWSER_STORAGE_KEY)
    if (!raw) return defaultPrefs()
    const parsed = JSON.parse(raw) as Partial<MemoTagBrowserPrefs> | null
    if (parsed === null || typeof parsed !== 'object') return defaultPrefs()
    return {
      mode: tagViewMode(parsed.mode),
      expanded: Array.isArray(parsed.expanded)
        ? parsed.expanded.filter((path): path is string => typeof path === 'string' && path.trim() !== '')
        : [],
    }
  } catch (error) {
    console.warn('[inkstone] Ignoring unreadable memo tag preferences', error)
    return defaultPrefs()
  }
}

export function saveMemoTagBrowserPrefs(
  prefs: MemoTagBrowserPrefs,
  storage: Storage | null = readStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(MEMO_TAG_BROWSER_STORAGE_KEY, JSON.stringify(prefs))
  } catch (error) {
    console.warn('[inkstone] Memo tag preferences could not be saved', error)
  }
}

export function buildMemoTagTree(counts: Readonly<Record<string, number>>): TagTreeNode[] {
  const tags: Tag[] = []
  let createdAt = 0
  for (const [rawName, rawCount] of Object.entries(counts)) {
    const name = rawName.trim()
    const count = Number(rawCount)
    if (!name || !Number.isFinite(count) || count <= 0) continue
    tags.push({ id: `memo-tag:${name}`, name, color: null, count, createdAt })
    createdAt += 1
  }
  return buildTagTree(tags)
}

export function flatMemoTagRows(tree: readonly TagTreeNode[]): TagTreeNode[] {
  const rows: TagTreeNode[] = []
  const walk = (nodes: readonly TagTreeNode[]): void => {
    for (const node of nodes) {
      if (!node.isVirtual) rows.push(node)
      walk(node.children)
    }
  }
  walk(tree)
  return rows.sort((left, right) => compareTagNames(left.fullPath, right.fullPath))
}

export function ancestorTagPaths(fullPath: string): string[] {
  const segments = fullPath.split('/').filter(Boolean)
  const paths: string[] = []
  let prefix = ''
  for (const segment of segments.slice(0, -1)) {
    prefix = prefix ? `${prefix}/${segment}` : segment
    paths.push(prefix)
  }
  return paths
}
