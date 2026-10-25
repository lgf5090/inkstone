import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantSettings, Automation } from '@shared/assistant'
import { computeNextRun } from '@shared/assistant-schedule'
import {
  DEFAULT_SETTINGS,
  DEFAULT_TODO_FOCUS,
  DEFAULT_TODO_WORKDAY,
  mergeSettings,
  mergeSettingsPatch,
} from '@shared/constants'
import { REMIND_OFFSETS } from '@shared/todos/model'
import { initI18n, t } from '../../lib/i18n'
import { ApiError } from '../../lib/api'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useSession } from '../../store/session'
import { TodoSettings } from './TodoSettings'

/**
 * The daily-plan row.
 *
 * It is a view onto the assistant's own `task_digest` automation, so what these cases pin is the wire,
 * not a second scheduler: turning the switch on creates one daily routine (or resumes the one that is
 * already there), turning it off pauses it, and a new time is written as a `daily` schedule. The last
 * case is the one a settings panel most easily gets wrong: a failed read must not leave an enabled-looking
 * switch that would create a duplicate routine on the next press.
 */

const {
  settingsMock,
  saveSettingsMock,
  automationsMock,
  createMock,
  updateMock,
  feedListMock,
  importCsvMock,
  updateSettingsMock,
} = vi.hoisted(() => ({
  settingsMock: vi.fn(),
  saveSettingsMock: vi.fn(),
  automationsMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  feedListMock: vi.fn(),
  importCsvMock: vi.fn(),
  updateSettingsMock: vi.fn(),
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
        createAutomation: createMock,
        updateAutomation: updateMock,
      },
      // The calendar block loads with the page; a case about the plan row must not trip over it.
      todos: { feed: { list: feedListMock, create: vi.fn(), remove: vi.fn() }, importCsv: importCsvMock },
    },
  }
})

const TIMEZONE = 'Asia/Shanghai'
const initialSession = useSession.getState()
let view: RenderedElement | null = null

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Daily plan',
    kind: 'task_digest',
    message: '',
    schedule: { type: 'daily', time: '09:00' },
    enabled: true,
    status: 'scheduled',
    nextRun: Date.now() + 3_600_000,
    lastRun: null,
    lastResult: null,
    lastError: null,
    runCount: 0,
    targetFolderId: null,
    targetNoteId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

/** Let every promise the row started settle, so the assertions read the finished screen. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve()
  })
}

async function render(): Promise<void> {
  view = renderElement(createElement(TodoSettings))
  await settle()
}

function switchControl(): HTMLButtonElement {
  const node = view?.container.querySelector<HTMLButtonElement>('[role="switch"]')
  if (!node) throw new Error('the daily-plan switch is not rendered')
  return node
}

function timeInput(): HTMLInputElement {
  const node = view?.container.querySelector<HTMLInputElement>('input[type="time"]')
  if (!node) throw new Error('the daily-plan time is not rendered')
  return node
}

function goalField(label: string): HTMLInputElement {
  const node = view?.container.querySelector<HTMLInputElement>(`input[type="number"][aria-label="${label}"]`)
  if (!node) throw new Error(`the ${label} field is not rendered`)
  return node
}

/** Hand a value to the field the way typing would, and let the row's state land. */
async function enterGoal(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(goalField(label), value)
    goalField(label).dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

async function toggle(): Promise<void> {
  await act(async () => {
    switchControl().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

async function chooseTime(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(timeInput(), value)
    timeInput().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  settingsMock.mockReset().mockResolvedValue({ settings: { timezone: TIMEZONE } as AssistantSettings })
  saveSettingsMock.mockReset().mockResolvedValue({ settings: { timezone: TIMEZONE } as AssistantSettings })
  automationsMock.mockReset().mockResolvedValue({ automations: [], runs: [], timezone: TIMEZONE })
  createMock.mockReset().mockImplementation(async (body: Partial<Automation>) => ({ automation: automation(body) }))
  updateMock.mockReset().mockImplementation(async (id: string, body: Partial<Automation>) => ({
    automation: automation({ id, ...body }),
  }))
  feedListMock.mockReset().mockResolvedValue({ feeds: [] })
  updateSettingsMock.mockReset()
  useSession.setState({
    settings: DEFAULT_SETTINGS,
    updateSettings: updateSettingsMock,
  })
})

afterEach(() => {
  view?.unmount()
  view = null
  useSession.setState(initialSession)
})

describe('the daily-plan row', () => {
  it('creates one daily routine when the switch is turned on, and pauses it when turned off', async () => {
    await render()
    expect(switchControl().getAttribute('aria-checked')).toBe('false')

    await toggle()
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock).toHaveBeenCalledWith({
      name: t('settings.todo_digest'),
      kind: 'task_digest',
      message: '',
      schedule: { type: 'daily', time: '09:00' },
      enabled: true,
    })
    expect(switchControl().getAttribute('aria-checked')).toBe('true')

    await toggle()
    expect(updateMock).toHaveBeenCalledWith('auto-1', { enabled: false })
    expect(switchControl().getAttribute('aria-checked')).toBe('false')
  })

  it('resumes the routine that is already there instead of creating a second one', async () => {
    automationsMock.mockResolvedValue({
      automations: [automation({ enabled: false, status: 'paused', nextRun: null })],
      runs: [],
      timezone: TIMEZONE,
    })
    await render()
    expect(switchControl().getAttribute('aria-checked')).toBe('false')

    await toggle()
    expect(updateMock).toHaveBeenCalledWith('auto-1', { enabled: true })
    expect(createMock).not.toHaveBeenCalled()
    expect(switchControl().getAttribute('aria-checked')).toBe('true')
  })

  it('writes a new time as a daily schedule the account zone can arm at 21:30', async () => {
    automationsMock.mockResolvedValue({ automations: [automation()], runs: [], timezone: TIMEZONE })
    await render()
    expect(timeInput().value).toBe('09:00')

    await chooseTime('21:30')
    expect(updateMock).toHaveBeenCalledWith('auto-1', { schedule: { type: 'daily', time: '21:30' } })
    expect(timeInput().value).toBe('21:30')

    // The schedule the row wrote is the one the sweep reads: 21:30 in Shanghai is 13:30 UTC.
    const next = computeNextRun({ type: 'daily', time: '21:30' }, TIMEZONE, new Date('2026-10-20T00:00:00.000Z'))
    expect(next?.toISOString()).toBe('2026-10-20T13:30:00.000Z')
  })

  it('says why it cannot read or write, and keeps the switch from creating a duplicate', async () => {
    automationsMock.mockRejectedValue(new ApiError(403, 'forbidden', 'The to-do app is not enabled for this account.'))
    await render()

    expect(view?.container.textContent).toContain(t('api.error.forbidden'))
    expect(switchControl().disabled).toBe(true)
    expect(timeInput().disabled).toBe(true)
    expect(createMock).not.toHaveBeenCalled()

    // The retry reads again; once it answers, the row is usable rather than stuck in its refusal.
    automationsMock.mockResolvedValue({ automations: [], runs: [], timezone: TIMEZONE })
    const retry = [...(view?.container.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find((button) => button.textContent === t('common.retry'))
    expect(retry).toBeTruthy()
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await settle()
    expect(switchControl().disabled).toBe(false)
    expect(view?.container.textContent).not.toContain(t('api.error.forbidden'))
  })

  it('reports a refused create and leaves the switch off', async () => {
    createMock.mockRejectedValue(new ApiError(403, 'forbidden', 'The assistant is not available for this account.'))
    await render()

    await toggle()
    expect(view?.container.textContent).toContain(t('api.error.forbidden'))
    expect(switchControl().getAttribute('aria-checked')).toBe('false')
  })

  it('hands the chosen file and the duplicate rule to the import endpoint', async () => {
    importCsvMock.mockResolvedValue({ created: 2, updated: 1, skipped: 3, missingLists: 0, errors: [] })
    await render()

    const input = view?.container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input, 'the import row never drew a file input').toBeTruthy()
    const file = new File(['title\nBuy milk'], 'tasks.csv', { type: 'text/csv' })
    // jsdom has no picker, so the selection is handed to the field the way the browser would.
    Object.defineProperty(input!, 'files', { value: [file], configurable: true })
    await act(async () => { input!.dispatchEvent(new Event('change', { bubbles: true })) })

    const button = [...(view?.container.querySelectorAll('button') ?? [])]
      .find((node) => node.textContent?.trim() === t('settings.todo_import_action'))
    expect(button, 'the row has no way to start the import').toBeTruthy()
    await act(async () => { button!.click() })
    await settle()

    expect(importCsvMock).toHaveBeenCalledWith(file, 'skip')
    expect(view?.container.textContent).toContain(t('settings.todo_import_result', { created: 2, updated: 1, skipped: 3 }))
  })
})

describe('the stored goals', () => {
  it('keeps a goal inside the range and reads zero, a negative number and an empty field as none', () => {
    expect(mergeSettings({ todo: { dailyGoal: 3, weeklyGoal: 12 } }).todo)
      .toMatchObject({ dailyGoal: 3, weeklyGoal: 12 })
    expect(mergeSettings({ todo: { dailyGoal: 0, weeklyGoal: -4 } }).todo)
      .toMatchObject({ dailyGoal: null, weeklyGoal: null })
    expect(mergeSettings({ todo: { dailyGoal: null, weeklyGoal: undefined } }).todo)
      .toMatchObject({ dailyGoal: null, weeklyGoal: null })
    // A field the reader left empty arrives as an empty string, not as a number.
    expect(mergeSettings({ todo: { dailyGoal: '', weeklyGoal: '8' } }).todo)
      .toMatchObject({ dailyGoal: null, weeklyGoal: null })
  })

  it('caps a goal at the field ceiling and rounds a fraction to a whole task', () => {
    expect(mergeSettings({ todo: { dailyGoal: 1200, weeklyGoal: 999.6 } }).todo)
      .toMatchObject({ dailyGoal: 999, weeklyGoal: 999 })
    expect(mergeSettings({ todo: { dailyGoal: 2.6 } }).todo.dailyGoal).toBe(3)
  })

  it('merges a patch into the stored goals and lets a later patch turn one off', () => {
    const stored = mergeSettings({ todo: { dailyGoal: 4, weeklyGoal: 20 } })
    const patched = mergeSettingsPatch(stored, { todo: { dailyGoal: 6 } })
    expect(patched.todo).toMatchObject({ dailyGoal: 6, weeklyGoal: 20 })
    const off = mergeSettingsPatch(patched, { todo: { dailyGoal: 0 } })
    expect(off.todo).toMatchObject({ dailyGoal: null, weeklyGoal: 20 })
  })
})

describe('the goal rows', () => {
  it('saves each whole count through the account settings and turns a goal off when its field is emptied', async () => {
    await render()
    expect([goalField(t('todo.goal.daily')).min, goalField(t('todo.goal.daily')).max]).toEqual(['0', '999'])
    expect([goalField(t('todo.goal.weekly')).min, goalField(t('todo.goal.weekly')).max]).toEqual(['0', '999'])

    await enterGoal(t('todo.goal.daily'), '3')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({ todo: { dailyGoal: 3 } })
    await enterGoal(t('todo.goal.weekly'), '12')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({ todo: { weeklyGoal: 12 } })

    await enterGoal(t('todo.goal.daily'), '')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({ todo: { dailyGoal: null } })
  })

  it('holds a typed count to the ceiling the settings merge applies', async () => {
    await render()
    await enterGoal(t('todo.goal.weekly'), '1200')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({ todo: { weeklyGoal: 999 } })
    await enterGoal(t('todo.goal.daily'), '-3')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({ todo: { dailyGoal: null } })
  })
})

/**
 * The focus and workday subgroups.
 *
 * The reason these cases exist at all is a failure mode that produces no error anywhere: the settings
 * merge lists the keys it rebuilds, and a subgroup missing from that list reads back as its default no
 * matter what the panel wrote. So the first case below is the one that matters — it asks the merge to
 * keep a value that differs from the default, which is exactly what a silent drop turns back into the
 * default. The rest pin the edges every stored key is documented to have.
 */
describe('the stored focus subgroup', () => {
  it('keeps a focus patch through the merge instead of reading back the defaults', () => {
    const patched = mergeSettingsPatch(DEFAULT_SETTINGS, {
      todo: { focus: { ...DEFAULT_TODO_FOCUS, strategy: 'flowtime', defaultMinutes: 50 } },
    })
    expect(patched.todo.focus?.strategy).toBe('flowtime')
    expect(patched.todo.focus?.defaultMinutes).toBe(50)
    expect(patched.todo.focus?.enabled).toBe(DEFAULT_TODO_FOCUS.enabled)
  })

  it('keeps every key of the subgroup, including the nested ones', () => {
    const wanted = {
      enabled: false,
      strategy: 'pomodoro',
      defaultMinutes: 12,
      pomodoro: { work: 40, short: 8, long: 20, every: 6 },
      flowtime: { breakEnabled: true, breakPercentage: 65 },
      pauseTrackingDuringBreak: false,
      sound: 'chime',
    }
    expect(mergeSettings({ todo: { focus: wanted } }).todo.focus).toEqual(wanted)
  })

  it('fills the keys a half-written subgroup left out', () => {
    const merged = mergeSettings({ todo: { focus: { pomodoro: { work: 40 } } } }).todo.focus
    expect(merged?.pomodoro).toEqual({ ...DEFAULT_TODO_FOCUS.pomodoro, work: 40 })
    expect(merged?.flowtime).toEqual(DEFAULT_TODO_FOCUS.flowtime)
    expect(merged?.strategy).toBe(DEFAULT_TODO_FOCUS.strategy)
  })

  it('holds each minute count to the field edges and rounds a fraction', () => {
    const merged = mergeSettings({
      todo: {
        focus: {
          defaultMinutes: 9999,
          pomodoro: { work: 0, short: -5, long: 12.6, every: 99 },
        },
      },
    }).todo.focus
    expect(merged?.defaultMinutes).toBe(240)
    expect(merged?.pomodoro).toEqual({ work: 1, short: 1, long: 13, every: 12 })
  })

  it('reads an impossible number as the default rather than storing it', () => {
    for (const bad of ['25', null, undefined, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const merged = mergeSettings({ todo: { focus: { defaultMinutes: bad } } }).todo.focus
      expect(merged?.defaultMinutes, String(bad)).toBe(DEFAULT_TODO_FOCUS.defaultMinutes)
    }
    for (const bad of ['5', null, [], Number.NaN]) {
      const merged = mergeSettings({ todo: { focus: { flowtime: { breakPercentage: bad } } } }).todo.focus
      expect(merged?.flowtime.breakPercentage, String(bad)).toBe(DEFAULT_TODO_FOCUS.flowtime.breakPercentage)
    }
    const everyBad = mergeSettings({ todo: { focus: { pomodoro: { every: '4' } } } }).todo.focus
    expect(everyBad?.pomodoro.every).toBe(DEFAULT_TODO_FOCUS.pomodoro.every)
  })

  it('keeps a stored sound setting the panel does not offer yet', () => {
    for (const sound of ['off', 'tick', 'chime', 'both'] as const) {
      expect(mergeSettings({ todo: { focus: { sound } } }).todo.focus?.sound).toBe(sound)
    }
    // A value the synthesiser has no cue for is dropped to silence rather than stored and ignored.
    expect(mergeSettings({ todo: { focus: { sound: 'bagpipes' } } }).todo.focus?.sound).toBe('off')
  })

  it('reads an unknown strategy and a non-boolean switch as their defaults', () => {
    const merged = mergeSettings({
      todo: { focus: { strategy: 'marathon', enabled: 'yes', pauseTrackingDuringBreak: 1, flowtime: { breakEnabled: 'no' } } },
    }).todo.focus
    expect(merged?.strategy).toBe(DEFAULT_TODO_FOCUS.strategy)
    expect(merged?.enabled).toBe(DEFAULT_TODO_FOCUS.enabled)
    expect(merged?.pauseTrackingDuringBreak).toBe(DEFAULT_TODO_FOCUS.pauseTrackingDuringBreak)
    expect(merged?.flowtime.breakEnabled).toBe(DEFAULT_TODO_FOCUS.flowtime.breakEnabled)
  })

  it('turns a whole subgroup that arrived as junk back into the defaults', () => {
    for (const junk of ['focus', 7, [], null]) {
      expect(mergeSettings({ todo: { focus: junk } }).todo.focus).toEqual(DEFAULT_TODO_FOCUS)
    }
  })

  // The merge decides whether a saved default is a tier at all, and a tier it has never heard of folds to
  // null — the reader picks "30 minutes before", the panel keeps showing it, and nothing is applied. The
  // validator reads `REMIND_OFFSETS` now, so walking the list here is what keeps it honest as the list
  // grows.
  it('keeps every reminder tier the app offers as a stored default', () => {
    for (const tier of REMIND_OFFSETS) {
      if (tier === 'none') continue
      expect(mergeSettings({ todo: { defaultRemind: tier } }).todo.defaultRemind).toBe(tier)
    }
    expect(mergeSettings({ todo: { defaultRemind: 'none' } }).todo.defaultRemind).toBeNull()
    expect(mergeSettings({ todo: { defaultRemind: '2h' } }).todo.defaultRemind).toBeNull()
  })

  it('leaves the rest of the to-do settings alone when only a focus key changes', () => {
    const stored = mergeSettings({ todo: { dailyGoal: 4, defaultRemind: '15m' } })
    const patched = mergeSettingsPatch(stored, { todo: { focus: { ...DEFAULT_TODO_FOCUS, defaultMinutes: 8 } } })
    expect(patched.todo.dailyGoal).toBe(4)
    expect(patched.todo.defaultRemind).toBe('15m')
    expect(patched.todo.focus?.defaultMinutes).toBe(8)
    expect(patched.appearance).toEqual(stored.appearance)
  })
})

describe('the stored workday subgroup', () => {
  it('keeps a workday patch through the merge instead of reading back the defaults', () => {
    const patched = mergeSettingsPatch(DEFAULT_SETTINGS, {
      todo: { workday: { ...DEFAULT_TODO_WORKDAY, dailyEstimateMinutes: 300, finishDayEnabled: false } },
    })
    expect(patched.todo.workday?.dailyEstimateMinutes).toBe(300)
    expect(patched.todo.workday?.finishDayEnabled).toBe(false)
  })

  it('reads zero, a negative number, an empty field and a string as no estimate', () => {
    for (const off of [0, -30, null, undefined, '', '240', Number.NaN]) {
      expect(mergeSettings({ todo: { workday: { dailyEstimateMinutes: off } } }).todo.workday
        ?.dailyEstimateMinutes, String(off)).toBeNull()
    }
  })

  it('caps the estimate at the longest working day it will plan and rounds a fraction', () => {
    expect(mergeSettings({ todo: { workday: { dailyEstimateMinutes: 5000 } } }).todo.workday
      ?.dailyEstimateMinutes).toBe(960)
    expect(mergeSettings({ todo: { workday: { dailyEstimateMinutes: 480.4 } } }).todo.workday
      ?.dailyEstimateMinutes).toBe(480)
    expect(mergeSettings({ todo: { workday: { dailyEstimateMinutes: 90.5 } } }).todo.workday
      ?.dailyEstimateMinutes).toBe(91)
  })

  it('keeps a junk subgroup as the defaults', () => {
    for (const junk of ['workday', {}, [], null]) {
      expect(mergeSettings({ todo: { workday: junk } }).todo.workday).toEqual(DEFAULT_TODO_WORKDAY)
    }
  })
})

describe('the focus and finish-day rows', () => {
  it('writes the whole focus subgroup when one switch moves', async () => {
    await render()
    await toggleRowSwitch(t('settings.todo_focus'))
    expect(updateSettingsMock).toHaveBeenLastCalledWith({
      todo: { focus: { ...DEFAULT_TODO_FOCUS, enabled: false } },
    })
  })

  it('sends the strategy the reader picked and keeps the other focus keys', async () => {
    await render()
    await chooseStrategy('pomodoro')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({
      todo: { focus: { ...DEFAULT_TODO_FOCUS, strategy: 'pomodoro' } },
    })
  })

  it('holds a typed focus length to the edges the merge applies', async () => {
    await render()
    await enterNumber(t('settings.todo_focus_minutes'), '500')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({
      todo: { focus: { ...DEFAULT_TODO_FOCUS, defaultMinutes: 240 } },
    })
    await enterNumber(t('settings.todo_focus_minutes'), '0')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({
      todo: { focus: { ...DEFAULT_TODO_FOCUS, defaultMinutes: 1 } },
    })
  })

  it('writes one pomodoro length without disturbing the other three', async () => {
    await render()
    await enterNumber(t('settings.todo_focus_pomodoro_work'), '45')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({
      todo: { focus: { ...DEFAULT_TODO_FOCUS, pomodoro: { ...DEFAULT_TODO_FOCUS.pomodoro, work: 45 } } },
    })
    await enterNumber(t('settings.todo_focus_pomodoro_every'), '99')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({
      todo: { focus: { ...DEFAULT_TODO_FOCUS, pomodoro: { ...DEFAULT_TODO_FOCUS.pomodoro, every: 12 } } },
    })
  })

  it('stacks the four pomodoro fields under their own title instead of squeezing the row', async () => {
    await render()
    const row = rowByTitle(t('settings.todo_focus_pomodoro'))
    expect(row, 'the pomodoro row is not rendered').toBeTruthy()
    // jsdom has no layout, so what can be proved here is the class the stacked layout is made of; the
    // widths themselves are on the screenshot list.
    expect(row!.className).toContain('md:flex-col')
    expect(row!.className).toContain('md:items-stretch')
    for (const label of [
      t('settings.todo_focus_pomodoro_work'),
      t('settings.todo_focus_pomodoro_short'),
      t('settings.todo_focus_pomodoro_long'),
      t('settings.todo_focus_pomodoro_every'),
    ]) {
      expect(numberField(label), label).toBeTruthy()
    }
  })

  it('keeps the focus sound off the panel until the overlay can actually play it', async () => {
    await render()
    expect(rowByTitle(t('settings.todo_digest'))).toBeTruthy()
    const selects = [...(view?.container.querySelectorAll('select') ?? [])]
    for (const select of selects) {
      const values = [...select.options].map((option) => option.value)
      expect(values, 'a control offers focus sounds the app cannot play yet').not.toContain('chime')
    }
  })

  it('turns the daily estimate off when its field is emptied', async () => {
    await render()
    const field = numberField(t('settings.todo_workday_estimate'))
    expect([field.min, field.max]).toEqual(['1', '960'])
    await enterNumber(t('settings.todo_workday_estimate'), '300')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({
      todo: { workday: { ...DEFAULT_TODO_WORKDAY, dailyEstimateMinutes: 300 } },
    })
    await enterNumber(t('settings.todo_workday_estimate'), '')
    expect(updateSettingsMock).toHaveBeenLastCalledWith({
      todo: { workday: { ...DEFAULT_TODO_WORKDAY, dailyEstimateMinutes: null } },
    })
  })
})

function rowByTitle(title: string): HTMLElement | null {
  return view?.container.querySelector<HTMLElement>(`[data-setting-title="${title}"]`) ?? null
}

function numberField(label: string): HTMLInputElement {
  const node = view?.container.querySelector<HTMLInputElement>(`input[type="number"][aria-label="${label}"]`)
  if (!node) throw new Error(`the ${label} field is not rendered`)
  return node
}

/** Hand a value to a number field the way typing would, and let the row's state land. */
async function enterNumber(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(numberField(label), value)
    numberField(label).dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

async function toggleRowSwitch(title: string): Promise<void> {
  const node = rowByTitle(title)?.querySelector<HTMLButtonElement>('[role="switch"]')
  if (!node) throw new Error(`the ${title} switch is not rendered`)
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

async function chooseStrategy(value: string): Promise<void> {
  const select = rowByTitle(t('settings.todo_focus_strategy'))?.querySelector<HTMLSelectElement>('select')
  if (!select) throw new Error('the focus strategy select is not rendered')
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
