/**
 * Zustand store for Short Links client state and UI workflow.
 */

import { create } from 'zustand'
import type {
  BreakdownPage,
  BundleStats,
  ClickStats,
  DashboardStats,
  ShortLink,
  ShortLinkBundle,
  ShortlinkApiKey,
  ShortlinkBackup,
  ShortlinksSettings,
  TimelineData,
  TimelineRange,
} from '@shared/tools/shortlinks/types'
import { shortlinksApi } from './api'
import { useUiStore } from '../../../lib/ui-store'

let linksRequestSeq = 0
let timelineSeeded = false
let linksFetchTimer: ReturnType<typeof setTimeout> | null = null

function scheduleLinksFetch(fetch: () => Promise<void>): void {
  if (linksFetchTimer) clearTimeout(linksFetchTimer)
  linksFetchTimer = setTimeout(() => {
    linksFetchTimer = null
    void fetch()
  }, 250)
}

export interface LinksFilter {
  search: string
  status: 'all' | 'active' | 'disabled'
  page: number
  pageSize: number
  sortBy: 'created_at' | 'clicks' | 'url' | 'label'
  sortOrder: 'asc' | 'desc'
  bundleId?: number
}

export interface ShortlinksStoreState {
  // Dashboard
  dashboardStats: DashboardStats | null
  loadingDashboard: boolean
  fetchDashboard: () => Promise<void>

  // Links List
  links: ShortLink[]
  totalLinks: number
  loadingLinks: boolean
  filter: LinksFilter
  setFilter: (patch: Partial<LinksFilter>) => void
  fetchLinks: () => Promise<void>

  // Link Detail & Analytics
  activeLinkId: number | null
  activeLink: ShortLink | null
  activeLinkStats: ClickStats | null
  activeLinkTimeline: TimelineData | null
  activeTimelineRange: TimelineRange
  loadingDetail: boolean
  selectLink: (id: number | null) => Promise<void>
  setTimelineRange: (range: TimelineRange) => Promise<void>
  refreshActiveLink: () => Promise<void>

  // Bundles
  bundles: ShortLinkBundle[]
  loadingBundles: boolean
  activeBundleId: number | null
  activeBundleLinks: ShortLink[]
  activeBundleStats: BundleStats | null
  loadingBundleDetail: boolean
  fetchBundles: () => Promise<void>
  selectBundle: (id: number | null) => Promise<void>

  // Settings, API Keys, Backups
  settings: ShortlinksSettings | null
  apiKeys: ShortlinkApiKey[]
  backups: ShortlinkBackup[]
  loadingSettings: boolean
  fetchSettings: () => Promise<void>
  fetchApiKeys: () => Promise<void>
  fetchBackups: () => Promise<void>

  // Breakdown Modal state
  breakdownModalOpen: boolean
  breakdownDimension: string | null
  breakdownPage: BreakdownPage | null
  loadingBreakdown: boolean
  openBreakdown: (dimension: string) => Promise<void>
  closeBreakdown: () => void

  // Modals
  createModalOpen: boolean
  setCreateModalOpen: (open: boolean) => void

  editModalOpen: boolean
  editingLink: ShortLink | null
  openEditModal: (link: ShortLink) => void
  closeEditModal: () => void

  addSlugModalOpen: boolean
  addSlugLinkId: number | null
  openAddSlugModal: (linkId: number) => void
  closeAddSlugModal: () => void

  qrModalOpen: boolean
  qrLink: ShortLink | null
  openQrModal: (link: ShortLink) => void
  closeQrModal: () => void

  bundleModalOpen: boolean
  editingBundle: ShortLinkBundle | null
  openBundleModal: (bundle?: ShortLinkBundle | null) => void
  closeBundleModal: () => void

  manageBundleLinksModalOpen: boolean
  setManageBundleLinksModalOpen: (open: boolean) => void

  importModalOpen: boolean
  setImportModalOpen: (open: boolean) => void
}

export const useShortlinksStore = create<ShortlinksStoreState>((set, get) => ({
  // Dashboard
  dashboardStats: null,
  loadingDashboard: false,
  fetchDashboard: async () => {
    set({ loadingDashboard: true })
    try {
      const stats = await shortlinksApi.getDashboard()
      set({ dashboardStats: stats })
    } catch (e) {
      useUiStore.getState().toast((e as Error).message, 'error')
    } finally {
      set({ loadingDashboard: false })
    }
  },

  // Links List
  links: [],
  totalLinks: 0,
  loadingLinks: false,
  filter: {
    search: '',
    status: 'all',
    page: 1,
    pageSize: 20,
    sortBy: 'created_at',
    sortOrder: 'desc',
  },
  setFilter: (patch) => {
    set((state) => ({ filter: { ...state.filter, ...patch } }))
    // A keystroke in the search box is debounced; every other filter change fetches at once.
    if (patch.search !== undefined) scheduleLinksFetch(get().fetchLinks)
    else void get().fetchLinks()
  },
  fetchLinks: async () => {
    const seq = ++linksRequestSeq
    set({ loadingLinks: true })
    const { filter } = get()
    try {
      const res = await shortlinksApi.getLinks({
        limit: filter.pageSize,
        offset: (filter.page - 1) * filter.pageSize,
        search: filter.search || undefined,
        status: filter.status,
        sort_by: filter.sortBy,
        sort_order: filter.sortOrder,
        bundle_id: filter.bundleId,
      })
      if (seq !== linksRequestSeq) return
      set({ links: res.items, totalLinks: res.total })
    } catch (e) {
      if (seq !== linksRequestSeq) return
      useUiStore.getState().toast((e as Error).message, 'error')
    } finally {
      if (seq === linksRequestSeq) set({ loadingLinks: false })
    }
  },

  // Link Detail & Analytics
  activeLinkId: null,
  activeLink: null,
  activeLinkStats: null,
  activeLinkTimeline: null,
  activeTimelineRange: '30d',
  loadingDetail: false,

  selectLink: async (id: number | null) => {
    set({ activeLinkId: id, activeLink: null, activeLinkStats: null, activeLinkTimeline: null })
    if (id === null) return
    await get().refreshActiveLink()
  },

  setTimelineRange: async (range: TimelineRange) => {
    set({ activeTimelineRange: range })
    const { activeLinkId } = get()
    if (!activeLinkId) return
    set({ loadingDetail: true })
    try {
      const [stats, timeline] = await Promise.all([
        shortlinksApi.getLinkStats(activeLinkId, range),
        shortlinksApi.getLinkTimeline(activeLinkId, range),
      ])
      set({ activeLinkStats: stats, activeLinkTimeline: timeline })
    } catch (e) {
      useUiStore.getState().toast((e as Error).message, 'error')
    } finally {
      set({ loadingDetail: false })
    }
  },

  refreshActiveLink: async () => {
    const { activeLinkId, activeTimelineRange } = get()
    if (!activeLinkId) return
    set({ loadingDetail: true })
    try {
      const [link, stats, timeline] = await Promise.all([
        shortlinksApi.getLink(activeLinkId),
        shortlinksApi.getLinkStats(activeLinkId, activeTimelineRange),
        shortlinksApi.getLinkTimeline(activeLinkId, activeTimelineRange),
      ])
      set({ activeLink: link, activeLinkStats: stats, activeLinkTimeline: timeline })
    } catch (e) {
      useUiStore.getState().toast((e as Error).message, 'error')
    } finally {
      set({ loadingDetail: false })
    }
  },

  // Bundles
  bundles: [],
  loadingBundles: false,
  activeBundleId: null,
  activeBundleLinks: [],
  activeBundleStats: null,
  loadingBundleDetail: false,

  fetchBundles: async () => {
    set({ loadingBundles: true })
    try {
      const bundles = await shortlinksApi.getBundles()
      set({ bundles })
    } catch (e) {
      useUiStore.getState().toast((e as Error).message, 'error')
    } finally {
      set({ loadingBundles: false })
    }
  },

  selectBundle: async (id: number | null) => {
    set({ activeBundleId: id })
    if (id === null) {
      set({ activeBundleLinks: [], activeBundleStats: null })
      return
    }
    set({ loadingBundleDetail: true })
    try {
      const [links, stats] = await Promise.all([
        shortlinksApi.getBundleLinks(id),
        shortlinksApi.getBundleStats(id, get().activeTimelineRange),
      ])
      set({ activeBundleLinks: links, activeBundleStats: stats })
    } catch (e) {
      useUiStore.getState().toast((e as Error).message, 'error')
    } finally {
      set({ loadingBundleDetail: false })
    }
  },

  // Settings, API Keys, Backups
  settings: null,
  apiKeys: [],
  backups: [],
  loadingSettings: false,

  fetchSettings: async () => {
    set({ loadingSettings: true })
    try {
      const settings = await shortlinksApi.getSettings()
      set((state) => ({
        settings,
        // The saved default range seeds the analytics range once; a later refetch must not undo a
        // range the reader picked by hand.
        activeTimelineRange: timelineSeeded ? state.activeTimelineRange : settings.default_range,
      }))
      timelineSeeded = true
    } catch (e) {
      useUiStore.getState().toast((e as Error).message, 'error')
    } finally {
      set({ loadingSettings: false })
    }
  },

  fetchApiKeys: async () => {
    try {
      const keys = await shortlinksApi.getApiKeys()
      set({ apiKeys: keys })
    } catch (e) {
      useUiStore.getState().toast((e as Error).message, 'error')
    }
  },

  fetchBackups: async () => {
    try {
      const backups = await shortlinksApi.getBackups()
      set({ backups })
    } catch (e) {
      useUiStore.getState().toast((e as Error).message, 'error')
    }
  },

  // Breakdown
  breakdownModalOpen: false,
  breakdownDimension: null,
  breakdownPage: null,
  loadingBreakdown: false,

  openBreakdown: async (dimension: string) => {
    const { activeLinkId, activeTimelineRange } = get()
    if (!activeLinkId) return
    set({
      breakdownModalOpen: true,
      breakdownDimension: dimension,
      loadingBreakdown: true,
      breakdownPage: null,
    })
    try {
      const page = await shortlinksApi.getLinkBreakdown(activeLinkId, {
        dimension,
        range: activeTimelineRange,
        limit: 50,
        offset: 0,
      })
      set({ breakdownPage: page })
    } catch (e) {
      useUiStore.getState().toast((e as Error).message, 'error')
    } finally {
      set({ loadingBreakdown: false })
    }
  },

  closeBreakdown: () => {
    set({ breakdownModalOpen: false, breakdownDimension: null, breakdownPage: null })
  },

  // Modals
  createModalOpen: false,
  setCreateModalOpen: (open) => set({ createModalOpen: open }),

  editModalOpen: false,
  editingLink: null,
  openEditModal: (link) => set({ editModalOpen: true, editingLink: link }),
  closeEditModal: () => set({ editModalOpen: false, editingLink: null }),

  addSlugModalOpen: false,
  addSlugLinkId: null,
  openAddSlugModal: (linkId) => set({ addSlugModalOpen: true, addSlugLinkId: linkId }),
  closeAddSlugModal: () => set({ addSlugModalOpen: false, addSlugLinkId: null }),

  qrModalOpen: false,
  qrLink: null,
  openQrModal: (link) => set({ qrModalOpen: true, qrLink: link }),
  closeQrModal: () => set({ qrModalOpen: false, qrLink: null }),

  bundleModalOpen: false,
  editingBundle: null,
  openBundleModal: (bundle) => set({ bundleModalOpen: true, editingBundle: bundle ?? null }),
  closeBundleModal: () => set({ bundleModalOpen: false, editingBundle: null }),

  manageBundleLinksModalOpen: false,
  setManageBundleLinksModalOpen: (open) => set({ manageBundleLinksModalOpen: open }),

  importModalOpen: false,
  setImportModalOpen: (open) => set({ importModalOpen: open }),
}))
