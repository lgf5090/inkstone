// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailContact, EmailGroupWithMembers } from '@shared/email/contacts'
import { api } from '../../src/client/lib/api'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { ContactsPage } from '../../src/client/features/email/ContactsPage'

const grace: EmailContact = {
  id: 'c1',
  email: 'grace@example.com',
  name: 'Grace Hopper',
  company: 'Navy',
  notes: '',
  starred: true,
  pinned: false,
  avatar: '',
  usageCount: 3,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const alan: EmailContact = {
  id: 'c2',
  email: 'alan@example.com',
  name: 'Alan Turing',
  company: '',
  notes: '',
  starred: false,
  pinned: false,
  avatar: '',
  usageCount: 1,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const team: EmailGroupWithMembers = {
  id: 'g1',
  name: 'Team',
  description: 'Everyone',
  starred: false,
  pinned: false,
  avatar: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  members: [grace, alan],
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function inputFor(label: string): HTMLInputElement {
  const target = [...document.querySelectorAll('label')]
    .find((node) => node.textContent?.trim().replace(/\s*\*$/, '') === label)
  if (!target?.htmlFor) throw new Error(`no field labelled ${label}`)
  const input = document.getElementById(target.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`field ${label} is not an input`)
  return input
}

function change(input: HTMLInputElement, next: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function settle(ms = 240): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

let view: RenderedElement | null = null

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the contacts page', () => {
  it('lists contacts and groups with their member counts', async () => {
    vi.spyOn(api.email, 'listContacts').mockResolvedValue([grace, alan])
    vi.spyOn(api.email, 'listGroups').mockResolvedValue([team])
    view = renderElement(createElement(ContactsPage, { onBack: vi.fn() }))
    await settle()
    expect(document.body.textContent).toContain('Grace Hopper')
    expect(document.body.textContent).toContain('Alan Turing')
    expect(document.body.textContent).toContain('Team')
    expect(document.body.textContent).toContain(t('email.contacts.member_count', { count: 2 }))
  })

  it('creates a contact from the add menu', async () => {
    vi.spyOn(api.email, 'listContacts').mockResolvedValue([])
    vi.spyOn(api.email, 'listGroups').mockResolvedValue([])
    const createContact = vi.spyOn(api.email, 'createContact').mockResolvedValue(grace)
    view = renderElement(createElement(ContactsPage, { onBack: vi.fn() }))
    await settle()
    act(() => { button(t('email.contacts.add')).click() })
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]')
    if (!item) throw new Error('no add menu item')
    act(() => { item.click() })
    change(inputFor(t('email.contacts.email')), 'grace@example.com')
    change(inputFor(t('email.contacts.name')), 'Grace Hopper')
    await act(async () => {
      button(t('common.save')).click()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    expect(createContact).toHaveBeenCalledWith({
      email: 'grace@example.com',
      name: 'Grace Hopper',
      company: '',
      notes: '',
      starred: false,
      pinned: false,
      avatar: '',
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
