import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantSettings, Automation } from '@shared/assistant'
import { computeNextRun } from '@shared/assistant-schedule'
import { DEFAULT_SETTINGS } from '@shared/constants'
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

const { settingsMock, saveSettingsMock, automationsMock, createMock, updateMock, feedListMock } = vi.hoisted(() => ({
  settingsMock: vi.fn(),
  saveSettingsMock: vi.fn(),
  automationsMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  feedListMock: vi.fn(),
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
      todos: { feed: { list: feedListMock, create: vi.fn(), remove: vi.fn() } },
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
  useSession.setState({
    settings: { ...DEFAULT_SETTINGS, todo: { defaultRemind: null } },
    updateSettings: async () => undefined,
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
})
