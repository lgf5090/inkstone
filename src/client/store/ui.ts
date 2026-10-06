import { create } from 'zustand'
import type { AccentName, BackgroundName, DateRangeFilter, EditorLayout, SortKey, SortOrder, ThemePref, UiDensity, ViewKind } from '@shared/types'
import { ACCENTS, LIMITS, VIEW_KINDS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import { tagKey } from '@shared/markdown-utils'
import { UI_STORAGE_KEY } from '../lib/runtime'


const STORAGE_KEY = UI_STORAGE_KEY

export type PanelName =
  | 'command'
  | 'settings'
  | 'shortcuts'
  | 'graph'
  | 'folders'
  | 'versions'
  | 'share'
  | 'info'

export type WorkspacePane = 'primary' | 'secondary'

export interface ToastItem {
  id: string
  title: string
  description?: string
  tone: 'default' | 'success' | 'danger' | 'warning'
  action?: { label: string; run: () => void }
  duration: number
}

interface UiState {

  navWidth: number
  listWidth: number
  navCollapsed: boolean
  listCollapsed: boolean
  searchList: boolean
  searchQuery: string
  searchRequest: number

  navDrawerOpen: boolean
  splitRatio: number | null
  /** A 0…1 ratio of the travel space, so resizing the window keeps the panel where the reader put it. */
  outlineFloatingPosition: { x: number; y: number } | null
  workspaceSplitRatio: number | null
  workspacePrimaryNoteId: string | null
  workspaceSecondaryNoteId: string | null
  activeWorkspacePane: WorkspacePane
  workspacePaneLayouts: Record<WorkspacePane, EditorLayout>
  mobilePane: 'nav' | 'list' | 'editor' | 'preview' | 'account'


  view: ViewKind
  folderId: string | null
  /** Tag filters in effect; one tag also matches its subtree, and several combine with AND. */
  tags: string[]
  /** Tags hidden from every view, matched subtree-wide exactly like `tags`. */
  excludedTags: string[]
  dateFilter: DateRangeFilter | null
  calendarJump: { year: number; month: number; nonce: number } | null
  sort: SortKey
  order: SortOrder
  density: UiDensity
  expandedFolders: string[]


  activeNoteId: string | null
  selectedIds: string[]
  recentNoteIds: string[]


  panel: PanelName | null
  outlineOpen: boolean
  backlinksOpen: boolean
  localGraphOpen: boolean
  toasts: ToastItem[]
  lightbox: { src: string; alt: string } | null


  theme: ThemePref
  accent: AccentName
  background: BackgroundName
  fontScale: number


  setLayout: (patch: Partial<Pick<UiState, 'navWidth' | 'listWidth' | 'splitRatio' | 'workspaceSplitRatio' | 'outlineFloatingPosition'>>) => void
  setWorkspacePaneLayout: (pane: WorkspacePane, layout: EditorLayout) => void
  setWorkspaceNote: (pane: WorkspacePane, id: string | null, activate?: boolean, revealOnMobile?: boolean) => void
  activateWorkspacePane: (pane: WorkspacePane) => void
  closeSecondaryNote: () => void
  removeWorkspaceNote: (id: string) => void
  toggleNav: () => void
  toggleNavDrawer: (open?: boolean) => void
  toggleList: () => void
  openSearchList: (seed?: string) => void
  setSearchQuery: (value: string) => void
  openExplorer: (folderId?: string | null) => void
  setMobilePane: (pane: UiState['mobilePane']) => void
  openView: (view: ViewKind, options?: { folderId?: string | null; tag?: string | null; tags?: readonly string[] }) => void
  toggleTagFilter: (tag: string, additive: boolean) => void
  toggleTagExclusion: (tag: string) => void
  setDateFilter: (value: DateRangeFilter | null) => void
  requestCalendarJump: (year: number, month: number) => void
  setSort: (sort: SortKey, order?: SortOrder) => void
  setDensity: (density: UiDensity) => void
  toggleFolder: (id: string) => void
  expandFolder: (id: string) => void
  setActiveNote: (id: string | null) => void
  setSelected: (ids: string[]) => void
  toggleSelected: (id: string, additive: boolean) => void
  openPanel: (panel: PanelName) => void
  closePanel: () => void
  togglePanel: (panel: PanelName) => void
  toggleOutline: () => void
  toggleBacklinks: () => void
  toggleLocalGraph: () => void
  showBacklinks: () => void
  setLightbox: (value: UiState['lightbox']) => void
  toast: (input: Omit<ToastItem, 'id' | 'duration' | 'tone'> & { tone?: ToastItem['tone']; duration?: number }) => string
  dismissToast: (id: string) => void
  applyAppearance: (patch: { theme?: ThemePref; accent?: AccentName; background?: BackgroundName; fontScale?: number }) => void
}

export const PANEL_WIDTHS = {
  navigation: { min: 196, max: 380 },
  noteList: { min: 260, max: 520 },
} as const

export const DEFAULT_LAYOUT = {
  navWidth: PANEL_WIDTHS.navigation.min,
  listWidth: PANEL_WIDTHS.noteList.min,
  splitRatio: null as number | null,
  outlineFloatingPosition: null as { x: number; y: number } | null,
} as const

const DEFAULTS = {
  ...DEFAULT_LAYOUT,
  navCollapsed: false,
  listCollapsed: true,
  view: 'all' as ViewKind,
  folderId: null,
  tags: [] as string[],
  excludedTags: [] as string[],
  dateFilter: null as DateRangeFilter | null,
  calendarJump: null as { year: number; month: number; nonce: number } | null,
  sort: 'updated' as SortKey,
  order: 'desc' as SortOrder,
  density: 'comfortable' as UiDensity,
  expandedFolders: [] as string[],
  activeNoteId: null,
  workspaceSplitRatio: null as number | null,
  workspacePrimaryNoteId: null as string | null,
  workspaceSecondaryNoteId: null as string | null,
  activeWorkspacePane: 'primary' as WorkspacePane,
  workspacePaneLayouts: { primary: 'live', secondary: 'live' } as Record<WorkspacePane, EditorLayout>,
  recentNoteIds: [] as string[],
  theme: 'system' as ThemePref,
  accent: 'indigo' as AccentName,
  background: 'paper' as BackgroundName,
  fontScale: 16,
}

const PERSISTED_KEYS = [
  'navWidth',
  'listWidth',
  'navCollapsed',
  'splitRatio',
  'outlineFloatingPosition',
  'workspaceSplitRatio',
  'workspacePrimaryNoteId',
  'workspaceSecondaryNoteId',
  'activeWorkspacePane',
  'workspacePaneLayouts',
  'view',
  'folderId',
  'tags',
  'excludedTags',
  'sort',
  'order',
  'density',
  'expandedFolders',
  'activeNoteId',
  'recentNoteIds',
  'theme',
  'accent',
  'background',
  'fontScale',
] as const

function loadPersisted(): Partial<UiState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const value = parsed as Record<string, unknown>
    const out: Partial<UiState> = {}

    if (isFiniteNumber(value.navWidth)) {
      out.navWidth = clamp(value.navWidth, PANEL_WIDTHS.navigation.min, PANEL_WIDTHS.navigation.max)
    }
    if (isFiniteNumber(value.listWidth)) {
      out.listWidth = clamp(value.listWidth, PANEL_WIDTHS.noteList.min, PANEL_WIDTHS.noteList.max)
    }
    if (typeof value.navCollapsed === 'boolean') out.navCollapsed = value.navCollapsed
    if (isFiniteNumber(value.splitRatio)) out.splitRatio = clamp(value.splitRatio, 0.2, 0.8)
    if (isRatioPoint(value.outlineFloatingPosition)) out.outlineFloatingPosition = value.outlineFloatingPosition
    if (isFiniteNumber(value.workspaceSplitRatio)) {
      out.workspaceSplitRatio = clamp(value.workspaceSplitRatio, 0.2, 0.8)
    }
    if (isChoice(value.view, VIEW_KINDS)) out.view = value.view as ViewKind
    if (value.folderId === null || typeof value.folderId === 'string') {
      out.folderId = value.folderId?.slice(0, 128) ?? null
    }
    if (Array.isArray(value.tags)) {
      out.tags = tagFilter(value.tags)
    }
    if (Array.isArray(value.excludedTags)) {
      out.excludedTags = tagFilter(value.excludedTags)
    }
    if (isChoice(value.sort, ['updated', 'created', 'title'])) out.sort = value.sort as SortKey
    if (isChoice(value.order, ['asc', 'desc'])) out.order = value.order as SortOrder
    if (isChoice(value.density, ['comfortable', 'compact'])) out.density = value.density as UiDensity
    if (Array.isArray(value.expandedFolders)) {
      out.expandedFolders = uniqueStrings(value.expandedFolders, 500)
    }
    if (value.activeNoteId === null || typeof value.activeNoteId === 'string') {
      out.activeNoteId = value.activeNoteId?.slice(0, 128) ?? null
    }
    if (value.workspacePrimaryNoteId === null || typeof value.workspacePrimaryNoteId === 'string') {
      out.workspacePrimaryNoteId = value.workspacePrimaryNoteId?.slice(0, 128) ?? null
    }
    if (value.workspaceSecondaryNoteId === null || typeof value.workspaceSecondaryNoteId === 'string') {
      out.workspaceSecondaryNoteId = value.workspaceSecondaryNoteId?.slice(0, 128) ?? null
    }
    if (isChoice(value.activeWorkspacePane, ['primary', 'secondary'])) {
      out.activeWorkspacePane = value.activeWorkspacePane as WorkspacePane
    }
    if (value.workspacePaneLayouts && typeof value.workspacePaneLayouts === 'object' && !Array.isArray(value.workspacePaneLayouts)) {
      const layouts = value.workspacePaneLayouts as Record<string, unknown>
      out.workspacePaneLayouts = {
        primary: layouts.primary === 'preview' ? 'preview' : layouts.primary === 'split' ? 'split' : 'live',
        secondary: layouts.secondary === 'preview' ? 'preview' : layouts.secondary === 'split' ? 'split' : 'live',
      }
    }
    if (Array.isArray(value.recentNoteIds)) {
      out.recentNoteIds = uniqueStrings(value.recentNoteIds, 24)
    }
    if (isChoice(value.theme, ['light', 'dark', 'system'])) out.theme = value.theme as ThemePref
    if (isChoice(value.accent, ACCENTS.map((accent) => accent.name))) {
      out.accent = value.accent as AccentName
    }
    if (isChoice(value.background, ['paper', 'white'])) {
      out.background = value.background as BackgroundName
    }
    if (isFiniteNumber(value.fontScale)) out.fontScale = clamp(Math.round(value.fontScale), 13, 22)
    if (!out.workspaceSecondaryNoteId) {
      out.workspacePrimaryNoteId = null
      out.activeWorkspacePane = 'primary'
    } else if (!out.workspacePrimaryNoteId) {
      out.workspacePrimaryNoteId = out.activeNoteId ?? null
    }
    if (out.workspaceSecondaryNoteId && out.workspacePrimaryNoteId) {
      out.activeNoteId = out.activeWorkspacePane === 'secondary'
        ? out.workspaceSecondaryNoteId
        : out.workspacePrimaryNoteId
    }
    return out
  } catch {
    return {}
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRatioPoint(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const point = value as Record<string, unknown>
  return isFiniteNumber(point.x) && isFiniteNumber(point.y)
}

function tagFilter(value: readonly unknown[]): string[] {
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => truncateText(item.trim(), LIMITS.tagNameMaxLength))
    .filter(Boolean)
  return uniqueStrings(names, LIMITS.tagFilterMax)
}

// Tag identity is tagKey-folded everywhere else (facets, subtree matching, the worker's
// `COLLATE NOCASE`), so a filter list has to compare names the same way: a width- or
// case-variant would otherwise occupy two slots that match exactly the same notes.
function hasTag(list: readonly string[], name: string): boolean {
  const key = tagKey(name)
  return list.some((item) => tagKey(item) === key)
}

function dropTag(list: readonly string[], name: string): string[] {
  const key = tagKey(name)
  return list.filter((item) => tagKey(item) !== key)
}

function isChoice(value: unknown, choices: readonly string[]): value is string {
  return typeof value === 'string' && choices.includes(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function uniqueStrings(value: unknown[], limit: number): string[] {
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    .slice(0, limit)
    .map((item) => item.slice(0, 128))
}

function activatedNoteFields(state: UiState, id: string | null, pane: WorkspacePane, revealOnMobile = true): Partial<UiState> {
  return {
    activeNoteId: id,
    activeWorkspacePane: pane,
    selectedIds: id ? [id] : [],
    recentNoteIds: id
      ? [id, ...state.recentNoteIds.filter((recentId) => recentId !== id)].slice(0, 24)
      : state.recentNoteIds,
    mobilePane: id && revealOnMobile ? 'preview' : state.mobilePane,
  }
}

let persistTimer: number | undefined
let lastPersisted = ''

function serializedPersistedState(state: UiState): string {
  const out: Record<string, unknown> = {}
  for (const key of PERSISTED_KEYS) out[key] = state[key]
  return JSON.stringify(out)
}

function schedulePersist(): void {
  // The subscriber fires on every notification, including the ones that change nothing
  // persisted (toasts, selection). Serializing 22 keys per keystroke cost more than the
  // localStorage write the 220 ms debounce already coalesces, so serialization waits too.
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    const serialized = serializedPersistedState(useUi.getState())
    if (serialized === lastPersisted) return
    try {
      localStorage.setItem(STORAGE_KEY, serialized)
      lastPersisted = serialized
    } catch {

    }
  }, 220)
}

let toastSeq = 0

export const useUi = create<UiState>((set, get) => ({
  ...DEFAULTS,
  selectedIds: [],
  navDrawerOpen: false,
  panel: null,
  outlineOpen: false,
  backlinksOpen: false,
  localGraphOpen: false,
  toasts: [],
  lightbox: null,
  mobilePane: 'list',
  searchList: false,
  searchQuery: '',
  searchRequest: 0,
  ...loadPersisted(),

  setLayout: (patch) => set(patch),
  setWorkspacePaneLayout: (pane, layout) => set((state) => ({
    workspacePaneLayouts: { ...state.workspacePaneLayouts, [pane]: layout },
  })),
  setWorkspaceNote: (pane, id, activate = true, revealOnMobile = true) => set((state) => {
    if (pane === 'secondary') {
      if (!id) {
        const primaryId = state.workspacePrimaryNoteId ??
          (state.activeWorkspacePane === 'primary' ? state.activeNoteId : null)
        return {
          workspacePrimaryNoteId: null,
          workspaceSecondaryNoteId: null,
          ...activatedNoteFields(state, primaryId, 'primary', revealOnMobile),
        }
      }
      const primaryId = state.workspaceSecondaryNoteId
        ? state.workspacePrimaryNoteId
        : state.activeNoteId
      return {
        workspacePrimaryNoteId: primaryId,
        workspaceSecondaryNoteId: id,
        outlineOpen: false,
        ...(activate ? activatedNoteFields(state, id, 'secondary', revealOnMobile) : {}),
      }
    }

    if (!id && state.workspaceSecondaryNoteId) {
      return {
        workspacePrimaryNoteId: null,
        workspaceSecondaryNoteId: null,
        ...activatedNoteFields(state, state.workspaceSecondaryNoteId, 'primary', revealOnMobile),
      }
    }
    if (state.workspaceSecondaryNoteId) {
      return {
        workspacePrimaryNoteId: id,
        ...(activate ? activatedNoteFields(state, id, 'primary', revealOnMobile) : {}),
      }
    }
    return activatedNoteFields(state, id, 'primary', revealOnMobile)
  }),
  activateWorkspacePane: (pane) => set((state) => {
    const targetId = pane === 'secondary'
      ? state.workspaceSecondaryNoteId
      : state.workspaceSecondaryNoteId
        ? state.workspacePrimaryNoteId
        : state.activeNoteId
    if (!targetId) return state
    return {
      ...activatedNoteFields(state, targetId, pane),
      outlineOpen: false,
    }
  }),
  closeSecondaryNote: () => set((state) => {
    if (!state.workspaceSecondaryNoteId) return state
    const primaryId = state.workspacePrimaryNoteId ??
      (state.activeWorkspacePane === 'primary' ? state.activeNoteId : null)
    return {
      workspacePrimaryNoteId: null,
      workspaceSecondaryNoteId: null,
      ...activatedNoteFields(state, primaryId, 'primary'),
    }
  }),
  removeWorkspaceNote: (id) => set((state) => {
    const primaryId = state.workspacePrimaryNoteId
    const secondaryId = state.workspaceSecondaryNoteId
    if (primaryId === id && secondaryId === id) {
      return {
        workspacePrimaryNoteId: null,
        workspaceSecondaryNoteId: null,
        ...activatedNoteFields(state, null, 'primary'),
      }
    }
    if (primaryId === id && secondaryId) {
      return {
        workspacePrimaryNoteId: null,
        workspaceSecondaryNoteId: null,
        ...activatedNoteFields(state, secondaryId, 'primary'),
      }
    }
    if (secondaryId === id) {
      const remainingId = primaryId ?? (state.activeWorkspacePane === 'primary' ? state.activeNoteId : null)
      return {
        workspacePrimaryNoteId: null,
        workspaceSecondaryNoteId: null,
        ...activatedNoteFields(state, remainingId, 'primary'),
      }
    }
    if (!secondaryId && state.activeNoteId === id) {
      return activatedNoteFields(state, null, 'primary')
    }
    return state
  }),
  toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
  toggleNavDrawer: (open) => set((s) => ({ navDrawerOpen: open ?? !s.navDrawerOpen })),
  toggleList: () => set((s) => ({ listCollapsed: !s.listCollapsed })),
  openSearchList: (seed) => set((s) => ({
    view: 'all', folderId: null, tags: [], selectedIds: [], dateFilter: null,
    searchList: true, searchRequest: s.searchRequest + 1, listCollapsed: false,
    mobilePane: 'list', navDrawerOpen: false, panel: null,
    ...(seed === undefined ? {} : { searchQuery: seed }),
  })),
  // The list search box holds this string and forwards it to /api/search verbatim, so an
  // expression written from a tag menu is the same grammar a person can type by hand.
  setSearchQuery: (value) => set({ searchQuery: truncateText(value, 512) }),
  openExplorer: (folderId = null) => set({
    view: folderId ? 'folder' : 'all', folderId, tags: [],
    searchList: false, listCollapsed: true, selectedIds: [], navDrawerOpen: false,
    dateFilter: null,
  }),
  setMobilePane: (mobilePane) => set({ mobilePane }),

  openView: (view, options) => {
    const tags = tagFilter(options?.tags ?? (options?.tag ? [options.tag] : []))
    return set({
      view: view === 'tag' && !tags.length ? 'all' : view,
      folderId: options?.folderId ?? null,
      tags,
      selectedIds: [],
      dateFilter: null,
      mobilePane: 'list',
      listCollapsed: false,
      searchList: false,

      navDrawerOpen: false,
    })
  },

  toggleTagExclusion: (tag) => set((s) => {
    const name = tag.trim()
    if (!name) return {}
    const excludedTags = hasTag(s.excludedTags, name) ? dropTag(s.excludedTags, name) : tagFilter([...s.excludedTags, name])
    const tags = tagFilter(dropTag(s.tags, name))
    return { excludedTags, tags, view: tags.length ? 'tag' : s.view === 'tag' ? 'all' : s.view }
  }),

  toggleTagFilter: (tag, additive) => set((s) => {
    const name = tag.trim()
    if (!name) return {}
    if (!additive) return { view: 'tag', tags: [name], selectedIds: [] }
    const tags = hasTag(s.tags, name) ? dropTag(s.tags, name) : tagFilter([...s.tags, name])
    return { view: tags.length ? 'tag' : 'all', tags, selectedIds: [] }
  }),

  setSort: (sort, order) => set((s) => ({ sort, order: order ?? s.order })),
  setDensity: (density) => set({ density }),
  setDateFilter: (dateFilter) => set({ dateFilter }),
  requestCalendarJump: (year, month) => set((s) => ({
    calendarJump: { year, month, nonce: (s.calendarJump?.nonce ?? 0) + 1 },
  })),

  toggleFolder: (id) =>
    set((s) => ({
      expandedFolders: s.expandedFolders.includes(id)
        ? s.expandedFolders.filter((f) => f !== id)
        : [...s.expandedFolders, id],
    })),

  expandFolder: (id) =>
    set((s) =>
      s.expandedFolders.includes(id) ? s : { expandedFolders: [...s.expandedFolders, id] },
    ),

  setActiveNote: (id) => {
    const state = get()
    const pane = state.workspaceSecondaryNoteId ? state.activeWorkspacePane : 'primary'
    state.setWorkspaceNote(pane, id)
  },

  setSelected: (ids) => set({ selectedIds: ids }),

  toggleSelected: (id, additive) =>
    set((s) => {
      if (!additive) return { selectedIds: [id] }
      return {
        selectedIds: s.selectedIds.includes(id)
          ? s.selectedIds.filter((x) => x !== id)
          : [...s.selectedIds, id],
      }
    }),

  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: null }),
  togglePanel: (panel) => set((s) => ({ panel: s.panel === panel ? null : panel })),
  toggleOutline: () => set((s) => ({ outlineOpen: !s.outlineOpen })),
  toggleBacklinks: () => set((s) => ({ backlinksOpen: !s.backlinksOpen })),
  toggleLocalGraph: () => set((s) => ({ localGraphOpen: !s.localGraphOpen })),
  showBacklinks: () => set({ backlinksOpen: true }),
  setLightbox: (lightbox) => set({ lightbox }),

  toast: (input) => {
    const id = `t${++toastSeq}`
    const item: ToastItem = {
      id,
      title: input.title,
      description: input.description,
      tone: input.tone ?? 'default',
      action: input.action,
      duration: input.duration ?? (input.tone === 'danger' ? 6000 : 3800),
    }
    set((s) => ({ toasts: [...s.toasts.slice(-4), item] }))
    return id
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  applyAppearance: (patch) => {
    const current = get()
    if (Object.entries(patch).some(([key, value]) => current[key as keyof typeof patch] !== value)) {
      set(patch)
    }
    applyThemeToDom(get())
  },
}))

lastPersisted = serializedPersistedState(useUi.getState())
useUi.subscribe(schedulePersist)

export function applyThemeToDom(state: Pick<UiState, 'theme' | 'accent' | 'background' | 'fontScale'>): void {
  const root = document.documentElement
  const dark =
    state.theme === 'dark' ||
    (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const theme = dark ? 'dark' : 'light'
  if (root.dataset.theme !== theme) root.dataset.theme = theme
  if (root.dataset.accent !== state.accent) root.dataset.accent = state.accent
  if (root.dataset.background !== state.background) root.dataset.background = state.background
}

let themeTransitionTimer: number | undefined

export function switchThemeWithTransition(
  next: ThemePref,
  origin?: { x: number; y: number },
  commit?: () => void,
): void {
  const ui = useUi.getState()
  const apply = commit ?? (() => ui.applyAppearance({ theme: next }))
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> }
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const root = document.documentElement
  window.clearTimeout(themeTransitionTimer)
  themeTransitionTimer = undefined
  root.classList.remove('theme-transition')

  if (!doc.startViewTransition || reduced || !origin) {
    root.classList.add('theme-transition')
    apply()
    themeTransitionTimer = window.setTimeout(() => {
      root.classList.remove('theme-transition')
      themeTransitionTimer = undefined
    }, 300)
    return
  }

  const transition = doc.startViewTransition(() => {
    apply()
  })

  void transition.ready.then(() => {
    const radius = Math.hypot(
      Math.max(origin.x, innerWidth - origin.x),
      Math.max(origin.y, innerHeight - origin.y),
    )
    document.documentElement.animate(
      {
        clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`],
      },
      {
        duration: 460,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        pseudoElement: '::view-transition-new(root)',
      },
    )
  }).catch(() => {})
}
