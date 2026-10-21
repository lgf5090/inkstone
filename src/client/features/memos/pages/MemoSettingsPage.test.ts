// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_VERSION } from '@shared/constants'
import { MEMO_PREFERENCES_DEFAULTS } from '@shared/memos/constants'
import type { MemoPreferences, MemoToken, MemoTokenCreateResult } from '@shared/memos/types'
import { ConfirmHost } from '../../../components/overlay'
import { initI18n, t } from '../../../lib/i18n'
import { ApiError } from '../../../lib/api'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { MemoSettingsPage } from './MemoSettingsPage'
import { MemoInboxPage } from './MemoInboxPage'

const api = vi.hoisted(() => ({
  preferences: { get: vi.fn(), patch: vi.fn() },
  tokens: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
}))

vi.mock('../api', () => ({ memosApi: api }))

let currentPreferences: MemoPreferences
let tokenItems: MemoToken[] = []
let rendered: RenderedElement | null = null

function preferences(overrides: Partial<MemoPreferences> = {}): MemoPreferences {
  return {
    ...MEMO_PREFERENCES_DEFAULTS,
    reactions: [...MEMO_PREFERENCES_DEFAULTS.reactions],
    tagRules: [],
    ...overrides,
  }
}

function token(overrides: Partial<MemoToken> = {}): MemoToken {
  return {
    id: 'token-1',
    description: 'Web Clipper',
    prefix: 'memo_pat_abcd1234',
    expiresAt: null,
    createdAt: 1_700_000_000,
    lastUsedAt: null,
    ...overrides,
  }
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function labeledControl<T extends HTMLElement>(text: string): T {
  const label = [...document.querySelectorAll('label')]
    .find((node) => node.textContent?.trim() === text)
  const control = label?.htmlFor ? document.getElementById(label.htmlFor) : null
  if (!control) throw new Error(`no labeled control ${text}`)
  return control as T
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

function submit(form: HTMLFormElement): void {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

function renderSettings(): HTMLElement {
  rendered = renderElement(createElement(
    Fragment,
    null,
    createElement(MemoSettingsPage),
    createElement(ConfirmHost),
  ))
  return rendered.container
}

beforeEach(async () => {
  await initI18n()
  vi.clearAllMocks()
  useUi.setState({ panel: null, toasts: [] })
  currentPreferences = preferences()
  tokenItems = []
  api.preferences.get.mockImplementation(() => Promise.resolve(currentPreferences))
  api.preferences.patch.mockImplementation((patch: Partial<MemoPreferences>) => {
    currentPreferences = { ...currentPreferences, ...patch }
    return Promise.resolve(currentPreferences)
  })
  api.tokens.list.mockImplementation(() => Promise.resolve({ tokens: tokenItems }))
  api.tokens.delete.mockImplementation((id: string) => {
    tokenItems = tokenItems.filter((item) => item.id !== id)
    return Promise.resolve({ ok: true })
  })
})

afterEach(() => {
  act(() => { rendered?.unmount() })
  rendered = null
  document.body.innerHTML = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  vi.unstubAllGlobals()
})

describe('the memo settings page', () => {
  it('renders every section and the attribution', async () => {
    const host = renderSettings()
    await flush()
    for (const key of [
      'memos.settings.general',
      'memos.settings.reactions',
      'memos.settings.tags',
      'memos.settings.tokens',
      'memos.settings.about',
      'memos.settings.account',
    ] as const) {
      expect(host.textContent).toContain(t(key))
    }
    expect(host.querySelector('#memos-settings-general')).not.toBeNull()
    expect(host.querySelector('#memos-settings-tokens')).not.toBeNull()
    expect(host.textContent).toContain(t('memos.settings.about_license'))
    expect(host.textContent).toContain(t('memos.settings.tokens_empty'))
    expect(host.textContent).toContain(t('memos.settings.about_version', { version: APP_VERSION }))
  })

  it('patches general preferences as they change', async () => {
    const host = renderSettings()
    await flush()
    const doubleClick = host.querySelector<HTMLButtonElement>(
      `button[role="switch"][aria-label="${t('memos.settings.double_click')}"]`,
    )
    expect(doubleClick?.getAttribute('aria-checked')).toBe('true')
    click(doubleClick!)
    await flush()
    expect(api.preferences.patch).toHaveBeenCalledWith({ enableDoubleClickEdit: false })

    const visibility = labeledControl<HTMLSelectElement>(t('memos.settings.default_visibility'))
    setValue(visibility, 'public')
    await flush()
    expect(api.preferences.patch).toHaveBeenCalledWith({ defaultVisibility: 'public' })
  })

  it('adds a reaction and rejects a duplicate in the picker list', async () => {
    const host = renderSettings()
    await flush()
    const field = labeledControl<HTMLInputElement>(t('memos.settings.reactions_add_label'))
    setValue(field, '🔥')
    submit(field.closest('form')!)
    await flush()
    expect(api.preferences.patch).toHaveBeenCalledWith({
      reactions: [...MEMO_PREFERENCES_DEFAULTS.reactions, '🔥'],
    })
    const remove = [...host.querySelectorAll('button')]
      .find((item) => item.getAttribute('aria-label') === t('memos.settings.reactions_remove', { emoji: '🔥' }))
    expect(remove).not.toBeUndefined()

    const calls = api.preferences.patch.mock.calls.length
    setValue(field, '👍')
    submit(field.closest('form')!)
    await flush()
    expect(host.textContent).toContain(t('memos.settings.reactions_duplicate', { emoji: '👍' }))
    expect(api.preferences.patch).toHaveBeenCalledTimes(calls)
  })

  it('shows the server reason when a tag rule is refused', async () => {
    const host = renderSettings()
    await flush()
    api.preferences.patch.mockRejectedValueOnce(new ApiError(
      400,
      'bad_request',
      t('api.error.bad_request'),
      undefined,
      'tagRules[0].pattern is not a valid regular expression',
    ))
    setValue(labeledControl<HTMLInputElement>(t('memos.settings.tags_pattern')), 'client/')
    click(buttonNamed(t('memos.settings.tags_add')))
    await flush()
    expect(host.textContent).toContain('tagRules[0].pattern is not a valid regular expression')
    expect(currentPreferences.tagRules).toEqual([])
  })

  it('adds a colored tag rule with blur after local validation', async () => {
    const host = renderSettings()
    await flush()
    setValue(labeledControl<HTMLInputElement>(t('memos.settings.tags_pattern')), 'secret')
    const color = host.querySelector<HTMLInputElement>('input[type="color"]')!
    setValue(color, '#ff0000')
    click([...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('role') === 'checkbox' && button.textContent?.includes(t('memos.settings.tags_blur')))!)
    click(buttonNamed(t('memos.settings.tags_add')))
    await flush()
    expect(api.preferences.patch).toHaveBeenCalledWith({
      tagRules: [{ pattern: 'secret', mode: 'exact', backgroundColor: '#ff0000', blurContent: true }],
    })
    expect(host.textContent).toContain(t('memos.settings.tags_blur_badge'))
  })

  it('reveals a created token once and revokes an existing one', async () => {
    tokenItems = [token()]
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const created: MemoTokenCreateResult = {
      token: 'memo_pat_secret_value_1234567890',
      tokenInfo: token({ id: 'token-2', description: 'CLI', createdAt: 1_700_000_100 }),
    }
    api.tokens.create.mockResolvedValue(created)
    const host = renderSettings()
    await flush()
    expect(host.textContent).toContain('Web Clipper')

    setValue(labeledControl<HTMLInputElement>(t('memos.settings.tokens_description_label')), 'CLI')
    setValue(labeledControl<HTMLSelectElement>(t('memos.settings.tokens_expiry_label')), '30')
    submit(buttonNamed(t('memos.settings.tokens_create')).closest('form')!)
    await flush()
    expect(api.tokens.create).toHaveBeenCalledWith({
      description: 'CLI',
      expiresAt: expect.any(Number),
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    const shown = dialog!.querySelector<HTMLInputElement>('input[readonly]')
    expect(shown?.value).toBe(created.token)
    expect(dialog!.querySelector('pre')?.textContent).toContain(created.token)
    click(buttonNamed(t('memos.settings.tokens_copy')))
    await flush()
    expect(writeText).toHaveBeenCalledWith(created.token)
    click(buttonNamed(t('memos.settings.tokens_done')))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(host.textContent).not.toContain(created.token)

    click(buttonNamed(t('memos.settings.tokens_revoke')))
    await flush()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    click(buttonNamed(t('memos.settings.tokens_revoke_confirm')))
    await flush()
    expect(api.tokens.delete).toHaveBeenCalledWith('token-1')
    expect(host.textContent).toContain(t('memos.settings.tokens_empty'))
  })

  it('opens the Inkstone settings for account management', async () => {
    renderSettings()
    await flush()
    click(buttonNamed(t('memos.settings.account_open')))
    expect(useUi.getState().panel).toBe('settings')
  })

  it('explains the account-isolated inbox', async () => {
    rendered = renderElement(createElement(MemoInboxPage))
    const host = rendered.container
    expect(host.textContent).toContain(t('memos.inbox.empty_title'))
    expect(host.textContent).toContain(t('memos.inbox.empty_description'))
    expect(host.textContent).toContain(t('memos.inbox.go_to_memos'))
  })
})
