import { create } from 'zustand'
import { GITHUB_REPOSITORY_URL } from '@shared/constants'
import type { UpdateCheckResponse } from '@shared/types'
import { isNewerVersion } from '@shared/version'
import { api } from '../lib/api'

const IGNORED_VERSION_KEY = 'inkstone:update:ignored-version'

interface UpdateState {
  status: 'idle' | 'checking' | 'ready' | 'error'
  info: UpdateCheckResponse | null
  available: boolean
  dialogOpen: boolean
  dismissedThisSession: string | null
  check: () => Promise<void>
  ignoreCurrentVersion: () => void
  remindLater: () => void
  openUpdatePage: () => void
}

let requestSequence = 0

export const useUpdate = create<UpdateState>((set, get) => ({
  status: 'idle',
  info: null,
  available: false,
  dialogOpen: false,
  dismissedThisSession: null,

  async check() {
    const sequence = ++requestSequence
    set({ status: 'checking' })
    try {
      const info = await api.update.check()
      if (sequence !== requestSequence) return
      const available = isNewerVersion(info.latestVersion, info.currentVersion)
      const ignored = readIgnoredVersion()
      const dismissedThisSession = get().dismissedThisSession
      set({
        status: 'ready',
        info,
        available,
        dialogOpen:
          available &&
          info.latestVersion !== ignored &&
          info.latestVersion !== dismissedThisSession,
      })
    } catch {
      if (sequence !== requestSequence) return
      set({ status: 'error', dialogOpen: false })
    }
  },

  ignoreCurrentVersion() {
    const version = get().info?.latestVersion
    if (version) writeIgnoredVersion(version)
    set({ dialogOpen: false, dismissedThisSession: version ?? null })
  },

  remindLater() {
    set({
      dialogOpen: false,
      dismissedThisSession: get().info?.latestVersion ?? null,
    })
  },

  openUpdatePage() {
    const { info } = get()
    const updateUrl = info?.updateUrl ?? null
    if (info?.latestVersion && isOfficialUpdateUrl(updateUrl)) {
      window.open(updateUrl, '_blank', 'noopener,noreferrer')
    }
    set({
      dialogOpen: false,
      dismissedThisSession: info?.latestVersion ?? null,
    })
  },
}))

export function isOfficialUpdateUrl(
  url: string | null,
): url is typeof GITHUB_REPOSITORY_URL {
  return url === GITHUB_REPOSITORY_URL
}

function readIgnoredVersion(): string | null {
  try {
    return localStorage.getItem(IGNORED_VERSION_KEY)
  } catch {
    return null
  }
}

function writeIgnoredVersion(version: string): void {
  // Recording a dismissal the reader already got, and the read above answers a refused storage with null,
  // which is the safe direction: the same update offer returns on the next check rather than a stale one
  // being taken as accepted.
  try {
    localStorage.setItem(IGNORED_VERSION_KEY, version)
  } catch {
  }
}
