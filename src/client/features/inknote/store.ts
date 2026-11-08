/** The Inknote client store: the library, one open note, page saves and optimistic metadata. */
import { create } from 'zustand'
import { inknoteApi } from './api'
import type {
  InknoteNoteMeta,
  InknoteNotebook,
  InknotePage,
  InknotePageContent,
  InknoteSettings,
  InknoteSubject,
  InknoteTemplate,
} from '@shared/inknote/types'
import { emptyPageContent, parseInknotePageContent, serializePageContent } from '@shared/inknote/parse'
import { isEmptyPage } from '../../lib/inknote/note-search'
import { samePageOrder, samePaper, snapshotNote, trimHistory, type InknoteHistoryEntry, type NoteSnapshot } from '../../lib/inknote/history-entry'
import { sanitizeInknoteSettings } from '@shared/inknote/settings'
import { DEFAULT_INKNOTE_SETTINGS } from '@shared/inknote/constants'
import { ApiError } from '../../lib/api'

export type InknoteSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'offline' | 'conflict'

interface Conflict {
  content: string
  rev: number
  updatedAt: number
}

interface InknoteState {
  library: {
    subjects: InknoteSubject[]
    notebooks: InknoteNotebook[]
    notes: InknoteNoteMeta[]
    settings: InknoteSettings
    templates: InknoteTemplate[]
  } | null
  note: InknoteNoteMeta | null
  pages: InknotePage[]
  activePageId: string | null
  activePageIndex: number
  tabs: string[]
  contentVersion: number
  saveState: InknoteSaveState
  saveError: string | null
  conflicts: Record<string, Conflict>
  /** Drafts left by a failed save, keyed by page id; the reader decides whether to restore. */
  drafts: Record<string, { content: InknotePageContent; savedAt: number; offline: boolean }>
  /** A replay is writing into the pages for the reader to watch; saves must not leave with it. */
  replaying: boolean
  /** Unified undo: content edits, page arrays, paper and page size share one stack. */
  undoStack: InknoteHistoryEntry[]
  redoStack: InknoteHistoryEntry[]
  applyingHistory: boolean
  loading: boolean
  opening: boolean
  error: string | null
  unauthorized: boolean
  settingsUpdatedAt: number
  initialized: boolean

  bootstrap: () => Promise<void>
  refreshLibrary: () => Promise<void>
  openNote: (id: string, pageIndex?: number) => Promise<void>
  closeNote: () => void
  closeTab: (id: string) => void
  setActivePage: (id: string) => void
  touchPage: () => void
  replacePageContent: (pageId: string, content: InknotePageContent) => void
  savePage: (pageId?: string) => Promise<boolean>
  saveAll: () => Promise<void>
  createNote: (notebookId?: string, title?: string) => Promise<string | null>
  updateNoteMeta: (patch: Partial<Pick<InknoteNoteMeta, 'title' | 'notebookId' | 'paper' | 'pageWidth' | 'pageHeight' | 'colorTag' | 'pinned'>>) => Promise<boolean>
  patchNotesMeta: (ids: string[], patch: Partial<Pick<InknoteNoteMeta, 'notebookId' | 'colorTag' | 'pinned'>>) => Promise<{ changed: number; failed: number }>
  deleteNote: (id: string) => Promise<void>
  restoreNote: (id: string) => Promise<void>
  purgeNote: (id: string) => Promise<void>
  duplicateNote: (id: string) => Promise<string | null>
  createSubject: (name: string) => Promise<void>
  updateSubject: (id: string, patch: { name?: string; position?: number }) => Promise<void>
  deleteSubject: (id: string) => Promise<void>
  createNotebook: (subjectId: string, name: string, coverColor?: string, emoji?: string) => Promise<void>
  updateNotebook: (id: string, patch: { name?: string; coverColor?: string; emoji?: string }) => Promise<void>
  deleteNotebook: (id: string) => Promise<void>
  createPage: (afterPageId?: string) => Promise<void>
  duplicatePage: (pageId: string) => Promise<void>
  deletePage: (pageId: string) => Promise<void>
  clearPage: (pageId: string) => Promise<void>
  deleteBlankPages: () => Promise<number>
  reorderPages: (pageIds: string[]) => Promise<void>
  copyPageTo: (targetNoteId: string, pageId: string) => Promise<void>
  updateSettings: (patch: Partial<InknoteSettings>) => Promise<void>
  resetSettings: () => Promise<void>
  refreshTemplates: () => Promise<void>
  addTemplate: (input: Parameters<typeof inknoteApi.createTemplate>[0]) => Promise<void>
  removeTemplate: (id: string) => Promise<void>
  clearConflict: (pageId: string) => void
  restoreDrafts: () => Promise<void>
  discardDrafts: () => void
  replayOfflineDrafts: () => Promise<void>
  recordContentHistory: (pageId: string, before: string, after: string, label: string) => void
  undo: () => Promise<void>
  redo: () => Promise<void>
  beginReplay: () => void
  applyReplayContent: (pageId: string, content: InknotePageContent) => void
  endReplay: (snapshot: Map<string, InknotePageContent>) => void
}

const saveTimers = new Map<string, number>()
/** Page ids whose content changed since the last successful save. */
const dirtyPages = new Set<string>()
const inFlight = new Map<string, Promise<boolean>>()
const SAVE_DELAY = 1_200
const AUTO_SNAPSHOT_DELAY = 45_000
const SETTINGS_SAVE_DELAY = 350
const syncChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('inknote-tabs')
let autoSnapshotAt = Date.now()
const coverAttemptAt = new Map<string, number>()
const coverUploaded = new Set<string>()
let autoSnapshotInFlight = false
let settingsTimer: number | undefined
let pendingSettings: InknoteSettings | null = null

async function uploadFirstPageCover(noteId: string, note: InknoteNoteMeta, page: InknotePage): Promise<void> {
  const last = coverAttemptAt.get(noteId) ?? 0
  if (note.coverAssetId || coverUploaded.has(noteId) || Date.now() - last < 10_000) return
  coverAttemptAt.set(noteId, Date.now())
  coverUploaded.add(noteId)
  try {
    const [{ renderPageToCanvas }, { fontStackFor }] = await Promise.all([
      import('./engine/renderer'),
      import('../../lib/inknote/text-layout'),
    ])
    const canvas = renderPageToCanvas(page.content, note.paper, {
      width: note.pageWidth,
      height: note.pageHeight,
      contentWidth: note.contentWidth,
      contentHeight: note.contentHeight,
    }, 160, fontStackFor('system'))
    if (!canvas) return
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.72))
    if (!blob) return
    const asset = await inknoteApi.uploadAsset(new File([blob], 'cover.jpg', { type: 'image/jpeg' }), 'cover', noteId)
    // The upload response already carries the URL, so the list can show the cover without a full
    // library round-trip after every note's first save.
    useInknoteStore.setState((state) => ({
      note: state.note?.id === noteId ? { ...state.note, coverAssetId: asset.id, coverUrl: asset.url } : state.note,
      library: state.library
        ? { ...state.library, notes: state.library.notes.map((entry) => entry.id === noteId ? { ...entry, coverAssetId: asset.id, coverUrl: asset.url } : entry) }
        : state.library,
    }))
  } catch (error) {
    coverUploaded.delete(noteId)
    console.warn('[inkstone] Could not build the note cover; the next save retries:', error)
  }
}

/** The server keeps ten snapshots and the account may have switched automatic backups off. */
function maybeAutoSnapshot(autoBackup: boolean): void {
  if (!autoBackup || autoSnapshotInFlight || Date.now() - autoSnapshotAt < AUTO_SNAPSHOT_DELAY) return
  autoSnapshotInFlight = true
  void inknoteApi.createSnapshot('auto')
    .then(() => { autoSnapshotAt = Date.now() })
    .catch((error) => { console.warn('[inkstone] Automatic snapshot failed; the next save retries:', error) })
    .finally(() => { autoSnapshotInFlight = false })
}

function message(error: unknown): string {
  if (error instanceof ApiError) return error.serverMessage ?? error.message
  return error instanceof Error ? error.message : 'Something went wrong'
}

function updateLibraryNote(
  library: InknoteState['library'],
  note: InknoteNoteMeta,
): InknoteState['library'] {
  if (!library) return library
  return { ...library, notes: library.notes.map((entry) => entry.id === note.id ? note : entry) }
}

export const useInknoteStore = create<InknoteState>((set, get) => {
  async function persist(pageId: string): Promise<boolean> {
    if (get().replaying) return true
    const { note } = get()
    if (!note) return false
    const running = inFlight.get(pageId)
    if (running) {
      // A save started before this edit. Remember that the row is dirty and let the finished request
      // start a second one; returning the in-flight result alone used to lose the newer content.
      dirtyPages.add(pageId)
      return running
    }
    if (!dirtyPages.has(pageId)) return true
    dirtyPages.delete(pageId)
    const promise = persistNow(note.id, pageId)
    inFlight.set(pageId, promise)
    let saved = false
    try {
      saved = await promise
    } finally {
      inFlight.delete(pageId)
    }
    // An edit that landed while this request was in flight starts one more save, and the caller waits
    // for it rather than learning about it after the tab has already gone. A failed save keeps its
    // dirty mark for the next scheduled retry instead of spinning here.
    if (saved && dirtyPages.has(pageId)) return persist(pageId)
    return saved
  }

  async function persistNow(noteId: string, pageId: string): Promise<boolean> {
    const { pages } = get()
    const page = pages.find((entry) => entry.id === pageId)
    if (!page) return false
    set({ saveState: 'saving', saveError: null })
    try {
      const content = serializePageContent(page.content)
      const saved = await inknoteApi.savePage(noteId, pageId, content, page.rev)
      try { localStorage.removeItem(`inknote-draft:${noteId}:${pageId}`) } catch { /* storage may be unavailable */ }
      // Only the rows that moved are rebuilt. A save that changed nothing used to hand every page and
      // the note a fresh object, and the canvas read that as a new document: its effects ran setPage and
      // fitView mid-stroke, which is how a stroke was cut or a zoom snapped back while autosave ran.
      set((state) => {
        const current = state.pages.find((entry) => entry.id === pageId)
        const pageMoved = current !== undefined && (current.rev !== saved.rev || current.updatedAt !== saved.updatedAt)
        const noteMoved = state.note !== null && state.note.id === noteId && state.note.updatedAt !== saved.updatedAt
        const drafts = Object.prototype.hasOwnProperty.call(state.drafts, pageId)
          ? Object.fromEntries(Object.entries(state.drafts).filter(([id]) => id !== pageId))
          : state.drafts
        if (!pageMoved && !noteMoved && drafts === state.drafts) return { saveState: 'saved' }
        return {
          pages: pageMoved
            ? state.pages.map((entry) => entry.id === pageId ? { ...entry, rev: saved.rev, updatedAt: saved.updatedAt } : entry)
            : state.pages,
          note: noteMoved && state.note ? { ...state.note, updatedAt: saved.updatedAt } : state.note,
          library: state.library
            ? { ...state.library, notes: state.library.notes.map((entry) => entry.id === noteId ? { ...entry, updatedAt: saved.updatedAt } : entry) }
            : state.library,
          drafts,
          saveState: 'saved',
          saveError: null,
        }
      })
      syncChannel?.postMessage({ type: 'page-saved', noteId, pageId, rev: saved.rev })
      if (page.position === 0) {
        const current = get()
        if (current.note?.id === noteId) void uploadFirstPageCover(noteId, current.note, page)
      }
      maybeAutoSnapshot(get().library?.settings.autoBackup ?? true)
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const details = error.details as { current?: Conflict } | undefined
        const current = details?.current
        if (current) {
          set((state) => ({
            conflicts: { ...state.conflicts, [pageId]: current },
            saveState: 'conflict',
            saveError: 'This page was changed elsewhere',
          }))
          // The page in this tab is still unsaved. Keep it as a draft so closing the tab cannot lose it.
          dirtyPages.add(pageId)
          writeDraft(noteId, pageId, page, false)
          return false
        }
      }
      const offline = error instanceof ApiError ? error.status === 0 : true
      writeDraft(noteId, pageId, page, offline)
      dirtyPages.add(pageId)
      set({ saveState: offline ? 'offline' : 'error', saveError: message(error) })
      return false
    }
  }

  function writeDraft(noteId: string, pageId: string, page: { content: InknotePageContent; rev: number }, offline: boolean): void {
    const savedAt = Date.now()
    try {
      localStorage.setItem(`inknote-draft:${noteId}:${pageId}`, JSON.stringify({ content: serializePageContent(page.content), baseRev: page.rev, savedAt, offline }))
    } catch { /* storage may be unavailable */ }
    set((state) => ({
      drafts: { ...state.drafts, [pageId]: { content: page.content, savedAt, offline } },
    }))
  }

  function scheduleSave(pageId: string) {
    dirtyPages.add(pageId)
    const existing = saveTimers.get(pageId)
    if (existing) window.clearTimeout(existing)
    set({ saveState: 'pending' })
    saveTimers.set(pageId, window.setTimeout(() => {
      saveTimers.delete(pageId)
      void persist(pageId)
    }, SAVE_DELAY))
  }

  async function flushSettings(): Promise<void> {
    if (settingsTimer !== undefined) {
      window.clearTimeout(settingsTimer)
      settingsTimer = undefined
    }
    const config = pendingSettings
    pendingSettings = null
    if (!config) return
    try {
      const saved = await inknoteApi.saveSettings(config, get().settingsUpdatedAt || undefined)
      set({ settingsUpdatedAt: saved.updatedAt })
    } catch (error) {
      // A 409 means this tab's token was from before another device's write. Keeping the stale token
      // made every later save fail the same way, silently, until the page was reloaded — so the
      // server's timestamp is read back here and the next save carries it.
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await inknoteApi.settings()
          set({ settingsUpdatedAt: latest.updatedAt })
        } catch {
          // The conflict itself is still reported below; a read that also failed changes nothing
          // about what the reader has to do.
        }
      }
      set({ error: message(error) })
    }
  }

  function scheduleSettings(config: InknoteSettings): void {
    pendingSettings = config
    if (settingsTimer !== undefined) window.clearTimeout(settingsTimer)
    settingsTimer = window.setTimeout(() => {
      settingsTimer = undefined
      void flushSettings()
    }, SETTINGS_SAVE_DELAY)
  }

  function currentSnapshot(): NoteSnapshot | null {
    const { note, pages } = get()
    return note ? snapshotNote(note, pages) : null
  }

  function pushEntry(entry: InknoteHistoryEntry): void {
    if (get().applyingHistory || get().replaying) return
    set((state) => ({ undoStack: trimHistory([...state.undoStack, entry]), redoStack: [] }))
  }

  async function reloadNoteSilently(noteId: string, index: number): Promise<void> {
    const response = await inknoteApi.note(noteId, 'all')
    const safeIndex = Math.min(Math.max(0, index), Math.max(0, response.pages.length - 1))
    set((state) => ({
      note: response.note,
      pages: response.pages,
      activePageId: response.pages[safeIndex]?.id ?? null,
      activePageIndex: safeIndex,
      contentVersion: state.contentVersion + 1,
      conflicts: {},
      saveState: 'saved',
      library: state.library
        ? { ...state.library, notes: state.library.notes.map((entry) => entry.id === noteId ? response.note : entry) }
        : state.library,
    }))
  }

  async function applyEntry(entry: InknoteHistoryEntry, side: 'before' | 'after'): Promise<void> {
    if (entry.kind === 'content') {
      const parsed = parseInknotePageContent(side === 'before' ? entry.before : entry.after)
      if (!parsed.ok) throw new Error('That history step has no readable page')
      set((state) => ({
        pages: state.pages.map((page) => page.id === entry.pageId ? { ...page, content: parsed.content } : page),
        contentVersion: state.contentVersion + 1,
      }))
      if (!await get().savePage(entry.pageId)) throw new Error('The stepped-back page could not be saved')
      return
    }
    const target = side === 'before' ? entry.before : entry.after
    const state = get()
    const note = state.note
    if (!note || note.id !== target.noteId) return
    const targetIds = new Set(target.pages.map((page) => page.id))
    for (const page of state.pages) {
      if (!targetIds.has(page.id)) await inknoteApi.deletePage(note.id, page.id)
    }
    for (const page of target.pages) {
      const existing = state.pages.find((entryPage) => entryPage.id === page.id)
      const next = serializePageContent(page.content)
      if (!existing) {
        await inknoteApi.createPage(note.id, { id: page.id, content: next })
      } else if (next !== serializePageContent(existing.content)) {
        await inknoteApi.savePage(note.id, page.id, next, existing.rev)
      }
    }
    const order = get().pages.filter((page) => targetIds.has(page.id)).map((page) => ({ id: page.id }))
    if (!samePageOrder(order, target.pages)) await inknoteApi.reorderPages(note.id, target.pages.map((page) => page.id))
    if (!samePaper(note.paper, target.paper) || note.pageWidth !== target.pageWidth || note.pageHeight !== target.pageHeight) {
      await inknoteApi.updateNote(note.id, {
        paper: target.paper,
        pageWidth: target.pageWidth,
        pageHeight: target.pageHeight,
        baseRev: note.rev,
      })
    }
    await reloadNoteSilently(note.id, state.activePageIndex)
  }

  return {
    library: null,
    note: null,
    pages: [],
    activePageId: null,
    activePageIndex: 0,
    tabs: [],
    contentVersion: 0,
    saveState: 'idle',
    saveError: null,
    conflicts: {},
    drafts: {},
    replaying: false,
    undoStack: [],
    redoStack: [],
    applyingHistory: false,
    loading: false,
    opening: false,
    error: null,
    settingsUpdatedAt: 0,
    initialized: false,
    unauthorized: false,

    async bootstrap() {
      if (get().loading) return
      set({ loading: true, error: null, unauthorized: false })
      try {
        const [library, settings, templates] = await Promise.all([
          inknoteApi.library(),
          inknoteApi.settings(),
          inknoteApi.templates(),
        ])
        set({
          library: {
            subjects: library.subjects,
            notebooks: library.notebooks,
            notes: library.notes,
            settings: sanitizeInknoteSettings(settings.config),
            templates: templates.templates,
          },
          settingsUpdatedAt: settings.updatedAt,
          tabs: library.settings.openTabs.filter((id) => library.notes.some((note) => note.id === id)),
          loading: false,
          initialized: true,
          error: null,
        })
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          set({ loading: false, initialized: true, unauthorized: true, error: null })
          return
        }
        set({ loading: false, initialized: true, error: message(error) })
      }
    },

    async refreshLibrary() {
      try {
        const library = await inknoteApi.library()
        set((state) => {
          const server = state.note ? library.notes.find((entry) => entry.id === state.note!.id) : undefined
          // A refresh that returned the same revision is not a change to the open note. Keeping the
          // object is what keeps its paper's identity stable, so the canvas's paper effect does not
          // re-fit the zoom every time a background refresh lands.
          const same = state.note !== null && server !== undefined
            && server.rev === state.note.rev
            && server.updatedAt === state.note.updatedAt
          return {
            library: {
              subjects: library.subjects,
              notebooks: library.notebooks,
              notes: library.notes,
              settings: state.library?.settings ?? sanitizeInknoteSettings(library.settings),
              templates: state.library?.templates ?? library.templates,
            },
            note: state.note ? (same ? state.note : server ?? state.note) : null,
          }
        })
      } catch {
        // A background refresh is allowed to miss; the next save or focus retries it.
      }
    },

    async openNote(id, pageIndex = 0) {
      await get().saveAll()
      dirtyPages.clear()
      set({ opening: true, error: null })
      try {
        const response = await inknoteApi.note(id, 'all')
        const index = Math.min(Math.max(0, pageIndex), Math.max(0, response.pages.length - 1))
        const drafts: InknoteState['drafts'] = {}
        for (const page of response.pages) {
          try {
            const raw = localStorage.getItem(`inknote-draft:${id}:${page.id}`)
            if (!raw) continue
            const parsed = JSON.parse(raw) as { content?: unknown; savedAt?: unknown; offline?: unknown }
            const content = parseInknotePageContent(typeof parsed.content === 'string' ? parsed.content : '')
            if (content.ok) drafts[page.id] = { content: content.content, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0, offline: parsed.offline === true }
          } catch { /* a corrupt draft is not a restore candidate */ }
        }
        set((state) => ({
          note: response.note,
          pages: response.pages,
          activePageId: response.pages[index]?.id ?? null,
          activePageIndex: index,
          tabs: state.tabs.includes(id) ? state.tabs : [id, ...state.tabs].slice(0, 20),
          opening: false,
          contentVersion: state.contentVersion + 1,
          conflicts: {},
          drafts,
          undoStack: [],
          redoStack: [],
          saveState: 'saved',
        }))
      } catch (error) {
        set({ opening: false, error: message(error) })
      }
    },

    closeNote() {
      void (async () => {
        await get().saveAll()
        dirtyPages.clear()
        set({ note: null, pages: [], activePageId: null, activePageIndex: 0, conflicts: {}, drafts: {}, undoStack: [], redoStack: [] })
      })()
    },

    closeTab(id) {
      const tabs = get().tabs.filter((tab) => tab !== id)
      set({ tabs })
      if (get().note?.id !== id) return
      const next = tabs[0]
      if (next) { void get().openNote(next); return }
      void (async () => {
        await get().saveAll()
        dirtyPages.clear()
        set({ note: null, pages: [], activePageId: null, activePageIndex: 0, conflicts: {}, drafts: {}, undoStack: [], redoStack: [] })
      })()
    },

    setActivePage(id) {
      const index = get().pages.findIndex((page) => page.id === id)
      if (index < 0) return
      void get().savePage(get().activePageId ?? undefined)
      set((state) => ({ activePageId: id, activePageIndex: index, contentVersion: state.contentVersion + 1 }))
    },

    touchPage() {
      const pageId = get().activePageId
      if (pageId) dirtyPages.add(pageId)
      set((state) => ({
        contentVersion: state.contentVersion + 1,
        saveState: state.conflicts[state.activePageId ?? ''] ? 'conflict' : 'pending',
      }))
      if (pageId) scheduleSave(pageId)
    },

    replacePageContent(pageId, content) {
      dirtyPages.add(pageId)
      set((state) => ({
        pages: state.pages.map((page) => page.id === pageId ? { ...page, content } : page),
        contentVersion: state.contentVersion + 1,
      }))
      scheduleSave(pageId)
    },

    async savePage(pageId) {
      if (get().replaying) return true
      const target = pageId ?? get().activePageId
      if (!target) return true
      const timer = saveTimers.get(target)
      if (timer) { window.clearTimeout(timer); saveTimers.delete(target) }
      return persist(target)
    },

    async saveAll() {
      for (const timer of saveTimers.values()) window.clearTimeout(timer)
      saveTimers.clear()
      await flushSettings()
      const ids = [...dirtyPages]
      for (const id of ids) await persist(id)
    },

    async createNote(notebookId, title) {
      const library = get().library
      const target = notebookId ?? library?.notebooks[0]?.id
      if (!target) { set({ error: 'Create a notebook first' }); return null }
      try {
        const settings = library?.settings
        const size = settings?.defaultPageSize === 'wide' ? { pageWidth: 1056, pageHeight: 816 } : {}
        const response = await inknoteApi.createNote({
          notebookId: target,
          title,
          ...(settings?.defaultPaper ? { paper: settings.defaultPaper } : {}),
          ...size,
        })
        set((state) => ({
          library: state.library ? { ...state.library, notes: [response.note, ...state.library.notes] } : state.library,
          note: response.note,
          pages: response.pages,
          activePageId: response.pages[0]?.id ?? null,
          activePageIndex: 0,
          tabs: [response.note.id, ...state.tabs].slice(0, 20),
          contentVersion: state.contentVersion + 1,
          saveState: 'saved',
        }))
        return response.note.id
      } catch (error) {
        set({ error: message(error) })
        return null
      }
    },

    async updateNoteMeta(patch) {
      const { note } = get()
      if (!note) return false
      const undoable = patch.paper !== undefined || patch.pageWidth !== undefined || patch.pageHeight !== undefined
      const before = undoable ? currentSnapshot() : null
      try {
        const next = await inknoteApi.updateNote(note.id, {
          ...patch,
          paper: patch.paper as unknown,
          baseRev: note.rev,
        })
        set((state) => ({
          note: next,
          library: updateLibraryNote(state.library, next),
        }))
        if (before && undoable) {
          const after = currentSnapshot()
          if (after) pushEntry({ kind: 'note', before, after, label: 'page-style' })
        }
        return true
      } catch (error) {
        set({ error: message(error) })
        return false
      }
    },

    async patchNotesMeta(ids, patch) {
      const notes = get().library?.notes ?? []
      let changed = 0
      let failed = 0
      for (const id of ids) {
        const meta = notes.find((entry) => entry.id === id)
        if (!meta) continue
        try {
          const next = await inknoteApi.updateNote(id, { ...patch, baseRev: meta.rev })
          set((state) => ({
            library: state.library ? { ...state.library, notes: state.library.notes.map((entry) => entry.id === id ? next : entry) } : null,
            ...(state.note?.id === id ? { note: next } : {}),
          }))
          changed += 1
        } catch {
          // A batch reports one count for every note it could not change; the caller shows it.
          failed += 1
        }
      }
      return { changed, failed }
    },

    async deleteNote(id) {
      await inknoteApi.deleteNote(id)
      set((state) => ({
        library: state.library ? { ...state.library, notes: state.library.notes.filter((entry) => entry.id !== id) } : null,
        tabs: state.tabs.filter((tab) => tab !== id),
        ...(state.note?.id === id ? { note: null, pages: [], activePageId: null, activePageIndex: 0, undoStack: [], redoStack: [] } : {}),
      }))
    },

    async restoreNote(id) {
      await inknoteApi.restoreNote(id)
      await get().refreshLibrary()
    },

    async purgeNote(id) {
      await inknoteApi.purgeNote(id)
      set((state) => ({
        library: state.library ? { ...state.library, notes: state.library.notes.filter((entry) => entry.id !== id) } : null,
        tabs: state.tabs.filter((tab) => tab !== id),
      }))
    },

    async duplicateNote(id) {
      const response = await inknoteApi.duplicateNote(id)
      set((state) => ({
        library: state.library ? { ...state.library, notes: [response.note, ...state.library.notes] } : state.library,
        note: response.note,
        pages: response.pages,
        activePageId: response.pages[0]?.id ?? null,
        activePageIndex: 0,
        tabs: [response.note.id, ...state.tabs].slice(0, 20),
        contentVersion: state.contentVersion + 1,
      }))
      return response.note.id
    },

    async createSubject(name) {
      await inknoteApi.createSubject({ name })
      await get().refreshLibrary()
    },
    async updateSubject(id, patch) {
      await inknoteApi.updateSubject(id, patch)
      await get().refreshLibrary()
    },
    async deleteSubject(id) {
      await inknoteApi.deleteSubject(id)
      await get().refreshLibrary()
    },
    async createNotebook(subjectId, name, coverColor, emoji) {
      await inknoteApi.createNotebook({ subjectId, name, coverColor, emoji })
      await get().refreshLibrary()
    },
    async updateNotebook(id, patch) {
      await inknoteApi.updateNotebook(id, patch)
      await get().refreshLibrary()
    },
    async deleteNotebook(id) {
      await inknoteApi.deleteNotebook(id)
      await get().refreshLibrary()
    },

    async createPage(afterPageId) {
      const note = get().note
      if (!note) return
      const before = currentSnapshot()
      await get().saveAll()
      const page = await inknoteApi.createPage(note.id, afterPageId ? { afterPageId } : {})
      const pages = [...get().pages]
      const index = pages.findIndex((entry) => entry.id === page.id)
      if (index < 0) pages.splice(Math.min(pages.length, (afterPageId ? pages.findIndex((entry) => entry.id === afterPageId) + 1 : pages.length)), 0, page)
      const next = pages.map((entry, position) => ({ ...entry, position }))
      set((state) => ({
        pages: next,
        note: state.note ? { ...state.note, pageCount: next.length } : null,
        activePageId: page.id,
        activePageIndex: next.findIndex((entry) => entry.id === page.id),
        contentVersion: state.contentVersion + 1,
      }))
      const after = currentSnapshot()
      if (before && after) pushEntry({ kind: 'note', before, after, label: 'page-add' })
    },

    async duplicatePage(pageId) {
      const note = get().note
      if (!note) return
      const before = currentSnapshot()
      await get().saveAll()
      const page = await inknoteApi.duplicatePage(note.id, pageId)
      const pages = [...get().pages, page].sort((a, b) => a.position - b.position).map((entry, position) => ({ ...entry, position }))
      set((state) => ({
        pages,
        note: state.note ? { ...state.note, pageCount: pages.length } : null,
        activePageId: page.id,
        activePageIndex: pages.findIndex((entry) => entry.id === page.id),
        contentVersion: state.contentVersion + 1,
      }))
      const after = currentSnapshot()
      if (before && after) pushEntry({ kind: 'note', before, after, label: 'page-duplicate' })
    },

    async deletePage(pageId) {
      const note = get().note
      if (!note) return
      const before = currentSnapshot()
      const removedIndex = get().pages.findIndex((page) => page.id === pageId)
      const activeId = get().activePageId
      await inknoteApi.deletePage(note.id, pageId)
      dirtyPages.delete(pageId)
      const pages = get().pages.filter((page) => page.id !== pageId).map((page, position) => ({ ...page, position }))
      const remainingActive = pages.findIndex((page) => page.id === activeId)
      const nextIndex = activeId === pageId
        ? Math.max(0, Math.min(removedIndex, pages.length - 1))
        : Math.max(0, remainingActive)
      set((state) => ({
        pages,
        note: state.note ? { ...state.note, pageCount: pages.length } : null,
        activePageId: pages[nextIndex]?.id ?? null,
        activePageIndex: nextIndex,
        contentVersion: state.contentVersion + 1,
      }))
      const after = currentSnapshot()
      if (before && after) pushEntry({ kind: 'note', before, after, label: 'page-delete' })
    },

    async clearPage(pageId) {
      const page = get().pages.find((entry) => entry.id === pageId)
      if (!page) return
      const before = serializePageContent(page.content)
      const empty = emptyPageContent()
      get().replacePageContent(pageId, empty)
      await get().savePage(pageId)
      pushEntry({ kind: 'content', pageId, before, after: serializePageContent(empty), label: 'page-clear' })
    },

    async deleteBlankPages() {
      const pages = get().pages
      const blanks = pages.filter((page) => isEmptyPage(page.content))
      let removed = 0
      for (const page of blanks) {
        if (get().pages.length <= 1) break
        await get().deletePage(page.id)
        removed += 1
      }
      return removed
    },

    async reorderPages(pageIds) {
      const note = get().note
      if (!note) return
      const before = currentSnapshot()
      await inknoteApi.reorderPages(note.id, pageIds)
      const byId = new Map(get().pages.map((page) => [page.id, page]))
      const pages = pageIds.flatMap((id, position) => {
        const page = byId.get(id)
        return page ? [{ ...page, position }] : []
      })
      set((state) => ({ pages, contentVersion: state.contentVersion + 1 }))
      const after = currentSnapshot()
      if (before && after && !samePageOrder(before.pages, after.pages)) pushEntry({ kind: 'note', before, after, label: 'page-order' })
    },

    async copyPageTo(targetNoteId, pageId) {
      const note = get().note
      if (!note) return
      await get().savePage(pageId)
      await inknoteApi.copyPage(targetNoteId, note.id, pageId)
      if (targetNoteId === note.id) await get().openNote(note.id)
    },

    async updateSettings(patch) {
      const current = get().library?.settings ?? DEFAULT_INKNOTE_SETTINGS
      const next = sanitizeInknoteSettings({ ...current, ...patch })
      set((state) => ({
        library: state.library ? { ...state.library, settings: next } : state.library,
      }))
      scheduleSettings(next)
    },

    async resetSettings() {
      set((state) => ({
        library: state.library ? { ...state.library, settings: sanitizeInknoteSettings(DEFAULT_INKNOTE_SETTINGS) } : state.library,
      }))
      await get().updateSettings(DEFAULT_INKNOTE_SETTINGS)
    },

    async refreshTemplates() {
      const templates = await inknoteApi.templates()
      set((state) => ({
        library: state.library ? { ...state.library, templates: templates.templates } : state.library,
      }))
    },
    async addTemplate(input) {
      await inknoteApi.createTemplate(input)
      await get().refreshTemplates()
    },
    async removeTemplate(id) {
      await inknoteApi.deleteTemplate(id)
      await get().refreshTemplates()
    },

    recordContentHistory(pageId, before, after, label) {
      if (before === after) return
      pushEntry({ kind: 'content', pageId, before, after, label })
    },

    async undo() {
      if (get().applyingHistory || get().replaying) return
      const entry = get().undoStack[get().undoStack.length - 1]
      if (!entry) return
      const undoStack = get().undoStack.slice(0, -1)
      const redoStack = [...get().redoStack, entry]
      set({ applyingHistory: true })
      try {
        await applyEntry(entry, 'before')
        set({ undoStack, redoStack })
      } catch (error) {
        set({ error: message(error) })
      } finally {
        set({ applyingHistory: false })
      }
    },

    async redo() {
      if (get().applyingHistory || get().replaying) return
      const entry = get().redoStack[get().redoStack.length - 1]
      if (!entry) return
      const redoStack = get().redoStack.slice(0, -1)
      const undoStack = [...get().undoStack, entry]
      set({ applyingHistory: true })
      try {
        await applyEntry(entry, 'after')
        set({ undoStack, redoStack })
      } catch (error) {
        set({ error: message(error) })
      } finally {
        set({ applyingHistory: false })
      }
    },

    clearConflict(pageId) {
      set((state) => {
        const conflicts = { ...state.conflicts }
        delete conflicts[pageId]
        return { conflicts, saveState: 'idle', saveError: null }
      })
    },

    async restoreDrafts() {
      const { note, drafts } = get()
      if (!note) return
      for (const [pageId, draft] of Object.entries(drafts)) {
        get().replacePageContent(pageId, draft.content)
        const saved = await get().savePage(pageId)
        if (!saved) continue
        set((state) => {
          const next = { ...state.drafts }
          delete next[pageId]
          return { drafts: next }
        })
      }
    },

    beginReplay() {
      set({ replaying: true })
    },

    applyReplayContent(pageId, content) {
      set((state) => ({
        pages: state.pages.map((page) => page.id === pageId ? { ...page, content } : page),
        contentVersion: state.contentVersion + 1,
      }))
    },

    endReplay(snapshot) {
      set((state) => ({
        replaying: false,
        pages: state.pages.map((page) => snapshot.has(page.id) ? { ...page, content: snapshot.get(page.id)! } : page),
        contentVersion: state.contentVersion + 1,
      }))
    },

    async replayOfflineDrafts() {
      const { note, drafts } = get()
      if (!note) return
      for (const [pageId, draft] of Object.entries(drafts)) {
        if (!draft.offline) continue
        get().replacePageContent(pageId, draft.content)
        const saved = await get().savePage(pageId)
        if (saved) {
          set((state) => {
            const next = { ...state.drafts }
            delete next[pageId]
            return { drafts: next }
          })
        }
      }
    },

    discardDrafts() {
      const { note, drafts } = get()
      if (!note) return
      for (const pageId of Object.keys(drafts)) {
        try { localStorage.removeItem(`inknote-draft:${note.id}:${pageId}`) } catch { /* storage may be unavailable */ }
      }
      set({ drafts: {} })
    },
  }
})

export function useInknoteSettings(): InknoteSettings {
  return useInknoteStore((state) => state.library?.settings ?? DEFAULT_INKNOTE_SETTINGS)
}
