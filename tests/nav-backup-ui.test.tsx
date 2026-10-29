// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NAV_BACKUP_STATE, type NavBackupConfig } from '../src/shared/nav/model'
import { navApi } from '../src/client/features/nav/api'
import { NavBackupModal } from '../src/client/features/nav/NavBackupPanel'
import { useUi } from '../src/client/store/ui'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'

const CONFIGURED: NavBackupConfig = {
  ...DEFAULT_NAV_BACKUP_STATE,
  url: 'https://dav.example.com/root',
  username: 'alice',
  hasPassword: true,
  schedule: 'daily',
  retention: 14,
  lastRunAt: Date.now() - 60 * 60_000,
  lastStatus: 'success',
  lastFilename: 'inkstone-nav-backup_2026-01-01_00-00-00.json',
  history: ['inkstone-nav-backup_2026-01-01_00-00-00.json'],
}

let rendered: RenderedElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function selectValue(element: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.restoreAllMocks()
  useUi.setState({ toasts: [] })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
})

describe('NavBackupModal', () => {
  it('shows a saved target without a password field and saves schedule changes', async () => {
    vi.spyOn(navApi, 'backupConfig').mockResolvedValue(CONFIGURED)
    const save = vi.spyOn(navApi, 'saveBackupConfig').mockResolvedValue({ ...CONFIGURED, schedule: 'weekly' })
    rendered = renderElement(<NavBackupModal open onClose={vi.fn()} />)
    await flush()

    expect(document.body.textContent).toContain('https://dav.example.com/root')
    expect(document.body.textContent).toContain(t('nav.backup.last_success'))
    expect(document.querySelector('input[type="password"]')).toBeNull()

    const frequency = document.querySelector(`select[aria-label="${t('nav.backup.frequency')}"]`) as HTMLSelectElement | null
    if (!frequency) throw new Error('No frequency select')
    selectValue(frequency, 'weekly')
    await flush()
    expect(save).toHaveBeenCalledWith({ schedule: 'weekly' })
  })

  it('asks for a password only when editing or setting up', async () => {
    vi.spyOn(navApi, 'backupConfig').mockResolvedValue(CONFIGURED)
    const save = vi.spyOn(navApi, 'saveBackupConfig').mockResolvedValue(CONFIGURED)
    vi.spyOn(navApi, 'webdavBackup').mockResolvedValue({ ok: true, filename: 'backup.json', verified: true })
    rendered = renderElement(<NavBackupModal open onClose={vi.fn()} />)
    await flush()

    const edit = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('nav.edit')}"]`)
    if (!edit) throw new Error('No edit button')
    act(() => edit.click())
    await flush()

    const password = document.querySelector<HTMLInputElement>('input[type="password"]')
    if (!password) throw new Error('No password field while editing')
    expect(password.placeholder).toBe(t('nav.backup.password_saved'))
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(password, 'new-password')
      password.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const saveButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === t('nav.save'))
    if (!saveButton) throw new Error('No save button')
    act(() => saveButton.click())
    await flush()
    expect(save).toHaveBeenCalledWith({
      url: 'https://dav.example.com/root',
      username: 'alice',
      password: 'new-password',
    })

    const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === t('nav.backup.now'))
    if (!back) throw new Error('No backup button')
    act(() => back.click())
    await flush()
    expect(navApi.webdavBackup).toHaveBeenCalledWith({ timestamped: true })
  })

  it('starts with a setup form when no target exists', async () => {
    vi.spyOn(navApi, 'backupConfig').mockResolvedValue({ ...DEFAULT_NAV_BACKUP_STATE, url: '', username: '', hasPassword: false })
    const save = vi.spyOn(navApi, 'saveBackupConfig').mockResolvedValue(CONFIGURED)
    rendered = renderElement(<NavBackupModal open onClose={vi.fn()} />)
    await flush()

    const url = document.querySelector<HTMLInputElement>('input[placeholder="https://dav.example.com/"]')
    const username = document.querySelector<HTMLInputElement>('input[autocomplete="username"]')
    const password = document.querySelector<HTMLInputElement>('input[type="password"]')
    if (!url || !username || !password) throw new Error('Setup fields missing')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(url, 'https://dav.example.com/root')
      url.dispatchEvent(new Event('input', { bubbles: true }))
      setter?.call(username, 'alice')
      username.dispatchEvent(new Event('input', { bubbles: true }))
      setter?.call(password, 'dav-password')
      password.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const saveButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === t('nav.save'))
    if (!saveButton) throw new Error('No save button')
    act(() => saveButton.click())
    await flush()
    expect(save).toHaveBeenCalledWith({
      url: 'https://dav.example.com/root',
      username: 'alice',
      password: 'dav-password',
    })
  })
})
