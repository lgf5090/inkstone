import { create } from 'zustand'

import type { PromptOptimizerNavView } from '@shared/tools/prompt-optimizer/types'

export const TOOLS_NAV_WIDTH = {
  min: 200,
  max: 380,
  default: 260,
} as const

export type ToolsSubmodule = 'password' | 'qrcode' | 'id_photo' | 'color' | 'shortlinks' | 'calculator' | 'compare' | 'network_panel' | 'prompt_optimizer'

const TOOLS_SUBMODULES: readonly ToolsSubmodule[] = ['password', 'qrcode', 'id_photo', 'color', 'shortlinks', 'calculator', 'compare', 'network_panel', 'prompt_optimizer']

/**
 * The module a Tools address names, or null when the address does not name one.
 *
 * A bookmark or a new tab has to open the module in its path rather than whichever module this
 * browser last remembered; the store keeps the preference for `/tools` itself, but a deeper address
 * is the reader's explicit answer.
 */
export function toolsSubmoduleFromPath(pathname: string): ToolsSubmodule | null {
  const match = /^\/tools\/([^/?#]+)/.exec(pathname)
  if (!match) return null
  const candidate = match[1] as ToolsSubmodule
  return TOOLS_SUBMODULES.includes(candidate) ? candidate : null
}

/** The address a sidebar entry links with, so history and the back button agree with the screen. */
export function toolsPathForSubmodule(submodule: ToolsSubmodule): string {
  return `/tools/${submodule}`
}

export type ShortlinksNavView = 'dashboard' | 'links' | 'bundles' | 'settings'

export type IdPhotoNavView =
  | 'studio'
  | 'compliance'
  | 'compare'
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
  | 'health'

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
  | 'settings'

export type CalculatorNavView =
  | 'standard'
  | 'scientific'
  | 'programmer'
  | 'date'
  | 'unit'
  | 'currency'
  | 'graph'
  | 'kinship'
  | 'textcalc'
  | 'settings'

const CALCULATOR_NAV_VIEWS: readonly CalculatorNavView[] = [
  'standard',
  'scientific',
  'programmer',
  'date',
  'unit',
  'currency',
  'graph',
  'kinship',
  'textcalc',
  'settings',
]

/** The calculator view a query names, so a pasted `/tools/calculator?view=textcalc` opens that view. */
export function calculatorViewFromSearch(search: string): CalculatorNavView | null {
  const candidate = new URLSearchParams(search).get('view') as CalculatorNavView | null
  return candidate && CALCULATOR_NAV_VIEWS.includes(candidate) ? candidate : null
}

export type CompareNavView = 'text' | 'files' | 'folders' | 'images' | 'projects' | 'stats' | 'shortcuts'

export type NetworkPanelNavView = 'speed' | 'info' | 'history' | 'settings'

export type { PromptOptimizerNavView } from '@shared/tools/prompt-optimizer/types'

const STORAGE_KEY = 'inkstone.tools.layout'

interface PersistedLayout {
  toolsNavWidth?: number
  toolsNavCollapsed?: boolean
  passwordModuleExpanded?: boolean
  qrcodeModuleExpanded?: boolean
  idPhotoModuleExpanded?: boolean
  colorModuleExpanded?: boolean
  shortlinksModuleExpanded?: boolean
  calculatorModuleExpanded?: boolean
  activeCalculatorView?: CalculatorNavView
  calculatorViewChosen?: boolean
  compareModuleExpanded?: boolean
  activeCompareView?: CompareNavView
  networkPanelModuleExpanded?: boolean
  activeNetworkPanelView?: NetworkPanelNavView
  promptOptimizerModuleExpanded?: boolean
  activePromptOptimizerView?: PromptOptimizerNavView
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPersistedLayout(), ...state }))
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
  calculatorModuleExpanded: boolean
  activeCalculatorView: CalculatorNavView
  calculatorViewChosen: boolean
  compareModuleExpanded: boolean
  activeCompareView: CompareNavView
  networkPanelModuleExpanded: boolean
  activeNetworkPanelView: NetworkPanelNavView
  promptOptimizerModuleExpanded: boolean
  activePromptOptimizerView: PromptOptimizerNavView

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
  setCalculatorModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  toggleCalculatorModuleExpanded: () => void
  setActiveCalculatorView: (view: CalculatorNavView) => void
  setCompareModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  toggleCompareModuleExpanded: () => void
  setActiveCompareView: (view: CompareNavView) => void
  setNetworkPanelModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  toggleNetworkPanelModuleExpanded: () => void
  setActiveNetworkPanelView: (view: NetworkPanelNavView) => void
  setPromptOptimizerModuleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void
  togglePromptOptimizerModuleExpanded: () => void
  setActivePromptOptimizerView: (view: PromptOptimizerNavView) => void
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
  calculatorModuleExpanded: initialPersisted.calculatorModuleExpanded ?? true,
  activeCalculatorView: initialPersisted.activeCalculatorView ?? 'standard',
  calculatorViewChosen: initialPersisted.calculatorViewChosen ?? false,
  compareModuleExpanded: initialPersisted.compareModuleExpanded ?? true,
  activeCompareView: initialPersisted.activeCompareView ?? 'text',
  networkPanelModuleExpanded: initialPersisted.networkPanelModuleExpanded ?? true,
  activeNetworkPanelView: initialPersisted.activeNetworkPanelView ?? 'speed',
  promptOptimizerModuleExpanded: initialPersisted.promptOptimizerModuleExpanded ?? true,
  activePromptOptimizerView: initialPersisted.activePromptOptimizerView ?? 'basic_system',

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
  setCalculatorModuleExpanded: (expanded) => {
    const next = typeof expanded === 'function' ? expanded(get().calculatorModuleExpanded) : expanded
    set({ calculatorModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      calculatorModuleExpanded: next,
      activeCalculatorView: get().activeCalculatorView,
      activeSubmodule: get().activeSubmodule,
    })
  },

  toggleCalculatorModuleExpanded: () => {
    const next = !get().calculatorModuleExpanded
    set({ calculatorModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      calculatorModuleExpanded: next,
      activeCalculatorView: get().activeCalculatorView,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setActiveCalculatorView: (view) => {
    set({ activeCalculatorView: view, calculatorViewChosen: true })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      calculatorModuleExpanded: get().calculatorModuleExpanded,
      activeCalculatorView: view,
      calculatorViewChosen: true,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setCompareModuleExpanded: (expanded) => {
    const next = typeof expanded === 'function' ? expanded(get().compareModuleExpanded) : expanded
    set({ compareModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      compareModuleExpanded: next,
      activeCompareView: get().activeCompareView,
      activeSubmodule: get().activeSubmodule,
    })
  },

  toggleCompareModuleExpanded: () => {
    const next = !get().compareModuleExpanded
    set({ compareModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      compareModuleExpanded: next,
      activeCompareView: get().activeCompareView,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setActiveCompareView: (view) => {
    set({ activeCompareView: view })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      compareModuleExpanded: get().compareModuleExpanded,
      activeCompareView: view,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setNetworkPanelModuleExpanded: (expanded) => {
    const next = typeof expanded === 'function' ? expanded(get().networkPanelModuleExpanded) : expanded
    set({ networkPanelModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      networkPanelModuleExpanded: next,
      activeNetworkPanelView: get().activeNetworkPanelView,
      activeSubmodule: get().activeSubmodule,
    })
  },

  toggleNetworkPanelModuleExpanded: () => {
    const next = !get().networkPanelModuleExpanded
    set({ networkPanelModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      networkPanelModuleExpanded: next,
      activeNetworkPanelView: get().activeNetworkPanelView,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setActiveNetworkPanelView: (view) => {
    set({ activeNetworkPanelView: view })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      networkPanelModuleExpanded: get().networkPanelModuleExpanded,
      activeNetworkPanelView: view,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setPromptOptimizerModuleExpanded: (expanded) => {
    const next = typeof expanded === 'function' ? expanded(get().promptOptimizerModuleExpanded) : expanded
    set({ promptOptimizerModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      promptOptimizerModuleExpanded: next,
      activePromptOptimizerView: get().activePromptOptimizerView,
      activeSubmodule: get().activeSubmodule,
    })
  },

  togglePromptOptimizerModuleExpanded: () => {
    const next = !get().promptOptimizerModuleExpanded
    set({ promptOptimizerModuleExpanded: next })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      promptOptimizerModuleExpanded: next,
      activePromptOptimizerView: get().activePromptOptimizerView,
      activeSubmodule: get().activeSubmodule,
    })
  },

  setActivePromptOptimizerView: (view) => {
    set({ activePromptOptimizerView: view })
    persistLayout({
      toolsNavWidth: get().toolsNavWidth,
      toolsNavCollapsed: get().toolsNavCollapsed,
      promptOptimizerModuleExpanded: get().promptOptimizerModuleExpanded,
      activePromptOptimizerView: view,
      activeSubmodule: get().activeSubmodule,
    })
  },

}))
