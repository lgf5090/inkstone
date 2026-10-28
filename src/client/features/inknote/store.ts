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
  drafts: Record<string, { content: InknotePageContent; savedAt: number }>
  loading: boolean
  opening: boolean
  error: string | null
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
}

const saveTimers = new Map<string, number>()
const inFlight = new Set<string>()
const SAVE_DELAY = 1_200
const AUTO_SNAPSHOT_DELAY = 45_000
let autoSnapshotAt = 0
let autoSnapshotInFlight = false

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
    const { note, pages } = get()
    if (!note) return false
    const page = pages.find((entry) => entry.id === pageId)
    if (!page) return false
    if (inFlight.has(pageId)) return true
    inFlight.add(pageId)
    set({ saveState: 'saving', saveError: null })
    try {
      const content = serializePageContent(page.content)
      const saved = await inknoteApi.savePage(note.id, pageId, content, page.rev)
      try { localStorage.removeItem(`inknote-draft:${note.id}:${pageId}`) } catch { /* storage may be unavailable */ }
      set((state) => ({
        pages: state.pages.map((entry) => entry.id === pageId ? { ...entry, rev: saved.rev, updatedAt: saved.updatedAt } : entry),
        note: state.note ? { ...state.note, updatedAt: saved.updatedAt, contentBytes: state.note.contentBytes } : null,
        saveState: 'saved',
      }))
      get().refreshLibrary().catch(() => {})
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
          return false
        }
      }
      const offline = error instanceof ApiError ? error.status === 0 : true
      try { localStorage.setItem(`inknote-draft:${note.id}:${pageId}`, JSON.stringify({ content: serializePageContent(page.content), baseRev: page.rev, savedAt: Date.now() })) } catch { /* storage may be unavailable */ }
      set({ saveState: offline ? 'offline' : 'error', saveError: message(error) })
      return false
    } finally {
      inFlight.delete(pageId)
    }
  }

  function scheduleSave(pageId: string) {
    const existing = saveTimers.get(pageId)
    if (existing) window.clearTimeout(existing)
    set({ saveState: 'pending' })
    saveTimers.set(pageId, window.setTimeout(() => {
      saveTimers.delete(pageId)
      void persist(pageId)
    }, SAVE_DELAY))
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
    loading: false,
    opening: false,
    error: null,
    settingsUpdatedAt: 0,
    initialized: false,

    async bootstrap() {
      if (get().loading) return
      set({ loading: true, error: null })
      try {
        const [library, settings, templates, trash] = await Promise.all([
          inknoteApi.library(),
          inknoteApi.settings(),
          inknoteApi.templates(),
          inknoteApi.trash(),
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
          // Trash is listed by the UI on demand; keeping the note count in the library is enough.
          ...(trash.notes.length ? {} : {}),
        })
      } catch (error) {
        set({ loading: false, initialized: true, error: message(error) })
      }
    },

    async refreshLibrary() {
      try {
        const library = await inknoteApi.library()
        set((state) => ({
          library: {
            subjects: library.subjects,
            notebooks: library.notebooks,
            notes: library.notes,
            settings: state.library?.settings ?? sanitizeInknoteSettings(library.settings),
            templates: state.library?.templates ?? library.templates,
          },
        }))
      } catch {
        // A background refresh is allowed to miss; the next save or focus retries it.
      }
    },

    async openNote(id, pageIndex = 0) {
      await get().saveAll()
      set({ opening: true, error: null })
      try {
        const response = await inknoteApi.note(id, 'all')
        const index = Math.min(Math.max(0, pageIndex), Math.max(0, response.pages.length - 1))
        const drafts: InknoteState['drafts'] = {}
        for (const page of response.pages) {
          try {
            const raw = localStorage.getItem(`inknote-draft:${id}:${page.id}`)
            if (!raw) continue
            const parsed = JSON.parse(raw) as { content?: unknown; savedAt?: unknown }
            const content = parseInknotePageContent(typeof parsed.content === 'string' ? parsed.content : '')
            if (content.ok) drafts[page.id] = { content: content.content, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 }
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
          saveState: 'saved',
        }))
      } catch (error) {
        set({ opening: false, error: message(error) })
      }
    },

    closeNote() {
      void get().saveAll()
      set({ note: null, pages: [], activePageId: null, activePageIndex: 0, conflicts: {}, drafts: {} })
    },

    closeTab(id) {
      const tabs = get().tabs.filter((tab) => tab !== id)
      set({ tabs })
      if (get().note?.id !== id) return
      const next = tabs[0]
      if (next) { void get().openNote(next); return }
      void get().saveAll()
      set({ note: null, pages: [], activePageId: null, activePageIndex: 0, conflicts: {}, drafts: {} })
    },

    setActivePage(id) {
      const index = get().pages.findIndex((page) => page.id === id)
      if (index < 0) return
      void get().savePage(get().activePageId ?? undefined)
      set((state) => ({ activePageId: id, activePageIndex: index, contentVersion: state.contentVersion + 1 }))
    },

    touchPage() {
      set((state) => ({
        contentVersion: state.contentVersion + 1,
        saveState: state.conflicts[state.activePageId ?? ''] ? 'conflict' : 'pending',
      }))
      if (get().activePageId) scheduleSave(get().activePageId!)
    },

    replacePageContent(pageId, content) {
      set((state) => ({
        pages: state.pages.map((page) => page.id === pageId ? { ...page, content } : page),
        contentVersion: state.contentVersion + 1,
      }))
      scheduleSave(pageId)
    },

    async savePage(pageId) {
      const target = pageId ?? get().activePageId
      if (!target) return true
      const timer = saveTimers.get(target)
      if (timer) { window.clearTimeout(timer); saveTimers.delete(target) }
      return persist(target)
    },

    async saveAll() {
      for (const timer of saveTimers.values()) window.clearTimeout(timer)
      saveTimers.clear()
      const ids = get().pages.map((page) => page.id)
      for (const id of ids) await persist(id)
    },

    async createNote(notebookId, title) {
      const library = get().library
      const target = notebookId ?? library?.notebooks[0]?.id
      if (!target) { set({ error: 'Create a notebook first' }); return null }
      try {
        const response = await inknoteApi.createNote({ notebookId: target, title })
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
        ...(state.note?.id === id ? { note: null, pages: [], activePageId: null, activePageIndex: 0 } : {}),
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
    },

    async duplicatePage(pageId) {
      const note = get().note
      if (!note) return
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
    },

    async deletePage(pageId) {
      const note = get().note
      if (!note) return
      await inknoteApi.deletePage(note.id, pageId)
      const pages = get().pages.filter((page) => page.id !== pageId).map((page, position) => ({ ...page, position }))
      const nextIndex = Math.max(0, Math.min(get().activePageIndex, pages.length - 1))
      set((state) => ({
        pages,
        note: state.note ? { ...state.note, pageCount: pages.length } : null,
        activePageId: pages[nextIndex]?.id ?? null,
        activePageIndex: nextIndex,
        contentVersion: state.contentVersion + 1,
      }))
    },

    async clearPage(pageId) {
      const page = get().pages.find((entry) => entry.id === pageId)
      if (!page) return
      get().replacePageContent(pageId, emptyPageContent())
      await get().savePage(pageId)
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

    async reorderPages(pageIds) {      const note = get().note
      if (!note) return
      await inknoteApi.reorderPages(note.id, pageIds)
      const byId = new Map(get().pages.map((page) => [page.id, page]))
      const pages = pageIds.flatMap((id, position) => {
        const page = byId.get(id)
        return page ? [{ ...page, position }] : []
      })
      set((state) => ({ pages, contentVersion: state.contentVersion + 1 }))
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
      try {
        const saved = await inknoteApi.saveSettings(next, get().settingsUpdatedAt || undefined)
        set({ settingsUpdatedAt: saved.updatedAt })
      } catch (error) {
        set({ error: message(error) })
      }
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
