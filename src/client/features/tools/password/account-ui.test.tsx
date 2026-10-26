import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedAccount, PasswordAccount, PasswordGroup } from '@shared/tools/password/types'
import { useToolsStore } from '../store'
import { passwordApi } from './api'
import { usePasswordVaultStore } from './store'
import {
  FaviconAvatar,
  extractDomain,
  getAvatarColor,
  getInitial,
} from './FaviconAvatar'
import { AccountCard } from './AccountCard'
import { AccountList } from './AccountList'
import { AccountForm, PasswordStrengthIndicator } from './AccountForm'
import { FavoriteAccounts } from './FavoriteAccounts'
import { AccountArea } from './AccountArea'
import { PasswordApp } from './PasswordApp'
import { generatePassword } from './Generator'

let host: HTMLDivElement
let root: Root

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  setValue.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const MOCK_GROUP: PasswordGroup = {
  id: 'g-default',
  name: '默认分组',
  parentId: '',
  sort: 0,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
}

const MOCK_ACCOUNT_1: DecryptedAccount = {
  id: 'acc-1',
  groupId: 'g-default',
  title: 'GitHub',
  username: 'shuaiplus',
  password: 'Password123!',
  link: 'https://github.com/shuaiplus/inkstone',
  remark: 'Self-hosted notebook',
  favicon: '',
  isFavorite: true,
  sort: 0,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
}

const MOCK_ACCOUNT_2: DecryptedAccount = {
  id: 'acc-2',
  groupId: 'g-default',
  title: 'Google Account',
  username: 'admin@google.com',
  password: 'AdminPassword456#',
  link: 'https://google.com',
  remark: 'Primary search and mail',
  favicon: 'https://google.com/custom-favicon.ico',
  isFavorite: false,
  sort: 1,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
}

const MOCK_RAW_ACCOUNTS: PasswordAccount[] = [
  {
    ...MOCK_ACCOUNT_1,
    title: 'encrypted_title_1',
    username: 'encrypted_user_1',
    password: 'encrypted_pass_1',
    link: 'encrypted_link_1',
    remark: 'encrypted_remark_1',
  },
  {
    ...MOCK_ACCOUNT_2,
    title: 'encrypted_title_2',
    username: 'encrypted_user_2',
    password: 'encrypted_pass_2',
    link: 'encrypted_link_2',
    remark: 'encrypted_remark_2',
  },
]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))

  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  })
  window.open = vi.fn()

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  // Mock API methods to avoid network requests
  vi.spyOn(passwordApi, 'getVaultState').mockResolvedValue({ hasVault: true })
  vi.spyOn(passwordApi, 'getGroups').mockResolvedValue([MOCK_GROUP])
  vi.spyOn(passwordApi, 'getAccounts').mockResolvedValue(MOCK_RAW_ACCOUNTS)
  vi.spyOn(passwordApi, 'createAccount').mockImplementation(async (payload) => ({
    id: 'acc-new',
    groupId: payload.groupId || 'g-default',
    title: payload.title || '',
    username: payload.username || '',
    password: payload.password || '',
    link: payload.link || '',
    remark: payload.remark || '',
    favicon: payload.favicon || '',
    isFavorite: payload.isFavorite || false,
    sort: payload.sort || 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }))
  vi.spyOn(passwordApi, 'updateAccount').mockImplementation(async (id, payload) => ({
    id,
    groupId: payload.groupId || 'g-default',
    title: payload.title || '',
    username: payload.username || '',
    password: payload.password || '',
    link: payload.link || '',
    remark: payload.remark || '',
    favicon: payload.favicon || '',
    isFavorite: payload.isFavorite ?? false,
    sort: payload.sort || 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }))
  vi.spyOn(passwordApi, 'deleteAccount').mockResolvedValue({ ok: true })

  // Reset Zustand stores
  usePasswordVaultStore.setState({
    vaultState: { hasVault: true },
    isUnlocked: true,
    keyIV: { key: 'mock-key', iv: 'mock-iv' },
    masterPasswordText: '123456',
    groups: [MOCK_GROUP],
    groupTree: [MOCK_GROUP],
    accounts: MOCK_RAW_ACCOUNTS,
    decryptedAccounts: {
      'acc-1': { ...MOCK_ACCOUNT_1 },
      'acc-2': { ...MOCK_ACCOUNT_2 },
    },
    selectedAccountId: 'acc-1',
    selectedGroupId: 'g-default',
    isLoading: false,
    isGeneratorModalOpen: false,
    isBatchOperationsOpen: false,
  })

  useToolsStore.setState({
    activePasswordView: 'all',
    selectedGroupId: 'g-default',
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FaviconAvatar', () => {
  it('extracts domain correctly from diverse link strings', () => {
    expect(extractDomain('https://github.com/shuaiplus')).toBe('github.com')
    expect(extractDomain('http://sub.example.com/path?q=1')).toBe('sub.example.com')
    expect(extractDomain('inkstone.dev')).toBe('inkstone.dev')
    expect(extractDomain('')).toBe('')
    expect(extractDomain(undefined)).toBe('')
  })

  it('extracts initial grapheme correctly for English, Chinese, and symbols', () => {
    expect(getInitial('GitHub')).toBe('G')
    expect(getInitial('github')).toBe('G')
    expect(getInitial('密码管家')).toBe('密')
    expect(getInitial('', 'https://google.com')).toBe('G')
    expect(getInitial('', '')).toBe('?')
  })

  it('computes deterministic colors from seeds', () => {
    const c1 = getAvatarColor('seed-a')
    const c2 = getAvatarColor('seed-a')
    const c3 = getAvatarColor('seed-b')
    expect(c1).toBe(c2)
    expect(typeof c1).toBe('string')
    expect(typeof c3).toBe('string')
  })

  it('renders image when candidate URL exists and falls back on error', async () => {
    act(() => {
      root.render(
        createElement(FaviconAvatar, {
          url: 'https://example.com',
          title: 'Example',
        }),
      )
    })

    const img = host.querySelector<HTMLImageElement>('img')
    expect(img).not.toBeNull()
    expect(img?.src).toContain('google.com/s2/favicons')

    // Simulate img error
    act(() => {
      img?.dispatchEvent(new Event('error'))
    })

    // Now img should be replaced with fallback initial
    const fallback = host.querySelector('[data-testid="favicon-initial"]')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toBe('E')
  })
})

describe('AccountCard', () => {
  it('renders account title, username, and avatar', () => {
    const onSelect = vi.fn()
    const onToggleFavorite = vi.fn()

    act(() => {
      root.render(
        createElement(AccountCard, {
          account: MOCK_ACCOUNT_1,
          isSelected: false,
          onSelect,
          onToggleFavorite,
        }),
      )
    })

    expect(host.textContent).toContain('GitHub')
    expect(host.textContent).toContain('shuaiplus')

    const starBtn = host.querySelector<HTMLButtonElement>('[data-testid="account-favorite-btn"]')
    expect(starBtn).not.toBeNull()

    act(() => {
      starBtn?.click()
    })
    expect(onToggleFavorite).toHaveBeenCalledWith('acc-1')
    // The star is a sibling of the row, not a control inside it: the press cannot reach the row's
    // handler on the way out, which is what the next assertion is actually checking.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selects through the row button and reports its pressed state', () => {
    const onSelect = vi.fn()

    act(() => {
      root.render(
        createElement(AccountCard, {
          account: MOCK_ACCOUNT_1,
          isSelected: true,
          onSelect,
        }),
      )
    })

    const card = host.querySelector<HTMLButtonElement>('[data-testid="account-card"]')!
    // Enter and Space are the browser's own activation for a button, so no keydown handler of ours is what
    // puts the row in the tab order — and nothing here overrides that order.
    expect(card.tagName).toBe('BUTTON')
    expect(card.getAttribute('type')).toBe('button')
    expect(card.hasAttribute('tabindex')).toBe(false)
    expect(card.getAttribute('aria-pressed')).toBe('true')
    expect(card.getAttribute('aria-label')).toBe('GitHub')

    act(() => {
      card.click()
    })
    expect(onSelect).toHaveBeenCalledWith(MOCK_ACCOUNT_1)
  })

  it('sets HTML5 drag data on dragstart', () => {
    act(() => {
      root.render(
        createElement(AccountCard, {
          account: MOCK_ACCOUNT_1,
          isSelected: false,
          onSelect: vi.fn(),
        }),
      )
    })

    const card = host.querySelector<HTMLElement>('[data-testid="account-card"]')!
    const dataTransfer = {
      setData: vi.fn(),
      effectAllowed: '',
    }
    const dragEvent = new Event('dragstart', { bubbles: true }) as any
    dragEvent.dataTransfer = dataTransfer

    act(() => {
      card.dispatchEvent(dragEvent)
    })

    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'acc-1')
    expect(dataTransfer.effectAllowed).toBe('move')
  })
})

describe('AccountList', () => {
  it('renders accounts list and instant fuzzy filters', async () => {
    act(() => {
      root.render(createElement(AccountList))
    })

    const cards = host.querySelectorAll('[data-testid="account-card"]')
    expect(cards.length).toBe(2)

    const searchInput = host.querySelector<HTMLInputElement>('[data-testid="account-search-input"]')!
    expect(searchInput).not.toBeNull()

    // Filter by 'GitHub'
    act(() => {
      setInputValue(searchInput, 'github')
    })

    const filtered = host.querySelectorAll('[data-testid="account-card"]')
    expect(filtered.length).toBe(1)
    expect(host.textContent).toContain('GitHub')
    expect(host.textContent).not.toContain('Google Account')
  })

  it('supports ArrowUp and ArrowDown keyboard navigation', async () => {
    act(() => {
      root.render(createElement(AccountList))
    })

    const container = host.querySelector<HTMLElement>('[data-testid="account-cards-container"]')!
    expect(usePasswordVaultStore.getState().selectedAccountId).toBe('acc-1')

    // Press ArrowDown
    act(() => {
      container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(usePasswordVaultStore.getState().selectedAccountId).toBe('acc-2')

    // Press ArrowUp
    act(() => {
      container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(usePasswordVaultStore.getState().selectedAccountId).toBe('acc-1')
  })

  it('triggers quick new account on add button click', async () => {
    const createAccountSpy = vi.spyOn(usePasswordVaultStore.getState(), 'createAccount')

    act(() => {
      root.render(createElement(AccountList))
    })

    const addBtn = host.querySelector<HTMLButtonElement>('[data-testid="account-add-btn"]')!
    expect(addBtn).not.toBeNull()

    await act(async () => {
      addBtn.click()
    })

    expect(createAccountSpy).toHaveBeenCalled()
  })
})

describe('AccountForm', () => {
  it('renders empty prompt when no account is selected', () => {
    usePasswordVaultStore.setState({ selectedAccountId: null })

    act(() => {
      root.render(createElement(AccountForm))
    })

    expect(host.querySelector('[data-testid="account-form-empty"]')).not.toBeNull()
  })

  it('renders details, supports anti-touch lock/unlock, password toggle, and copy', async () => {
    act(() => {
      root.render(createElement(AccountForm))
    })

    expect(host.querySelector('[data-testid="account-form"]')).not.toBeNull()

    const titleInput = host.querySelector<HTMLInputElement>('[data-testid="input-title"]')!
    const usernameInput = host.querySelector<HTMLInputElement>('[data-testid="input-username"]')!
    const passwordInput = host.querySelector<HTMLInputElement>('[data-testid="input-password"]')!

    expect(titleInput.value).toBe('GitHub')
    expect(usernameInput.value).toBe('shuaiplus')
    expect(passwordInput.value).toBe('Password123!')
    expect(passwordInput.type).toBe('password')

    // Existing content defaults to locked
    expect(titleInput.disabled).toBe(true)

    // Unlock anti-touch
    const lockBtn = host.querySelector<HTMLButtonElement>('[data-testid="form-lock-btn"]')!
    act(() => {
      lockBtn.click()
    })
    expect(titleInput.disabled).toBe(false)

    // Toggle password eye
    const toggleEyeBtn = host.querySelector<HTMLButtonElement>('[data-testid="toggle-password-btn"]')!
    act(() => {
      toggleEyeBtn.click()
    })
    expect(passwordInput.type).toBe('text')

    // Copy username
    const copyUserBtn = host.querySelector<HTMLButtonElement>('[data-testid="copy-username-btn"]')!
    await act(async () => {
      copyUserBtn.click()
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('shuaiplus')

    // Copy password
    const copyPassBtn = host.querySelector<HTMLButtonElement>('[data-testid="copy-password-btn"]')!
    await act(async () => {
      copyPassBtn.click()
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Password123!')
  })

  it('auto-saves form modifications with 300ms debounce', async () => {
    const updateSpy = vi.spyOn(usePasswordVaultStore.getState(), 'updateAccount')

    act(() => {
      root.render(createElement(AccountForm))
    })

    // Unlock
    const lockBtn = host.querySelector<HTMLButtonElement>('[data-testid="form-lock-btn"]')!
    act(() => {
      lockBtn.click()
    })

    const titleInput = host.querySelector<HTMLInputElement>('[data-testid="input-title"]')!

    act(() => {
      setInputValue(titleInput, 'GitHub Enterprise')
    })

    // Before 300ms, not called yet
    expect(updateSpy).not.toHaveBeenCalled()

    // Fast forward debounce timer
    await act(async () => {
      await delay(350)
    })

    expect(updateSpy).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      title: 'GitHub Enterprise',
    }))
  })

  it('opens URL and copies password on website link button click', async () => {
    act(() => {
      root.render(createElement(AccountForm))
    })

    const openLinkBtn = host.querySelector<HTMLButtonElement>('[data-testid="open-link-btn"]')!
    await act(async () => {
      openLinkBtn.click()
    })

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Password123!')
    expect(window.open).toHaveBeenCalledWith('https://github.com/shuaiplus/inkstone', '_blank', 'noopener,noreferrer')
  })
})

describe('PasswordStrengthIndicator', () => {
  it('renders strength score and label properly', () => {
    act(() => {
      root.render(createElement(PasswordStrengthIndicator, { password: 'CorrectHorseBatteryStaple2026!' }))
    })

    const indicator = host.querySelector('[data-testid="password-strength-indicator"]')
    expect(indicator).not.toBeNull()

    const bars = host.querySelectorAll('[data-testid="strength-bar"]')
    expect(bars.length).toBe(4)

    const label = host.querySelector('[data-testid="strength-label"]')
    expect(label?.textContent?.length).toBeGreaterThan(0)
  })
})

describe('FavoriteAccounts', () => {
  it('renders favorite accounts view filtering by starred items', () => {
    act(() => {
      root.render(createElement(FavoriteAccounts))
    })

    expect(host.querySelector('[data-testid="favorite-accounts-view"]')).not.toBeNull()
    const cards = host.querySelectorAll('[data-testid="account-card"]')
    // MOCK_ACCOUNT_1 is favorite, MOCK_ACCOUNT_2 is not
    expect(cards.length).toBe(1)
    expect(host.textContent).toContain('GitHub')
  })
})

describe('AccountArea', () => {
  it('renders dual pane containing AccountList and AccountForm', () => {
    act(() => {
      root.render(createElement(AccountArea))
    })

    expect(host.querySelector('[data-testid="account-area"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="account-list"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="account-form"]')).not.toBeNull()
  })
})

describe('PasswordApp Integration', () => {
  it('renders Door when locked and vault exists', async () => {
    usePasswordVaultStore.setState({ isUnlocked: false, vaultState: { hasVault: true } })

    await act(async () => {
      root.render(createElement(PasswordApp))
    })

    expect(host.querySelector('[data-testid="password-door"]')).not.toBeNull()
  })

  it('renders Setting when locked and vault has not been initialized', async () => {
    usePasswordVaultStore.setState({
      isUnlocked: false,
      vaultState: { hasVault: false },
      isSettingOpen: true,
    })

    await act(async () => {
      root.render(createElement(PasswordApp))
    })

    expect(document.querySelector('[data-testid="password-setting-input"]')).not.toBeNull()
  })

  it('renders AccountArea when unlocked in all mode', async () => {
    usePasswordVaultStore.setState({ isUnlocked: true })
    useToolsStore.setState({ activePasswordView: 'all' })

    await act(async () => {
      root.render(createElement(PasswordApp))
    })

    expect(host.querySelector('[data-testid="account-area"]')).not.toBeNull()
  })

  it('renders FavoriteAccounts when activePasswordView is favorites', async () => {
    usePasswordVaultStore.setState({ isUnlocked: true })
    useToolsStore.setState({ activePasswordView: 'favorites' })

    await act(async () => {
      root.render(createElement(PasswordApp))
    })

    expect(host.querySelector('[data-testid="favorite-accounts-view"]')).not.toBeNull()
  })

  it('renders Generator when activePasswordView is generator', async () => {
    usePasswordVaultStore.setState({ isUnlocked: true })
    useToolsStore.setState({ activePasswordView: 'generator' })

    await act(async () => {
      root.render(createElement(PasswordApp))
    })

    expect(host.querySelector('[data-testid="password-generator-view"]')).not.toBeNull()
  })
})

describe('Password Generator Logic', () => {
  it('generates random password conforming to length and options', () => {
    const pwd1 = generatePassword({
      length: 20,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: true,
    })
    expect(pwd1.length).toBe(20)

    const numOnly = generatePassword({
      length: 8,
      uppercase: false,
      lowercase: false,
      numbers: true,
      symbols: false,
    })
    expect(numOnly.length).toBe(8)
    expect(/^\d+$/.test(numOnly)).toBe(true)
  })
})
