// @vitest-environment jsdom
/**
 * The timeline's date arithmetic and the edits its bars offer.
 *
 * The cases pin the facts a painted grid can get wrong while still looking plausible: an estimate fills
 * only a missing end, a missing estimate stays visibly unknown, and both pointer and keyboard edits go
 * through the store's guarded task writer rather than a second timeline-only API path.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'
import { TimelineView, shiftTimelineRange, timelineBarFor, timelineRangeFor } from './TimelineView'
import { readsOwnRows, useTodos } from './store'
import { surfacesFor, surfacesForPhoneMore } from './views/nav'

const NOW = Date.parse('2026-10-21T09:00:00Z')
const service = vi.hoisted(() => ({
  tasks: [] as TodoTask[],
  total: 0,
  reads: 0,
  fail: false,
  wait: null as null | (() => void),
  updates: [] as { id: string; patch: Record<string, unknown>; rev: number | undefined }[],
}))

const COUNTS: TaskCounts = {
  inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {},
}

vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {
    constructor(readonly status = 500) { super('request failed') }
  },
  CLIENT_ID: 'timeline-test',
  api: {
    todos: {
      list: async () => {
        service.reads += 1
        if (service.wait) await new Promise<void>((resolve) => { service.wait = resolve })
        if (service.fail) throw new Error('timeline read failed')
        return { tasks: service.tasks, total: service.total, counts: COUNTS, dayEnd: NOW + 86_400_000, timezone: 'UTC' }
      },
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      counts: async () => ({ counts: COUNTS, dayEnd: NOW + 86_400_000, timezone: 'UTC' }),
      update: async (id: string, patch: Record<string, unknown>, rev?: number) => {
        service.updates.push({ id, patch, rev })
        const current = service.tasks.find((task) => task.id === id)
        if (!current) throw new Error('missing task')
        const next = { ...current, ...patch, rev: (current.rev ?? 0) + 1 } as unknown as Record<string, unknown>
        if (typeof next.startAt === 'string') next.startAt = Date.parse(`${next.startAt.length === 10 ? `${next.startAt}T00:00` : next.startAt}:00Z`)
        if (typeof next.dueAt === 'string') next.dueAt = Date.parse(`${next.dueAt.length === 10 ? `${next.dueAt}T23:59` : next.dueAt}:00Z`)
        const updated = next as unknown as TodoTask
        service.tasks = service.tasks.map((task) => task.id === id ? updated : task)
        return { task: updated }
      },
    },
  },
}))

function task(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: id,
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
    rev: 1,
    timeEstimateMs: null,
    ...extra,
  } as TodoTask
}

const at = (day: string, time = '00:00'): number => Date.parse(`${day}T${time}:00Z`)
const DAY = 86_400_000

function fixtures(): TodoTask[] {
  return [
    task('span', { startAt: at('2026-10-20', '09:00'), dueAt: at('2026-10-22', '17:00'), timeEstimateMs: 2 * DAY }),
    task('estimated', { dueAt: at('2026-10-23', '10:00'), timeEstimateMs: DAY }),
    task('placeholder', { dueAt: at('2026-10-24', '10:00') }),
    task('start-only', { startAt: at('2026-10-25', '09:00'), timeEstimateMs: 2 * DAY }),
    task('unscheduled'),
  ]
}

const original = useTodos.getState()
let view: RenderedElement | null = null

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

async function mount(): Promise<HTMLElement> {
  view = renderElement(createElement(TimelineView))
  await flush()
  return view.container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)
  if (!found) throw new Error(`missing button: ${label}`)
  return found
}

async function press(node: HTMLElement): Promise<void> {
  await act(async () => { node.click() })
  await flush()
}

async function key(node: HTMLElement, value: string, shiftKey = false): Promise<void> {
  await act(async () => { node.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })) })
  await flush()
}

async function pointer(node: HTMLElement, type: string, clientX: number): Promise<void> {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, { clientX: { value: clientX }, button: { value: 0 }, pointerId: { value: 1 } })
  await act(async () => { node.dispatchEvent(event) })
  await flush()
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.tasks = fixtures()
  service.total = service.tasks.length
  service.reads = 0
  service.fail = false
  service.wait = null
  service.updates = []
  useTodos.setState(original, true)
  useTodos.setState({
    view: 'timeline',
    tasks: service.tasks,
    completed: [],
    lists: [],
    tags: [],
    timezone: 'UTC',
    timelineFrom: '2026-10-19',
    timelineTo: '2026-10-26',
    timelineScale: 'week',
    editorOpen: false,
    selectedIds: new Set<string>(),
    status: 'ready',
    error: null,
  })
  window.history.replaceState(null, '', '/todo?view=timeline&from=2026-10-19&to=2026-10-26&timelineScale=week')
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  window.history.replaceState(null, '', '/todo')
})

describe('timeline date arithmetic', () => {
  it('uses the estimate only to fill a missing end', () => {
    expect(timelineRangeFor('2026-10-21', 'week')).toEqual({ from: '2026-10-19', to: '2026-10-26' })
    expect(timelineRangeFor('2026-02-10', 'month')).toEqual({ from: '2026-02-01', to: '2026-03-01' })
    expect(shiftTimelineRange({ from: '2026-12-01', to: '2027-01-01' }, 'month', 1))
      .toEqual({ from: '2027-01-01', to: '2027-02-01' })

    expect(timelineBarFor(task('due', { dueAt: at('2026-10-23'), timeEstimateMs: 2 * DAY }), 'UTC'))
      .toMatchObject({ start: '2026-10-21', end: '2026-10-23', startExplicit: false, endExplicit: true, estimated: true })
    expect(timelineBarFor(task('start', { startAt: at('2026-10-20'), timeEstimateMs: 2 * DAY }), 'UTC'))
      .toMatchObject({ start: '2026-10-20', end: '2026-10-21', startExplicit: true, endExplicit: false, estimated: true })
    expect(timelineBarFor(task('none', { dueAt: at('2026-10-23') }), 'UTC'))
      .toMatchObject({ start: '2026-10-23', end: '2026-10-23', estimated: false })
    expect(timelineBarFor(task('undated'), 'UTC')).toBeNull()
  })

  it('is a surface with its own rows and a reachable navigation entry', () => {
    expect(readsOwnRows('timeline')).toBe(true)
    expect(surfacesFor('sidebar', { finishDayEnabled: true }).map((surface) => surface.view)).toContain('timeline')
    expect(surfacesForPhoneMore({ finishDayEnabled: true }).map((surface) => surface.view)).toContain('timeline')
  })
})

describe('the timeline screen', () => {
  it('draws start/due/estimate bars, a no-estimate placeholder, and unscheduled work', async () => {
    const container = await mount()
    expect(container.querySelector('[data-timeline-bar-wrap="span"]')).toMatchObject({
      dataset: { timelineStart: '2026-10-20', timelineEnd: '2026-10-22' },
    })
    expect(container.querySelector('[data-timeline-bar-wrap="estimated"]')).toMatchObject({
      dataset: { timelineStart: '2026-10-22', timelineEnd: '2026-10-23' },
    })
    expect(container.querySelector('[data-timeline-bar-wrap="start-only"]')).toMatchObject({
      dataset: { timelineStart: '2026-10-25', timelineEnd: '2026-10-26' },
    })
    const placeholder = container.querySelector('[data-timeline-bar="placeholder"]')
    expect(placeholder?.hasAttribute('data-timeline-placeholder')).toBe(true)
    expect(placeholder?.textContent).toContain(t('todo.time.none'))
    expect(container.textContent).toContain(t('project.view.unscheduled_count', { count: 1 }))
    expect(container.querySelectorAll('[data-timeline-day]')).toHaveLength(7)
  })

  it('moves a due date with the keyboard through updateTask', async () => {
    const container = await mount()
    const handle = container.querySelector<HTMLButtonElement>('[data-timeline-row="span"] [data-timeline-handle="end"]')!
    handle.focus()
    expect(document.activeElement).toBe(handle)
    await key(handle, 'ArrowRight')
    expect(service.updates.at(-1)).toMatchObject({ id: 'span', patch: { dueAt: '2026-10-23T17:00' }, rev: 1 })
    expect(container.querySelector('[data-timeline-bar-wrap="span"]')?.getAttribute('data-timeline-end')).toBe('2026-10-23')
  })

  it('moves a start date with the keyboard and clamps it at the due date', async () => {
    const container = await mount()
    const start = container.querySelector<HTMLButtonElement>('[data-timeline-row="span"] [data-timeline-handle="start"]')!
    await key(start, 'ArrowLeft')
    expect(service.updates.at(-1)).toMatchObject({ id: 'span', patch: { startAt: '2026-10-19T09:00' } })
    await key(start, 'ArrowRight', true)
    // The start cannot cross the due date; the clamp is part of the edit rather than a backwards bar.
    expect(service.updates.at(-1)).toMatchObject({ id: 'span', patch: { startAt: '2026-10-22T09:00' } })
  })

  it('drags either end and commits only on release', async () => {
    const container = await mount()
    const start = container.querySelector<HTMLButtonElement>('[data-timeline-row="span"] [data-timeline-handle="start"]')!
    await pointer(start, 'pointerdown', 100)
    await pointer(start, 'pointermove', 140)
    expect(service.updates).toHaveLength(0)
    expect(container.querySelector('[data-timeline-bar-wrap="span"]')?.getAttribute('data-timeline-start')).toBe('2026-10-21')
    await pointer(start, 'pointerup', 140)
    expect(service.updates.at(-1)).toMatchObject({ id: 'span', patch: { startAt: '2026-10-21T09:00' } })

    const end = container.querySelector<HTMLButtonElement>('[data-timeline-row="span"] [data-timeline-handle="end"]')!
    await pointer(end, 'pointerdown', 200)
    await pointer(end, 'pointermove', 244)
    await pointer(end, 'pointerup', 244)
    expect(service.updates.at(-1)).toMatchObject({ id: 'span', patch: { dueAt: '2026-10-23T17:00' } })
  })

  it('switches range and scale in the URL', async () => {
    const container = await mount()
    await press(button(container, t('todo.calendar.next')))
    expect(useTodos.getState()).toMatchObject({ timelineFrom: '2026-10-26', timelineTo: '2026-11-02', timelineScale: 'week' })
    expect(window.location.search).toContain('from=2026-10-26')
    expect(window.location.search).toContain('to=2026-11-02')

    await press(button(container, t('preview.kanban_calendar_month')))
    expect(useTodos.getState()).toMatchObject({ timelineFrom: '2026-10-01', timelineTo: '2026-11-01', timelineScale: 'month' })
    expect(window.location.search).toContain('timelineScale=month')
    expect(container.querySelectorAll('[data-timeline-day]')).toHaveLength(31)
  })

  it('shows loading, empty, and failure as different answers', async () => {
    service.tasks = []
    service.total = 0
    service.wait = () => {}
    const container = await mount()
    expect(container.querySelector('[role="status"]')?.textContent).toContain(t('common.loading'))
    await act(async () => { service.wait?.() })
    await flush()
    expect(container.textContent).toContain(t('todo.empty.plan'))

    act(() => { view?.unmount() })
    view = null
    service.fail = true
    service.wait = null
    const failed = await mount()
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain('timeline read failed')
    expect(failed.textContent).not.toContain(t('todo.empty.plan'))
    service.fail = false
    const reads = service.reads
    await press(button(failed, t('common.retry')))
    expect(service.reads).toBe(reads + 1)
    expect(failed.textContent).toContain(t('todo.empty.plan'))
  })
})
