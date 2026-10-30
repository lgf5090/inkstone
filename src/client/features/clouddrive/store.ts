import { create } from 'zustand'
import type { CloudDriveBootstrap, CloudDrivePrefs } from '@shared/clouddrive/model'
import { parseCloudDrivePrefs } from '@shared/clouddrive/model'
import { clouddriveApi } from './api'
import { readCloudDrivePrefs, writeCloudDrivePrefs } from './prefs'

interface CloudDriveState {
  bootstrap: CloudDriveBootstrap | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  prefs: CloudDrivePrefs
  refreshKey: number
  load: () => Promise<void>
  setPrefs: (patch: Partial<CloudDrivePrefs>) => void
  bumpRefresh: () => void
}

export const useCloudDriveStore = create<CloudDriveState>((set, get) => ({
  bootstrap: null,
  status: 'idle',
  error: null,
  prefs: parseCloudDrivePrefs(null),
  refreshKey: 0,
  load: async () => {
    if (get().status === 'loading') return
    set({ status: 'loading', error: null })
    try {
      const bootstrap = await clouddriveApi.bootstrap()
      const prefs = { ...readCloudDrivePrefs(bootstrap.user.id), lastMountId: get().prefs.lastMountId || 'primary' }
      set({ bootstrap, status: 'ready', prefs })
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  },
  setPrefs: (patch) => {
    const bootstrap = get().bootstrap
    const prefs = { ...get().prefs, ...patch }
    if (bootstrap) writeCloudDrivePrefs(bootstrap.user.id, prefs)
    set({ prefs })
  },
  bumpRefresh: () => set((state) => ({ refreshKey: state.refreshKey + 1 })),
}))
