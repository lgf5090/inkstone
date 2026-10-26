// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { ConfirmHost, PromptHost } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { usePasswordVaultStore } from './store'
import { passwordApi } from './api'
import {
  encryptValue,
  getKeyIv,
  getRecoveryPass,
} from './crypto'
import { Door } from './Door'
import { Setting } from './Setting'
import { Reset } from './Reset'
import { Recover } from './Recover'
import { useAutoLock } from './useAutoLock'
import { GroupTree } from './GroupTree'
import { GroupTreeNode, MAX_GROUP_TREE_DEPTH } from './GroupTreeNode'
import { ToolsSidebar } from '../ToolsSidebar'
import type { PasswordAccount, PasswordGroup } from '@shared/tools/password/types'

let view: RenderedElement | null = null

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, value)
  } else {
    input.value = value
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function renderWithHosts(node: React.ReactNode) {
  view = renderElement(
    createElement(
      'div',
      null,
      node,
      createElement(ConfirmHost, { key: 'confirm-host' }),
      createElement(PromptHost, { key: 'prompt-host' }),
    ),
  )
  return view
}

describe('WS-5: Password Manager Core UI - Door System & Group Tree', () => {
  const masterPassword = 'MyPass' // 6 chars
  const keyiv = getKeyIv(masterPassword)

  beforeEach(async () => {
    localStorage.clear()
    await initI18n()

    // Reset store state
    usePasswordVaultStore.setState({
      vaultState: {
        hasVault: true,
        recoveryHint: getRecoveryPass(masterPassword.slice(0, 3)),
      },
      isUnlocked: false,
      keyIV: null,
      masterPasswordText: '',
      groups: [],
      groupTree: [],
      accounts: [],
      decryptedAccounts: {},
      selectedAccountId: null,
      selectedGroupId: null,
      isSettingOpen: false,
      isResetOpen: false,
      isRecoverOpen: false,
    })

    vi.restoreAllMocks()
  })

  afterEach(() => {
    act(() => {
      view?.unmount()
    })
    view = null
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  // ---------------------------------------------------------------- Door
  describe('Door Component', () => {
    it('renders centered card with 6-digit password input and actions', () => {
      renderWithHosts(createElement(Door))

      const card = document.querySelector('[data-testid="password-door-card"]')
      expect(card).toBeTruthy()
      expect(card?.textContent).toContain(t('tools.password.door.title'))

      const input = document.querySelector<HTMLInputElement>('[data-testid="password-door-input"]')
      expect(input).toBeTruthy()
      expect(input?.maxLength).toBe(6)

      expect(document.querySelector('[data-testid="password-door-forgot"]')).toBeTruthy()
      expect(document.querySelector('[data-testid="password-door-modify"]')).toBeTruthy()
    })

    it('detects CapsLock real-time via event.getModifierState', () => {
      renderWithHosts(createElement(Door))
      const input = document.querySelector<HTMLInputElement>('[data-testid="password-door-input"]')!

      // CapsLock is ON
      act(() => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'A',
            bubbles: true,
            modifierCapsLock: true,
          }),
        )
      })

      // Caps lock alert should appear
      const capsAlert = document.querySelector('[data-testid="password-door-caps-lock"]')
      expect(capsAlert).toBeTruthy()
      expect(capsAlert?.textContent).toContain(t('tools.password.door.caps_lock'))

      // CapsLock is OFF
      act(() => {
        input.dispatchEvent(
          new KeyboardEvent('keyup', {
            key: 'a',
            bubbles: true,
            modifierCapsLock: false,
          }),
        )
      })

      expect(document.querySelector('[data-testid="password-door-caps-lock"]')).toBeNull()
    })

    it('intercepts Chinese IME composition state and shows warning', () => {
      renderWithHosts(createElement(Door))
      const input = document.querySelector<HTMLInputElement>('[data-testid="password-door-input"]')!

      act(() => {
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      })

      const imeAlert = document.querySelector('[data-testid="password-door-ime-warn"]')
      expect(imeAlert).toBeTruthy()
      expect(imeAlert?.textContent).toContain(t('tools.password.door.ime_warn'))

      act(() => {
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      })

      expect(document.querySelector('[data-testid="password-door-ime-warn"]')).toBeNull()
    })

    it('rejects passwords shorter than 6 characters and applies shake animation', async () => {
      renderWithHosts(createElement(Door))
      const input = document.querySelector<HTMLInputElement>('[data-testid="password-door-input"]')!
      const card = document.querySelector('[data-testid="password-door-card"]')!

      act(() => {
        setInputValue(input, '123')
      })

      const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-door-submit"]')!
      await act(async () => {
        submitBtn.click()
      })

      expect(card.classList.contains('door-fail')).toBe(true)
      expect(usePasswordVaultStore.getState().isUnlocked).toBe(false)
    })

    it('shakes and shows fail error when wrong password is submitted', async () => {
      const encAccount: PasswordAccount = {
        id: 'acc-1',
        groupId: 'grp-1',
        title: encryptValue(keyiv, 'My Vault Account'),
        username: encryptValue(keyiv, 'admin'),
        password: encryptValue(keyiv, 'secret'),
        link: '',
        remark: '',
        favicon: '',
        isFavorite: false,
        sort: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      usePasswordVaultStore.setState({ accounts: [encAccount] })

      renderWithHosts(createElement(Door))
      const input = document.querySelector<HTMLInputElement>('[data-testid="password-door-input"]')!
      const card = document.querySelector('[data-testid="password-door-card"]')!

      act(() => {
        setInputValue(input, 'Wrong1')
      })

      const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-door-submit"]')!
      await act(async () => {
        submitBtn.click()
      })

      expect(card.classList.contains('door-fail')).toBe(true)
      const errorEl = document.querySelector('[data-testid="password-door-error"]')
      expect(errorEl?.textContent).toContain(t('tools.password.door.fail'))
      expect(usePasswordVaultStore.getState().isUnlocked).toBe(false)
    })

    it('unlocks successfully on correct 6-digit password submitted via Enter key', async () => {
      const encAccount: PasswordAccount = {
        id: 'acc-1',
        groupId: 'grp-1',
        title: encryptValue(keyiv, 'My Vault Account'),
        username: encryptValue(keyiv, 'admin'),
        password: encryptValue(keyiv, 'secret'),
        link: '',
        remark: '',
        favicon: '',
        isFavorite: false,
        sort: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      usePasswordVaultStore.setState({ accounts: [encAccount] })
      vi.spyOn(passwordApi, 'getGroups').mockResolvedValue([])
      vi.spyOn(passwordApi, 'getAccounts').mockResolvedValue([encAccount])

      renderWithHosts(createElement(Door))
      const input = document.querySelector<HTMLInputElement>('[data-testid="password-door-input"]')!
      const rememberCheckbox = document.querySelector<HTMLInputElement>('[data-testid="password-door-remember"]')!

      act(() => {
        rememberCheckbox.click()
        setInputValue(input, masterPassword)
      })

      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      expect(usePasswordVaultStore.getState().isUnlocked).toBe(true)
      expect(usePasswordVaultStore.getState().masterPasswordText).toBe(masterPassword)
      expect(usePasswordVaultStore.getState().keyIV?.key).toBe(keyiv.key)
    })

    it('navigates to recover and reset modals from Door links', () => {
      renderWithHosts(createElement(Door))

      const forgotBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-door-forgot"]')!
      act(() => {
        forgotBtn.click()
      })
      expect(usePasswordVaultStore.getState().isRecoverOpen).toBe(true)

      const modifyBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-door-modify"]')!
      act(() => {
        modifyBtn.click()
      })
      expect(usePasswordVaultStore.getState().isResetOpen).toBe(true)
    })
  })

  // ---------------------------------------------------------------- Setting
  describe('Setting Component (First-Time Vault Initialization)', () => {
    it('evaluates password strength in real time', () => {
      usePasswordVaultStore.setState({ isSettingOpen: true })
      renderWithHosts(createElement(Setting))

      const input = document.querySelector<HTMLInputElement>('[data-testid="password-setting-input"]')!

      act(() => {
        setInputValue(input, '123456')
      })

      const strengthSection = document.querySelector('[data-testid="password-setting-strength"]')
      expect(strengthSection).toBeTruthy()
      const label = document.querySelector('[data-testid="password-strength-label"]')
      expect(label?.textContent).toBeTruthy()
    })

    it('shows mismatch error if passwords do not match', async () => {
      usePasswordVaultStore.setState({ isSettingOpen: true })
      renderWithHosts(createElement(Setting))

      const input1 = document.querySelector<HTMLInputElement>('[data-testid="password-setting-input"]')!
      const input2 = document.querySelector<HTMLInputElement>('[data-testid="password-setting-confirm"]')!

      act(() => {
        setInputValue(input1, 'Pass01')
        setInputValue(input2, 'Pass02')
      })

      const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-setting-submit"]')!
      await act(async () => {
        submitBtn.click()
      })

      const error = document.querySelector('[data-testid="password-setting-error"]')
      expect(error?.textContent).toContain(t('tools.password.setting.mismatch'))
      expect(usePasswordVaultStore.getState().isUnlocked).toBe(false)
    })

    it('calls initVault, creates default group & welcome account, and auto-unlocks', async () => {
      const initSpy = vi.spyOn(passwordApi, 'initVault').mockResolvedValue({ ok: true })
      const createGroupSpy = vi.spyOn(passwordApi, 'createGroup').mockResolvedValue({
        id: 'group-default-1',
        name: t('tools.password.setting.default_group'),
        parentId: '',
        sort: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const createAccountSpy = vi.spyOn(passwordApi, 'createAccount').mockResolvedValue({
        id: 'acc-welcome',
        groupId: 'group-default-1',
        title: 'cipher-title',
        username: 'cipher-user',
        password: 'cipher-pass',
        link: '',
        remark: '',
        favicon: '',
        isFavorite: false,
        sort: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      vi.spyOn(passwordApi, 'getGroups').mockResolvedValue([])
      vi.spyOn(passwordApi, 'getAccounts').mockResolvedValue([])

      usePasswordVaultStore.setState({ isSettingOpen: true })
      renderWithHosts(createElement(Setting))

      const input1 = document.querySelector<HTMLInputElement>('[data-testid="password-setting-input"]')!
      const input2 = document.querySelector<HTMLInputElement>('[data-testid="password-setting-confirm"]')!

      act(() => {
        setInputValue(input1, 'Init01')
        setInputValue(input2, 'Init01')
      })

      const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-setting-submit"]')!
      await act(async () => {
        submitBtn.click()
      })

      expect(initSpy).toHaveBeenCalled()
      expect(createGroupSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: t('tools.password.setting.default_group') }),
      )
      expect(createAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: 'group-default-1',
        }),
      )
      expect(usePasswordVaultStore.getState().isSettingOpen).toBe(false)
      expect(usePasswordVaultStore.getState().isUnlocked).toBe(true)
      expect(usePasswordVaultStore.getState().masterPasswordText).toBe('Init01')
    })
  })

  // ---------------------------------------------------------------- Reset
  describe('Reset Component (Change Master Password)', () => {
    it('validates old password and blocks reset if old password is wrong', async () => {
      usePasswordVaultStore.setState({
        isResetOpen: true,
        masterPasswordText: masterPassword,
      })
      renderWithHosts(createElement(Reset))

      const oldInput = document.querySelector<HTMLInputElement>('[data-testid="password-reset-old"]')!
      const newInput = document.querySelector<HTMLInputElement>('[data-testid="password-reset-new"]')!
      const confirmInput = document.querySelector<HTMLInputElement>('[data-testid="password-reset-confirm"]')!

      act(() => {
        setInputValue(oldInput, 'WrongP')
        setInputValue(newInput, 'NewP26')
        setInputValue(confirmInput, 'NewP26')
      })

      const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-reset-submit"]')!
      await act(async () => {
        submitBtn.click()
      })

      const error = document.querySelector('[data-testid="password-reset-error"]')
      expect(error).toBeTruthy()
      expect(error?.textContent).toContain(t('tools.password.door.fail'))
    })

    it('batch re-encrypts all accounts and calls resetMasterPassword on success', async () => {
      const existingAccount: PasswordAccount = {
        id: 'acc-existing',
        groupId: 'grp-1',
        title: encryptValue(keyiv, 'Old Plain Title'),
        username: encryptValue(keyiv, 'oldUser'),
        password: encryptValue(keyiv, 'oldPass'),
        link: encryptValue(keyiv, 'https://example.com'),
        remark: encryptValue(keyiv, 'note'),
        favicon: '',
        isFavorite: false,
        sort: 1,
        createdAt: 1000,
        updatedAt: 1000,
      }

      usePasswordVaultStore.setState({
        isResetOpen: true,
        isUnlocked: true,
        masterPasswordText: masterPassword,
        accounts: [existingAccount],
      })

      const resetApiSpy = vi.spyOn(passwordApi, 'resetMasterPassword').mockResolvedValue({ ok: true })
      vi.spyOn(passwordApi, 'getAccounts').mockResolvedValue([existingAccount])

      renderWithHosts(createElement(Reset))

      const oldInput = document.querySelector<HTMLInputElement>('[data-testid="password-reset-old"]')!
      const newInput = document.querySelector<HTMLInputElement>('[data-testid="password-reset-new"]')!
      const confirmInput = document.querySelector<HTMLInputElement>('[data-testid="password-reset-confirm"]')!

      const newPass = 'FreshP'
      act(() => {
        setInputValue(oldInput, masterPassword)
        setInputValue(newInput, newPass)
        setInputValue(confirmInput, newPass)
      })

      const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-reset-submit"]')!
      await act(async () => {
        submitBtn.click()
      })

      expect(resetApiSpy).toHaveBeenCalled()
      const payload = resetApiSpy.mock.calls[0][0]
      expect(payload.accounts).toHaveLength(1)

      const newKeyIv = getKeyIv(newPass)
      const reencryptedAccount = payload.accounts[0]
      expect(reencryptedAccount.id).toBe(existingAccount.id)
      expect(usePasswordVaultStore.getState().masterPasswordText).toBe(newPass)
      expect(usePasswordVaultStore.getState().keyIV?.key).toBe(newKeyIv.key)
      expect(usePasswordVaultStore.getState().isResetOpen).toBe(false)
    })
  })

  // ---------------------------------------------------------------- Recover
  describe('Recover Component', () => {
    it('displays first 3 characters hint and verifies with remaining 3 characters', async () => {
      const hint = masterPassword.slice(0, 3) // 'MyP'
      const suffix = masterPassword.slice(3) // 'ass'

      usePasswordVaultStore.setState({
        isRecoverOpen: true,
        vaultState: {
          hasVault: true,
          recoveryHint: getRecoveryPass(hint),
        },
      })

      renderWithHosts(createElement(Recover))

      // Displays first 3 chars
      const hintBadge = document.querySelector('[data-testid="password-recover-prefix-badge"]')
      expect(hintBadge?.textContent).toBe(hint)

      const suffixInput = document.querySelector<HTMLInputElement>('[data-testid="password-recover-suffix-input"]')!
      expect(suffixInput).toBeTruthy()
      expect(suffixInput.maxLength).toBe(3)

      act(() => {
        setInputValue(suffixInput, suffix)
      })

      const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-recover-submit"]')!
      await act(async () => {
        submitBtn.click()
      })

      expect(usePasswordVaultStore.getState().isUnlocked).toBe(true)
      expect(usePasswordVaultStore.getState().masterPasswordText).toBe(masterPassword)
      expect(usePasswordVaultStore.getState().isRecoverOpen).toBe(false)
    })

    it('rejects incomplete or incorrect suffix', async () => {
      const hint = masterPassword.slice(0, 3)

      usePasswordVaultStore.setState({
        isRecoverOpen: true,
        vaultState: {
          hasVault: true,
          recoveryHint: getRecoveryPass(hint),
        },
      })

      renderWithHosts(createElement(Recover))
      const suffixInput = document.querySelector<HTMLInputElement>('[data-testid="password-recover-suffix-input"]')!

      // Enter only 2 characters
      act(() => {
        setInputValue(suffixInput, '12')
      })

      const submitBtn = document.querySelector<HTMLButtonElement>('[data-testid="password-recover-submit"]')!
      await act(async () => {
        submitBtn.click()
      })

      const error = document.querySelector('[data-testid="password-recover-error"]')
      expect(error).toBeTruthy()
      expect(usePasswordVaultStore.getState().isUnlocked).toBe(false)
    })
  })

  // ---------------------------------------------------------------- useAutoLock
  describe('useAutoLock Hook', () => {
    function AutoLockHost({ timeout }: { timeout?: number }) {
      useAutoLock(timeout)
      return createElement('div', { 'data-testid': 'autolock-host' })
    }

    it('automatically destroys memory keyIV and locks screen after 5 minutes of blur', () => {
      vi.useFakeTimers()
      usePasswordVaultStore.setState({
        isUnlocked: true,
        keyIV: keyiv,
        masterPasswordText: masterPassword,
      })

      renderWithHosts(createElement(AutoLockHost, { timeout: 300_000 }))

      act(() => {
        window.dispatchEvent(new Event('blur'))
      })

      act(() => {
        vi.advanceTimersByTime(240_000)
      })
      expect(usePasswordVaultStore.getState().isUnlocked).toBe(true)

      act(() => {
        vi.advanceTimersByTime(60_000)
      })

      expect(usePasswordVaultStore.getState().isUnlocked).toBe(false)
      expect(usePasswordVaultStore.getState().keyIV).toBeNull()
      expect(usePasswordVaultStore.getState().masterPasswordText).toBe('')
    })

    it('cancels auto-lock if focus returns before 5 minutes', () => {
      vi.useFakeTimers()
      usePasswordVaultStore.setState({
        isUnlocked: true,
        keyIV: keyiv,
        masterPasswordText: masterPassword,
      })

      renderWithHosts(createElement(AutoLockHost, { timeout: 300_000 }))

      act(() => {
        window.dispatchEvent(new Event('blur'))
        vi.advanceTimersByTime(120_000)
      })

      act(() => {
        window.dispatchEvent(new Event('focus'))
      })

      act(() => {
        vi.advanceTimersByTime(200_000)
      })

      expect(usePasswordVaultStore.getState().isUnlocked).toBe(true)
    })

    it('locks immediately on focus if elapsed time since blur >= 5 minutes', () => {
      usePasswordVaultStore.setState({
        isUnlocked: true,
        keyIV: keyiv,
        masterPasswordText: masterPassword,
      })

      renderWithHosts(createElement(AutoLockHost, { timeout: 300_000 }))

      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now)

      act(() => {
        window.dispatchEvent(new Event('blur'))
      })

      vi.spyOn(Date, 'now').mockReturnValue(now + 360_000)

      act(() => {
        window.dispatchEvent(new Event('focus'))
      })

      expect(usePasswordVaultStore.getState().isUnlocked).toBe(false)
    })
  })

  // ---------------------------------------------------------------- GroupTree & GroupTreeNode
  describe('GroupTree and GroupTreeNode Components', () => {
    const mockGroups: PasswordGroup[] = [
      {
        id: 'grp-root',
        name: '工作项目',
        parentId: '',
        sort: 1,
        createdAt: 1000,
        updatedAt: 1000,
        childs: [
          {
            id: 'grp-sub1',
            name: 'Cloudflare',
            parentId: 'grp-root',
            sort: 1,
            createdAt: 1000,
            updatedAt: 1000,
            childs: [],
          },
        ],
      },
      {
        id: 'grp-personal',
        name: '个人生活',
        parentId: '',
        sort: 2,
        createdAt: 1000,
        updatedAt: 1000,
        childs: [],
      },
    ]

    const mockAccounts: PasswordAccount[] = [
      {
        id: 'acc-1',
        groupId: 'grp-sub1',
        title: 'CF-Token',
        username: 'user@example.com',
        password: 'pass',
        link: '',
        remark: '',
        favicon: '',
        isFavorite: false,
        sort: 1,
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'acc-2',
        groupId: 'grp-personal',
        title: 'Netflix',
        username: 'personal',
        password: 'pass',
        link: '',
        remark: '',
        favicon: '',
        isFavorite: false,
        sort: 1,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]

    beforeEach(() => {
      usePasswordVaultStore.setState({
        isUnlocked: true,
        keyIV: keyiv,
        masterPasswordText: masterPassword,
        groups: [
          mockGroups[0],
          mockGroups[0].childs![0],
          mockGroups[1],
        ],
        groupTree: mockGroups,
        accounts: mockAccounts,
        selectedGroupId: 'grp-root',
      })
    })

    it('renders multi-level group tree with indentation and accounts badge', () => {
      renderWithHosts(createElement(GroupTree))

      const rootNode = document.querySelector('[data-testid="group-tree-node-grp-root"]')
      expect(rootNode).toBeTruthy()
      expect(rootNode?.getAttribute('data-depth')).toBe('1')

      const subNode = document.querySelector('[data-testid="group-tree-node-grp-sub1"]')
      expect(subNode).toBeTruthy()
      expect(subNode?.getAttribute('data-depth')).toBe('2')
      expect(subNode?.textContent).toContain('1')
    })

    it('names the toggle for its state and folds the branch back', () => {
      renderWithHosts(createElement(GroupTree))

      const rootNode = document.querySelector('[data-testid="group-tree-node-grp-root"]')!
      const toggleBtn = rootNode.querySelector<HTMLButtonElement>('[data-testid="group-toggle"]')!
      const expandedName = toggleBtn.getAttribute('aria-label')
      expect(expandedName).toBeTruthy()

      act(() => {
        toggleBtn.click()
      })

      expect(document.querySelector('[data-testid="group-tree-node-grp-sub1"]')).toBeNull()

      // The name is locale text, so the test asks that it exists and moves with the state — not what it says.
      const collapsedName = toggleBtn.getAttribute('aria-label')
      expect(collapsedName).toBeTruthy()
      expect(collapsedName).not.toBe(expandedName)

      act(() => {
        toggleBtn.click()
      })

      expect(document.querySelector('[data-testid="group-tree-node-grp-sub1"]')).toBeTruthy()
    })

    it('blocks deletion of group with child groups', async () => {
      const toastSpy = vi.spyOn(useUi.getState(), 'toast')

      renderWithHosts(createElement(GroupTree))
      const rootNode = document.querySelector('[data-testid="group-tree-node-grp-root"]')!

      act(() => {
        rootNode.querySelector('div')?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: 100,
            clientY: 100,
          }),
        )
      })

      const deleteMenuItem = [...document.querySelectorAll('[role="menu"] button')].find(
        (b) => b.textContent?.includes(t('tools.password.group.delete')),
      )
      expect(deleteMenuItem).toBeTruthy()

      await act(async () => {
        deleteMenuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: t('tools.password.group.delete_has_children'),
          tone: 'warning',
        }),
      )
    })

    it('blocks deletion of group containing accounts', async () => {
      const toastSpy = vi.spyOn(useUi.getState(), 'toast')

      renderWithHosts(createElement(GroupTree))
      const personalNode = document.querySelector('[data-testid="group-tree-node-grp-personal"]')!

      act(() => {
        personalNode.querySelector('div')?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: 100,
            clientY: 100,
          }),
        )
      })

      const deleteMenuItem = [...document.querySelectorAll('[role="menu"] button')].find(
        (b) => b.textContent?.includes(t('tools.password.group.delete')),
      )

      await act(async () => {
        deleteMenuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: t('tools.password.group.delete_has_accounts'),
          tone: 'warning',
        }),
      )
    })

    it('supports HTML5 drag and drop of accounts onto a group node', async () => {
      const moveSpy = vi.spyOn(passwordApi, 'updateAccount').mockResolvedValue({} as any)

      renderWithHosts(createElement(GroupTree))
      const personalNode = document.querySelector('[data-testid="group-tree-node-grp-personal"]')!.querySelector('div')!

      const dropEvent = new Event('drop', { bubbles: true }) as any
      dropEvent.dataTransfer = {
        getData: (type: string) => {
          if (type === 'text/inkstone-password-account-id') return 'acc-1'
          return ''
        },
      }

      await act(async () => {
        personalNode.dispatchEvent(dropEvent)
      })

      expect(moveSpy).toHaveBeenCalledWith('acc-1', expect.objectContaining({ groupId: 'grp-personal' }))
    })

    it('supports HTML5 drag and drop of groups to re-parent', async () => {
      const updateGroupSpy = vi.spyOn(passwordApi, 'updateGroup').mockResolvedValue({} as any)

      renderWithHosts(createElement(GroupTree))
      const personalNode = document.querySelector('[data-testid="group-tree-node-grp-personal"]')!.querySelector('div')!

      const dropEvent = new Event('drop', { bubbles: true }) as any
      dropEvent.dataTransfer = {
        getData: (type: string) => {
          if (type === 'text/inkstone-password-group-id') return 'grp-sub1'
          return ''
        },
      }

      await act(async () => {
        personalNode.dispatchEvent(dropEvent)
      })

      expect(updateGroupSpy).toHaveBeenCalledWith('grp-sub1', { parentId: 'grp-personal' })
    })

    it('prevents circular group nesting (dropping into own child)', async () => {
      const toastSpy = vi.spyOn(useUi.getState(), 'toast')

      renderWithHosts(createElement(GroupTree))
      const subNode = document.querySelector('[data-testid="group-tree-node-grp-sub1"]')!.querySelector('div')!

      const dropEvent = new Event('drop', { bubbles: true }) as any
      dropEvent.dataTransfer = {
        getData: (type: string) => {
          if (type === 'text/inkstone-password-group-id') return 'grp-root'
          return ''
        },
      }

      await act(async () => {
        subNode.dispatchEvent(dropEvent)
      })

      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: t('tools.password.group.cannot_move_into_child'),
          tone: 'warning',
        }),
      )
    })

    it('enforces maximum depth limit of 7 levels', () => {
      expect(MAX_GROUP_TREE_DEPTH).toBe(7)

      const maxDepthGroup: PasswordGroup = {
        id: 'depth-7',
        name: 'Deepest',
        parentId: 'parent-6',
        sort: 1,
        createdAt: 1000,
        updatedAt: 1000,
      }

      renderWithHosts(
        createElement(GroupTreeNode, {
          group: maxDepthGroup,
          depth: 7,
          selectedGroupId: null,
          expandedIds: new Set<string>(),
          accountCountMap: {},
          onSelect: vi.fn(),
          onToggleExpand: vi.fn(),
          onNewChild: vi.fn(),
          onRename: vi.fn(),
          onDelete: vi.fn(),
          onExport: vi.fn(),
          onImport: vi.fn(),
          onMoveGroup: vi.fn(),
          onMoveAccount: vi.fn(),
        }),
      )

      expect(document.querySelector('[data-testid="group-new-child-btn"]')).toBeNull()
    })
  })

  // ---------------------------------------------------------------- ToolsSidebar
  describe('ToolsSidebar Integration', () => {
    it('mounts GroupTree inside the password sidebar slot', () => {
      renderWithHosts(createElement(ToolsSidebar))

      const slot = document.querySelector('[data-testid="tools-password-group-tree-slot"]')
      expect(slot).toBeTruthy()

      const groupTree = slot?.querySelector('[data-testid="password-group-tree"]')
      expect(groupTree).toBeTruthy()
    })
  })
})
