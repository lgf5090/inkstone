// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailFolder } from '@shared/email/model'
import { renderElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { useUi } from '../../src/client/store/ui'
import { FolderSidebarRail } from '../../src/client/features/email/FolderSidebar'

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 3 },
  { id: 'sent', name: 'Sent', isDeletable: false, unreadCount: 0 },
  { id: 'draft', name: 'Drafts', isDeletable: false, unreadCount: 1 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0 },
  { id: 'trash', name: 'Trash', isDeletable: false, unreadCount: 0 },
]

const uiOriginal = useUi.getState()

afterEach(() => {
  useUi.setState(uiOriginal, true)
  document.body.innerHTML = ''
})

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

describe('the collapsed folder rail', () => {
  it('offers the folders and the unread count, and expands from its own button', () => {
    const onSelect = vi.fn()
    const onExpand = vi.fn()
    const view = renderElement(createElement(FolderSidebarRail, {
      folders,
      activeFolderId: 'inbox',
      onSelect,
      onExpand,
    }))
    expect(button(t('sidebar.expand_navigation'))).toBeTruthy()
    const inbox = button(`${t('email.folder.inbox')} · 3`)
    expect(inbox.getAttribute('aria-current')).toBe('page')
    act(() => { inbox.click() })
    expect(onSelect).toHaveBeenCalledWith('inbox')
    act(() => { button(t('sidebar.expand_navigation')).click() })
    expect(onExpand).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('keeps the collapse state and width in the layout store', () => {
    expect(useUi.getState().emailNavCollapsed).toBe(false)
    act(() => { useUi.getState().toggleEmailNav() })
    expect(useUi.getState().emailNavCollapsed).toBe(true)
    act(() => { useUi.getState().setLayout({ emailNavWidth: 300 }) })
    expect(useUi.getState().emailNavWidth).toBe(300)
  })
})
