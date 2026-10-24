// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount } from '@shared/email/model'
import type { EmailTemplate } from '@shared/email/templates'
import { api } from '../../src/client/lib/api'
import { t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { ConfirmHost } from '../../src/client/components/overlay'
import { TemplatesPage } from '../../src/client/features/email/TemplatesPage'
import { useEmailStore } from '../../src/client/features/email/store'

const original = useEmailStore.getState()

const account: EmailAccount = {
  id: 'a1',
  address: 'ada@example.com',
  displayName: 'Ada',
  settings: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const template: EmailTemplate = {
  id: 't1',
  name: 'Welcome',
  subject: 'Hello',
  body: 'Hi there',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

function buttonByText(label: string, scope: Element | Document = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function buttonByLabel(label: string, scope: Element | Document = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

function fieldFor(label: string): HTMLInputElement | HTMLTextAreaElement {
  const target = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim() === label)
  if (!target?.htmlFor) throw new Error(`no field labelled ${label}`)
  const field = document.getElementById(target.htmlFor)
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    throw new Error(`field ${label} is not an input`)
  }
  return field
}

function change(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function harness(): RenderedElement {
  return renderElement(createElement('div', null,
    createElement(TemplatesPage, { accountId: account.id }),
    createElement(ConfirmHost)))
}

let view: RenderedElement | null = null

beforeEach(() => {
  vi.spyOn(api.email, 'listTemplates').mockResolvedValue([template])
  vi.spyOn(api.email, 'createTemplate').mockImplementation(async (_id, input) => ({
    id: 't-new',
    name: input.name,
    subject: input.subject,
    body: input.body,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  }))
  vi.spyOn(api.email, 'updateTemplate').mockImplementation(async (_id, _templateId, patch) => ({
    ...template,
    ...patch,
    updatedAt: '2026-10-02T00:00:00.000Z',
  }))
  vi.spyOn(api.email, 'deleteTemplate').mockResolvedValue(undefined)
  useEmailStore.setState(original, true)
  useEmailStore.setState({
    accounts: [account],
    accountsStatus: 'ready',
    accountsError: null,
  })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the templates page', () => {
  it('lists the templates of the account', async () => {
    view = harness()
    await settle()

    expect(api.email.listTemplates).toHaveBeenCalledWith(account.id)
    expect(document.body.textContent).toContain('Welcome')
    expect(document.body.textContent).toContain('Hello')
    expect(document.body.textContent).toContain('Hi there')
  })

  it('creates a template from the dialog', async () => {
    view = harness()
    await settle()

    act(() => { buttonByText(t('email.templates.new')).click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    change(fieldFor(t('email.templates.name')), '  Billing  ')
    change(fieldFor(t('email.templates.subject')), '  Invoice  ')
    change(fieldFor(t('email.templates.body')), 'Line one\nLine two')
    await act(async () => {
      buttonByText(t('common.save'), dialog).click()
      await Promise.resolve()
    })

    expect(api.email.createTemplate).toHaveBeenCalledWith(account.id, {
      name: 'Billing',
      subject: 'Invoice',
      body: 'Line one\nLine two',
    })
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('Billing')
  })

  it('rejects an empty name before calling the API', async () => {
    view = harness()
    await settle()

    act(() => { buttonByText(t('email.templates.new')).click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => {
      buttonByText(t('common.save'), dialog).click()
      await Promise.resolve()
    })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('email.templates.invalid_name'))
    expect(api.email.createTemplate).not.toHaveBeenCalled()
  })

  it('edits a template in the dialog', async () => {
    view = harness()
    await settle()

    act(() => { buttonByLabel(t('email.templates.edit_named', { name: 'Welcome' })).click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(fieldFor(t('email.templates.name')).value).toBe('Welcome')
    change(fieldFor(t('email.templates.subject')), 'Updated')
    await act(async () => {
      buttonByText(t('common.save'), dialog).click()
      await Promise.resolve()
    })

    expect(api.email.updateTemplate).toHaveBeenCalledWith(account.id, template.id, {
      name: 'Welcome',
      subject: 'Updated',
      body: 'Hi there',
    })
    await settle()
    expect(document.body.textContent).toContain('Updated')
  })

  it('asks before deleting a template', async () => {
    view = harness()
    await settle()

    await act(async () => {
      buttonByLabel(t('email.templates.delete_named', { name: 'Welcome' })).click()
      await Promise.resolve()
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain(t('email.templates.delete_title', { name: 'Welcome' }))
    await act(async () => {
      buttonByText(t('common.delete'), dialog).click()
      await Promise.resolve()
    })
    expect(api.email.deleteTemplate).toHaveBeenCalledWith(account.id, template.id)
    await settle()
    expect(document.body.textContent).not.toContain('Welcome')
    expect(document.body.textContent).toContain(t('email.templates.empty'))
  })

  it('shows the empty state without templates', async () => {
    vi.mocked(api.email.listTemplates).mockResolvedValue([])
    view = harness()
    await settle()

    expect(document.body.textContent).toContain(t('email.templates.empty'))
    expect(document.body.textContent).toContain(t('email.templates.empty_hint'))
  })

  it('states a failed load and retries', async () => {
    vi.mocked(api.email.listTemplates)
      .mockRejectedValueOnce(new Error('Mailbox unavailable'))
      .mockResolvedValueOnce([template])
    view = harness()
    await settle()

    expect(document.body.textContent).toContain(t('email.templates.error'))
    expect(document.body.textContent).toContain('Mailbox unavailable')

    await act(async () => {
      buttonByText(t('common.retry')).click()
      await Promise.resolve()
    })
    await settle()
    expect(api.email.listTemplates).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Welcome')
  })
})
