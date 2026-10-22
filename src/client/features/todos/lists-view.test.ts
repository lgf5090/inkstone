// @vitest-environment jsdom
/**
 * The organizer page's list tree, one level deep.
 *
 * A child is drawn inside its parent rather than beside it, and the archive shelf starts collapsed so
 * a list the reader put away does not take up the page they are working on. The store is handed a
 * fixed answer, so what is pinned here is the structure a real answer would produce.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { ListsView } from './ListsView'
import { useTodos } from './store'
import type { TaskCounts, TaskList } from '@shared/todos/model'

/** A list as the route serialises one. */
type ListEntry = TaskList & { archivedAt: number | null; parentId: string | null }

function entry(id: string, name: string, extra: Partial<ListEntry> = {}): ListEntry {
  return {
    id,
    name,
    icon: null,
    color: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    openCount: 0,
    doneCount: 0,
    archivedAt: null,
    parentId: null,
    ...extra,
  }
}

function counts(open: number): TaskCounts {
  return { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: open, completed: 0, starred: 0, byList: {}, byTag: {} }
}

let view: RenderedElement | undefined

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  useTodos.setState({
    lists: [],
    archivedLists: [],
    tags: [],
    counts: counts(0),
    loadArchivedLists: async () => {},
  })
})

afterEach(() => {
  view?.unmount()
  view = undefined
  vi.unstubAllGlobals()
})

function render(): void {
  view = renderElement(createElement(ListsView, { onOpen: () => {} }))
}

/** The row a list's open button belongs to. */
function rowNamed(name: string): HTMLElement {
  const button = view!.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('todo.action.view_list')} ${name}"]`,
  )
  expect(button, `no row for ${name}`).not.toBeNull()
  return button!.closest('li') as HTMLElement
}

describe('the list tree', () => {
  it('draws a child inside its parent and a root on its own', () => {
    useTodos.setState({
      lists: [
        entry('travel', 'Travel', { position: 0 }),
        entry('booking', 'Booking', { position: 1, parentId: 'travel' }),
        entry('work', 'Work', { position: 2 }),
      ],
    })
    render()

    const parent = rowNamed('Travel')
    const child = rowNamed('Booking')
    const nested = parent.querySelector('ul')
    expect(nested, 'the child list was not drawn inside its parent').not.toBeNull()
    expect(nested!.contains(child)).toBe(true)
    // The child appears once, and only under its parent: its nearest list is the one inside the
    // parent's item, not the top-level list beside it.
    const holder = child.closest('ul')!
    expect(holder).toBe(nested)
    expect(holder.closest('li')).toBe(parent)
    expect(rowNamed('Work').querySelector('ul')).toBeNull()
    // The two top-level lists are siblings; the child is not a third one.
    expect(parent.parentElement!.children).toHaveLength(2)
  })

  it('keeps the archive shelf collapsed until it is opened', async () => {
    useTodos.setState({
      lists: [entry('active', 'Active')],
      archivedLists: [entry('old', 'Old', { archivedAt: 123 })],
    })
    render()

    expect(view!.container.textContent).not.toContain('Old')
    const toggle = view!.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('todo.list.archived')}"]`,
    )
    expect(toggle).not.toBeNull()
    expect(toggle!.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      toggle!.click()
      await Promise.resolve()
    })

    const opened = view!.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('todo.list.archived')}"]`,
    )
    expect(opened!.getAttribute('aria-expanded')).toBe('true')
    expect(view!.container.textContent).toContain('Old')
  })

  it('archives a list through the store when its row asks', async () => {
    const writes: { id: string; patch: { archived?: boolean } }[] = []
    useTodos.setState({
      lists: [entry('active', 'Active')],
      updateList: async (id, patch) => {
        writes.push({ id, patch })
        return null
      },
    })
    render()

    // Archiving lives in the row's own menu now: one `⋯` per row instead of three buttons that took a
    // third of a phone's width.
    const menuButton = view!.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('todo.task.actions')}: Active"]`,
    )
    expect(menuButton, 'the row offers no actions').not.toBeNull()
    await act(async () => {
      menuButton!.click()
      await Promise.resolve()
    })
    const archive = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((node) => (node.textContent ?? '').trim() === t('todo.action.archive'))
    expect(archive, 'the row menu offers no archive').not.toBeUndefined()
    await act(async () => {
      archive!.click()
      await Promise.resolve()
    })

    expect(writes).toEqual([{ id: 'active', patch: { archived: true } }])
  })
})
