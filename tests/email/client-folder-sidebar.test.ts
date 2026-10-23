// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailFolder } from '@shared/email/model'
import { renderElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { useUi } from '../../src/client/store/ui'
import { prompt } from '../../src/client/components/overlay'
import { FolderSidebar, FolderSidebarRail } from '../../src/client/features/email/FolderSidebar'

vi.mock('../../src/client/components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/components/overlay')>()
  return {
    ...actual,
    prompt: vi.fn(async () => null),
    confirm: vi.fn(async () => false),
  }
})

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 3, parentId: null, color: null, sortOrder: 0 },
  { id: 'sent', name: 'Sent', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'draft', name: 'Drafts', isDeletable: false, unreadCount: 1, parentId: null, color: null, sortOrder: 0 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'trash', name: 'Trash', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'work', name: 'Work', isDeletable: true, unreadCount: 2, parentId: null, color: '#3b82f6', sortOrder: 0 },
  { id: 'projects', name: 'Projects', isDeletable: true, unreadCount: 0, parentId: 'work', color: null, sortOrder: 0 },
]

const uiOriginal = useUi.getState()

beforeEach(() => {
  vi.mocked(prompt).mockReset()
  vi.mocked(prompt).mockResolvedValue(null)
})

afterEach(() => {
  useUi.setState(uiOriginal, true)
  document.body.innerHTML = ''
})

function sidebarProps(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acc-1',
    folders,
    activeFolderId: 'inbox',
    onSelect: vi.fn(),
    onCreate: vi.fn(async (_name: string, _parentId: string | null) => undefined),
    onRename: vi.fn(async (_id: string, _name: string) => undefined),
    onColor: vi.fn(async (_id: string, _color: string | null) => undefined),
    onMove: vi.fn(async (_id: string, _parentId: string | null) => undefined),
    onDelete: vi.fn(async (_id: string) => undefined),
    tags: [],
    tagsStatus: 'ready' as const,
    tagsError: null,
    activeTagName: null,
    onSelectTag: vi.fn(),
    onReloadTags: vi.fn(async () => undefined),
    ...overrides,
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function treeRow(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button[data-tree-row]')]
    .find((node) => node.textContent?.includes(label))
  if (!found) throw new Error(`no tree row named ${label}`)
  return found
}

function maybeTreeRow(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>('button[data-tree-row]')]
    .find((node) => node.textContent?.includes(label)) ?? null
}

function menuItem(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no menu item named ${label}`)
  return found
}

function openRowMenu(row: HTMLButtonElement): void {
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }))
  })
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
    expect(maybeTreeRow('Work')).toBeNull()
    view.unmount()
  })

  it('collapses from the expanded sidebar and does not offer a second expand button there', () => {
    const onCollapse = vi.fn()
    const view = renderElement(createElement(FolderSidebar, sidebarProps({ onCollapse })))
    expect(() => button(t('sidebar.expand_navigation'))).toThrow()
    act(() => { button(t('sidebar.collapse_navigation')).click() })
    expect(onCollapse).toHaveBeenCalledTimes(1)
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

describe('the nested folder tree', () => {
  it('keeps children hidden until their branch expands and applies the level', () => {
    const props = sidebarProps()
    const view = renderElement(createElement(FolderSidebar, props))
    expect(treeRow(t('email.folder.inbox')).closest('[role="treeitem"]')?.getAttribute('aria-level')).toBe('1')
    expect(maybeTreeRow('Projects')).toBeNull()
    const work = treeRow('Work')
    expect(work.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false')
    act(() => { button(t('email.folder.expand', { name: 'Work' })).click() })
    const child = treeRow('Projects')
    expect(child.closest('[role="treeitem"]')?.getAttribute('aria-level')).toBe('2')
    act(() => { child.click() })
    expect(props.onSelect).toHaveBeenCalledWith('projects')
    view.unmount()
  })

  it('expands the ancestors of the folder already open', () => {
    const view = renderElement(createElement(FolderSidebar, sidebarProps({ activeFolderId: 'projects' })))
    const child = treeRow('Projects')
    expect(child.getAttribute('aria-current')).toBe('page')
    expect(child.closest('[role="treeitem"]')?.getAttribute('aria-level')).toBe('2')
    view.unmount()
  })

  it('offers subfolder creation with the parent id from the row menu', async () => {
    const props = sidebarProps()
    vi.mocked(prompt).mockResolvedValue('Child')
    const view = renderElement(createElement(FolderSidebar, props))
    openRowMenu(treeRow('Work'))
    expect(menuItem(t('email.folder.new_child'))).toBeTruthy()
    expect(menuItem(t('email.folder.rename'))).toBeTruthy()
    expect(menuItem(t('email.folder.delete'))).toBeTruthy()
    await act(async () => {
      menuItem(t('email.folder.new_child')).click()
      for (let index = 0; index < 10; index++) await Promise.resolve()
    })
    expect(props.onCreate).toHaveBeenCalledWith('Child', 'work')
    view.unmount()
  })

  it('keeps system folders to the subfolder action and opens the menu with Shift+F10', () => {
    const view = renderElement(createElement(FolderSidebar, sidebarProps()))
    openRowMenu(treeRow(t('email.folder.inbox')))
    expect(menuItem(t('email.folder.new_child'))).toBeTruthy()
    const rename = [...document.querySelectorAll('[role="menuitem"]')]
      .some((node) => node.textContent?.trim() === t('email.folder.rename'))
    expect(rename).toBe(false)
    act(() => { document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click() })
    expect(document.querySelector('[role="menu"]')).toBeNull()

    const inbox = treeRow(t('email.folder.inbox'))
    act(() => {
      inbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
    view.unmount()
  })
})
