// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimeEntrySource, TodoTimeEntry } from '@shared/todos/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { ConfirmHost } from '../../components/overlay'
import { durationLabel } from './stats-charts'

const mocks = vi.hoisted(() => ({
  time: vi.fn(),
  addTime: vi.fn(),
  removeTime: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      todos: { ...actual.api.todos, ...mocks },
    },
  }
})

import { TaskTimeSection } from './TaskTimeSection'

const TASK = 'task-1'
let view: RenderedElement | null = null

function entry(id: string, startAt: string, endAt: string | null, source: TimeEntrySource): TodoTimeEntry {
  const start = Date.parse(startAt)
  const end = endAt === null ? null : Date.parse(endAt)
  return {
    id,
    taskId: TASK,
    startAt: start,
    endAt: end,
    day: startAt.slice(0, 10),
    source,
    createdAt: start,
    updatedAt: end ?? start,
  }
}

beforeEach(async () => {
  await initI18n()
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  mocks.time.mockReset().mockResolvedValue({ entries: [] })
  mocks.addTime.mockReset().mockResolvedValue({ entries: [] })
  mocks.removeTime.mockReset().mockResolvedValue({ deleted: true })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

function mount(): void {
  view = renderElement(<>
    <TaskTimeSection taskId={TASK} timezone="UTC" />
    <ConfirmHost />
  </>)
}

function section(): HTMLElement {
  const found = document.querySelector<HTMLElement>(`section[aria-label="${t('project.time.title')}"]`)
  if (!found) throw new Error('the task time section did not render')
  return found
}

function button(label: string, root: HTMLElement = section()): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.getAttribute('aria-label') === label || (node.textContent ?? '').trim() === label)
  if (!found) throw new Error(`missing button ${label}`)
  return found
}

function dateInput(label: string): HTMLInputElement {
  const found = section().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!found) throw new Error(`missing date input ${label}`)
  return found
}

function typeDate(label: string, value: string): void {
  const input = dateInput(label)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function deleteButton(): HTMLButtonElement {
  const found = [...section().querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => (node.getAttribute('aria-label') ?? '').startsWith(t('common.delete')))
  if (!found) throw new Error('the entry has no delete button')
  return found
}

describe('TaskTimeSection', () => {
  it('shows loading, then every returned cross-midnight entry with its own times, duration, and source', async () => {
    let resolve!: (answer: { entries: TodoTimeEntry[] }) => void
    mocks.time.mockReturnValue(new Promise((done) => { resolve = done }))
    const first = entry('e1', '2026-10-20T23:30:00Z', '2026-10-21T00:30:00Z', 'manual')
    const second = entry('e2', '2026-10-21T00:30:00Z', '2026-10-21T01:15:00Z', 'timer')
    mount()

    expect(section().textContent).toContain(t('common.loading'))
    await act(async () => {
      resolve({ entries: [first, second] })
      await Promise.resolve()
    })

    const rows = [...section().querySelectorAll('li')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain(t('settings.manual'))
    expect(rows[0]!.textContent).toContain(durationLabel(first.endAt! - first.startAt))
    expect(rows[0]!.querySelectorAll('time')).toHaveLength(2)
    expect(rows[1]!.textContent).toContain(t('todo.time.source_timer'))
    expect(rows[1]!.textContent).toContain(durationLabel(second.endAt! - second.startAt))
    expect(rows[1]!.querySelector('time')?.getAttribute('datetime')).toBe(new Date(second.startAt).toISOString())
  })

  it('distinguishes an empty ledger from a read that has not finished', async () => {
    mount()
    await flush()
    expect(section().textContent).toContain(t('project.time.empty'))
    expect(section().textContent).not.toContain(t('common.loading'))
  })

  it('keeps the failure visible and retries the task-level read', async () => {
    mocks.time.mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce({ entries: [] })
    mount()
    await flush()

    expect(section().textContent).toContain(t('common.action_failed'))
    expect(section().textContent).toContain('read failed')
    await act(async () => {
      button(t('common.retry')).click()
      await Promise.resolve()
    })
    await flush()

    expect(mocks.time).toHaveBeenCalledTimes(2)
    expect(mocks.time).toHaveBeenLastCalledWith(TASK)
    expect(section().textContent).toContain(t('project.time.empty'))
  })

  it('files a valid manual span and renders each entry the server returned', async () => {
    const returned = [
      entry('e1', '2026-10-20T23:30:00Z', '2026-10-21T00:00:00Z', 'manual'),
      entry('e2', '2026-10-21T00:00:00Z', '2026-10-21T00:30:00Z', 'manual'),
    ]
    mocks.addTime.mockResolvedValue({ entries: returned })
    mount()
    await flush()

    typeDate(t('todo.task.start_label'), '2026-10-20T23:30')
    typeDate(t('todo.time.end_label'), '2026-10-21T00:30')
    await act(async () => {
      button(t('settings.manual')).click()
      await Promise.resolve()
    })
    await flush()

    expect(mocks.addTime).toHaveBeenCalledWith(TASK, {
      startAt: Date.parse('2026-10-20T23:30:00Z'),
      endAt: Date.parse('2026-10-21T00:30:00Z'),
    })
    expect(section().querySelectorAll('li')).toHaveLength(2)
    expect(dateInput(t('todo.task.start_label')).value).toBe('')
    expect(dateInput(t('todo.time.end_label')).value).toBe('')
  })

  it('refuses an end at or before the start without writing', async () => {
    mount()
    await flush()
    typeDate(t('todo.task.start_label'), '2026-10-20T10:00')
    typeDate(t('todo.time.end_label'), '2026-10-20T09:00')

    expect(dateInput(t('todo.time.end_label')).getAttribute('aria-invalid')).toBe('true')
    expect(section().textContent).toContain(`${t('todo.time.end_label')}: ${t('api.error.bad_request')}`)
    expect(button(t('settings.manual')).disabled).toBe(true)
    expect(mocks.addTime).not.toHaveBeenCalled()
  })

  it('refuses a single manual entry longer than four hours', async () => {
    mount()
    await flush()
    typeDate(t('todo.task.start_label'), '2026-10-20T08:00')
    typeDate(t('todo.time.end_label'), '2026-10-20T12:01')

    expect(section().textContent).toContain(t('todo.time.logged_refused'))
    expect(button(t('settings.manual')).disabled).toBe(true)
    expect(mocks.addTime).not.toHaveBeenCalled()
  })

  it('says why manual entry is unavailable offline and does not queue it', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    mount()
    await flush()
    typeDate(t('todo.task.start_label'), '2026-10-20T08:00')
    typeDate(t('todo.time.end_label'), '2026-10-20T09:00')

    expect(section().textContent).toContain(t('todo.time.logged_offline'))
    expect(button(t('settings.manual')).disabled).toBe(true)
    expect(mocks.addTime).not.toHaveBeenCalled()
  })

  it('asks through the overlay before deleting, and cancel leaves the entry alone', async () => {
    mocks.time.mockResolvedValue({ entries: [entry('e1', '2026-10-20T08:00:00Z', '2026-10-20T09:00:00Z', 'manual')] })
    mount()
    await flush()

    act(() => { deleteButton().click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain(t('common.delete'))
    expect(mocks.removeTime).not.toHaveBeenCalled()

    act(() => { button(t('common.cancel'), dialog!).click() })
    await flush()
    expect(mocks.removeTime).not.toHaveBeenCalled()
    expect(section().querySelectorAll('li')).toHaveLength(1)

    act(() => { deleteButton().click() })
    const confirmation = document.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => {
      button(t('common.delete'), confirmation).click()
      await Promise.resolve()
    })
    await flush()

    expect(mocks.removeTime).toHaveBeenCalledWith('e1')
    expect(section().querySelectorAll('li')).toHaveLength(0)
    expect(section().textContent).toContain(t('project.time.empty'))
  })
})
