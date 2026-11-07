import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveVaultKey } from './crypto'

vi.mock('./api', () => ({
  passwordApi: {
    getVaultState: vi.fn(),
    getGroups: vi.fn(),
    getAccounts: vi.fn(),
    getSettings: vi.fn(),
    updateAccount: vi.fn(),
    createAccount: vi.fn(),
    deleteAccount: vi.fn(),
    unlock: vi.fn(),
    resetMasterPassword: vi.fn(),
  },
}))

import { copySecret } from './utils/clipboard'
import { usePasswordVaultStore } from './store'

const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const key = deriveVaultKey('abcdef', SALT)

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = []

  onmessage: ((event: MessageEvent) => void) | null = null
  posted: unknown[] = []

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this)
  }

  postMessage(data: unknown): void {
    this.posted.push(data)
  }

  close(): void {}
}

function stubClipboard(initial: string | null): { written: string[] } {
  const written: string[] = []
  let current = initial
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        current = text
        written.push(text)
      }),
      readText: vi.fn(async () => current ?? ''),
    },
  })
  return { written }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The store keeps one channel for the module's lifetime, so the fake is installed before the
  // first unlock and the same instance is reused by every case below.
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  usePasswordVaultStore.setState({
    vaultState: { hasVault: true },
    isUnlocked: false,
    keyIV: null,
    accounts: [],
    groups: [],
    groupTree: [],
    decryptedAccounts: {},
    selectedAccountId: null,
    selectedGroupId: null,
  })
})

function channel(): FakeBroadcastChannel {
  return FakeBroadcastChannel.instances[0]!
}

describe('cross-tab lock', () => {
  it('locks the other tabs when this one locks', () => {
    usePasswordVaultStore.getState().unlock(key)
    expect(channel().name).toBe('inkstone-password-lock')

    usePasswordVaultStore.getState().lock()
    expect(channel().posted).toEqual(['lock'])
  })

  it('goes back to the door when another tab locks', () => {
    usePasswordVaultStore.getState().unlock(key)
    usePasswordVaultStore.setState({
      accounts: [
        {
          id: 'acc-1',
          groupId: 'grp-1',
          title: 'sealed',
          username: '',
          password: '',
          link: '',
          remark: '',
          isFavorite: false,
          sort: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      selectedAccountId: 'acc-1',
    })

    channel().onmessage?.(new MessageEvent('message', { data: 'lock' }))

    const state = usePasswordVaultStore.getState()
    expect(state.isUnlocked).toBe(false)
    expect(state.keyIV).toBeNull()
    expect(state.accounts).toEqual([])
    expect(state.selectedAccountId).toBeNull()
  })

  it('ignores unrelated channel traffic', () => {
    usePasswordVaultStore.getState().unlock(key)

    channel().onmessage?.(new MessageEvent('message', { data: 'unlock' }))

    expect(usePasswordVaultStore.getState().isUnlocked).toBe(true)
  })
})

describe('clipboard cleanup on lock', () => {
  it('wipes the copied secret when the vault locks', async () => {
    const clipboard = stubClipboard(null)
    await copySecret('hunter2', 60_000)

    usePasswordVaultStore.getState().lock()
    await Promise.resolve()
    await Promise.resolve()

    expect(clipboard.written).toEqual(['hunter2', ''])
  })

  it('leaves a value the reader copied afterwards alone', async () => {
    const clipboard = stubClipboard(null)
    await copySecret('hunter2', 60_000)
    await navigator.clipboard.writeText('something else')
    clipboard.written.length = 0

    usePasswordVaultStore.getState().lock()
    await Promise.resolve()
    await Promise.resolve()

    expect(clipboard.written).toEqual([])
  })
})
