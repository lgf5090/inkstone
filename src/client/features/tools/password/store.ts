import { create } from 'zustand'
import type {
  KeyIV,
  PasswordVaultState,
  PasswordGroup,
  PasswordAccount,
  PasswordSettings,
  DecryptedAccount,
} from '@shared/tools/password/types'
import { passwordApi } from './api'
import {
  createVaultSalt,
  decryptValue,
  deriveVaultKey,
  encryptValue,
  getKeyIv,
  hashMasterPassword,
} from './crypto'
import { reencryptAccounts } from './utils/reencrypt'
import { clearClipboardSecret } from './utils/clipboard'
import { t } from '../../../lib/i18n'

/** One tab locking must lock the others: a second tab left open kept the plaintext on screen. */
const LOCK_CHANNEL_NAME = 'inkstone-password-lock'

let lockChannel: BroadcastChannel | null = null

function lockedState(state: PasswordVaultStore): Partial<PasswordVaultStore> {
  return {
    keyEpoch: state.keyEpoch + 1,
    isUnlocked: false,
    keyIV: null,
    selectedAccountId: null,
    // The plaintext and the metadata both go: group names and per-group counts are not secrets the
    // locked pane should keep showing. Unlock repopulates them from the server.
    groups: [],
    groupTree: [],
    accounts: [],
    selectedGroupId: null,
    decryptedAccounts: {},
  }
}

/**
 * The channel is opened on first unlock, so every tab that could receive a lock is already
 * listening. Environments without `BroadcastChannel` (older browsers, jsdom) just skip the sync.
 */
function lockChannelRef(): BroadcastChannel | null {
  if (lockChannel) return lockChannel
  if (typeof BroadcastChannel === 'undefined') return null

  lockChannel = new BroadcastChannel(LOCK_CHANNEL_NAME)
  lockChannel.onmessage = (event: MessageEvent) => {
    if (event.data !== 'lock') return
    clearClipboardSecret()
    usePasswordVaultStore.setState((state) => lockedState(state))
  }
  return lockChannel
}

export type PasswordViewMode =
  | 'all'
  | 'favorites'
  | 'generator'
  | 'groups'
  | 'backup_settings'
  | 'batch_operations'
  | 'health'

export interface PasswordVaultStore {
  vaultState: PasswordVaultState | null
  /** Server-side preferences; `autoLockMinutes` is what the auto-lock timer actually uses. */
  settings: PasswordSettings | null
  isUnlocked: boolean
  keyIV: KeyIV | null
  groups: PasswordGroup[]
  groupTree: PasswordGroup[]
  accounts: PasswordAccount[]
  decryptedAccounts: Record<string, DecryptedAccount>
  selectedAccountId: string | null
  selectedGroupId: string | null
  activeView: PasswordViewMode
  isLoading: boolean
  lastActiveTime: number
  /**
   * Bumped by every unlock, lock and wipe. Async work captures it before awaiting and refuses to
   * write back when it moved, so a stale response cannot repopulate a locked vault or overwrite a
   * vault that is now open under a different key.
   */
  keyEpoch: number

  // Modals
  isSettingOpen: boolean
  isResetOpen: boolean
  isRecoverOpen: boolean
  isGeneratorModalOpen: boolean
  isBatchOperationsOpen: boolean
  isExportModalOpen: boolean
  isImportModalOpen: boolean
  isBackupSettingsOpen: boolean
  targetGroupForExportImport: PasswordGroup | null

  // Methods
  checkVaultAndAutoUnlock: () => Promise<void>
  unlock: (keyiv: KeyIV) => void
  loadSettings: () => Promise<void>
  upgradeLegacyVault: (password: string) => Promise<void>
  lock: () => void
  clearVaultState: () => void
  forgetSession: () => void
  refreshData: () => Promise<void>
  setSelectedAccountId: (id: string | null) => void
  setSelectedGroupId: (id: string | null) => void
  setActiveView: (view: PasswordViewMode) => void
  touchActivity: () => void

  // CRUD
  createAccount: (data: Partial<DecryptedAccount> & { groupId: string }) => Promise<PasswordAccount>
  updateAccount: (id: string, data: Partial<DecryptedAccount>) => Promise<PasswordAccount>
  deleteAccount: (id: string) => Promise<void>
  toggleFavorite: (id: string) => Promise<void>

  createGroup: (name: string, parentId?: string) => Promise<PasswordGroup>
  updateGroup: (
    id: string,
    dataOrName: string | { name?: string; parentId?: string; icon?: string; sort?: number },
  ) => Promise<void>
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
    a.sort !== b.sort ? a.sort - b.sort : a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'accent' })
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

function sealedAad(accountId: string, field: string): string {
  return `${field}:${accountId}`
}

function decryptAccount(acc: PasswordAccount, keyiv: KeyIV): DecryptedAccount {
  let decryptUnreadable = false
  const tryDecrypt = (field: string, val: string) => {
    if (!val) return ''
    try {
      return decryptValue(keyiv, val, sealedAad(acc.id, field))
    } catch {
      decryptUnreadable = true
      return ''
    }
  }

  // A TOTP secret is the one field whose failure must be visible: showing the ciphertext as if it
  // were the secret makes the live code silently wrong, and a reset that dropped it leaves nothing
  // to notice. An unreadable non-empty value is reported so the UI can ask for the secret again.
  let totpUnreadable = false
  const sealedTotp = acc.totpSecret ?? ''
  let totpSecret = ''
  if (sealedTotp) {
    try {
      totpSecret = decryptValue(keyiv, sealedTotp, sealedAad(acc.id, 'totpSecret'))
    } catch {
      totpUnreadable = true
    }
  }

  return {
    id: acc.id,
    groupId: acc.groupId,
    title: tryDecrypt('title', acc.title),
    username: tryDecrypt('username', acc.username),
    password: tryDecrypt('password', acc.password),
    link: tryDecrypt('link', acc.link),
    remark: tryDecrypt('remark', acc.remark),
    totpSecret,
    totpUnreadable,
    decryptUnreadable,
    isFavorite: acc.isFavorite,
    sort: acc.sort,
    createdAt: acc.createdAt,
    updatedAt: acc.updatedAt,
  }
}

export const usePasswordVaultStore = create<PasswordVaultStore>((set, get) => ({
  vaultState: null,
  settings: null,
  isUnlocked: false,
  keyIV: null,
  groups: [],
  groupTree: [],
  accounts: [],
  decryptedAccounts: {},
  selectedAccountId: null,
  selectedGroupId: null,
  activeView: 'all',
  isLoading: false,
  lastActiveTime: Date.now(),
  keyEpoch: 0,

  isSettingOpen: false,
  isResetOpen: false,
  isRecoverOpen: false,
  isGeneratorModalOpen: false,
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
      }
    } catch {
      // `vaultState` stays null, so the pane keeps its loading branch — the honest answer when the
      // server could not be asked.
    } finally {
      set({ isLoading: false })
    }
  },

  unlock: (keyiv: KeyIV) => {
    // Open the lock channel now rather than on the first local lock: a tab that never locked still
    // has to hear the tab next to it lock.
    lockChannelRef()
    set((state) => ({
      keyEpoch: state.keyEpoch + 1,
      isUnlocked: true,
      keyIV: keyiv,
      lastActiveTime: Date.now(),
      // Whoever holds the key has a vault: the locked pane asks `vaultState.hasVault` to choose between the
      // door and the setup form, and the answer read before the vault was created would lock a reader out of
      // an empty screen until the next reload.
      vaultState: state.vaultState ? { ...state.vaultState, hasVault: true } : state.vaultState,
    }))

    void get().refreshData()
    void get().loadSettings()
  },

  loadSettings: async () => {
    if (!get().keyIV) return
    try {
      set({ settings: await passwordApi.getSettings() })
    } catch {
      // Keep the last known value; the 5-minute default covers a first read that failed.
    }
  },

  upgradeLegacyVault: async (password) => {
    // Vaults created before the salted derivation are re-sealed here, while the password is in
    // hand: one atomic reset that swaps the key, the verifier and every row together.
    const legacy = getKeyIv(password)
    const salt = createVaultSalt()
    const next = deriveVaultKey(password, salt)
    const raw = await passwordApi.getAccounts()
    const { rows, failedIndex } = reencryptAccounts(raw, legacy, next)
    if (failedIndex >= 0) {
      throw new Error(t('tools.password.upgrade.blocked', { index: String(failedIndex + 1) }))
    }

    await passwordApi.resetMasterPassword({
      oldPassword: password,
      newMasterHash: hashMasterPassword(password),
      newKdfSalt: salt,
      accounts: rows,
    })
    get().unlock(next)
  },

  lock: () => {
    set(lockedState)
    clearClipboardSecret()
    // Tell the other tabs. `postMessage` does not deliver to the sender, so this tab does not
    // re-enter the handler.
    lockChannelRef()?.postMessage('lock')
  },

  clearVaultState: () => {
    set((state) => ({
      keyEpoch: state.keyEpoch + 1,
      vaultState: { hasVault: false },
      isUnlocked: false,
      keyIV: null,
      groups: [],
      groupTree: [],
      accounts: [],
      decryptedAccounts: {},
      selectedAccountId: null,
      selectedGroupId: null,
    }))
  },

  forgetSession: () => {
    // Signing out must leave nothing of the previous reader behind: not the plaintext, not the
    // ciphertext, and not the answer "this account has a vault". `vaultState: null` makes the pane
    // ask the server again for whoever signs in next.
    set((state) => ({
      keyEpoch: state.keyEpoch + 1,
      vaultState: null,
      isUnlocked: false,
      keyIV: null,
      groups: [],
      groupTree: [],
      accounts: [],
      decryptedAccounts: {},
      selectedAccountId: null,
      selectedGroupId: null,
      isSettingOpen: false,
      isResetOpen: false,
      isRecoverOpen: false,
      isExportModalOpen: false,
      isImportModalOpen: false,
      isBackupSettingsOpen: false,
      isBatchOperationsOpen: false,
      isGeneratorModalOpen: false,
      targetGroupForExportImport: null,
    }))
  },

  refreshData: async () => {
    const { keyIV, keyEpoch } = get()
    if (!keyIV) return

    set({ isLoading: true })
    try {
      const [groups, accounts] = await Promise.all([
        passwordApi.getGroups(),
        passwordApi.getAccounts(),
      ])

      // A lock, a re-key or a second unlock while this was in flight makes the answer stale: the
      // old key would otherwise write its plaintext back into a vault that is now locked or keyed
      // differently.
      if (get().keyEpoch !== keyEpoch) return

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
      // The vault stays on whatever it showed before; the next refresh retries.
    } finally {
      if (get().keyEpoch === keyEpoch) {
        set({ isLoading: false })
      }
    }
  },

  setSelectedAccountId: (id) => set({ selectedAccountId: id }),
  setSelectedGroupId: (id) => set({ selectedGroupId: id }),
  setActiveView: (view) => set({ activeView: view }),

  createAccount: async (data) => {
    const { keyIV, decryptedAccounts, accounts } = get()
    if (!keyIV) throw new Error('Vault is locked')

    // The id is chosen before the first seal: it is the associated data, so the ciphertext can only
    // be opened for this row.
    const id = data.id ?? crypto.randomUUID()
    const encryptedPayload: Partial<PasswordAccount> & { groupId: string; id: string } = {
      id,
      groupId: data.groupId,
      title: data.title ? encryptValue(keyIV, data.title, sealedAad(id, 'title')) : '',
      username: data.username ? encryptValue(keyIV, data.username, sealedAad(id, 'username')) : '',
      password: data.password ? encryptValue(keyIV, data.password, sealedAad(id, 'password')) : '',
      link: data.link ? encryptValue(keyIV, data.link, sealedAad(id, 'link')) : '',
      remark: data.remark ? encryptValue(keyIV, data.remark, sealedAad(id, 'remark')) : '',
      totpSecret: data.totpSecret ? encryptValue(keyIV, data.totpSecret, sealedAad(id, 'totpSecret')) : '',
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
    const { keyIV, keyEpoch, accounts } = get()
    if (!keyIV) throw new Error('Vault is locked')

    const encryptedUpdates: Partial<PasswordAccount> & { expectedUpdatedAt?: number } = {}
    // The version the editor last saw: a second tab that wrote in the meantime gets a conflict
    // instead of being silently overwritten.
    const known = accounts.find((account) => account.id === id)
    if (known) encryptedUpdates.expectedUpdatedAt = known.updatedAt
    if (data.groupId !== undefined) encryptedUpdates.groupId = data.groupId
    if (data.title !== undefined) encryptedUpdates.title = encryptValue(keyIV, data.title, sealedAad(id, 'title'))
    if (data.username !== undefined) encryptedUpdates.username = encryptValue(keyIV, data.username, sealedAad(id, 'username'))
    if (data.password !== undefined) encryptedUpdates.password = encryptValue(keyIV, data.password, sealedAad(id, 'password'))
    if (data.link !== undefined) encryptedUpdates.link = encryptValue(keyIV, data.link, sealedAad(id, 'link'))
    if (data.remark !== undefined) encryptedUpdates.remark = encryptValue(keyIV, data.remark, sealedAad(id, 'remark'))
    if (data.totpSecret !== undefined) encryptedUpdates.totpSecret = encryptValue(keyIV, data.totpSecret, sealedAad(id, 'totpSecret'))
    if (data.isFavorite !== undefined) encryptedUpdates.isFavorite = data.isFavorite
    if (data.sort !== undefined) encryptedUpdates.sort = data.sort

    const updated = await passwordApi.updateAccount(id, encryptedUpdates)
    if (get().keyEpoch !== keyEpoch) {
      // Locked or re-keyed while the write was in flight: the row is on the server, but this
      // session must not decrypt it into a vault that no longer holds that key.
      return updated
    }
    const dec = decryptAccount(updated, keyIV)

    // Re-read after the await: another write (a favourite toggle, a second tab's save) may have
    // landed in between, and the snapshot taken before the request would undo it.
    set((state) => ({
      accounts: state.accounts.map((a) => (a.id === id ? updated : a)),
      decryptedAccounts: { ...state.decryptedAccounts, [id]: dec },
    }))

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
    const { decryptedAccounts, accounts } = get()
    const target = decryptedAccounts[id]
    if (!target) return
    const next = !target.isFavorite

    // Flip locally first: two clicks in quick succession must build on each other, not on the
    // pre-request snapshot (which made the pair cancel out on the server while the UI flipped once).
    set({
      decryptedAccounts: { ...decryptedAccounts, [id]: { ...target, isFavorite: next } },
      accounts: accounts.map((a) => (a.id === id ? { ...a, isFavorite: next } : a)),
    })

    try {
      await get().updateAccount(id, { isFavorite: next })
    } catch (error) {
      const state = get()
      set({
        decryptedAccounts: {
          ...state.decryptedAccounts,
          [id]: { ...target, isFavorite: target.isFavorite },
        },
        accounts: state.accounts.map((a) =>
          a.id === id ? { ...a, isFavorite: target.isFavorite } : a,
        ),
      })
      throw error
    }
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
    // Reorder the array as well: updating `sort` alone left the list in its old order until the next
    // full refresh, so a drag looked like it had done nothing.
    const nextAccounts = accounts
      .map((a) => (sortMap.has(a.id) ? { ...a, sort: sortMap.get(a.id)! } : a))
      .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
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
  openBatchOperations: () => set({ isBatchOperationsOpen: true }),
  closeBatchOperations: () => set({ isBatchOperationsOpen: false }),
  openExportModal: (group) => set({ isExportModalOpen: true, targetGroupForExportImport: group || null }),
  closeExportModal: () => set({ isExportModalOpen: false, targetGroupForExportImport: null }),
  openImportModal: (group) => set({ isImportModalOpen: true, targetGroupForExportImport: group || null }),
  closeImportModal: () => set({ isImportModalOpen: false, targetGroupForExportImport: null }),
  openBackupSettings: () => set({ isBackupSettingsOpen: true }),
  closeBackupSettings: () => set({ isBackupSettingsOpen: false }),
}))
