import { create } from 'zustand'

export const TOOLS_NAV_WIDTH = {
  min: 200,
  max: 380,
  default: 260,
} as const

export type ToolsSubmodule = 'password'

export type PasswordNavView =
  | 'all'
  | 'favorites'
  | 'generator'
  | 'groups'
  | 'backup_settings'
  | 'batch_operations'

const STORAGE_KEY = 'inkstone.tools.layout'

interface PersistedLayout {
  toolsNavWidth?: number
  toolsNavCollapsed?: boolean
  passwordModuleExpanded?: boolean
}

function loadPersistedLayout(): PersistedLayout {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!raw) return {}
    return JSON.parse(raw) as PersistedLayout
  } catch {
    return {}
  }
}

function persistLayout(state: PersistedLayout): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    }
  } catch {
    // Best effort background persist
  }
}

export interface ToolsState {
  toolsNavWidth: number
  toolsNavCollapsed: boolean
  toolsNavDrawerOpen: boolean
  activeSubmodule: ToolsSubmodule
  passwordModuleExpanded: boolean
  activePasswordView: PasswordNavView
  selectedGroupId: string | null

  setToolsNavWidth: (width: number) => void
  toggleToolsNav: () => void
  setToolsNavCollapsed: (collapsed: boolean) => void
  toggleToolsNavDrawer: (open?: boolean) => void
  setActiveSubmodule: (submodule: ToolsSubmodule) => void
  setPasswordModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  togglePasswordModuleExpanded: () => void
  setActivePasswordView: (view: PasswordNavView) => void
  setSelectedGroupId: (id: string | null) => void
}

const initialPersisted = loadPersistedLayout()

export const useToolsStore = create<ToolsState>((set, get) => ({
  toolsNavWidth:
    typeof initialPersisted.toolsNavWidth === 'number'
      ? Math.min(
          TOOLS_NAV_WIDTH.max,
          Math.max(TOOLS_NAV_WIDTH.min, Math.round(initialPersisted.toolsNavWidth)),
        )
      : TOOLS_NAV_WIDTH.default,
  toolsNavCollapsed: Boolean(initialPersisted.toolsNavCollapsed),
  toolsNavDrawerOpen: false,
  activeSubmodule: 'password',
  passwordModuleExpanded: initialPersisted.passwordModuleExpanded ?? true,
  activePasswordView: 'all',
  selectedGroupId: null,

  setToolsNavWidth: (width: number) => {
    const clamped = Math.min(
      TOOLS_NAV_WIDTH.max,
      Math.max(TOOLS_NAV_WIDTH.min, Math.round(width)),
    )
    set({ toolsNavWidth: clamped })
    persistLayout({
      toolsNavWidth: clamped,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
    })
  },

  toggleToolsNav: () => {
    const next = !get().toolsNavCollapsed
    set({ toolsNavCollapsed: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: next,
      passwordModuleExpanded: get().passwordModuleExpanded,
    })
  },

  setToolsNavCollapsed: (collapsed: boolean) => {
    set({ toolsNavCollapsed: collapsed })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: collapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
    })
  },

  toggleToolsNavDrawer: (open?: boolean) => {
    set((state) => ({
      toolsNavDrawerOpen: typeof open === 'boolean' ? open : !state.toolsNavDrawerOpen,
    }))
  },

  setActiveSubmodule: (submodule: ToolsSubmodule) => {
    set({ activeSubmodule: submodule })
  },

  setPasswordModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof expanded === 'function' ? expanded(get().passwordModuleExpanded) : expanded
    set({ passwordModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: next,
    })
  },

  togglePasswordModuleExpanded: () => {
    const next = !get().passwordModuleExpanded
    set({ passwordModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: next,
    })
  },

  setActivePasswordView: (view: PasswordNavView) => {
    set({ activePasswordView: view })
  },

  setSelectedGroupId: (id: string | null) => {
    set({ selectedGroupId: id })
  },
}))
