import { create } from 'zustand'
import type {
  KeyIV,
  PasswordVaultState,
  PasswordGroup,
  PasswordAccount,
  DecryptedAccount,
} from '@shared/tools/password/types'
import { passwordApi } from './api'
import {
  decryptValue,
  encryptValue,
  getKeyIv,
  getOriginalPasswordPlus,
  getRecoveryPass,
} from './crypto'

const LOGIN_INFO_KEY = 'inkstone.tools.password.login_info'
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export type PasswordViewMode =
  | 'all'
  | 'favorites'
  | 'generator'
  | 'groups'
  | 'backup_settings'
  | 'batch_operations'

export interface PasswordVaultStore {
  vaultState: PasswordVaultState | null
  isUnlocked: boolean
  keyIV: KeyIV | null
  masterPasswordText: string
  groups: PasswordGroup[]
  groupTree: PasswordGroup[]
  accounts: PasswordAccount[]
  decryptedAccounts: Record<string, DecryptedAccount>
  selectedAccountId: string | null
  selectedGroupId: string | null
  activeView: PasswordViewMode
  searchQuery: string
  isLoading: boolean
  lastActiveTime: number

  // Modals
  isSettingOpen: boolean
  isResetOpen: boolean
  isRecoverOpen: boolean
  isGeneratorModalOpen: boolean
  isQuickAddModalOpen: boolean
  isBatchOperationsOpen: boolean
  isExportModalOpen: boolean
  isImportModalOpen: boolean
  isBackupSettingsOpen: boolean
  targetGroupForExportImport: PasswordGroup | null

  // Methods
  checkVaultAndAutoUnlock: () => Promise<void>
  unlock: (keyiv: KeyIV, rememberLogin?: boolean, rawPassword?: string) => void
  lock: () => void
  refreshData: () => Promise<void>
  setSelectedAccountId: (id: string | null) => void
  setSelectedGroupId: (id: string | null) => void
  setActiveView: (view: PasswordViewMode) => void
  setSearchQuery: (query: string) => void
  touchActivity: () => void

  // CRUD
  createAccount: (data: Partial<DecryptedAccount> & { groupId: string }) => Promise<PasswordAccount>
  updateAccount: (id: string, data: Partial<DecryptedAccount>) => Promise<PasswordAccount>
  deleteAccount: (id: string) => Promise<void>
  toggleFavorite: (id: string) => Promise<void>

  createGroup: (name: string, parentId?: string) => Promise<PasswordGroup>
  updateGroup: (id: string, dataOrName: string | { name?: string; parentId?: string; sort?: number }) => Promise<void>
  deleteGroup: (id: string) => Promise<void>
  moveAccountToGroup: (accountId: string, targetGroupId: string) => Promise<void>
  reorderAccounts: (accounts: Array<{ id: string; sort: number }>) => Promise<void>

  // Modals management
  openSetting: () => void
  closeSetting: () => void
  openReset: () => void
  closeReset: () => void
  openRecover: () => void
  closeRecover: () => void
  openGeneratorModal: () => void
  closeGeneratorModal: () => void
  openQuickAddModal: () => void
  closeQuickAddModal: () => void
  openBatchOperations: () => void
  closeBatchOperations: () => void
  openExportModal: (group?: PasswordGroup) => void
  closeExportModal: () => void
  openImportModal: (group?: PasswordGroup) => void
  closeImportModal: () => void
  openBackupSettings: () => void
  closeBackupSettings: () => void
}

function buildTree(groups: PasswordGroup[]): PasswordGroup[] {
  const groupMap = new Map<string, PasswordGroup>()
  const rootGroups: PasswordGroup[] = []

  const sorted = [...groups].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'accent' })
  )

  for (const g of sorted) {
    groupMap.set(g.id, { ...g, childs: [] })
  }

  for (const g of sorted) {
    const node = groupMap.get(g.id)!
    if (g.parentId && groupMap.has(g.parentId)) {
      groupMap.get(g.parentId)!.childs!.push(node)
    } else {
      rootGroups.push(node)
    }
  }

  return rootGroups
}

function decryptAccount(acc: PasswordAccount, keyiv: KeyIV): DecryptedAccount {
  const tryDecrypt = (val: string) => {
    if (!val) return ''
    try {
      return decryptValue(keyiv, val)
    } catch {
      return val
    }
  }

  return {
    id: acc.id,
    groupId: acc.groupId,
    title: tryDecrypt(acc.title),
    username: tryDecrypt(acc.username),
    password: tryDecrypt(acc.password),
    link: tryDecrypt(acc.link),
    remark: tryDecrypt(acc.remark),
    favicon: acc.favicon || '',
    isFavorite: acc.isFavorite,
    sort: acc.sort,
    createdAt: acc.createdAt,
    updatedAt: acc.updatedAt,
  }
}

export const usePasswordVaultStore = create<PasswordVaultStore>((set, get) => ({
  vaultState: null,
  isUnlocked: false,
  keyIV: null,
  masterPasswordText: '',
  groups: [],
  groupTree: [],
  accounts: [],
  decryptedAccounts: {},
  selectedAccountId: null,
  selectedGroupId: null,
  activeView: 'all',
  searchQuery: '',
  isLoading: false,
  lastActiveTime: Date.now(),

  isSettingOpen: false,
  isResetOpen: false,
  isRecoverOpen: false,
  isGeneratorModalOpen: false,
  isQuickAddModalOpen: false,
  isBatchOperationsOpen: false,
  isExportModalOpen: false,
  isImportModalOpen: false,
  isBackupSettingsOpen: false,
  targetGroupForExportImport: null,

  touchActivity: () => set({ lastActiveTime: Date.now() }),

  checkVaultAndAutoUnlock: async () => {
    set({ isLoading: true })
    try {
      const state = await passwordApi.getVaultState()
      set({ vaultState: state })

      if (!state.hasVault) {
        set({ isSettingOpen: true, isUnlocked: false, isLoading: false })
        return
      }

      // Check 24h remember login in localStorage
      const savedInfo = typeof localStorage !== 'undefined' ? localStorage.getItem(LOGIN_INFO_KEY) : null
      if (savedInfo) {
        try {
          const { expireTime, encryptedPass } = JSON.parse(savedInfo)
          if (expireTime > Date.now() && encryptedPass) {
            const rawPassword = getOriginalPasswordPlus(encryptedPass)
            if (rawPassword) {
              const keyiv = getKeyIv(rawPassword)
              get().unlock(keyiv, false, rawPassword)
            }
          } else {
            localStorage.removeItem(LOGIN_INFO_KEY)
          }
        } catch {
          localStorage.removeItem(LOGIN_INFO_KEY)
        }
      }
    } catch {
      // Ignored
    } finally {
      set({ isLoading: false })
    }
  },

  unlock: (keyiv: KeyIV, rememberLogin = false, rawPassword = '') => {
    if (rememberLogin && rawPassword && typeof localStorage !== 'undefined') {
      try {
        const encryptedPass = getRecoveryPass(rawPassword)
        const expireTime = Date.now() + ONE_DAY_MS
        localStorage.setItem(LOGIN_INFO_KEY, JSON.stringify({ encryptedPass, expireTime }))
      } catch {
        // Ignored
      }
    }

    set({
      isUnlocked: true,
      keyIV: keyiv,
      masterPasswordText: rawPassword,
      lastActiveTime: Date.now(),
    })

    void get().refreshData()
  },

  lock: () => {
    if (typeof localStorage !== 'undefined') {
      const savedInfo = localStorage.getItem(LOGIN_INFO_KEY)
      if (savedInfo) {
        try {
          const { expireTime } = JSON.parse(savedInfo)
          if (expireTime <= Date.now()) {
            localStorage.removeItem(LOGIN_INFO_KEY)
          }
        } catch {
          localStorage.removeItem(LOGIN_INFO_KEY)
        }
      }
    }

    set({
      isUnlocked: false,
      keyIV: null,
      masterPasswordText: '',
      selectedAccountId: null,
    })
  },

  refreshData: async () => {
    const { keyIV } = get()
    if (!keyIV) return

    set({ isLoading: true })
    try {
      const [groups, accounts] = await Promise.all([
        passwordApi.getGroups(),
        passwordApi.getAccounts(),
      ])

      const groupTree = buildTree(groups)
      const decryptedMap: Record<string, DecryptedAccount> = {}

      for (const acc of accounts) {
        decryptedMap[acc.id] = decryptAccount(acc, keyIV)
      }

      set({
        groups,
        groupTree,
        accounts,
        decryptedAccounts: decryptedMap,
        selectedGroupId: get().selectedGroupId || (groups[0]?.id ?? null),
      })
    } catch {
      // Error handled by UI boundary
    } finally {
      set({ isLoading: false })
    }
  },

  setSelectedAccountId: (id) => set({ selectedAccountId: id }),
  setSelectedGroupId: (id) => set({ selectedGroupId: id }),
  setActiveView: (view) => set({ activeView: view }),
  setSearchQuery: (query) => set({ searchQuery: query }),

  createAccount: async (data) => {
    const { keyIV, decryptedAccounts, accounts } = get()
    if (!keyIV) throw new Error('Vault is locked')

    const encryptedPayload: Partial<PasswordAccount> & { groupId: string } = {
      groupId: data.groupId,
      title: data.title ? encryptValue(keyIV, data.title) : '',
      username: data.username ? encryptValue(keyIV, data.username) : '',
      password: data.password ? encryptValue(keyIV, data.password) : '',
      link: data.link ? encryptValue(keyIV, data.link) : '',
      remark: data.remark ? encryptValue(keyIV, data.remark) : '',
      favicon: data.favicon || '',
      isFavorite: Boolean(data.isFavorite),
      sort: data.sort ?? accounts.length,
    }

    const created = await passwordApi.createAccount(encryptedPayload)
    const dec = decryptAccount(created, keyIV)

    set({
      accounts: [...accounts, created],
      decryptedAccounts: { ...decryptedAccounts, [created.id]: dec },
      selectedAccountId: created.id,
    })

    return created
  },

  updateAccount: async (id, data) => {
    const { keyIV, decryptedAccounts, accounts } = get()
    if (!keyIV) throw new Error('Vault is locked')

    const encryptedUpdates: Partial<PasswordAccount> = {}
    if (data.groupId !== undefined) encryptedUpdates.groupId = data.groupId
    if (data.title !== undefined) encryptedUpdates.title = encryptValue(keyIV, data.title)
    if (data.username !== undefined) encryptedUpdates.username = encryptValue(keyIV, data.username)
    if (data.password !== undefined) encryptedUpdates.password = encryptValue(keyIV, data.password)
    if (data.link !== undefined) encryptedUpdates.link = encryptValue(keyIV, data.link)
    if (data.remark !== undefined) encryptedUpdates.remark = encryptValue(keyIV, data.remark)
    if (data.favicon !== undefined) encryptedUpdates.favicon = data.favicon
    if (data.isFavorite !== undefined) encryptedUpdates.isFavorite = data.isFavorite
    if (data.sort !== undefined) encryptedUpdates.sort = data.sort

    const updated = await passwordApi.updateAccount(id, encryptedUpdates)
    const dec = decryptAccount(updated, keyIV)

    set({
      accounts: accounts.map((a) => (a.id === id ? updated : a)),
      decryptedAccounts: { ...decryptedAccounts, [id]: dec },
    })

    return updated
  },

  deleteAccount: async (id) => {
    await passwordApi.deleteAccount(id)
    const { accounts, decryptedAccounts, selectedAccountId } = get()

    const nextAccounts = accounts.filter((a) => a.id !== id)
    const nextDecrypted = { ...decryptedAccounts }
    delete nextDecrypted[id]

    set({
      accounts: nextAccounts,
      decryptedAccounts: nextDecrypted,
      selectedAccountId: selectedAccountId === id ? null : selectedAccountId,
    })
  },

  toggleFavorite: async (id) => {
    const { decryptedAccounts } = get()
    const target = decryptedAccounts[id]
    if (!target) return
    await get().updateAccount(id, { isFavorite: !target.isFavorite })
  },

  createGroup: async (name, parentId = '') => {
    const created = await passwordApi.createGroup({ name, parentId })
    const { groups } = get()
    const nextGroups = [...groups, created]
    set({
      groups: nextGroups,
      groupTree: buildTree(nextGroups),
      selectedGroupId: created.id,
    })
    return created
  },

  updateGroup: async (id, dataOrName) => {
    const patch = typeof dataOrName === 'string' ? { name: dataOrName } : dataOrName
    const updated = await passwordApi.updateGroup(id, patch)
    const { groups } = get()
    const nextGroups = groups.map((g) => (g.id === id ? updated : g))
    set({
      groups: nextGroups,
      groupTree: buildTree(nextGroups),
    })
  },

  deleteGroup: async (id) => {
    await passwordApi.deleteGroup(id)
    const { groups, selectedGroupId } = get()
    const nextGroups = groups.filter((g) => g.id !== id)
    set({
      groups: nextGroups,
      groupTree: buildTree(nextGroups),
      selectedGroupId: selectedGroupId === id ? (nextGroups[0]?.id ?? null) : selectedGroupId,
    })
  },

  moveAccountToGroup: async (accountId, targetGroupId) => {
    await get().updateAccount(accountId, { groupId: targetGroupId })
  },

  reorderAccounts: async (items) => {
    await passwordApi.reorderAccounts(items)
    const { accounts } = get()
    const sortMap = new Map(items.map((i) => [i.id, i.sort]))
    const nextAccounts = accounts.map((a) =>
      sortMap.has(a.id) ? { ...a, sort: sortMap.get(a.id)! } : a
    )
    set({ accounts: nextAccounts })
  },

  openSetting: () => set({ isSettingOpen: true }),
  closeSetting: () => set({ isSettingOpen: false }),
  openReset: () => set({ isResetOpen: true }),
  closeReset: () => set({ isResetOpen: false }),
  openRecover: () => set({ isRecoverOpen: true }),
  closeRecover: () => set({ isRecoverOpen: false }),
  openGeneratorModal: () => set({ isGeneratorModalOpen: true }),
  closeGeneratorModal: () => set({ isGeneratorModalOpen: false }),
  openQuickAddModal: () => set({ isQuickAddModalOpen: true }),
  closeQuickAddModal: () => set({ isQuickAddModalOpen: false }),
  openBatchOperations: () => set({ isBatchOperationsOpen: true }),
  closeBatchOperations: () => set({ isBatchOperationsOpen: false }),
  openExportModal: (group) => set({ isExportModalOpen: true, targetGroupForExportImport: group || null }),
  closeExportModal: () => set({ isExportModalOpen: false, targetGroupForExportImport: null }),
  openImportModal: (group) => set({ isImportModalOpen: true, targetGroupForExportImport: group || null }),
  closeImportModal: () => set({ isImportModalOpen: false, targetGroupForExportImport: null }),
  openBackupSettings: () => set({ isBackupSettingsOpen: true }),
  closeBackupSettings: () => set({ isBackupSettingsOpen: false }),
}))
