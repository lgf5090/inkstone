import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PasswordAccount } from '@shared/tools/password/types'
import { deriveVaultKey, encryptValue } from './crypto'

vi.mock('./api', () => ({
  passwordApi: {
    getVaultState: vi.fn(),
    getGroups: vi.fn(),
    getAccounts: vi.fn(),
    updateAccount: vi.fn(),
    createAccount: vi.fn(),
    deleteAccount: vi.fn(),
    unlock: vi.fn(),
    resetMasterPassword: vi.fn(),
  },
}))

import { passwordApi } from './api'
import { usePasswordVaultStore } from './store'

const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const key = deriveVaultKey('abcdef', SALT)

function account(overrides: Partial<PasswordAccount> = {}): PasswordAccount {
  return {
    id: 'acc-1',
    groupId: 'grp-1',
    title: encryptValue(key, 'GitHub'),
    username: encryptValue(key, 'octocat'),
    password: encryptValue(key, 'hunter2'),
    link: encryptValue(key, 'https://github.com'),
    remark: '',
    favicon: '',
    isFavorite: false,
    sort: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function resetStore(): void {
  usePasswordVaultStore.setState({
    vaultState: { hasVault: true },
    isUnlocked: true,
    keyIV: key,
    keyEpoch: 0,
    groups: [],
    groupTree: [],
    accounts: [],
    decryptedAccounts: {},
    selectedAccountId: null,
    selectedGroupId: null,
    isLoading: false,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(passwordApi.getGroups).mockResolvedValue([])
  vi.mocked(passwordApi.getAccounts).mockResolvedValue([])
  resetStore()
})

describe('vault store locking and races', () => {
  it('drops every decrypted value on lock, and bumps the epoch so stale work is refused', () => {
    const row = account()
    usePasswordVaultStore.setState({ accounts: [row] })
    usePasswordVaultStore.getState().unlock(key) // also kicks off refreshData
    usePasswordVaultStore.setState({
      decryptedAccounts: {
        'acc-1': {
          id: 'acc-1',
          groupId: 'grp-1',
          title: 'GitHub',
          username: 'octocat',
          password: 'hunter2',
          link: '',
          remark: '',
          favicon: '',
          isFavorite: false,
          sort: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    })
    const before = usePasswordVaultStore.getState().keyEpoch

    usePasswordVaultStore.getState().lock()

    const after = usePasswordVaultStore.getState()
    expect(after.isUnlocked).toBe(false)
    expect(after.keyIV).toBeNull()
    expect(after.decryptedAccounts).toEqual({})
    expect(after.keyEpoch).toBeGreaterThan(before)
  })

  it('does not write plaintext back when the vault is locked mid-refresh', async () => {
    let resolveAccounts: ((rows: PasswordAccount[]) => void) | undefined
    vi.mocked(passwordApi.getGroups).mockResolvedValue([])
    vi.mocked(passwordApi.getAccounts).mockReturnValue(
      new Promise<PasswordAccount[]>((resolve) => {
        resolveAccounts = resolve
      }),
    )

    const pending = usePasswordVaultStore.getState().refreshData()
    usePasswordVaultStore.getState().lock()
    resolveAccounts?.([account()])
    await pending

    expect(usePasswordVaultStore.getState().decryptedAccounts).toEqual({})
    expect(usePasswordVaultStore.getState().accounts).toEqual([])
  })

  it('counts two fast favourite clicks as two flips instead of cancelling them out', async () => {
    usePasswordVaultStore.setState({
      accounts: [account()],
      decryptedAccounts: {
        'acc-1': {
          id: 'acc-1',
          groupId: 'grp-1',
          title: 'GitHub',
          username: 'octocat',
          password: 'hunter2',
          link: '',
          remark: '',
          favicon: '',
          isFavorite: false,
          sort: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    })
    vi.mocked(passwordApi.updateAccount).mockImplementation(async (_id, data) => ({
      ...account(),
      ...data,
    }))

    await Promise.all([
      usePasswordVaultStore.getState().toggleFavorite('acc-1'),
      usePasswordVaultStore.getState().toggleFavorite('acc-1'),
    ])

    const sent = vi.mocked(passwordApi.updateAccount).mock.calls.map((call) => call[1].isFavorite)
    expect(sent).toEqual([true, false])
    expect(usePasswordVaultStore.getState().decryptedAccounts['acc-1']?.isFavorite).toBe(false)
  })

  it('forgetSession leaves nothing behind for the next reader', () => {
    usePasswordVaultStore.setState({ accounts: [account()], isSettingOpen: true })

    usePasswordVaultStore.getState().forgetSession()

    const state = usePasswordVaultStore.getState()
    expect(state.vaultState).toBeNull()
    expect(state.accounts).toEqual([])
    expect(state.decryptedAccounts).toEqual({})
    expect(state.isUnlocked).toBe(false)
    expect(state.isSettingOpen).toBe(false)
  })
})
