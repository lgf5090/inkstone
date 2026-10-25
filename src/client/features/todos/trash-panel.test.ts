// @vitest-environment jsdom
/**
 * The trash screen: the rows a delete hid, and the two doors out.
 *
 * The server is stubbed at the API boundary, so the assertions are about the requests the screen makes:
 * restoring asks the store for the same id the delete stamped, and purging asks first — a permanent
 * delete is the one gesture in this feature that cannot be taken back.
 */
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { ConfirmHost } from '../../components/overlay'
import { TrashPanel } from './TrashPanel'
import { useTodos } from './store'
import { TODO_TRASH_RETENTION_DAYS, TRASH_PAGE_SIZE, type TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  tasks: [] as TodoTask[],
  purges: [] as string[],
  restores: [] as string[],
  /** Every trash request, in the order the screen made them. */
  requests: [] as { limit?: number, offset?: number }[],
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      trash: async (params: { limit?: number, offset?: number } = {}) => {
        service.requests.push(params)
        const offset = params.offset ?? 0
        const limit = params.limit ?? 100
        return { tasks: service.tasks.slice(offset, offset + limit), total: service.tasks.length }
      },
      purge: async (id: string) => {
        service.purges.push(id)
        return { purged: true as const }
      },
    },
  },
}))

const original = useTodos.getState()
let view: RenderedElement | null = null

function row(id: string, title: string): TodoTask {
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    deletedAt: 1_700_000_000_000,
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label || (node.textContent ?? '').trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.tasks = [row('a', 'First'), row('b', 'Second')]
  service.purges.length = 0
  service.restores.length = 0
  useTodos.setState(original, true)
  // The panel only needs the store's restore entry; the listing reload is the store's own test.
  useTodos.setState({
    restoreTask: async (id) => {
      service.restores.push(id)
      service.tasks = service.tasks.filter((task) => task.id !== id)
      return true
    },
  })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

describe('the trash panel', () => {
  it('lists the trashed rows and restores one by its id', async () => {
    view = renderElement(createElement(TrashPanel, { open: true, onClose: () => {} }))
    await settle()
    expect(document.body.textContent).toContain('First')
    expect(document.body.textContent).toContain('Second')

    await act(async () => {
      buttonNamed(`${t('todo.trash.restore')} First`).click()
    })
    await settle()

    expect(service.restores).toEqual(['a'])
    expect(document.body.textContent).not.toContain('First')
    expect(document.body.textContent).toContain('Second')
  })

  it('pages the trash by the shared page size, not by a number it invented', async () => {
    service.tasks = Array.from({ length: TRASH_PAGE_SIZE + 10 }, (_, index) => row(`t${index}`, `Task ${index}`))

    view = renderElement(createElement(TrashPanel, { open: true, onClose: () => {} }))
    await settle()

    // One page, asked for in the size the route itself answers by, and the retention sentence names
    // the window the sweep keeps rather than a second copy of it.
    expect(service.requests.at(0)).toEqual({ limit: TRASH_PAGE_SIZE })
    expect(document.body.textContent).toContain(
      t('todo.trash.description', { days: TODO_TRASH_RETENTION_DAYS }),
    )
    expect(document.body.querySelectorAll('[data-todo-trash-row]').length).toBe(TRASH_PAGE_SIZE)
  })

  it('asks before purging and only then removes the row', async () => {
    view = renderElement(createElement(Fragment, null,
      createElement(TrashPanel, { open: true, onClose: () => {} }),
      createElement(ConfirmHost),
    ))
    await settle()

    await act(async () => {
      buttonNamed(`${t('todo.trash.purge')} Second`).click()
    })
    await settle()
    expect(service.purges).toEqual([])
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    expect(dialogs.at(-1)?.textContent).toContain(t('todo.trash.purge_hint'))

    const confirmButton = [...dialogs.at(-1)!.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => (node.textContent ?? '').trim() === t('todo.trash.purge'))
    expect(confirmButton, 'the confirm dialog offered no permanent-delete button').toBeTruthy()
    await act(async () => { confirmButton!.click() })
    await settle()

    expect(service.purges).toEqual(['b'])
    expect(document.body.textContent).not.toContain('Second')
  })
})
