import { create } from 'zustand'
import { api } from '../../../lib/api'
import { toast } from './toast'
import { t } from '../../../lib/i18n'
import {
  EXCALIDRAW_MAX_LIBRARY_BYTES,
  EXCALIDRAW_MAX_LIBRARY_ITEMS,
  sanitizeElements,
} from '../../../lib/markdown/excalidraw/body'
import type {
  ExcalidrawLibraryFolder,
  ExcalidrawLibraryItem,
  ExcalidrawLibraryManifest,
  LibraryFolderNode,
  OfficialLibraryEntry,
} from './types'

const LOCAL_STORAGE_KEY = 'inkstone_excalidraw_library_manifest_v2'

// The upstream catalog changes a few times a week; re-opening the browser ought not to cost a request.
const OFFICIAL_CATALOG_TTL = 10 * 60 * 1000
let officialCatalogInFlight: Promise<OfficialLibraryEntry[]> | null = null

interface LibraryStoreState {
  folders: ExcalidrawLibraryFolder[]
  items: ExcalidrawLibraryItem[]
  activeFolderId: string | null
  expandedFolderIds: string[]
  searchQuery: string
  loading: boolean
  syncing: boolean
  lastSavedAt: number
  officialCatalog: OfficialLibraryEntry[]
  officialCatalogAt: number
  officialCatalogLoading: boolean

  loadOfficialCatalog: (force?: boolean) => Promise<OfficialLibraryEntry[]>

  init: () => Promise<void>
  setActiveFolderId: (id: string | null) => void
  setSearchQuery: (query: string) => void
  toggleFolder: (id: string) => void
  expandFolder: (id: string) => void
  collapseFolder: (id: string) => void
  expandAll: () => void
  collapseAll: () => void

  createFolder: (name: string, parentId?: string | null) => string
  renameFolder: (id: string, name: string) => void
  deleteFolder: (id: string) => void
  moveFolder: (id: string, targetParentId: string | null, beforeId?: string | null) => void
  sortFolders: (parentId: string | null) => void

  addItem: (
    folderId: string | null,
    elements: readonly any[],
    name?: string,
    svgPreview?: string,
  ) => ExcalidrawLibraryItem
  deleteItem: (id: string) => void
  renameItem: (id: string, name: string) => void
  moveItem: (id: string, targetFolderId: string | null) => void

  importFromLibraryData: (
    data: any,
    targetFolderId: string | null,
    sourceName?: string,
  ) => Promise<number>
  exportFolder: (folderId: string | null) => void
  exportAll: () => void
  syncToBackend: () => Promise<void>
}

let syncTimeout: number | null = null

function scheduleSync(get: () => LibraryStoreState) {
  if (typeof window === 'undefined') return
  if (syncTimeout !== null) {
    window.clearTimeout(syncTimeout)
  }
  syncTimeout = window.setTimeout(() => {
    syncTimeout = null
    void get().syncToBackend()
  }, 800)
}

/**
 * svgPreview is a derived render of elements the manifest already carries, and it is by far the
 * largest field in an item (a whole exported SVG per shape). Keeping it out of both stores is what
 * lets a real library fit inside the ~5 MB localStorage quota at all, and keeps a single rename from
 * uploading megabytes; the preview is recomputed on demand and memoised in memory.
 */
function withoutPreviews(items: ExcalidrawLibraryItem[]): ExcalidrawLibraryItem[] {
  return items.map((item) => (item.svgPreview === undefined ? item : { ...item, svgPreview: undefined }))
}

function persistLocal(manifest: ExcalidrawLibraryManifest) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ ...manifest, items: withoutPreviews(manifest.items) }))
  } catch {
  }
}

function readLocal(): ExcalidrawLibraryManifest | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
  }
  return null
}

const defaultFolders: ExcalidrawLibraryFolder[] = [
  {
    id: 'folder-general',
    name: 'General',
    parentId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: 0,
  },
  {
    id: 'folder-diagrams',
    name: 'Diagrams',
    parentId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    order: 1,
  },
]

export function buildLibraryTree(
  folders: ExcalidrawLibraryFolder[],
  items: ExcalidrawLibraryItem[],
): LibraryFolderNode[] {
  const itemsByFolder = new Map<string | null, number>()
  for (const item of items) {
    const fid = item.folderId ?? null
    itemsByFolder.set(fid, (itemsByFolder.get(fid) ?? 0) + 1)
  }

  const byParent = new Map<string | null, ExcalidrawLibraryFolder[]>()
  for (const folder of folders) {
    const pid = folder.parentId ?? null
    const list = byParent.get(pid) ?? []
    list.push(folder)
    byParent.set(pid, list)
  }

  for (const list of byParent.values()) {
    list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  }

  function recurse(parentId: string | null, depth: number): LibraryFolderNode[] {
    const children = byParent.get(parentId) ?? []
    return children.map((f) => {
      const childNodes = recurse(f.id, depth + 1)
      const direct = itemsByFolder.get(f.id) ?? 0
      const total = direct + childNodes.reduce((acc, c) => acc + c.itemCount, 0)
      return {
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        order: f.order,
        depth,
        children: childNodes,
        directCount: direct,
        itemCount: total,
        color: f.color,
        icon: f.icon,
      }
    })
  }

  return recurse(null, 0)
}

export function getAllFolderDescendants(
  folders: readonly ExcalidrawLibraryFolder[],
  rootFolderId: string,
): Set<string> {
  const result = new Set<string>([rootFolderId])
  const queue = [rootFolderId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const f of folders) {
      if (f.parentId === current && !result.has(f.id)) {
        result.add(f.id)
        queue.push(f.id)
      }
    }
  }
  return result
}

export function extractItemName(
  entry: any,
  fallbackIndex?: number,
  fallbackPrefix = 'Item',
): string {
  if (entry?.name && typeof entry.name === 'string') {
    const trimmed = entry.name.trim()
    if (trimmed && !/^(stencil|item)\s*\d+$/i.test(trimmed)) {
      return trimmed
    }
  }

  const elements = Array.isArray(entry) ? entry : entry?.elements || []
  if (Array.isArray(elements) && elements.length > 0) {
    const textEls = elements.filter(
      (el) => el && (el.type === 'text' || typeof el.text === 'string' || typeof el.rawText === 'string'),
    )
    if (textEls.length > 0) {
      const candidate =
        textEls.find((el) => {
          const t = String(el.text || el.rawText || '').trim()
          return t.length > 0 && !/^\d{1,2}:\d{2}$/.test(t) && !/^\d+$/.test(t)
        }) || textEls[0]
      const text = String(candidate.text || candidate.rawText || '')
        .replace(/\r?\n/g, ' ')
        .trim()
      if (text.length > 0) {
        return text.length > 40 ? `${text.slice(0, 37)}...` : text
      }
    }

    if (entry?.customData?.name) return String(entry.customData.name).trim()
    for (const el of elements) {
      if (el?.customData?.name) return String(el.customData.name).trim()
      if (el?.label?.text) return String(el.label.text).trim()
    }

    if (elements.length === 1 && elements[0]?.type) {
      const typeStr = String(elements[0].type)
      const capitalized = typeStr.charAt(0).toUpperCase() + typeStr.slice(1)
      return typeof fallbackIndex === 'number' ? `${capitalized} ${fallbackIndex + 1}` : capitalized
    }
  }

  if (entry?.name && typeof entry.name === 'string' && entry.name.trim()) {
    return entry.name.trim()
  }

  return typeof fallbackIndex === 'number' ? `${fallbackPrefix} ${fallbackIndex + 1}` : fallbackPrefix
}

export function healLibraryItems(
  rawItems: ExcalidrawLibraryItem[],
): { items: ExcalidrawLibraryItem[]; changed: boolean } {
  let changed = false
  const items = rawItems.map((item, idx) => {
    if (!item.name || /^(stencil|item)\s*\d+$/i.test(item.name.trim())) {
      const extracted = extractItemName(item, idx, item.name || 'Item')
      if (extracted && extracted !== item.name && !/^(stencil|item)\s*\d+$/i.test(extracted.trim())) {
        changed = true
        return { ...item, name: extracted }
      }
    }
    return item
  })
  return { items, changed }
}

export const useExcalidrawLibraryStore = create<LibraryStoreState>((set, get) => ({
  folders: defaultFolders,
  items: [],
  activeFolderId: null,
  expandedFolderIds: ['folder-general', 'folder-diagrams'],
  searchQuery: '',
  loading: false,
  syncing: false,
  lastSavedAt: 0,
  officialCatalog: [],
  officialCatalogAt: 0,
  officialCatalogLoading: false,

  loadOfficialCatalog: async (force = false) => {
    const state = get()
    if (
      !force &&
      state.officialCatalog.length > 0 &&
      Date.now() - state.officialCatalogAt < OFFICIAL_CATALOG_TTL
    ) {
      return state.officialCatalog
    }
    if (officialCatalogInFlight) return officialCatalogInFlight

    set({ officialCatalogLoading: true })
    const run = (async (): Promise<OfficialLibraryEntry[]> => {
      try {
        const res = await api.excalidrawLibrary.getOfficialCatalog()
        const list = res.ok && Array.isArray(res.libraries) ? (res.libraries as OfficialLibraryEntry[]) : []
        // A failed or empty response keeps whatever catalog is already on screen instead of blanking it.
        if (list.length > 0) set({ officialCatalog: list, officialCatalogAt: Date.now() })
        return list
      } finally {
        set({ officialCatalogLoading: false })
        officialCatalogInFlight = null
      }
    })()
    officialCatalogInFlight = run
    return run
  },

  init: async () => {
    const local = readLocal()
    if (local && Array.isArray(local.folders) && Array.isArray(local.items)) {
      const { items: healedLocal, changed } = healLibraryItems(local.items)
      const nextFolders = local.folders.length > 0 ? local.folders : defaultFolders
      set({
        folders: nextFolders,
        items: healedLocal,
        lastSavedAt: local.updatedAt || 0,
      })
      if (changed) {
        persistLocal({
          version: 2,
          folders: nextFolders,
          items: healedLocal,
          updatedAt: Date.now(),
        })
      }
    }

    set({ loading: true })
    try {
      const res = await api.excalidrawLibrary.getManifest()
      if (res?.ok && res.manifest) {
        const mf = res.manifest as ExcalidrawLibraryManifest
        const remoteFolders = Array.isArray(mf.folders) && mf.folders.length > 0 ? mf.folders : defaultFolders
        const remoteItems = Array.isArray(mf.items) ? mf.items : []
        const { items: healedRemote } = healLibraryItems(remoteItems)
        set({
          folders: remoteFolders,
          items: healedRemote,
          lastSavedAt: mf.updatedAt || Date.now(),
        })
        persistLocal({
          version: 2,
          folders: remoteFolders,
          items: healedRemote,
          updatedAt: mf.updatedAt || Date.now(),
        })
        // A heal renames shapes the store already has; pushing it back on every boot would spend a
        // full-manifest upload per device per session. The next real edit carries the names along.
      }
    } catch {
    } finally {
      set({ loading: false })
    }
  },

  setActiveFolderId: (id) => set({ activeFolderId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),

  toggleFolder: (id) =>
    set((state) => {
      const exists = state.expandedFolderIds.includes(id)
      return {
        expandedFolderIds: exists
          ? state.expandedFolderIds.filter((fid) => fid !== id)
          : [...state.expandedFolderIds, id],
      }
    }),

  expandFolder: (id) =>
    set((state) => ({
      expandedFolderIds: state.expandedFolderIds.includes(id)
        ? state.expandedFolderIds
        : [...state.expandedFolderIds, id],
    })),

  collapseFolder: (id) =>
    set((state) => ({
      expandedFolderIds: state.expandedFolderIds.filter((fid) => fid !== id),
    })),

  expandAll: () =>
    set((state) => ({
      expandedFolderIds: state.folders.map((f) => f.id),
    })),

  collapseAll: () => set({ expandedFolderIds: [] }),

  createFolder: (name, parentId = null) => {
    const trimmed = name.trim() || t('excalidraw.new_folder')
    const id = `folder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const state = get()
    const siblings = state.folders.filter((f) => f.parentId === (parentId ?? null))
    const nextOrder = siblings.length > 0 ? Math.max(...siblings.map((s) => s.order)) + 1 : 0

    const newFolder: ExcalidrawLibraryFolder = {
      id,
      name: trimmed,
      parentId: parentId ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order: nextOrder,
    }

    const nextFolders = [...state.folders, newFolder]
    const nextExpanded = parentId
      ? [...new Set([...state.expandedFolderIds, parentId, id])]
      : [...new Set([...state.expandedFolderIds, id])]

    set({
      folders: nextFolders,
      expandedFolderIds: nextExpanded,
      activeFolderId: id,
    })

    persistLocal({
      version: 2,
      folders: nextFolders,
      items: state.items,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
    return id
  },

  renameFolder: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const state = get()
    const nextFolders = state.folders.map((f) => (f.id === id ? { ...f, name: trimmed, updatedAt: Date.now() } : f))
    set({ folders: nextFolders })
    persistLocal({
      version: 2,
      folders: nextFolders,
      items: state.items,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
  },

  deleteFolder: (id) => {
    const state = get()
    const descendants = getAllFolderDescendants(state.folders, id)
    const nextFolders = state.folders.filter((f) => !descendants.has(f.id))
    const nextItems = state.items.filter((item) => !item.folderId || !descendants.has(item.folderId))
    const nextActive = state.activeFolderId && descendants.has(state.activeFolderId) ? null : state.activeFolderId

    set({
      folders: nextFolders,
      items: nextItems,
      activeFolderId: nextActive,
      expandedFolderIds: state.expandedFolderIds.filter((fid) => !descendants.has(fid)),
    })

    persistLocal({
      version: 2,
      folders: nextFolders,
      items: nextItems,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
  },

  moveFolder: (id, targetParentId, beforeId = null) => {
    const state = get()
    if (id === targetParentId) return
    const descendants = getAllFolderDescendants(state.folders, id)
    if (targetParentId && descendants.has(targetParentId)) return

    const moving = state.folders.find((f) => f.id === id)
    if (!moving) return

    let siblings = state.folders.filter((f) => f.parentId === (targetParentId ?? null) && f.id !== id)
    siblings.sort((a, b) => a.order - b.order)

    const updatedMoving = { ...moving, parentId: targetParentId ?? null, updatedAt: Date.now() }

    if (beforeId) {
      const idx = siblings.findIndex((s) => s.id === beforeId)
      if (idx >= 0) {
        siblings.splice(idx, 0, updatedMoving)
      } else {
        siblings.push(updatedMoving)
      }
    } else {
      siblings.push(updatedMoving)
    }

    siblings = siblings.map((item, idx) => ({ ...item, order: idx }))

    const otherFolders = state.folders.filter(
      (f) => f.parentId !== (targetParentId ?? null) && f.id !== id,
    )
    const nextFolders = [...otherFolders, ...siblings]

    set({ folders: nextFolders })
    persistLocal({
      version: 2,
      folders: nextFolders,
      items: state.items,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
  },

  sortFolders: (parentId) => {
    const state = get()
    const target = parentId ?? null
    const ordered = state.folders
      .filter((f) => (f.parentId ?? null) === target)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.order - b.order)
    const rank = new Map(ordered.map((f, idx) => [f.id, idx]))
    if (rank.size === 0) return
    const stamp = Date.now()
    const nextFolders = state.folders.map((f) => {
      const idx = rank.get(f.id)
      return idx === undefined || f.order === idx ? f : { ...f, order: idx, updatedAt: stamp }
    })
    // A group already in alphabetical order must not spend a write, an upload and a re-render of
    // every surface reading the manifest.
    if (nextFolders.every((f, idx) => f === state.folders[idx])) return
    set({ folders: nextFolders })
    persistLocal({
      version: 2,
      folders: nextFolders,
      items: state.items,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
  },

  addItem: (folderId, elements, name, svgPreview) => {
    const state = get()
    const targetFolder = folderId ?? state.activeFolderId ?? (state.folders[0]?.id ?? null)
    const id = `stencil-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const title = extractItemName({ name, elements }, state.items.length)

    const newItem: ExcalidrawLibraryItem = {
      id,
      folderId: targetFolder,
      name: title,
      elements: JSON.parse(JSON.stringify(elements)),
      status: 'unpublished',
      created: Date.now(),
      svgPreview,
    }

    const nextItems = [newItem, ...state.items]
    set({ items: nextItems, activeFolderId: targetFolder })

    persistLocal({
      version: 2,
      folders: state.folders,
      items: nextItems,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
    return newItem
  },

  deleteItem: (id) => {
    const state = get()
    const nextItems = state.items.filter((item) => item.id !== id)
    set({ items: nextItems })
    persistLocal({
      version: 2,
      folders: state.folders,
      items: nextItems,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
  },

  renameItem: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const state = get()
    const nextItems = state.items.map((it) => (it.id === id ? { ...it, name: trimmed } : it))
    set({ items: nextItems })
    persistLocal({
      version: 2,
      folders: state.folders,
      items: nextItems,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
  },

  moveItem: (id, targetFolderId) => {
    const state = get()
    const nextItems = state.items.map((it) => (it.id === id ? { ...it, folderId: targetFolderId } : it))
    set({ items: nextItems })
    persistLocal({
      version: 2,
      folders: state.folders,
      items: nextItems,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
  },

  importFromLibraryData: async (data, targetFolderId, sourceName) => {
    const state = get()
    let rawItems: any[] = []

    if (Array.isArray(data)) {
      if (data.length > 0 && Array.isArray(data[0])) {
        rawItems = data.map((elements, idx) => ({ id: `imp-${idx}`, elements }))
      } else if (data.length > 0 && data[0]?.elements) {
        rawItems = data
      } else if (data.length > 0 && data[0]?.type) {
        rawItems = [{ id: 'imp-single', elements: data }]
      }
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.libraryItems)) {
        rawItems = data.libraryItems.map((item: any, idx: number) => {
          if (Array.isArray(item)) return { id: `imp-${idx}`, elements: item }
          return item
        })
      } else if (Array.isArray(data.library)) {
        rawItems = data.library.map((item: any, idx: number) => {
          if (Array.isArray(item)) return { id: `imp-${idx}`, elements: item }
          return item
        })
      }
    }

    if (rawItems.length === 0) return 0

    let folderId = targetFolderId
    let nextFolders = [...state.folders]

    if (sourceName) {
      const cleanName = sourceName.replace(/\.excalidrawlib$/i, '').trim()
      const existing = nextFolders.find(
        (f) => f.name.toLowerCase() === cleanName.toLowerCase() && f.parentId === targetFolderId,
      )
      if (existing) {
        folderId = existing.id
      } else {
        const newFid = `folder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const newFolder: ExcalidrawLibraryFolder = {
          id: newFid,
          name: cleanName,
          parentId: targetFolderId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          order: nextFolders.length,
        }
        nextFolders.push(newFolder)
        folderId = newFid
      }
    } else if (!folderId) {
      folderId = state.activeFolderId ?? (state.folders[0]?.id ?? null)
    }

    const cleanPrefix = sourceName ? sourceName.replace(/\.excalidrawlib$/i, '').trim() : 'Item'
    // A library file is authored somewhere else and drawn here later, so its elements take the same route
    // a note body takes: embeddables, hostile links and oversized point lists are dropped before anything
    // reaches the store - the stencil tree hands these very elements to restoreElements and exportToSvg.
    const importedItems: ExcalidrawLibraryItem[] = []
    let droppedElements = 0
    let skippedItems = 0
    let budget = EXCALIDRAW_MAX_LIBRARY_BYTES
    for (const [idx, entry] of rawItems.entries()) {
      if (importedItems.length >= EXCALIDRAW_MAX_LIBRARY_ITEMS) {
        skippedItems += rawItems.length - idx
        break
      }
      const rawElements = Array.isArray(entry) ? entry : entry.elements || []
      const safe = sanitizeElements(rawElements)
      droppedElements += safe.dropped
      if (safe.error || safe.elements.length === 0) {
        skippedItems += 1
        continue
      }
      const size = JSON.stringify(safe.elements).length
      if (size > budget) {
        skippedItems += rawItems.length - idx
        break
      }
      budget -= size
      importedItems.push({
        id: `stencil-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        folderId,
        name: extractItemName(entry, idx, cleanPrefix),
        elements: safe.elements,
        status: 'published',
        created: Date.now(),
      })
    }

    if (droppedElements > 0 || skippedItems > 0) {
      toast({
        title: t('excalidraw.library_import_skipped', {
          imported: importedItems.length,
          skipped: skippedItems,
          dropped: droppedElements,
        }),
        tone: importedItems.length === 0 ? 'danger' : 'default',
      })
    }
    if (importedItems.length === 0) return 0

    const nextItems = [...importedItems, ...state.items]
    const nextExpanded = folderId
      ? [...new Set([...state.expandedFolderIds, folderId])]
      : state.expandedFolderIds

    set({
      folders: nextFolders,
      items: nextItems,
      activeFolderId: folderId,
      expandedFolderIds: nextExpanded,
    })

    persistLocal({
      version: 2,
      folders: nextFolders,
      items: nextItems,
      updatedAt: Date.now(),
    })
    scheduleSync(get)
    return importedItems.length
  },

  exportFolder: (folderId) => {
    const state = get()
    let exportItems: ExcalidrawLibraryItem[] = []
    let filename = 'library.excalidrawlib'

    if (folderId) {
      const descendants = getAllFolderDescendants(state.folders, folderId)
      exportItems = state.items.filter((it) => it.folderId && descendants.has(it.folderId))
      const folder = state.folders.find((f) => f.id === folderId)
      if (folder) {
        filename = `${folder.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')}.excalidrawlib`
      }
    } else {
      exportItems = state.items
    }

    const payload = {
      type: 'excalidrawlib',
      version: 2,
      source: 'https://inkstone.app',
      libraryItems: exportItems.map((it) => it.elements),
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  },

  exportAll: () => {
    const state = get()
    const payload = {
      type: 'excalidrawlib',
      version: 2,
      source: 'https://inkstone.app',
      libraryItems: state.items.map((it) => it.elements),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'inkstone-all-stencils.excalidrawlib'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  },

  syncToBackend: async () => {
    const state = get()
    set({ syncing: true })
    try {
      const manifest: ExcalidrawLibraryManifest = {
        version: 2,
        folders: state.folders,
        items: withoutPreviews(state.items),
        updatedAt: Date.now(),
      }
      await api.excalidrawLibrary.saveManifest(manifest)
      set({ lastSavedAt: Date.now() })
    } catch (err) {
      console.error('Failed to sync library to backend:', err)
      toast({ title: t('excalidraw.save_manifest_failed'), tone: 'danger' })
    } finally {
      set({ syncing: false })
    }
  },
}))
