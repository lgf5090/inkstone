import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { shareMatchesSelection, type ShareTarget } from '@shared/share-selection'
import type { ShareCategory, ShareFolder, ShareGlobalStats, ShareTag } from '@shared/share-hub'
import type { ShareListItem } from '@shared/types'
import { shareHubApi } from '../../../lib/api-share-hub'

/**
 * The hub's own state, held once and handed down.
 *
 * Deliberately a hook and not an app store: every number the hub shows belongs to the hub, and a
 * slice of the global store would be a second place the sidebar's counts live — with the workspace
 * header's share badge then free to disagree with the panel it opens.
 *
 * The rows are fetched once and filtered here rather than re-queried per click, because the ten
 * categories, the folders and the tags are all views over the same set. The rule that decides which
 * view a row belongs to is `shareMatchesSelection`, the very predicate the server's SQL is generated
 * from, so the sidebar's count and the list it labels cannot come to disagree.
 */

export type ShareViewMode = 'table' | 'grid'

export type ShareSortKey = 'newest' | 'oldest' | 'views' | 'title'

/** The sort orders the toolbar offers, in the order it lists them. */
export const SHARE_SORT_KEYS: readonly ShareSortKey[] = ['newest', 'oldest', 'views', 'title']

export interface ShareHubState {
  category: ShareCategory
  folderId: string | null
  tagName: string | null
  search: string
  sort: ShareSortKey
  view: ShareViewMode
  selected: ReadonlySet<string>
}

export interface ShareHub extends ShareHubState {
  loading: boolean
  /** True only when nothing arrived at all; a partial failure keeps the rows it did produce. */
  failed: boolean
  shares: ShareListItem[]
  /** The rows the current category, filing and search select, in the chosen order. */
  visible: ShareListItem[]
  stats: ShareGlobalStats | null
  folders: ShareFolder[]
  tags: ShareTag[]
  /** How many of `visible` the user has selected — the batch bar's own count. */
  selectedVisible: number
  selectCategory: (category: ShareCategory) => void
  selectFolder: (folderId: string | null) => void
  selectTag: (tagName: string | null) => void
  setSearch: (search: string) => void
  setSort: (sort: ShareSortKey) => void
  setView: (view: ShareViewMode) => void
  toggle: (noteId: string) => void
  /** The header checkbox: fills the selection with this view, or empties it when the view is already full. */
  toggleAllVisible: () => void
  clearSelection: () => void
  /** Refetches rows and counters together; the batch actions call it once they have written. */
  refresh: () => void
}

export function useShareHub(open: boolean, initialView: ShareViewMode = 'table'): ShareHub {
  const [state, setState] = useState<ShareHubState>({
    category: 'dashboard',
    folderId: null,
    tagName: null,
    search: '',
    sort: 'newest',
    view: initialView,
    selected: new Set<string>(),
  })
  const [rows, setRows] = useState<ShareListItem[] | null>(null)
  const [stats, setStats] = useState<ShareGlobalStats | null>(null)
  const [folders, setFolders] = useState<ShareFolder[]>([])
  const [tags, setTags] = useState<ShareTag[]>([])
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // Each open or refresh owns an epoch. A response is only allowed to land if nothing newer has been
  // asked for since it started, which is what stops a slow first page from overwriting a category
  // the user already moved past.
  const epoch = useRef(0)

  useEffect(() => {
    if (!open) return
    const mine = ++epoch.current
    const controller = new AbortController()
    let cancelled = false

    const settle = <T,>(setter: (value: T) => void) => (value: T) => {
      if (!cancelled && epoch.current === mine) setter(value)
    }

    // One combined failure is reported only when the list itself is unreachable: the counters, the
    // folder tree and the tag list each degrade to "not shown", and a hub that refused to open
    // because a tag call timed out would be worse than one that opened without them.
    void Promise.allSettled([
      shareHubApi.list(controller.signal).then((res) => settle(setRows)(res.shares)),
      shareHubApi.stats(controller.signal).then((res) => settle(setStats)(res.globalStats)),
      shareHubApi.folders.list(controller.signal).then((res) => settle(setFolders)(res.folders)),
      shareHubApi.tags.list(controller.signal).then((res) => settle(setTags)(res.tags)),
    ]).then((results) => {
      if (cancelled || epoch.current !== mine) return
      setFailed(results[0].status === 'rejected')
      if (results[0].status === 'rejected') setRows([])
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [open, attempt])

  const patch = useCallback((next: Partial<ShareHubState>) => {
    setState((current) => ({ ...current, ...next }))
  }, [])

  /** A category and a filing are one choice: picking either clears the other. */
  const selectCategory = useCallback((category: ShareCategory) => {
    setState((current) => ({ ...current, category, folderId: null, tagName: null, selected: EMPTY }))
  }, [])
  const selectFolder = useCallback((folderId: string | null) => {
    setState((current) => ({
      ...current,
      folderId,
      tagName: null,
      category: 'all',
      selected: EMPTY,
    }))
  }, [])
  const selectTag = useCallback((tagName: string | null) => {
    setState((current) => ({
      ...current,
      tagName,
      folderId: null,
      category: 'all',
      selected: EMPTY,
    }))
  }, [])

  const toggle = useCallback((noteId: string) => {
    setState((current) => {
      const next = new Set(current.selected)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return { ...current, selected: next }
    })
  }, [])

  const visible = useMemo(
    () => orderShares(filterShares(rows ?? [], state), state.sort),
    [rows, state],
  )

  const toggleAllVisible = useCallback(() => {
    // Read the rows from the same memo the list renders, not from a `rows` captured when this
    // callback was first made: the hub mounts before the fetch resolves, so a captured `rows` is
    // forever the empty one and the header checkbox would select nothing at all.
    const ids = visible.map((row) => row.noteId)
    setState((current) => ({
      ...current,
      selected: ids.length > 0 && ids.every((id) => current.selected.has(id)) ? EMPTY : new Set(ids),
    }))
  }, [visible])

  const clearSelection = useCallback(() => {
    setState((current) => ({ ...current, selected: EMPTY }))
  }, [])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])

  return {
    ...state,
    loading: open && rows === null,
    failed,
    shares: rows ?? [],
    visible,
    stats,
    folders,
    tags,
    selectedVisible: visible.reduce((count, row) => (state.selected.has(row.noteId) ? count + 1 : count), 0),
    selectCategory,
    selectFolder,
    selectTag,
    setSearch: (search) => patch({ search }),
    setSort: (sort) => patch({ sort }),
    setView: (view) => patch({ view }),
    toggle,
    toggleAllVisible,
    clearSelection,
    refresh,
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>()

/**
 * The rows a category, a filing and the search box select.
 *
 * `shareMatchesSelection` carries the category and filing; the text filter is the hub's own, and it
 * matches the note's title rather than the slug because that is the word the owner typed when they
 * made the link.
 */
function filterShares(rows: readonly ShareListItem[], state: ShareHubState): ShareListItem[] {
  const target: ShareTarget | null = state.folderId
    ? { type: 'folder', value: state.folderId }
    : state.tagName
      ? { type: 'tag', value: state.tagName }
      : null
  const status = statusOf(state.category)
  const needle = state.search.trim().toLowerCase()
  const now = Date.now()
  return rows.filter((row) => {
    if (!shareMatchesSelection(row, { status, target }, now)) return false
    if (!needle) return true
    return (row.noteTitle ?? '').toLowerCase().includes(needle)
  })
}

/** The dashboard and the collections view filter nothing; every other category is a status. */
function statusOf(category: ShareCategory) {
  return category === 'dashboard' || category === 'collections' ? null : category
}

function orderShares(rows: ShareListItem[], sort: ShareSortKey): ShareListItem[] {
  const byNewest = (a: ShareListItem, b: ShareListItem) => b.createdAt - a.createdAt
  const comparator =
    sort === 'oldest'
      ? (a: ShareListItem, b: ShareListItem) => a.createdAt - b.createdAt
      : sort === 'views'
        ? (a: ShareListItem, b: ShareListItem) => b.views - a.views || byNewest(a, b)
        : sort === 'title'
          ? (a: ShareListItem, b: ShareListItem) =>
            (a.noteTitle ?? '').localeCompare(b.noteTitle ?? '') || byNewest(a, b)
          : byNewest
  return [...rows].sort(comparator)
}
