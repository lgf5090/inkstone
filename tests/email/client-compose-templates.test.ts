// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount } from '@shared/email/model'
import type { EmailTemplate } from '@shared/email/templates'
import { api } from '../../src/client/lib/api'
import { t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { useUi } from '../../src/client/store/ui'
import { ComposePanel } from '../../src/client/features/email/ComposePanel'

const account: EmailAccount = {
  id: 'a1',
  address: 'ada@example.com',
  displayName: 'Ada',
  settings: {
    signature: { enabled: false, text: '' },
    autoDraft: true,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const templates: EmailTemplate[] = [
  {
    id: 't1',
    name: 'Welcome',
    subject: 'Hello',
    body: 'Hi there',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: 't2',
    name: 'Meeting',
    subject: 'Meeting notes',
    body: '- Point one',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
]

function buttonByText(label: string, scope: Element | Document = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

function subjectInput(): HTMLInputElement {
  const target = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim().replace(/\s*\*$/, '') === t('email.compose.subject'))
  if (!target?.htmlFor) throw new Error('no subject field')
  const input = document.getElementById(target.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error('subject field is not an input')
  return input
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    if (ms > 0) {
      await vi.advanceTimersByTimeAsync(ms)
      return
    }
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

function panel(settings: EmailAccount['settings'] = account.settings): RenderedElement {
  return renderElement(createElement(ComposePanel, {
    account: { ...account, settings },
    mode: 'new',
    draftId: null,
    original: null,
    onClose: vi.fn(),
    onSent: vi.fn(),
  }))
}

let view: RenderedElement | null = null

beforeEach(() => {
  vi.spyOn(api.email, 'listTemplates').mockResolvedValue(templates)
  vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  useUi.setState({ toasts: [] })
})

describe('the compose template menu', () => {
  it('loads templates on first open and fills an empty message', async () => {
    view = panel()
    expect(subjectInput().value).toBe('')

    await act(async () => {
      buttonByLabel(t('email.templates.insert')).click()
      await Promise.resolve()
    })
    await settle()
    expect(api.email.listTemplates).toHaveBeenCalledWith(account.id)
    expect(document.body.textContent).toContain('Welcome')

    await act(async () => {
      buttonByText('Welcome').click()
      await Promise.resolve()
    })
    expect(subjectInput().value).toBe('Hello')
    expect(document.querySelector('.cm-content')?.textContent).toBe('Hi there')
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.templates.inserted', { name: 'Welcome' }))
  })

  it('inserts at the cursor and keeps an existing signature', async () => {
    view = panel({ ...account.settings, signature: { enabled: true, text: 'Ada Lovelace' } })
    expect(document.querySelector('.cm-content')?.textContent).toContain('Ada Lovelace')

    await act(async () => {
      buttonByLabel(t('email.templates.insert')).click()
      await Promise.resolve()
    })
    await settle()
    await act(async () => {
      buttonByText('Welcome').click()
      await Promise.resolve()
    })

    const content = document.querySelector('.cm-content')?.textContent ?? ''
    expect(content).toContain('Hi there')
    expect(content).toContain('Ada Lovelace')
    expect(content.indexOf('Hi there')).toBeLessThan(content.indexOf('Ada Lovelace'))
    expect(subjectInput().value).toBe('Hello')
  })

  it('loads the list only once and fills the subject of the chosen template', async () => {
    view = panel({ ...account.settings, signature: { enabled: true, text: 'Ada Lovelace' } })

    await act(async () => {
      buttonByLabel(t('email.templates.insert')).click()
      await Promise.resolve()
    })
    await settle()
    act(() => { buttonByLabel(t('email.templates.insert')).click() })
    await act(async () => {
      buttonByLabel(t('email.templates.insert')).click()
      await Promise.resolve()
    })
    await settle()
    expect(api.email.listTemplates).toHaveBeenCalledTimes(1)

    await act(async () => {
      buttonByText('Meeting').click()
      await Promise.resolve()
    })
    expect(subjectInput().value).toBe('Meeting notes')
    expect(document.querySelector('.cm-content')?.textContent).toContain('- Point one')
  })

  it('reports a failed load and does not autosave before a template is chosen', async () => {
    vi.useFakeTimers()
    vi.mocked(api.email.listTemplates).mockRejectedValueOnce(new Error('Templates offline'))
    view = panel()

    await act(async () => {
      buttonByLabel(t('email.templates.insert')).click()
      await Promise.resolve()
    })
    await settle(1700)
    expect(document.body.textContent).toContain(t('email.templates.menu_error'))
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain('Templates offline')
    expect(api.email.saveDraft).not.toHaveBeenCalled()
  })

  it('autosaves only after a template is chosen', async () => {
    vi.useFakeTimers()
    view = panel()

    await act(async () => {
      buttonByLabel(t('email.templates.insert')).click()
      await Promise.resolve()
    })
    await settle(2000)
    expect(api.email.saveDraft).not.toHaveBeenCalled()

    await act(async () => {
      buttonByText('Welcome').click()
      await Promise.resolve()
    })
    await settle(1700)
    expect(api.email.saveDraft).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.email.saveDraft).mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      subject: 'Hello',
      body: 'Hi there',
    }))
  })
})
