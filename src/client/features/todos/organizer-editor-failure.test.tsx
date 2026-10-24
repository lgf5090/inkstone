// @vitest-environment jsdom
/**
 * A list the server refused to create keeps its editor open.
 *
 * `createList` answers `null` when the write was refused, and the dialog used to close on that answer
 * anyway — the name the reader had just typed went with it, leaving only a toast about a list that is
 * not in the sidebar. The panel now waits for the row the store hands back before it closes.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      createList: async (input: Record<string, unknown>) => {
        server.created.push(input)
        throw new Error('The server refused the write.')
      },
    },
  },
}))

const server = vi.hoisted(() => ({ created: [] as Record<string, unknown>[] }))

import { ListEditor } from './OrganizerEditors'
import { useTodos } from './store'

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  server.created.length = 0
  useTodos.setState(original, true)
})

afterEach(() => {
  if (view) act(() => { view!.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

function panel(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('the list editor did not open')
  return dialog
}

function nameField(): HTMLInputElement {
  const field = panel().querySelector<HTMLInputElement>(`input[aria-label="${t('todo.list.name_label')}"]`)
  if (!field) throw new Error('the list editor offers no name field')
  return field
}

function saveButton(): HTMLButtonElement {
  const button = [...panel().querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.textContent ?? '').trim() === t('todo.action.save'))
  if (!button) throw new Error('the list editor offers no save button')
  return button
}

describe('a list the server refused', () => {
  it('keeps the dialog open on the name the reader typed', async () => {
    act(() => {
      useTodos.setState({
        status: 'ready',
        lists: [],
        archivedLists: [],
        tags: [],
        tasks: [],
        completed: [],
        counts: EMPTY_COUNTS,
        timezone: 'UTC',
        listEditor: { open: true, list: null },
      })
    })
    view = renderElement(createElement(ListEditor))
    await flush()

    const field = nameField()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(field, 'Reading')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { saveButton().click() })
    await flush()

    expect(server.created).toHaveLength(1)
    expect(server.created[0]!.name).toBe('Reading')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(useTodos.getState().listEditor.open).toBe(true)
    expect(nameField().value).toBe('Reading')
  })
})

describe('the custom colour field', () => {
  it('names the line that explains a refused hex', async () => {
    act(() => {
      useTodos.setState({
        status: 'ready',
        lists: [],
        archivedLists: [],
        tags: [],
        tasks: [],
        completed: [],
        counts: EMPTY_COUNTS,
        timezone: 'UTC',
        listEditor: { open: true, list: null },
      })
    })
    view = renderElement(createElement(ListEditor))
    await flush()

    const field = panel().querySelector<HTMLInputElement>(`input[aria-label="${t('todo.list.color_custom')}"]`)
    expect(field, 'the list editor offers no custom colour field').not.toBeNull()
    // The border turning red is a message only sighted readers receive; `aria-describedby` is how the
    // same sentence reaches everyone else. It has to point at a real element, which is the half a
    // hand-written panel usually forgets.
    const describedBy = field!.getAttribute('aria-describedby')
    expect(describedBy, 'the field is described by nothing').toBeTruthy()
    const hint = document.getElementById(describedBy!)
    expect(hint, 'aria-describedby points at no element').not.toBeNull()
    expect(hint!.textContent?.trim()).not.toBe('')
    // Nothing has been refused yet, so the field is not announced as invalid.
    expect(field!.getAttribute('aria-invalid')).toBeNull()
  })
})
