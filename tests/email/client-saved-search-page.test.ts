// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailFolder } from '@shared/email/model'
import type { EmailAddress } from '../../src/client/features/email/email-address'
import { api } from '../../src/client/lib/api'
import { t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { prompt } from '../../src/client/components/overlay'
import { MailboxPage } from '../../src/client/features/email/MailboxPage'
import { useEmailStore } from '../../src/client/features/email/store'

vi.mock('../../src/client/components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/components/overlay')>()
  return {
    ...actual,
    prompt: vi.fn(async () => null),
  }
})

const account: EmailAccount = {
  id: 'a1',
  address: 'ada@example.com',
  displayName: 'Ada',
  settings: { signature: { enabled: false, text: '' }, autoDraft: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
]

const query = 'from:billing is:unread'

const original = useEmailStore.getState()

function address(kind: 'search' | 'mailbox'): Extract<EmailAddress, { kind: 'mailbox' | 'search' }> {
  return kind === 'search'
    ? { kind: 'search', accountId: account.id, query, messageId: null }
    : { kind: 'mailbox', accountId: account.id, folderId: 'inbox', messageId: null, compose: null, draftId: null }
}

function saveButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === t('email.saved_search.save_action'))
  if (!found) throw new Error('the save search button is not on screen')
  return found
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve()
  })
}

let view: RenderedElement | null = null

beforeEach(() => {
  useEmailStore.setState(original, true)
  window.history.replaceState(null, '', '/email/accounts/a1/search')
  vi.mocked(prompt).mockReset()
  vi.mocked(prompt).mockResolvedValue(null)
  vi.spyOn(api.email, 'listFolders').mockResolvedValue(folders)
  vi.spyOn(api.email, 'listTags').mockResolvedValue([])
  vi.spyOn(api.email, 'listSearches').mockResolvedValue([])
  vi.spyOn(api.email, 'search').mockResolvedValue({ emails: [], totalCount: 0 })
  vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
})

afterEach(() => {
  view?.unmount()
  view = null
  useEmailStore.getState().stopPolling()
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
  window.history.replaceState(null, '', '/')
  document.body.innerHTML = ''
})

describe('the save search action', () => {
  it('is enabled in search mode and saves the current raw query under the chosen name', async () => {
    const created = {
      id: 's1',
      name: 'Invoices',
      query,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const create = vi.spyOn(api.email, 'createSearch').mockResolvedValue(created)
    vi.mocked(api.email.listSearches).mockResolvedValueOnce([]).mockResolvedValue([created])
    vi.mocked(prompt).mockResolvedValue('Invoices')
    view = renderElement(createElement(MailboxPage, { address: address('search'), account }))
    await settle()

    expect(useEmailStore.getState().listMode).toBe('search')
    const save = saveButton()
    expect(save.disabled).toBe(false)
    act(() => { save.click() })
    await settle()

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      title: t('email.saved_search.save_title'),
      placeholder: query,
    }))
    expect(create).toHaveBeenCalledWith('a1', { name: 'Invoices', query })
    expect(useEmailStore.getState().searches).toEqual([created])
  })

  it('is disabled outside search mode', async () => {
    view = renderElement(createElement(MailboxPage, { address: address('mailbox'), account }))
    await settle()
    expect(saveButton().disabled).toBe(true)
  })

  it('keeps the search when the prompt is cancelled', async () => {
    const create = vi.spyOn(api.email, 'createSearch')
    view = renderElement(createElement(MailboxPage, { address: address('search'), account }))
    await settle()
    act(() => { saveButton().click() })
    await settle()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })})
