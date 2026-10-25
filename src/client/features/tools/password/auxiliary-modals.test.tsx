// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, setLocaleAsync, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../lib/test-render'
import { usePasswordVaultStore } from './store'
import { passwordApi } from './api'
import { getKeyIv, encryptValue } from './crypto'
import { escapeCSVField, parseCSVRows, parseCSV, toCSV } from './utils/csv-parser'
import { generateRandomPassword } from './utils/generator'
import { PasswordGeneratorModal } from './PasswordGeneratorModal'
import { RandomPasswordView } from './RandomPasswordView'
import { QuickAddModal } from './QuickAddModal'
import { BatchOperationsModal } from './BatchOperationsModal'
import { ExportModal } from './ExportModal'
import { ImportModal, parseImportData } from './ImportModal'
import { BackupSettingsModal } from './BackupSettingsModal'
import type { PasswordGroup, PasswordAccount, DecryptedAccount } from '@shared/tools/password/types'

// Mock passwordApi methods
vi.mock('./api', () => ({
  passwordApi: {
    getVaultState: vi.fn(),
    getGroups: vi.fn(),
    getAccounts: vi.fn(),
    createAccount: vi.fn(),
    updateAccount: vi.fn(),
    deleteAccount: vi.fn(),
    batchDeleteAccounts: vi.fn().mockResolvedValue({ ok: true, count: 2 }),
    batchMoveAccounts: vi.fn().mockResolvedValue({ ok: true, count: 2 }),
    batchImportAccounts: vi.fn().mockResolvedValue([]),
    exportPlaintext: vi.fn().mockResolvedValue({ fileId: 'f-1', downloadUrl: '/exp', size: 123 }),
    getSettings: vi.fn().mockResolvedValue({
      webdav: { url: 'https://dav.test/pwd', username: 'tester', password: '123', enabled: true },
      autoBackupEnabled: true,
      autoLockMinutes: 15,
      updatedAt: 1000,
    }),
    saveSettings: vi.fn().mockResolvedValue({ ok: true }),
    testWebdav: vi.fn().mockResolvedValue({ ok: true }),
    getBackups: vi.fn().mockResolvedValue([
      {
        id: 'b-1',
        filename: 'backup_20261026.json',
        r2Key: 'backups/b-1.json',
        size: 2048,
        type: 'manual',
        createdAt: 1700000000000,
      },
    ]),
    createBackup: vi.fn().mockResolvedValue({
      id: 'b-2',
      filename: 'backup_new.json',
      r2Key: 'backups/b-2.json',
      size: 4096,
      type: 'manual',
      createdAt: 1700000001000,
    }),
    restoreBackup: vi.fn().mockResolvedValue({ ok: true, count: 5 }),
    deleteBackup: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

function setInputValue(element: HTMLElement, value: string): void {
  const prototype = Object.getPrototypeOf(element)
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('WS-7: Auxiliary Feature Modules', () => {
  const MASTER_PASS = '123456'
  const keyiv = getKeyIv(MASTER_PASS)

  const sampleGroups: PasswordGroup[] = [
    { id: 'g-root', name: '常用网站', parentId: '', sort: 0, createdAt: 1000, updatedAt: 1000 },
    { id: 'g-work', name: '工作业务', parentId: 'g-root', sort: 1, createdAt: 1000, updatedAt: 1000 },
    { id: 'g-fin', name: '财务金融', parentId: '', sort: 2, createdAt: 1000, updatedAt: 1000 },
  ]

  const sampleAccounts: PasswordAccount[] = [
    {
      id: 'acc-1',
      groupId: 'g-root',
      title: encryptValue(keyiv, 'GitHub'),
      username: encryptValue(keyiv, 'octocat'),
      password: encryptValue(keyiv, 'gh-secret-pwd'),
      link: encryptValue(keyiv, 'https://github.com'),
      remark: encryptValue(keyiv, 'personal developer account'),
      favicon: '',
      isFavorite: true,
      sort: 0,
      createdAt: 1000,
      updatedAt: 1000,
    },
    {
      id: 'acc-2',
      groupId: 'g-work',
      title: encryptValue(keyiv, 'Slack'),
      username: encryptValue(keyiv, 'work_user'),
      password: encryptValue(keyiv, 'work-pwd-789'),
      link: encryptValue(keyiv, 'https://slack.com'),
      remark: encryptValue(keyiv, 'company communication'),
      favicon: '',
      isFavorite: false,
      sort: 1,
      createdAt: 1000,
      updatedAt: 1000,
    },
    {
      id: 'acc-3',
      groupId: 'g-fin',
      title: encryptValue(keyiv, 'Bank of China'),
      username: encryptValue(keyiv, 'boc_user'),
      password: encryptValue(keyiv, 'bank-pass-321'),
      link: encryptValue(keyiv, 'https://boc.cn'),
      remark: encryptValue(keyiv, 'savings card'),
      favicon: '',
      isFavorite: false,
      sort: 2,
      createdAt: 1000,
      updatedAt: 1000,
    },
  ]

  const sampleDecrypted: Record<string, DecryptedAccount> = {
    'acc-1': {
      id: 'acc-1',
      groupId: 'g-root',
      title: 'GitHub',
      username: 'octocat',
      password: 'gh-secret-pwd',
      link: 'https://github.com',
      remark: 'personal developer account',
      favicon: '',
      isFavorite: true,
      sort: 0,
      createdAt: 1000,
      updatedAt: 1000,
    },
    'acc-2': {
      id: 'acc-2',
      groupId: 'g-work',
      title: 'Slack',
      username: 'work_user',
      password: 'work-pwd-789',
      link: 'https://slack.com',
      remark: 'company communication',
      favicon: '',
      isFavorite: false,
      sort: 1,
      createdAt: 1000,
      updatedAt: 1000,
    },
    'acc-3': {
      id: 'acc-3',
      groupId: 'g-fin',
      title: 'Bank of China',
      username: 'boc_user',
      password: 'bank-pass-321',
      link: 'https://boc.cn',
      remark: 'savings card',
      favicon: '',
      isFavorite: false,
      sort: 2,
      createdAt: 1000,
      updatedAt: 1000,
    },
  }

  beforeEach(async () => {
    installTestGlobals()
    await initI18n()
    await setLocaleAsync('zh-CN')

    // Clipboard mock
    if (!navigator.clipboard) {
      Object.assign(navigator, {
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      })
    } else {
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    }

    // URL blob mocks
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
    globalThis.URL.revokeObjectURL = vi.fn()

    // Mock HTMLAnchorElement click
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    // Set up store in unlocked state
    usePasswordVaultStore.setState({
      isUnlocked: true,
      keyIV: keyiv,
      masterPasswordText: MASTER_PASS,
      groups: sampleGroups,
      accounts: sampleAccounts,
      decryptedAccounts: sampleDecrypted,
      selectedGroupId: 'g-root',
      selectedAccountId: null,
      isGeneratorModalOpen: false,
      isQuickAddModalOpen: false,
      isBatchOperationsOpen: false,
      isExportModalOpen: false,
      isImportModalOpen: false,
      isBackupSettingsOpen: false,
      targetGroupForExportImport: null,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  // =========================================================================
  // 1. CSV Parser & Serializer
  // =========================================================================
  describe('1. CSV Parser & Serializer (utils/csv-parser.ts)', () => {
    it('escapes fields with comma, quotes, and newlines', () => {
      expect(escapeCSVField('hello')).toBe('hello')
      expect(escapeCSVField('hello,world')).toBe('"hello,world"')
      expect(escapeCSVField('hello "quote"')).toBe('"hello ""quote"""')
      expect(escapeCSVField('line1\nline2')).toBe('"line1\nline2"')
      expect(escapeCSVField(null)).toBe('')
      expect(escapeCSVField(undefined)).toBe('')
    })

    it('parses standard CSV rows and escaped quotes', () => {
      const csv = 'a,b,c\n"d,1","e ""2""",f'
      const rows = parseCSVRows(csv)
      expect(rows).toEqual([
        ['a', 'b', 'c'],
        ['d,1', 'e "2"', 'f'],
      ])
    })

    it('parses multiline CSV content inside quotes', () => {
      const csv = 'title,remark\n"Google","line1\nline2\nline3"'
      const rows = parseCSVRows(csv)
      expect(rows).toEqual([
        ['title', 'remark'],
        ['Google', 'line1\nline2\nline3'],
      ])
    })

    it('parses CSV with standard english headers', () => {
      const csv =
        'title,username,password,link,remark\n' +
        'GitHub,octocat,gh-pwd,https://github.com,"developer notes"'
      const accounts = parseCSV(csv)
      expect(accounts).toHaveLength(1)
      expect(accounts[0]).toEqual({
        title: 'GitHub',
        username: 'octocat',
        password: 'gh-pwd',
        link: 'https://github.com',
        remark: 'developer notes',
      })
    })

    it('parses CSV with Chinese headers', () => {
      const csv =
        '标题,用户名,密码,网址,备注\n' +
        '微信,wechat_user,wx123456,https://weixin.qq.com,常用社交'
      const accounts = parseCSV(csv)
      expect(accounts).toHaveLength(1)
      expect(accounts[0]).toEqual({
        title: '微信',
        username: 'wechat_user',
        password: 'wx123456',
        link: 'https://weixin.qq.com',
        remark: '常用社交',
      })
    })

    it('parses CSV without headers treating row 0 as data', () => {
      const csv = 'Google,user@gmail.com,pass123,https://google.com,search engine'
      const accounts = parseCSV(csv)
      expect(accounts).toHaveLength(1)
      expect(accounts[0].title).toBe('Google')
      expect(accounts[0].username).toBe('user@gmail.com')
      expect(accounts[0].password).toBe('pass123')
      expect(accounts[0].link).toBe('https://google.com')
      expect(accounts[0].remark).toBe('search engine')
    })

    it('roundtrip toCSV and parseCSV preserves account credentials', () => {
      const original = [
        {
          title: 'Site A, with comma',
          username: 'user "special"',
          password: 'secret,123\npwd',
          link: 'https://site-a.com',
          remark: 'important\nline 2',
        },
        {
          title: 'Site B',
          username: 'admin',
          password: 'pass',
          link: '',
          remark: '',
        },
      ]

      const csvString = toCSV(original)
      expect(csvString.startsWith('title,username,password,link,remark')).toBe(true)

      const parsed = parseCSV(csvString)
      expect(parsed).toEqual(original)
    })
  })

  // =========================================================================
  // 2. Password Generator Engine
  // =========================================================================
  describe('2. Password Generator Engine (utils/generator.ts)', () => {
    it('generates a password of the specified length', () => {
      const p16 = generateRandomPassword({ length: 16 })
      expect(p16).toHaveLength(16)

      const p32 = generateRandomPassword({ length: 32 })
      expect(p32).toHaveLength(32)

      const p64 = generateRandomPassword({ length: 64 })
      expect(p64).toHaveLength(64)
    })

    it('generates uppercase-only passwords when only uppercase is selected', () => {
      const pwd = generateRandomPassword({
        length: 20,
        uppercase: true,
        lowercase: false,
        numbers: false,
        symbols: false,
      })
      expect(pwd).toHaveLength(20)
      expect(/^[A-Z]+$/.test(pwd)).toBe(true)
    })

    it('generates numbers-only passwords when only numbers is selected', () => {
      const pwd = generateRandomPassword({
        length: 20,
        uppercase: false,
        lowercase: false,
        numbers: true,
        symbols: false,
      })
      expect(pwd).toHaveLength(20)
      expect(/^[0-9]+$/.test(pwd)).toBe(true)
    })

    it('uses custom symbols when symbols is selected', () => {
      const custom = '@#$'
      const pwd = generateRandomPassword({
        length: 30,
        uppercase: false,
        lowercase: false,
        numbers: false,
        symbols: true,
        customSymbols: custom,
      })
      expect(pwd).toHaveLength(30)
      expect(/^[@#$]+$/.test(pwd)).toBe(true)
    })

    it('returns empty string when all character sets are disabled', () => {
      const pwd = generateRandomPassword({
        length: 16,
        uppercase: false,
        lowercase: false,
        numbers: false,
        symbols: false,
      })
      expect(pwd).toBe('')
    })
  })

  // =========================================================================
  // 3. PasswordGeneratorModal & RandomPasswordView
  // =========================================================================
  describe('3. PasswordGeneratorModal & RandomPasswordView UI', () => {
    it('renders modal, shows generated password, and allows regenerating', () => {
      const view = renderElement(createElement(PasswordGeneratorModal, { open: true }))

      const output = document.querySelector('[data-testid="generated-password-output"]')
      expect(output).not.toBeNull()
      const firstPwd = output?.textContent || ''
      expect(firstPwd.length).toBeGreaterThanOrEqual(16)

      // Click regenerate button by aria-label or title
      const regenBtn = document.querySelector(
        `button[title="${t('tools.password.generator.generate')}"]`
      ) as HTMLButtonElement
      expect(regenBtn).not.toBeNull()
      act(() => {
        regenBtn.click()
      })

      const secondPwd = output?.textContent || ''
      expect(secondPwd.length).toBeGreaterThanOrEqual(16)
      view.unmount()
    })

    it('copies password to clipboard when copy button is clicked', async () => {
      const view = renderElement(createElement(PasswordGeneratorModal, { open: true }))

      const copyBtn = document.querySelector(
        `button[title="${t('tools.password.generator.copy')}"]`
      ) as HTMLButtonElement
      expect(copyBtn).not.toBeNull()

      await act(async () => {
        copyBtn.click()
      })

      expect(navigator.clipboard.writeText).toHaveBeenCalled()
      view.unmount()
    })

    it('calls onApply when "应用到当前账号" is clicked in modal mode', () => {
      const onApply = vi.fn()
      const onClose = vi.fn()
      const view = renderElement(
        createElement(PasswordGeneratorModal, { open: true, onApply, onClose })
      )

      const applyBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.generator.apply'))
      ) as HTMLButtonElement
      expect(applyBtn).not.toBeNull()

      act(() => {
        applyBtn.click()
      })

      expect(onApply).toHaveBeenCalled()
      expect(typeof onApply.mock.calls[0][0]).toBe('string')
      expect(onApply.mock.calls[0][0].length).toBeGreaterThan(0)
      expect(onClose).toHaveBeenCalled()
      view.unmount()
    })

    it('renders RandomPasswordView as a standalone page without crashing', () => {
      const view = renderElement(createElement(RandomPasswordView))
      const root = view.container.querySelector('[data-testid="random-password-view"]')
      expect(root).not.toBeNull()
      expect(root?.textContent).toContain(t('tools.password.generator.title'))
      view.unmount()
    })
  })

  // =========================================================================
  // 4. QuickAddModal
  // =========================================================================
  describe('4. QuickAddModal', () => {
    it('parses comma-separated rows in standard mode and displays preview table', () => {
      const view = renderElement(createElement(QuickAddModal, { open: true }))

      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      expect(textarea).not.toBeNull()

      setInputValue(
        textarea,
        'GitHub, octo, pass1, https://github.com, my git\nGoogle, guser, pass2, https://google.com, my search'
      )

      // Check preview table
      expect(document.body.textContent).toContain('已解析 2 条')
      expect(document.body.textContent).toContain('GitHub')
      expect(document.body.textContent).toContain('Google')
      view.unmount()
    })

    it('switches to minimal mode and parses title & link pairs', () => {
      const view = renderElement(createElement(QuickAddModal, { open: true }))

      // Click minimal mode
      const minimalTab = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('极简模式')
      ) as HTMLButtonElement
      expect(minimalTab).not.toBeNull()

      act(() => {
        minimalTab.click()
      })

      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      setInputValue(textarea, 'Twitter, https://x.com\nReddit, https://reddit.com')

      expect(document.body.textContent).toContain('Twitter')
      expect(document.body.textContent).toContain('https://x.com')
      view.unmount()
    })

    it('encrypts accounts and calls batchImportAccounts on submission', async () => {
      const onClose = vi.fn()
      const view = renderElement(createElement(QuickAddModal, { open: true, onClose }))

      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      setInputValue(textarea, 'DemoSite, demo_user, demo_pwd, https://demo.com, remark')

      const submitBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('确认添加')
      ) as HTMLButtonElement
      expect(submitBtn).not.toBeNull()
      expect(submitBtn.disabled).toBe(false)

      await act(async () => {
        submitBtn.click()
      })

      expect(passwordApi.batchImportAccounts).toHaveBeenCalled()
      const [groupId, accounts] = (passwordApi.batchImportAccounts as any).mock.calls[0]
      expect(groupId).toBe('g-root')
      expect(accounts).toHaveLength(1)
      // Confirm encrypted ciphertext (hex string not plaintext)
      expect(accounts[0].title).not.toBe('DemoSite')
      expect(onClose).toHaveBeenCalled()
      view.unmount()
    })
  })

  // =========================================================================
  // 5. BatchOperationsModal
  // =========================================================================
  describe('5. BatchOperationsModal', () => {
    it('renders account list and handles select-all and invert-selection', () => {
      const view = renderElement(createElement(BatchOperationsModal, { open: true }))

      expect(document.body.textContent).toContain('已选 0 / 3 项')

      // Select All
      const selectAllBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.batch.select_all'))
      ) as HTMLButtonElement
      act(() => {
        selectAllBtn.click()
      })
      expect(document.body.textContent).toContain('已选 3 / 3 项')

      // Invert Selection
      const invertBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.batch.invert'))
      ) as HTMLButtonElement
      act(() => {
        invertBtn.click()
      })
      expect(document.body.textContent).toContain('已选 0 / 3 项')

      view.unmount()
    })

    it('performs batch move to target group', async () => {
      const view = renderElement(createElement(BatchOperationsModal, { open: true }))

      // Select all
      const selectAllBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.batch.select_all'))
      ) as HTMLButtonElement
      act(() => {
        selectAllBtn.click()
      })

      // Find Batch Move button
      const moveBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.batch.move'))
      ) as HTMLButtonElement
      expect(moveBtn.disabled).toBe(false)

      await act(async () => {
        moveBtn.click()
      })

      expect(passwordApi.batchMoveAccounts).toHaveBeenCalled()
      view.unmount()
    })

    it('copies credentials to clipboard on batch copy', async () => {
      const view = renderElement(createElement(BatchOperationsModal, { open: true }))

      // Select all
      const selectAllBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.batch.select_all'))
      ) as HTMLButtonElement
      act(() => {
        selectAllBtn.click()
      })

      const copyBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.batch.copy'))
      ) as HTMLButtonElement
      expect(copyBtn.disabled).toBe(false)

      await act(async () => {
        copyBtn.click()
      })

      expect(navigator.clipboard.writeText).toHaveBeenCalled()
      const copiedText = (navigator.clipboard.writeText as any).mock.calls[0][0]
      expect(copiedText).toContain('GitHub')
      expect(copiedText).toContain('Slack')
      view.unmount()
    })

    it('opens confirmation modal and performs batch delete', async () => {
      const view = renderElement(createElement(BatchOperationsModal, { open: true }))

      // Select all
      const selectAllBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.batch.select_all'))
      ) as HTMLButtonElement
      act(() => {
        selectAllBtn.click()
      })

      // Click batch delete button to trigger confirmation modal
      const deleteBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.batch.delete'))
      ) as HTMLButtonElement
      act(() => {
        deleteBtn.click()
      })

      // Confirmation modal should be visible
      expect(document.body.textContent).toContain('确认批量删除')
      const confirmDeleteBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === '确认删除'
      ) as HTMLButtonElement
      expect(confirmDeleteBtn).not.toBeNull()

      await act(async () => {
        confirmDeleteBtn.click()
      })

      expect(passwordApi.batchDeleteAccounts).toHaveBeenCalledWith(['acc-1', 'acc-2', 'acc-3'])
      view.unmount()
    })
  })

  // =========================================================================
  // 6. ExportModal
  // =========================================================================
  describe('6. ExportModal', () => {
    it('verifies master password and denies export when password is incorrect', async () => {
      const view = renderElement(createElement(ExportModal, { open: true }))

      const pwdInput = document.querySelector('#export-master-password') as HTMLInputElement
      setInputValue(pwdInput, 'wrong-password')

      const exportBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.export.download'))
      ) as HTMLButtonElement

      await act(async () => {
        exportBtn.click()
      })

      expect(document.body.textContent).toContain(t('tools.password.door.fail'))
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
      view.unmount()
    })

    it('exports CSV file and triggers download on valid master password', async () => {
      const onClose = vi.fn()
      const view = renderElement(createElement(ExportModal, { open: true, onClose }))

      const pwdInput = document.querySelector('#export-master-password') as HTMLInputElement
      setInputValue(pwdInput, MASTER_PASS)

      const exportBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.export.download'))
      ) as HTMLButtonElement

      await act(async () => {
        exportBtn.click()
      })

      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled()
      expect(passwordApi.exportPlaintext).toHaveBeenCalledWith('csv', expect.any(String))
      expect(onClose).toHaveBeenCalled()
      view.unmount()
    })

    it('exports TXT format when TXT format option is chosen', async () => {
      const view = renderElement(createElement(ExportModal, { open: true }))

      // Switch to TXT
      const txtOption = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('TXT 纯文本格式')
      ) as HTMLButtonElement
      act(() => {
        txtOption.click()
      })

      const pwdInput = document.querySelector('#export-master-password') as HTMLInputElement
      setInputValue(pwdInput, MASTER_PASS)

      const exportBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.export.download'))
      ) as HTMLButtonElement

      await act(async () => {
        exportBtn.click()
      })

      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled()
      expect(passwordApi.exportPlaintext).toHaveBeenCalledWith(
        'txt',
        expect.stringContaining(`${t('tools.password.account.title')}: GitHub`)
      )
      view.unmount()
    })
  })

  // =========================================================================
  // 7. ImportModal
  // =========================================================================
  describe('7. ImportModal', () => {
    it('parses block-formatted TXT data using parseImportData helper', () => {
      const txt =
        '标题: Twitter\n用户名: elon\n密码: mars2026\n网址: https://x.com\n说明备注: space\n---\n标题: OpenAI\n用户名: sam\n密码: gpt5\n网址: https://openai.com'
      const parsed = parseImportData(txt)
      expect(parsed).toHaveLength(2)
      expect(parsed[0].title).toBe('Twitter')
      expect(parsed[0].username).toBe('elon')
      expect(parsed[0].password).toBe('mars2026')
      expect(parsed[1].title).toBe('OpenAI')
    })

    it('parses pasted CSV data, renders preview, and submits to batchImportAccounts', async () => {
      const onClose = vi.fn()
      const view = renderElement(createElement(ImportModal, { open: true, onClose }))

      const textarea = document.querySelector('textarea') as HTMLTextAreaElement
      setInputValue(
        textarea,
        'title,username,password,link,remark\n' +
          'Notion,notion_user,notion_pwd,https://notion.so,workspace notes'
      )

      expect(document.body.textContent).toContain('已识别 1 条记录')
      expect(document.body.textContent).toContain('Notion')

      const submitBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.import.confirm'))
      ) as HTMLButtonElement

      await act(async () => {
        submitBtn.click()
      })

      expect(passwordApi.batchImportAccounts).toHaveBeenCalled()
      const [groupId, accs] = (passwordApi.batchImportAccounts as any).mock.calls[0]
      expect(groupId).toBe('g-root')
      expect(accs).toHaveLength(1)
      expect(accs[0].title).not.toBe('Notion') // encrypted!
      expect(onClose).toHaveBeenCalled()
      view.unmount()
    })
  })

  // =========================================================================
  // 8. BackupSettingsModal
  // =========================================================================
  describe('8. BackupSettingsModal', () => {
    it('loads and lists backup history and creates new cloud backup', async () => {
      const view = renderElement(createElement(BackupSettingsModal, { open: true }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(passwordApi.getBackups).toHaveBeenCalled()
      expect(document.body.textContent).toContain('backup_20261026.json')

      // Create Cloud Backup
      const createBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.backup.now'))
      ) as HTMLButtonElement
      expect(createBtn).not.toBeNull()

      await act(async () => {
        createBtn.click()
      })

      expect(passwordApi.createBackup).toHaveBeenCalled()
      view.unmount()
    })

    it('downloads local JSON snapshot', () => {
      const view = renderElement(createElement(BackupSettingsModal, { open: true }))

      const downloadLocalBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.backup.download'))
      ) as HTMLButtonElement
      expect(downloadLocalBtn).not.toBeNull()

      act(() => {
        downloadLocalBtn.click()
      })

      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled()
      view.unmount()
    })

    it('restores backup snapshot after secondary confirmation', async () => {
      const onClose = vi.fn()
      const view = renderElement(createElement(BackupSettingsModal, { open: true, onClose }))

      await act(async () => {
        await Promise.resolve()
      })

      // Click restore on record
      const restoreBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.backup.restore'))
      ) as HTMLButtonElement
      expect(restoreBtn).not.toBeNull()

      act(() => {
        restoreBtn.click()
      })

      // Confirmation modal
      expect(document.body.textContent).toContain('确认恢复备份')
      const confirmRestoreBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === t('tools.password.backup.restore') && b.className.includes('bg-[var(--danger)]')
      ) as HTMLButtonElement
      expect(confirmRestoreBtn).not.toBeNull()

      await act(async () => {
        confirmRestoreBtn.click()
      })

      expect(passwordApi.restoreBackup).toHaveBeenCalledWith('b-1')
      expect(onClose).toHaveBeenCalled()
      view.unmount()
    })

    it('switches to WebDAV tab, tests connection, and saves settings', async () => {
      const view = renderElement(createElement(BackupSettingsModal, { open: true }))

      await act(async () => {
        await Promise.resolve()
      })

      // Switch to WebDAV tab
      const webdavTab = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.backup.webdav_tab'))
      ) as HTMLButtonElement
      expect(webdavTab).not.toBeNull()
      act(() => {
        webdavTab.click()
      })

      expect(document.body.textContent).toContain(t('tools.password.backup.webdav_enable'))

      // Test connection
      const testBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(t('tools.password.backup.webdav_test'))
      ) as HTMLButtonElement
      expect(testBtn).not.toBeNull()
      await act(async () => {
        testBtn.click()
      })
      expect(passwordApi.testWebdav).toHaveBeenCalled()

      // Save settings
      const saveBtn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('保存设置')
      ) as HTMLButtonElement
      expect(saveBtn).not.toBeNull()
      await act(async () => {
        saveBtn.click()
      })
      expect(passwordApi.saveSettings).toHaveBeenCalled()

      view.unmount()
    })
  })
})
