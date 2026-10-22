// @vitest-environment jsdom
/**
 * A filter line kept under a name, from the settings row to the sidebar and back.
 *
 * The line is stored with the account settings, so these cases also pin what the merge keeps: a name
 * and a line are both required, the name is trimmed, the list is capped, and the id stays stable. Then
 * the whole gesture: save in the to-do settings, find it under the sidebar's tags, open it — the
 * address carries the line and nothing else — and delete it from there.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, mergeSettingsPatch } from '@shared/constants'
import type { AssistantSettings } from '@shared/assistant'
import type { TodoTask } from '@shared/todos/model'
import type { SavedTodoFilter } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { useSession } from '../../store/session'
import { TodoSettings } from '../settings/TodoSettings'
import { TodosApp } from './TodosApp'
import { useTodos } from './store'

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

const { settingsMock, saveSettingsMock, automationsMock, feedListMock, listMock } = vi.hoisted(() => ({
  settingsMock: vi.fn(),
  saveSettingsMock: vi.fn(),
  automationsMock: vi.fn(),
  feedListMock: vi.fn(),
  listMock: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: {
      assistant: {
        settings: settingsMock,
        saveSettings: saveSettingsMock,
        automations: automationsMock,
        createAutomation: vi.fn(),
        updateAutomation: vi.fn(),
      },
      todos: {
        feed: { list: feedListMock, create: vi.fn(), remove: vi.fn() },
        list: listMock,
        lists: async () => ({
          lists: [{ id: 'L1', name: 'Work', icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0 }],
        }),
        tags: async () => ({ tags: [] }),
        get: async () => ({ task: null, steps: [] }),
      },
    },
  }
})

let view: RenderedElement | null = null

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  })
}

function field(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`the ${label} field is not rendered`)
  return input
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonSaying(container: HTMLElement, words: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === words) ?? null
}

function savedFilters(): SavedTodoFilter[] {
  return useSession.getState().settings.todo.savedFilters ?? []
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  settingsMock.mockReset().mockResolvedValue({ settings: { timezone: 'UTC' } as AssistantSettings })
  saveSettingsMock.mockReset().mockResolvedValue({ settings: { timezone: 'UTC' } as AssistantSettings })
  automationsMock.mockReset().mockResolvedValue({ automations: [], runs: [], timezone: 'UTC' })
  feedListMock.mockReset().mockResolvedValue({ feeds: [] })
  listMock.mockReset().mockResolvedValue({
    tasks: [] as TodoTask[],
    total: 0,
    counts: EMPTY_COUNTS,
    dayEnd: Date.now() + 3_600_000,
    timezone: 'UTC',
  })
  // The real store merges a patch into the session before it goes to the server; the stub does the
  // same locally, so a row saved in one render is the row the next render reads.
  useSession.setState({
    settings: mergeSettings({}),
    updateSettings: (patch) => {
      useSession.setState((state) => ({ settings: mergeSettingsPatch(state.settings, patch) }))
    },
  })
  useTodos.setState(useTodos.getInitialState(), true)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/todo')
  vi.unstubAllGlobals()
})

describe('what the settings merge keeps', () => {
  it('keeps a named line, trims it, and drops an entry missing either half', () => {
    const merged = mergeSettings({
      todo: {
        savedFilters: [
          { id: 'filter-1', name: '  Work  ', query: '  list:Work  ' },
          { id: 'filter-noname', name: '   ', query: 'tag:x' },
          { id: 'filter-empty', name: 'Empty', query: '   ' },
          { id: 'filter-2', name: 'Due', query: 'due:2026-10-01..2026-10-31', stray: true },
        ],
      },
    })
    expect(merged.todo.savedFilters).toEqual([
      { id: 'filter-1', name: 'Work', query: 'list:Work' },
      { id: 'filter-2', name: 'Due', query: 'due:2026-10-01..2026-10-31' },
    ])
  })

  it('caps how many lines are kept, and how long each one may be', () => {
    const many = Array.from({ length: 31 }, (_unused, index) => ({
      id: `filter-${index}`,
      name: `Filter ${index}`,
      query: 'p:1',
    }))
    const merged = mergeSettings({ todo: { savedFilters: many } })
    expect(merged.todo.savedFilters).toHaveLength(30)

    const long = mergeSettings({ todo: { savedFilters: [{ id: 'filter-long', name: 'Long', query: 'x'.repeat(500) }] } })
    expect(long.todo.savedFilters?.[0]?.query).toHaveLength(200)
  })
})

describe('the saved filter, end to end', () => {
  it('is saved in the to-do settings, opened from the sidebar, and deleted there', async () => {
    // 1. Save it in the settings row.
    view = renderElement(createElement(TodoSettings))
    await settle()
    typeInto(field(view.container, t('settings.todo_saved_filter_name')), 'Urgent work')
    typeInto(field(view.container, t('settings.todo_saved_filter_query')), 'list:Work p:1')
    await settle()
    const save = buttonSaying(view.container, t('settings.todo_saved_filter_add'))
    expect(save, 'the settings row has no way to keep the line').not.toBeNull()
    await act(async () => { save!.click() })
    await settle()

    expect(savedFilters()).toEqual([
      { id: expect.stringMatching(/^filter-[a-z0-9]+$/), name: 'Urgent work', query: 'list:Work p:1' },
    ])
    expect(view.container.textContent).toContain('Urgent work')

    act(() => { view!.unmount() })
    view = null
    document.body.innerHTML = ''

    // 2. It is under the sidebar's tags, and opening it writes the line into the address.
    stubBreakpoint(true)
    window.history.replaceState(null, '', '/todo')
    view = renderElement(createElement(TodosApp))
    await settle()

    const sidebar = view.container.querySelector('nav')
    expect(sidebar, 'the wide layout drew no sidebar').not.toBeNull()
    const entry = [...sidebar!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Urgent work'))
    expect(entry, 'the saved filter never reached the sidebar').toBeTruthy()

    await act(async () => { entry!.click() })
    await settle()

    const search = new URLSearchParams(window.location.search)
    expect(search.get('q')).toBe('list:Work p:1')
    expect(search.get('view')).toBeNull()
    expect(useTodos.getState().view).toBe('board')
    expect(useTodos.getState().query).toBe('list:Work p:1')
    const asked = listMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(asked.list).toBe('L1')
    expect(asked.priority).toBe('low')
    expect(asked.q).toBeUndefined()

    // 3. The × beside it removes the saved filter, not the task rows behind it.
    const remove = sidebar!.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('todo.saved_filter.delete', { name: 'Urgent work' })}"]`)
    expect(remove, 'the sidebar entry cannot be deleted').not.toBeNull()
    await act(async () => { remove!.click() })
    await settle()

    expect(savedFilters()).toEqual([])
    expect(view.container.textContent).not.toContain('Urgent work')
    expect(window.location.search).toContain('q=')
  })
})

describe('a stored settings object that predates the field', () => {
  it('reads as no saved filters rather than a crash', () => {
    const before = { ...DEFAULT_SETTINGS, todo: { defaultRemind: null } }
    useSession.setState({ settings: before })
    expect(useSession.getState().settings.todo.savedFilters ?? []).toEqual([])
  })
})
