// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailFolder } from '@shared/email/model'
import type { EmailBlockedSender, EmailFilter } from '@shared/email/rules'
import { api } from '../../src/client/lib/api'
import { t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { ConfirmHost } from '../../src/client/components/overlay'
import { RulesPage } from '../../src/client/features/email/RulesPage'
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

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 1 },
  { id: 'trash', name: 'Trash', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 2 },
]

const filter: EmailFilter = {
  id: 'f1',
  name: 'Invoices',
  enabled: true,
  sortOrder: 0,
  conditions: [{ field: 'subjectContains', value: 'invoice' }],
  actions: [{ type: 'moveTo', folder: 'archive' }, { type: 'markRead' }],
  createdAt: '2026-10-01T00:00:00.000Z',
}

const blocked: EmailBlockedSender[] = [
  { address: 'spam@example.com', createdAt: '2026-10-01T00:00:00.000Z' },
]

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

function inputFor(label: string): HTMLInputElement {
  const target = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim() === label)
  if (!target?.htmlFor) throw new Error(`no field labelled ${label}`)
  const input = document.getElementById(target.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`field ${label} is not an input`)
  return input
}

function change(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function harness(): RenderedElement {
  return renderElement(createElement('div', null,
    createElement(RulesPage, { accountId: account.id }),
    createElement(ConfirmHost)))
}

let view: RenderedElement | null = null

beforeEach(() => {
  vi.spyOn(api.email, 'listFilters').mockResolvedValue([filter])
  vi.spyOn(api.email, 'listBlockedSenders').mockResolvedValue(blocked)
  vi.spyOn(api.email, 'updateFilter').mockImplementation(async (_id, _filterId, patch) => ({ ...filter, ...patch }))
  vi.spyOn(api.email, 'createFilter').mockImplementation(async (_id, input) => ({
    id: 'f-new',
    name: input.name,
    enabled: input.enabled,
    sortOrder: 1,
    conditions: input.conditions,
    actions: input.actions,
    createdAt: '2026-10-02T00:00:00.000Z',
  }))
  vi.spyOn(api.email, 'deleteFilter').mockResolvedValue(undefined)
  vi.spyOn(api.email, 'addBlockedSender').mockResolvedValue({
    address: 'new@example.com',
    createdAt: '2026-10-02T00:00:00.000Z',
  })
  vi.spyOn(api.email, 'removeBlockedSender').mockResolvedValue(undefined)
  useEmailStore.setState(original, true)
  useEmailStore.setState({
    accounts: [account],
    accountsStatus: 'ready',
    accountsError: null,
    folders,
    foldersAccountId: account.id,
    foldersStatus: 'ready',
    foldersError: null,
  })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the rules page', () => {
  it('lists filters with summaries and blocked senders', async () => {
    view = harness()
    await settle()

    expect(document.body.textContent).toContain('Invoices')
    expect(document.body.textContent).toContain(t('email.rules.summary.subject', { value: 'invoice' }))
    expect(document.body.textContent).toContain(t('email.rules.summary.move', { folder: t('email.folder.archive') }))
    expect(document.body.textContent).toContain('spam@example.com')
    expect(api.email.listFilters).toHaveBeenCalledWith(account.id)
    expect(api.email.listBlockedSenders).toHaveBeenCalledWith(account.id)
  })

  it('toggles a filter through the API', async () => {
    view = harness()
    await settle()

    const toggle = buttonByLabel(t('email.rules.toggle', { name: 'Invoices' }))
    await act(async () => {
      toggle.click()
      await Promise.resolve()
    })
    expect(api.email.updateFilter).toHaveBeenCalledWith(account.id, filter.id, { enabled: false })
  })

  it('edits a filter in the dialog and saves through the API', async () => {
    view = harness()
    await settle()

    act(() => { buttonByLabel(t('email.rules.edit_named', { name: 'Invoices' })).click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain(t('email.rules.edit_named', { name: 'Invoices' }))
    expect(inputFor(t('email.rules.name')).value).toBe('Invoices')

    change(inputFor(t('email.rules.name')), 'Invoices 2')
    await act(async () => {
      buttonByText(t('common.save'), dialog).click()
      await Promise.resolve()
    })

    expect(api.email.updateFilter).toHaveBeenCalledWith(account.id, filter.id, expect.objectContaining({
      name: 'Invoices 2',
      conditions: [{ field: 'subjectContains', value: 'invoice' }],
      actions: [{ type: 'moveTo', folder: 'archive' }, { type: 'markRead' }],
    }))
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('Invoices 2')
  })

  it('creates a filter from the dialog with conditions and actions', async () => {
    view = harness()
    await settle()

    act(() => { buttonByText(t('email.rules.new')).click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    change(inputFor(t('email.rules.name')), 'Billing')
    change(inputFor(t('email.rules.from')), 'billing@example.com')
    act(() => { buttonByText(t('email.rules.trash'), dialog).click() })
    await act(async () => {
      buttonByText(t('common.save'), dialog).click()
      await Promise.resolve()
    })

    expect(api.email.createFilter).toHaveBeenCalledWith(account.id, {
      name: 'Billing',
      enabled: true,
      conditions: [{ field: 'fromContains', value: 'billing@example.com' }],
      actions: [{ type: 'trash' }],
    })
    await settle()
    expect(document.body.textContent).toContain('Billing')
  })

  it('asks before deleting a filter', async () => {
    view = harness()
    await settle()

    await act(async () => {
      buttonByLabel(t('email.rules.delete_named', { name: 'Invoices' })).click()
      await Promise.resolve()
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain(t('email.rules.delete_title', { name: 'Invoices' }))
    await act(async () => {
      buttonByText(t('common.delete'), dialog).click()
      await Promise.resolve()
    })
    expect(api.email.deleteFilter).toHaveBeenCalledWith(account.id, filter.id)
    await settle()
    expect(document.body.textContent).not.toContain('Invoices')
  })

  it('adds and removes a blocked sender', async () => {
    view = harness()
    await settle()

    change(inputFor(t('email.rules.block_address')), 'new@example.com')
    await act(async () => {
      buttonByText(t('email.rules.block_add')).click()
      await Promise.resolve()
    })
    expect(api.email.addBlockedSender).toHaveBeenCalledWith(account.id, 'new@example.com')
    await settle()
    expect(document.body.textContent).toContain('new@example.com')

    const row = [...document.querySelectorAll('li')]
      .find((node) => node.textContent?.includes('spam@example.com'))
    const remove = row?.querySelector('button')
    if (!remove) throw new Error('no remove button for the blocked sender')
    await act(async () => {
      remove.click()
      await Promise.resolve()
    })
    expect(api.email.removeBlockedSender).toHaveBeenCalledWith(account.id, 'spam@example.com')
    await settle()
    expect(document.body.textContent).not.toContain('spam@example.com')
  })

  it('rejects an invalid address before calling the API', async () => {
    view = harness()
    await settle()

    change(inputFor(t('email.rules.block_address')), 'not-an-address')
    act(() => { buttonByText(t('email.rules.block_add')).click() })
    expect(document.body.textContent).toContain(t('email.rules.block_invalid'))
    expect(api.email.addBlockedSender).not.toHaveBeenCalled()
  })
})
