import { create } from 'zustand'
import type {
  NavBootstrap,
  NavCategory,
  NavCounts,
  NavDisplaySettings,
  NavLink,
  NavSearchSettings,
  NavVisit,
  NavWebdavSettings,
} from '@shared/nav/model'
import { DEFAULT_NAV_SETTINGS } from '@shared/nav/model'
import { useSession } from '../../store/session'
import { navApi } from './api'

export type NavSyncState = 'idle' | 'saving' | 'saved' | 'error'
export type NavStatus = 'loading' | 'ready' | 'error'

interface NavState {
  status: NavStatus
  error: string | null
  categories: NavCategory[]
  links: NavLink[]
  visits: Record<string, NavVisit>
  counts: NavCounts
  settings: NavBootstrap['settings']
  webdav: NavWebdavSettings
  sync: NavSyncState
  unlockTokens: Record<string, string>
  selectedCategory: string | null
  selectedSubcategory: string | null
  query: string
  load: (force?: boolean) => Promise<void>
  unlock: (categoryId: string, password: string) => Promise<void>
  setQuery: (query: string) => void
  selectCategory: (categoryId: string | null, subcategoryId?: string | null) => void
  createCategory: (body: unknown) => Promise<NavCategory>
  updateCategory: (id: string, body: unknown) => Promise<NavCategory>
  deleteCategory: (id: string, fallbackCategoryId: string) => Promise<void>
  reorderCategories: (parentId: string | null, orderedIds: string[]) => Promise<void>
  reorderCategoryGroups: (groups: { parentId: string | null; orderedIds: string[] }[]) => Promise<void>
  createLink: (body: unknown) => Promise<NavLink>
  updateLink: (id: string, body: unknown) => Promise<NavLink>
  deleteLink: (id: string) => Promise<void>
  reorderLinks: (scope: 'pinned' | 'category', orderedIds: string[], categoryId?: string) => Promise<void>
  batch: (body: { action: 'delete' | 'move' | 'rewrite'; ids: string[]; fallbackCategoryId?: string; template?: string }) => Promise<void>
  saveDisplay: (value: NavDisplaySettings) => Promise<void>
  saveSearch: (value: NavSearchSettings) => Promise<void>
  saveAiModel: (modelId: string) => Promise<void>
  recordVisit: (link: NavLink) => void
  flushVisits: (keepalive?: boolean) => void
}

interface CacheEntry {
  userId: string
  data: NavBootstrap
}

let cache: CacheEntry | null = null
let visitTimer: ReturnType<typeof setTimeout> | null = null
let pendingVisits = new Map<string, number>()
let listenersInstalled = false

function currentUserId(): string | null {
  return useSession.getState().user?.id ?? null
}

function unlockKey(userId: string): string {
  return `inkstone.nav.unlocks.${userId}`
}

function readUnlockTokens(userId: string): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.sessionStorage.getItem(unlockKey(userId))
    const parsed = raw ? JSON.parse(raw) as unknown : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function writeUnlockTokens(userId: string, tokens: Record<string, string>): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(unlockKey(userId), JSON.stringify(tokens))
  } catch {
    // A full session storage must not take the navigation app down; the tokens live in memory too.
  }
}

function installVisitFlush(): void {
  if (listenersInstalled || typeof window === 'undefined') return
  listenersInstalled = true
  const flush = () => useNavStore.getState().flushVisits(true)
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  // The store is a module singleton, so this listener is intentionally never removed; a page is the
  // lifetime of this app and a second one after a full reload starts from a new module graph.
}

function applyBootstrap(data: NavBootstrap): Partial<NavState> {
  return {
    status: 'ready',
    error: null,
    categories: data.categories,
    links: data.links,
    visits: data.visits,
    counts: data.counts,
    settings: data.settings,
    webdav: data.webdav,
  }
}

export const useNavStore = create<NavState>((set, get) => {
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    set({ sync: 'saving' })
    try {
      const result = await task()
      set({ sync: 'saved' })
      setTimeout(() => {
        if (get().sync === 'saved') set({ sync: 'idle' })
      }, 1500)
      return result
    } catch (error) {
      set({ sync: 'error' })
      throw error
    }
  }

  const refresh = async (): Promise<void> => {
    const user = currentUserId()
    if (!user) {
      set({ status: 'error', error: 'unauthenticated' })
      return
    }
    const tokens = { ...get().unlockTokens, ...readUnlockTokens(user) }
    const data = await navApi.bootstrap(Object.values(tokens))
    cache = { userId: user, data }
    set({ ...applyBootstrap(data), unlockTokens: tokens })
  }

  return {
    status: 'loading',
    error: null,
    categories: [],
    links: [],
    visits: {},
    counts: { total: 0, byCategory: {} },
    settings: DEFAULT_NAV_SETTINGS,
    webdav: { url: '', username: '', hasPassword: false },
    sync: 'idle',
    unlockTokens: {},
    selectedCategory: null,
    selectedSubcategory: null,
    query: '',

    async load(force = false) {
      installVisitFlush()
      const user = currentUserId()
      if (!user) {
        set({ status: 'error', error: 'unauthenticated' })
        return
      }
      const tokens = readUnlockTokens(user)
      if (!force && cache?.userId === user) {
        set({ ...applyBootstrap(cache.data), unlockTokens: tokens })
      } else {
        set({ status: 'loading', error: null })
      }
      try {
        const data = await navApi.bootstrap(Object.values(tokens))
        cache = { userId: user, data }
        set({ ...applyBootstrap(data), unlockTokens: tokens })
      } catch (error) {
        if (cache?.userId === user) {
          set({ status: 'ready', error: error instanceof Error ? error.message : 'load_failed' })
        } else {
          set({ status: 'error', error: error instanceof Error ? error.message : 'load_failed' })
        }
      }
    },

    async unlock(categoryId, password) {
      const user = currentUserId()
      if (!user) throw new Error('unauthenticated')
      const { token } = await run(() => navApi.unlockCategory(categoryId, password))
      const tokens = { ...get().unlockTokens, [categoryId]: token }
      writeUnlockTokens(user, tokens)
      set({ unlockTokens: tokens })
      await refresh()
    },

    setQuery(query) {
      set({ query })
    },

    selectCategory(categoryId, subcategoryId = null) {
      set({ selectedCategory: categoryId, selectedSubcategory: subcategoryId })
    },

    async createCategory(body) {
      const { category } = await run(() => navApi.createCategory(body))
      await refresh()
      return category
    },

    async updateCategory(id, body) {
      const { category } = await run(() => navApi.updateCategory(id, body))
      await refresh()
      return category
    },

    async deleteCategory(id, fallbackCategoryId) {
      await run(() => navApi.deleteCategory(id, fallbackCategoryId))
      if (get().selectedCategory === id || get().selectedSubcategory === id) {
        set({ selectedCategory: null, selectedSubcategory: null })
      }
      await refresh()
    },

    async reorderCategories(parentId, orderedIds) {
      await run(() => navApi.orderCategories(parentId, orderedIds))
      await refresh()
    },

    async reorderCategoryGroups(groups) {
      await run(async () => {
        for (const group of groups) await navApi.orderCategories(group.parentId, group.orderedIds)
      })
      await refresh()
    },

    async createLink(body) {
      const { link } = await run(() => navApi.createLink(body))
      await refresh()
      return link
    },

    async updateLink(id, body) {
      const { link } = await run(() => navApi.updateLink(id, body))
      await refresh()
      return link
    },

    async deleteLink(id) {
      await run(() => navApi.deleteLink(id))
      await refresh()
    },

    async reorderLinks(scope, orderedIds, categoryId) {
      await run(() => navApi.orderLinks({ scope, categoryId, orderedIds }, Object.values(get().unlockTokens)))
      await refresh()
    },

    async batch(body) {
      await run(() => navApi.batch(body))
      await refresh()
    },

    async saveDisplay(value) {
      await run(() => navApi.saveSettings('display', value))
      set({ settings: { ...get().settings, display: value } })
    },

    async saveSearch(value) {
      await run(() => navApi.saveSettings('search', value))
      set({ settings: { ...get().settings, search: value } })
    },

    async saveAiModel(modelId) {
      const value = { modelId }
      await run(() => navApi.saveSettings('ai', value))
      set({ settings: { ...get().settings, ai: value } })
    },

    recordVisit(link) {
      const previous = get().visits[link.id] ?? { lastVisitedAt: 0, visitCount: 0 }
      const next = { lastVisitedAt: Date.now(), visitCount: previous.visitCount + 1 }
      set({ visits: { ...get().visits, [link.id]: next } })
      pendingVisits.set(link.id, (pendingVisits.get(link.id) ?? 0) + 1)
      if (visitTimer) clearTimeout(visitTimer)
      visitTimer = setTimeout(() => get().flushVisits(false), 2000)
    },

    flushVisits(keepalive = false) {
      if (visitTimer) {
        clearTimeout(visitTimer)
        visitTimer = null
      }
      if (!pendingVisits.size) return
      const visits = [...pendingVisits].map(([linkId, count]) => ({ linkId, count }))
      pendingVisits = new Map()
      void navApi.visits(visits, keepalive).catch((error) => {
        for (const visit of visits) pendingVisits.set(visit.linkId, (pendingVisits.get(visit.linkId) ?? 0) + visit.count)
        console.warn('[inkstone] Navigation visit sync failed', error instanceof Error ? error.message : error)
      })
    },
  }
})

export function clearNavSessionState(): void {
  if (typeof window !== 'undefined') {
    try {
      for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = window.sessionStorage.key(index)
        if (key?.startsWith('inkstone.nav.unlocks.')) window.sessionStorage.removeItem(key)
      }
    } catch {
      // Storage may be unavailable in private windows; the in-memory state below still clears.
    }
  }
  if (visitTimer) clearTimeout(visitTimer)
  visitTimer = null
  pendingVisits = new Map()
  cache = null
  useNavStore.setState({
    status: 'loading',
    error: null,
    categories: [],
    links: [],
    visits: {},
    counts: { total: 0, byCategory: {} },
    settings: DEFAULT_NAV_SETTINGS,
    webdav: { url: '', username: '', hasPassword: false },
    sync: 'idle',
    unlockTokens: {},
    selectedCategory: null,
    selectedSubcategory: null,
    query: '',
  })
}
