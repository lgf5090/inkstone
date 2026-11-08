import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PasswordAccount } from '@shared/tools/password/types'
import { deriveVaultKey, encryptValue } from './crypto'

vi.mock('./api', () => ({
  passwordApi: {
    getVaultState: vi.fn(),
    getGroups: vi.fn(),
    getAccounts: vi.fn(),
    getAccountsPage: vi.fn(),
    updateAccount: vi.fn(),
    createAccount: vi.fn(),
    deleteAccount: vi.fn(),
    reorderAccounts: vi.fn(),
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
  vi.mocked(passwordApi.getAccountsPage).mockResolvedValue({ items: [], nextCursor: null })
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
          isFavorite: false,
          sort: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    })
    const before = usePasswordVaultStore.getState().keyEpoch

    usePasswordVaultStore.setState({
      groups: [{ id: 'grp-1', userId: 'u', name: 'Work', parentId: '', icon: '', sort: 0, createdAt: 1, updatedAt: 1 }],
      accounts: [row],
      selectedGroupId: 'grp-1',
    })
    usePasswordVaultStore.getState().lock()

    const after = usePasswordVaultStore.getState()
    expect(after.isUnlocked).toBe(false)
    expect(after.keyIV).toBeNull()
    expect(after.decryptedAccounts).toEqual({})
    expect(after.keyEpoch).toBeGreaterThan(before)
    // Group names and account titles are metadata, not plaintext secrets, but the locked pane has no
    // business keeping them either — a locked vault should look empty until it is unlocked again.
    expect(after.groups).toEqual([])
    expect(after.groupTree).toEqual([])
    expect(after.accounts).toEqual([])
    expect(after.selectedGroupId).toBeNull()
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

  it('surfaces a TOTP secret that does not open instead of showing ciphertext as the secret', async () => {
    vi.mocked(passwordApi.getAccountsPage).mockResolvedValue({
      items: [account({ id: 'acc-broken', totpSecret: 'deadbeef' })],
      nextCursor: null,
    })

    await usePasswordVaultStore.getState().refreshData()

    const row = usePasswordVaultStore.getState().decryptedAccounts['acc-broken']
    expect(row?.totpSecret).toBe('')
    expect(row?.totpUnreadable).toBe(true)
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

  it('moves the list immediately after a drag instead of waiting for the next refresh', async () => {
    vi.mocked(passwordApi.reorderAccounts).mockResolvedValue(undefined as never)
    usePasswordVaultStore.setState({
      accounts: [
        account({ id: 'first', sort: 0 }),
        account({ id: 'second', sort: 1 }),
        account({ id: 'third', sort: 2 }),
      ],
    })

    await usePasswordVaultStore.getState().reorderAccounts([
      { id: 'first', sort: 5 },
      { id: 'third', sort: 0 },
    ])

    // Before the fix only `sort` changed: the array kept its old order, so a drag looked like a no-op
    // until a full reload.
    expect(usePasswordVaultStore.getState().accounts.map((row) => row.id)).toEqual([
      'third',
      'second',
      'first',
    ])
  })

  it('orders the group tree by sort, not by name', async () => {
    vi.mocked(passwordApi.getGroups).mockResolvedValue([
      { id: 'g2', name: 'Alpha', parentId: '', sort: 2, createdAt: 1, updatedAt: 1 },
      { id: 'g1', name: 'Zulu', parentId: '', sort: 1, createdAt: 1, updatedAt: 1 },
    ])
    usePasswordVaultStore.setState({ keyIV: key, isUnlocked: true })

    await usePasswordVaultStore.getState().refreshData()

    // Alphabetical order would put "Alpha" first and make the stored `sort` column decorative.
    expect(usePasswordVaultStore.getState().groupTree.map((group) => group.id)).toEqual(['g1', 'g2'])
  })

  it('paints only the first page until the whole vault is asked for', async () => {
    vi.mocked(passwordApi.getAccountsPage).mockResolvedValue({
      items: [account({ id: 'a', sort: 0 })],
      nextCursor: 'cursor-1',
    })
    vi.mocked(passwordApi.getAccounts).mockResolvedValue([
      account({ id: 'a', sort: 0 }),
      account({ id: 'b', sort: 1 }),
      account({ id: 'c', sort: 2 }),
    ])
    usePasswordVaultStore.setState({ keyIV: key, isUnlocked: true })

    await usePasswordVaultStore.getState().refreshData()
    await Promise.resolve()
    await Promise.resolve()

    let state = usePasswordVaultStore.getState()
    expect(state.accounts.map((row) => row.id)).toEqual(['a'])
    expect(state.nextAccountsCursor).toBe('cursor-1')
    expect(Object.keys(state.decryptedAccounts)).toEqual(['a'])
    // Unlocking a big vault must not fetch and decrypt every row: the list pages from here.
    expect(passwordApi.getAccounts).not.toHaveBeenCalled()

    await usePasswordVaultStore.getState().ensureAllAccounts()

    state = usePasswordVaultStore.getState()
    expect(state.accounts.map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(state.nextAccountsCursor).toBeNull()
    expect(Object.keys(state.decryptedAccounts)).toHaveLength(3)
  })

  it('appends the next cursor page when the background load could not finish', async () => {
    vi.mocked(passwordApi.getAccountsPage)
      .mockResolvedValueOnce({ items: [account({ id: 'a', sort: 0 })], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [account({ id: 'b', sort: 1 })], nextCursor: null })
    vi.mocked(passwordApi.getAccounts).mockRejectedValue(new Error('offline'))
    usePasswordVaultStore.setState({ keyIV: key, isUnlocked: true })

    await usePasswordVaultStore.getState().refreshData()
    await usePasswordVaultStore.getState().loadMoreAccounts()

    const state = usePasswordVaultStore.getState()
    expect(state.accounts.map((row) => row.id)).toEqual(['a', 'b'])
    expect(state.nextAccountsCursor).toBeNull()
  })
})
