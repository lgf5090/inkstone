// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EmailContact, EmailGroupWithMembers } from '@shared/email/contacts'
import { initI18n, t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { EmailContactsTab, EmailFavoritesTab, EmailGroupsTab } from '../../src/client/features/email/EmailContactSidebar'

const contacts: EmailContact[] = [
  { id: 'c1', email: 'grace@example.com', name: 'Grace Hopper', company: '', notes: '', starred: true, pinned: true, avatar: '', usageCount: 0, lastUsedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'c2', email: 'alan@example.com', name: 'Alan Turing', company: '', notes: '', starred: false, pinned: false, avatar: '', usageCount: 0, lastUsedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
]
const groups: EmailGroupWithMembers[] = [
  { id: 'g1', name: 'Design team', description: '', starred: true, pinned: true, avatar: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', members: [contacts[0]!] },
]

let view: RenderedElement | null = null

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function menuLabels(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent?.trim() ?? '')
}

describe('the contact and group tabs', () => {
  it('opens the contact actions from a right click', () => {
    view = renderElement(createElement(EmailContactsTab, {
      contacts,
      contactsStatus: 'ready',
      contactsError: null,
      activeContactId: null,
      onSelectContact: vi.fn(),
      onNewContact: vi.fn(),
      onEditContact: vi.fn(),
      onManage: vi.fn(),
      onChanged: vi.fn(),
      onReload: vi.fn(),
    }))
    const row = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.includes('Grace Hopper'))
    expect(row).toBeTruthy()
    act(() => {
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }))
    })
    expect(menuLabels()).toContain(t('email.contacts.edit_action'))
    expect(menuLabels()).toContain(t('email.contacts.unstar_action'))
    expect(menuLabels()).toContain(t('email.contacts.delete_action'))
  })

  it('opens the group actions from a right click', () => {
    view = renderElement(createElement(EmailGroupsTab, {
      groups,
      groupsStatus: 'ready',
      groupsError: null,
      activeGroupId: null,
      onSelectGroup: vi.fn(),
      onSelectContact: vi.fn(),
      onNewGroup: vi.fn(),
      onEditGroup: vi.fn(),
      onEditContact: vi.fn(),
      onManage: vi.fn(),
      onChanged: vi.fn(),
      onReload: vi.fn(),
    }))
    const row = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.includes('Design team'))
    act(() => {
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }))
    })
    expect(menuLabels()).toContain(t('email.contacts.group_members'))
    expect(menuLabels()).toContain(t('email.contacts.edit_action'))
  })

  it('lists only favorites in the favorites tab', () => {
    view = renderElement(createElement(EmailFavoritesTab, {
      contacts,
      groups,
      activeContactId: null,
      activeGroupId: null,
      onSelectContact: vi.fn(),
      onSelectGroup: vi.fn(),
      onSelectStarredMessages: vi.fn(),
      onEditContact: vi.fn(),
      onEditGroup: vi.fn(),
      onManage: vi.fn(),
      onChanged: vi.fn(),
      onReload: vi.fn(),
    }))
    expect(document.body.textContent).toContain('Grace Hopper')
    expect(document.body.textContent).not.toContain('Alan Turing')
    expect(document.body.textContent).toContain(t('email.sidebar.starred_messages'))
    expect(document.querySelector('[data-email-view="starred"]')).not.toBeNull()
  })
})
