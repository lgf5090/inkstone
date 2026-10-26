import { create } from 'zustand'

export const TOOLS_NAV_WIDTH = {
  min: 200,
  max: 380,
  default: 260,
} as const

export type ToolsSubmodule = 'password' | 'qrcode' | 'id_photo' | 'color' | 'shortlinks'

export type ShortlinksNavView = 'dashboard' | 'links' | 'bundles' | 'settings'

export type IdPhotoNavView =
  | 'studio'
  | 'compliance'
  | 'print'
  | 'batch'
  | 'specs'
  | 'history'
  | 'settings'

export type PasswordNavView =
  | 'all'
  | 'favorites'
  | 'generator'
  | 'groups'
  | 'backup_settings'
  | 'batch_operations'

export type QrCodeNavView =
  | 'generator'
  | 'scanner'
  | 'compare'
  | 'batch'
  | 'history'
  | 'templates'
  | 'settings'

export type ColorNavView =
  | 'studio'
  | 'algorithm'
  | 'ai_palette'
  | 'ui_palettes'
  | 'image_palette'
  | 'traditional'
  | 'gradient'
  | 'color_hunt'
  | 'favorites'

const STORAGE_KEY = 'inkstone.tools.layout'

interface PersistedLayout {
  toolsNavWidth?: number
  toolsNavCollapsed?: boolean
  passwordModuleExpanded?: boolean
  qrcodeModuleExpanded?: boolean
  idPhotoModuleExpanded?: boolean
  colorModuleExpanded?: boolean
  shortlinksModuleExpanded?: boolean
  activeSubmodule?: ToolsSubmodule
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
  qrcodeModuleExpanded: boolean
  activeQrCodeView: QrCodeNavView
  idPhotoModuleExpanded: boolean
  activeIdPhotoView: IdPhotoNavView
  colorModuleExpanded: boolean
  activeColorView: ColorNavView
  shortlinksModuleExpanded: boolean
  activeShortlinksView: ShortlinksNavView

  setToolsNavWidth: (width: number) => void
  toggleToolsNav: () => void
  setToolsNavCollapsed: (collapsed: boolean) => void
  toggleToolsNavDrawer: (open?: boolean) => void
  setActiveSubmodule: (submodule: ToolsSubmodule) => void
  setPasswordModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  togglePasswordModuleExpanded: () => void
  setActivePasswordView: (view: PasswordNavView) => void
  setSelectedGroupId: (id: string | null) => void
  setQrcodeModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  toggleQrcodeModuleExpanded: () => void
  setActiveQrCodeView: (view: QrCodeNavView) => void
  setIdPhotoModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  toggleIdPhotoModuleExpanded: () => void
  setActiveIdPhotoView: (view: IdPhotoNavView) => void
  setColorModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  toggleColorModuleExpanded: () => void
  setActiveColorView: (view: ColorNavView) => void
  setShortlinksModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  toggleShortlinksModuleExpanded: () => void
  setActiveShortlinksView: (view: ShortlinksNavView) => void
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
  // Short links open first: the vault behind the password module would otherwise greet every visit.
  activeSubmodule: initialPersisted.activeSubmodule ?? 'shortlinks',
  passwordModuleExpanded: initialPersisted.passwordModuleExpanded ?? true,
  activePasswordView: 'all',
  selectedGroupId: null,
  qrcodeModuleExpanded: initialPersisted.qrcodeModuleExpanded ?? true,
  activeQrCodeView: 'generator',
  idPhotoModuleExpanded: initialPersisted.idPhotoModuleExpanded ?? true,
  activeIdPhotoView: 'studio',
  colorModuleExpanded: initialPersisted.colorModuleExpanded ?? true,
  activeColorView: 'studio',
  shortlinksModuleExpanded: initialPersisted.shortlinksModuleExpanded ?? true,
  activeShortlinksView: 'dashboard',

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
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: get().activeSubmodule,
    })
  },

  toggleToolsNav: () => {
    const next = !get().toolsNavCollapsed
    set({ toolsNavCollapsed: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: next,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setToolsNavCollapsed: (collapsed: boolean) => {
    set({ toolsNavCollapsed: collapsed })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: collapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: get().activeSubmodule,
    })
  },

  toggleToolsNavDrawer: (open?: boolean) => {
    set((state) => ({
      toolsNavDrawerOpen: typeof open === 'boolean' ? open : !state.toolsNavDrawerOpen,
    }))
  },

  setActiveSubmodule: (submodule: ToolsSubmodule) => {
    set({ activeSubmodule: submodule })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: submodule,
    })
  },

  setPasswordModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof expanded === 'function' ? expanded(get().passwordModuleExpanded) : expanded
    set({ passwordModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: next,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: get().activeSubmodule,
    })
  },

  togglePasswordModuleExpanded: () => {
    const next = !get().passwordModuleExpanded
    set({ passwordModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: next,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setActivePasswordView: (view: PasswordNavView) => {
    set({ activePasswordView: view })
  },

  setSelectedGroupId: (id: string | null) => {
    set({ selectedGroupId: id })
  },

  setQrcodeModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof expanded === 'function' ? expanded(get().qrcodeModuleExpanded) : expanded
    set({ qrcodeModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: next,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: get().activeSubmodule,
    })
  },

  toggleQrcodeModuleExpanded: () => {
    const next = !get().qrcodeModuleExpanded
    set({ qrcodeModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: next,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setActiveQrCodeView: (view: QrCodeNavView) => {
    set({ activeQrCodeView: view })
  },

  setIdPhotoModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof expanded === 'function' ? expanded(get().idPhotoModuleExpanded) : expanded
    set({ idPhotoModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      idPhotoModuleExpanded: next,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: get().activeSubmodule,
    })
  },

  toggleIdPhotoModuleExpanded: () => {
    const next = !get().idPhotoModuleExpanded
    set({ idPhotoModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      idPhotoModuleExpanded: next,
      colorModuleExpanded: get().colorModuleExpanded,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setActiveIdPhotoView: (view: IdPhotoNavView) => {
    set({ activeIdPhotoView: view })
  },

  setColorModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof expanded === 'function' ? expanded(get().colorModuleExpanded) : expanded
    set({ colorModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: next,
      activeSubmodule: get().activeSubmodule,
    })
  },

  toggleColorModuleExpanded: () => {
    const next = !get().colorModuleExpanded
    set({ colorModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: next,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setActiveColorView: (view: ColorNavView) => {
    set({ activeColorView: view })
  },

  setShortlinksModuleExpanded: (expanded) => {
    const next = typeof expanded === 'function' ? expanded(get().shortlinksModuleExpanded) : expanded
    set({ shortlinksModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: get().colorModuleExpanded,
      shortlinksModuleExpanded: next,
      activeSubmodule: get().activeSubmodule,
    })
  },

  toggleShortlinksModuleExpanded: () => {
    const next = !get().shortlinksModuleExpanded
    set({ shortlinksModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      passwordModuleExpanded: get().passwordModuleExpanded,
      qrcodeModuleExpanded: get().qrcodeModuleExpanded,
      colorModuleExpanded: get().colorModuleExpanded,
      shortlinksModuleExpanded: next,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setActiveShortlinksView: (view: ShortlinksNavView) => {
    set({ activeShortlinksView: view })
  },
}))
