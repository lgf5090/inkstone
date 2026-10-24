// @vitest-environment jsdom
/**
 * Dropping a file onto a row, onto the route that has been waiting for a caller.
 *
 * `POST /api/todos/:id/attachments` has been complete since the attachment round — the same storage,
 * budget, quota, sniffing and link row every note file uses — and nothing in the client ever called it
 * (C12). This is that caller: a file dragged onto a row goes to that route and no other.
 *
 * Two boundaries are pinned here and they are not the same one. The card must tell a file from a task,
 * because both arrive on the same `drop` event and a file mistaken for a task would move a row the
 * reader never meant to move. And the card's own size check is a courtesy: it says "too large" in the
 * time it takes to let go rather than after an upload that was always going to be refused. The server
 * keeps the limit — the client's answer is never the trust boundary, so a file the client let through
 * is still handed to the same route a note uses, with nothing about the limit copied into the request.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { LIMITS } from '@shared/constants'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  uploads: [] as { path: string; init: { method?: string; formData?: FormData } }[],
  moves: [] as { id: string; body: Record<string, unknown> }[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  fail: null as Error | null,
}))

vi.mock('../../lib/api', () => {
  const counts: TaskCounts = {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0,
    completed: 0, starred: 0, byList: {}, byTag: {},
  }
  return {
    CLIENT_ID: 'test-client',
    ApiError: class ApiError extends Error {
      constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
        super(message)
      }
    },
    request: async (path: string, init: { method?: string; formData?: FormData } = {}) => {
      service.uploads.push({ path, init })
      if (service.fail) throw service.fail
      return { attachment: { id: 'file-1', filename: 'a.txt', mime: 'text/plain', size: 1, url: '/api/files/file-1', createdAt: 0 } }
    },
    api: {
      todos: {
        list: async () => ({
          tasks: [], total: 0, counts, dayEnd: Date.now() + 3_600_000, timezone: 'UTC',
        }),
        lists: async () => ({ lists: [] }),
        tags: async () => ({ tags: [] }),
        move: async (id: string, body: Record<string, unknown>) => {
          service.moves.push({ id, body })
          return { task: null }
        },
        update: async (id: string, patch: Record<string, unknown>) => {
          service.updates.push({ id, patch })
          return { task: null, next: null }
        },
      },
    },
  }
})

import { TaskCard, TODO_DRAG_TYPE, type TaskMoveControls } from './TaskCard'
import { useTodos } from './store'
import { useUi } from '../../store/ui'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function task(id = 'a'): TodoTask {
  return {
    id,
    title: id,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    remindedAt: null,
    plannedFor: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    position: 1000,
  }
}

function file(name: string, size = 8): File {
  const entry = new File(['contents'], name, { type: 'text/plain' })
  if (size !== 8) Object.defineProperty(entry, 'size', { value: size })
  return entry
}

function controls(overrides: Partial<TaskMoveControls> = {}): TaskMoveControls {
  return {
    dragEnabled: true,
    onDrop: vi.fn(),
    order: { up: true, down: true, moveUp: vi.fn(), moveDown: vi.fn() },
    onMoveToList: vi.fn(),
    ...overrides,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

function mount(row: TodoTask, move: TaskMoveControls | undefined = controls()): void {
  useTodos.setState({
    status: 'ready',
    tasks: [row],
    completed: [],
    total: 1,
    lists: [],
    tags: [],
    timezone: 'UTC',
    dayEnd: NOW + DAY,
    selectedIds: new Set<string>(),
  })
  view = renderElement(createElement(TaskCard, {
    task: row,
    lists: [],
    bounds: { dayEnd: NOW + DAY, now: NOW },
    timezone: 'UTC',
    onOpen: () => {},
    onStar: () => {},
    ...(move ? { move } : {}),
  }))
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.uploads.length = 0
  service.moves.length = 0
  service.updates.length = 0
  service.fail = null
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100))
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
  vi.restoreAllMocks()
})

function card(): HTMLElement {
  const node = view!.container.querySelector<HTMLElement>('article')
  expect(node, 'the row is not rendered').toBeTruthy()
  return node!
}

/** One drag event at the row, carrying either files or the bag an in-app drag writes. */
async function send(
  type: 'dragover' | 'drop' | 'dragleave',
  bag: Map<string, string>,
  files: File[],
): Promise<Event> {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    dataTransfer: {
      value: {
        types: [...(files.length > 0 ? ['Files'] : []), ...bag.keys()],
        getData: (format: string) => bag.get(format) ?? '',
        setData: (format: string, value: string) => { bag.set(format, value) },
        dropEffect: 'none',
        effectAllowed: 'unset',
        files,
        setDragImage: () => {},
      },
    },
    clientY: { value: 20 },
    relatedTarget: { value: null },
  })
  await act(async () => {
    card().dispatchEvent(event)
    await Promise.resolve()
    await Promise.resolve()
  })
  return event
}

function hint(): HTMLElement | null {
  return view!.container.querySelector<HTMLElement>('[data-todo-attach-hint]')
}

function lastToast(): { title: string; description?: string; tone?: string } | undefined {
  return useUi.getState().toasts.at(-1)
}

describe('a file dropped on a row', () => {
  it('goes to the task attachment route as the file field the route reads', async () => {
    mount(task())

    await send('drop', new Map(), [file('notes.txt')])

    expect(service.uploads).toHaveLength(1)
    expect(service.uploads[0]!.path).toBe('/api/todos/a/attachments')
    expect(service.uploads[0]!.init.method).toBe('POST')
    const form = service.uploads[0]!.init.formData
    expect(form, 'no multipart body was built').toBeInstanceOf(FormData)
    expect(form!.get('file')).toBeInstanceOf(File)
    expect((form!.get('file') as File).name).toBe('notes.txt')
    // The limit is the server's to find; nothing about it rides along in the request.
    expect([...form!.keys()]).toEqual(['file'])
  })

  it('is never read as a task moved', async () => {
    const move = controls()
    mount(task(), move)

    const event = await send('drop', new Map(), [file('notes.txt')])

    expect(event.defaultPrevented, 'a file dropped on the row was left to the browser').toBe(true)
    expect(move.onDrop, 'a file was taken for a row being reordered').not.toHaveBeenCalled()
    expect(service.moves, 'a file moved a task').toEqual([])
    expect(service.updates, 'a file wrote a task').toEqual([])
  })

  it('refuses a file over the limit before anything is sent', async () => {
    mount(task())

    await send('drop', new Map(), [file('huge.bin', LIMITS.attachmentMaxBytes + 1)])

    // The client's courtesy: the reader is told now, not after an upload that was always going to fail.
    expect(service.uploads, 'an oversized file was uploaded anyway').toEqual([])
    expect(lastToast()?.title).toBe(t('todo.attach.too_large', { count: 1, limit: Math.round(LIMITS.attachmentMaxBytes / 1_048_576) }))
  })

  it('says what the server said when the upload comes back refused', async () => {
    mount(task())
    service.fail = new Error('The file exceeds the 25 MB limit')

    await send('drop', new Map(), [file('a.txt'), file('b.txt')])

    // No silent half: both files were handed over, and the answer that came back is said out loud.
    expect(service.uploads).toHaveLength(2)
    const toast = lastToast()
    expect(toast?.title).toBe(t('attachments.upload_failed_value0', { value0: 2 }))
    expect(toast?.description).toContain('The file exceeds the 25 MB limit')
    expect(toast?.tone).toBe('danger')
  })

  it('reports the files that landed', async () => {
    mount(task())

    await send('drop', new Map(), [file('a.txt')])

    expect(lastToast()?.title).toBe(t('attachments.uploaded_value0', { value0: 1 }))
  })

  it('paints the way in while the pointer is over it, and takes it away after', async () => {
    mount(task())

    await send('dragover', new Map(), [file('a.txt')])
    expect(hint(), 'a file hovered with nothing saying it would land').not.toBeNull()
    expect(hint()!.textContent).toContain(t('attachments.drag_drop_hint'))
    // The strip is what a pointer reads; the toast is what a reader is told.
    expect(hint()!.getAttribute('aria-hidden')).toBe('true')

    await send('dragleave', new Map(), [file('a.txt')])
    expect(hint(), 'the strip outlived the pointer').toBeNull()
  })

  it('offers the strip even where the row refuses a drop between rows', async () => {
    const move = controls({ onDrop: undefined })
    mount(task(), move)

    await send('dragover', new Map(), [file('a.txt')])

    expect(hint(), 'a column that declines reorders also declined the file').not.toBeNull()
    const event = await send('drop', new Map(), [file('a.txt')])
    expect(event.defaultPrevented).toBe(true)
    expect(service.uploads).toHaveLength(1)
  })

  it('leaves a task drag as a task drag, which is the other half of the same event', async () => {
    const move = controls()
    mount(task(), move)

    const bag = new Map([[TODO_DRAG_TYPE, 'b']])
    await send('dragover', bag, [])
    expect(hint(), 'a task dragged over the row was dressed up as a file').toBeNull()

    await send('drop', bag, [])
    expect(service.uploads, 'a task drop was read as files').toEqual([])
    // The row still answers a task the way the gap grammar says it should.
    expect(move.onDrop).toHaveBeenCalledTimes(1)
  })
})

describe('a row with no drag controls at all', () => {
  it('still takes a file', async () => {
    mount(task(), undefined)

    await send('drop', new Map(), [file('a.txt')])

    expect(service.uploads).toHaveLength(1)
  })
})
