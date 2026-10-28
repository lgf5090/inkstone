import { create } from 'zustand'

export const DEVELOPMENT_NAV_WIDTH = {
  min: 200,
  max: 380,
  default: 260,
} as const

export type DevelopmentModuleId = 'database' | 'api-tester' | 'xget'

export function developmentModuleForPath(pathname: string): DevelopmentModuleId {
  if (pathname.startsWith('/development/api-tester')) return 'api-tester'
  return pathname.startsWith('/development/xget') ? 'xget' : 'database'
}

const STORAGE_KEY = 'inkstone.development.layout'

interface PersistedLayout {
  navWidth?: number
  navCollapsed?: boolean
}

function loadLayout(): PersistedLayout {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    return raw ? (JSON.parse(raw) as PersistedLayout) : {}
  } catch (error) {
    console.warn('[inkstone] Development layout could not be read:', error)
    return {}
  }
}

function persistLayout(layout: PersistedLayout): void {
  try {
    if (typeof localStorage === 'undefined') return
    const previous = loadLayout()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...previous, ...layout }))
  } catch (error) {
    console.warn('[inkstone] Development layout could not be saved:', error)
  }
}

export interface DevelopmentState {
  navWidth: number
  navCollapsed: boolean
  navDrawerOpen: boolean
  setNavWidth: (width: number) => void
  toggleNavCollapsed: () => void
  setNavCollapsed: (collapsed: boolean) => void
  toggleNavDrawer: (open?: boolean) => void
}

const initial = loadLayout()

export const useDevelopmentStore = create<DevelopmentState>((set, get) => ({
  navWidth:
    typeof initial.navWidth === 'number'
      ? Math.min(DEVELOPMENT_NAV_WIDTH.max, Math.max(DEVELOPMENT_NAV_WIDTH.min, Math.round(initial.navWidth)))
      : DEVELOPMENT_NAV_WIDTH.default,
  navCollapsed: Boolean(initial.navCollapsed),
  navDrawerOpen: false,

  setNavWidth: (width) => {
    const next = Math.min(DEVELOPMENT_NAV_WIDTH.max, Math.max(DEVELOPMENT_NAV_WIDTH.min, Math.round(width)))
    set({ navWidth: next })
    persistLayout({ navWidth: next })
  },

  toggleNavCollapsed: () => {
    const next = !get().navCollapsed
    set({ navCollapsed: next })
    persistLayout({ navCollapsed: next })
  },

  setNavCollapsed: (collapsed) => {
    set({ navCollapsed: collapsed })
    persistLayout({ navCollapsed: collapsed })
  },

  toggleNavDrawer: (open) => {
    set((state) => ({ navDrawerOpen: typeof open === 'boolean' ? open : !state.navDrawerOpen }))
  },
}))
