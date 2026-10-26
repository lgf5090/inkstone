// @vitest-environment jsdom
/**
 * The habits screen: what a row says it holds, and what a press actually writes.
 *
 * The rules worth pinning are the ones a screen can get wrong while looking right. A tap must land on the
 * day the answer named, not on the machine's today; the number under a row must come from the re-read
 * rather than from what the press asked for; a streak must count the target and not "anything happened";
 * and a control that cannot do what it says — taking a tap back from a day that holds none — is not drawn
 * as if it could.
 *
 * The fake below keeps habits and their days in one mutable array and rebuilds the whole answer on every
 * read, the way the endpoint does. A fake that replayed one fixed answer would let a screen that never
 * re-read pass every case here.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, localeTag, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CountersView } from './CountersView'
import { readsOwnRows } from './store'
import { surfacesFor, surfacesForPhoneMore, TODO_SURFACES } from './views/nav'
import { durationLabel } from './stats-charts'
import { MAX_COUNTER_DAY_AMOUNT, type CounterKind, type CounterReading, type CounterReadings, type TodoCounter } from '@shared/todos/model'

const NOW = 1_700_000_000_000
const TODAY = '2023-11-14'
/** The window the endpoint answers with; the screen only ever reads the tail of it back. */
const WINDOW_DAYS = 366
const DAY_MS = 86_400_000
const MINUTE_S = 60
/** The milliseconds a duration label expects, against the seconds a habit stores. */
const SECOND_MS = 1000

const service = vi.hoisted(() => ({
  habits: [] as { counter: TodoCounter, days: Map<string, number> }[],
  reads: 0,
  fail: false,
  ticks: [] as { id: string, delta: number, day?: string }[],
  starts: [] as string[],
  stops: [] as string[],
  creates: [] as Record<string, unknown>[],
  updates: [] as { id: string, body: Record<string, unknown> }[],
  removes: [] as string[],
  // Stood up in `beforeEach`: a hoisted factory runs before the module's own constants exist.
  now: 0,
}))

const overlay = vi.hoisted(() => ({ answer: true }))

function dayWindow(): string[] {
  return Array.from({ length: WINDOW_DAYS }, (_, index) =>
    new Date(Date.parse(`${TODAY}T00:00:00Z`) - (WINDOW_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10))
}

/** The answer the endpoint would give: every habit, and every day of its window, empty ones included. */
function currentReadings(): CounterReadings {
  const readings: CounterReading[] = service.habits.map((habit) => ({
    from: dayWindow()[0]!,
    to: TODAY,
    today: TODAY,
    days: dayWindow().map((day) => ({ day, amount: habit.days.get(day) ?? 0 })),
    counter: habit.counter,
  }))
  return { today: TODAY, readings }
}

function habit(id: string, title: string, over: Partial<TodoCounter> = {}): TodoCounter {
  return {
    id,
    title,
    kind: 'clicks' as CounterKind,
    icon: null,
    color: '#2563eb',
    goal: null,
    runningSince: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      counters: async () => {
        service.reads += 1
        if (service.fail) throw new Error('the habits could not be read')
        return currentReadings()
      },
      tickCounter: async (id: string, body: { delta: number, day?: string }) => {
        service.ticks.push({ id, delta: body.delta, ...(body.day === undefined ? {} : { day: body.day }) })
        const held = service.habits.find((entry) => entry.counter.id === id)
        const day = body.day ?? TODAY
        if (!held) throw new Error('no such habit')
        const amount = Math.max(0, Math.min(MAX_COUNTER_DAY_AMOUNT, (held.days.get(day) ?? 0) + body.delta))
        if (amount === 0) held.days.delete(day)
        else held.days.set(day, amount)
        return { day, amount }
      },
      startCounter: async (id: string) => {
        service.starts.push(id)
        const held = service.habits.find((entry) => entry.counter.id === id)
        if (!held) throw new Error('no such habit')
        held.counter = { ...held.counter, runningSince: service.now }
        return { counter: held.counter }
      },
      stopCounter: async (id: string) => {
        service.stops.push(id)
        const held = service.habits.find((entry) => entry.counter.id === id)
        if (!held) throw new Error('no such habit')
        const began = held.counter.runningSince ?? service.now
        held.counter = { ...held.counter, runningSince: null }
        const seconds = Math.max(0, Math.floor((service.now - began) / 1000))
        const amount = (held.days.get(TODAY) ?? 0) + seconds
        if (amount > 0) held.days.set(TODAY, amount)
        return { counter: held.counter, filed: seconds > 0 ? { day: TODAY, amount } : null }
      },
      createCounter: async (body: Record<string, unknown>) => {
        service.creates.push(body)
        const counter = habit(`new-habit-${service.habits.length + 1}`, String(body.title), {
          kind: (body.kind as CounterKind) ?? 'clicks',
          goal: body.goal as number | null,
        })
        service.habits.push({ counter, days: new Map() })
        return { counter }
      },
      updateCounter: async (id: string, body: Record<string, unknown>) => {
        service.updates.push({ id, body })
        const held = service.habits.find((entry) => entry.counter.id === id)
        if (!held) throw new Error('no such habit')
        held.counter = { ...held.counter, ...body }
        return { counter: held.counter }
      },
      removeCounter: async (id: string) => {
        service.removes.push(id)
        service.habits = service.habits.filter((entry) => entry.counter.id !== id)
        return { deleted: true }
      },
    },
  },
}))

// Only `confirm` is stood in for; the rest of the overlay module stays real, because the modules this
// screen drags in import their dialogs from it too.
vi.mock('../../components/overlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/overlay')>()),
  confirm: async () => overlay.answer,
}))

let view: RenderedElement | null = null

async function open(): Promise<void> {
  view = renderElement(createElement(CountersView))
  await act(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

function screen(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-counters-view]')
  if (!node) throw new Error('the habits screen did not render')
  return node
}

function rowFor(title: string): HTMLElement {
  const row = [...screen().querySelectorAll<HTMLElement>('li[data-habit-row]')]
    .find((entry) => entry.textContent?.includes(title))
  if (!row) throw new Error(`no row was drawn for ${title}`)
  return row
}

function buttonNamed(label: string, within: HTMLElement = screen()): HTMLButtonElement | undefined {
  return [...within.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => (entry.getAttribute('aria-label') ?? entry.textContent ?? '').includes(label))
}

async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

async function type(target: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A button of the dialog, which lives in a portal rather than inside the screen's own node. */
function dialogButton(label: string): HTMLButtonElement | undefined {
  return buttonNamed(label, dialog())
}

/** The dialog the habits screen opened, or the failure of the case that expected one. */
function dialog(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!node) throw new Error('the habit dialog did not open')
  return node
}

/**
 * A field of the dialog, by what it holds.
 *
 * `Segmented` is a row of radios, so "the first input" is whatever the reader picked rather than what
 * they typed; the text fields are the ones a case can write into.
 */
function field(kind: 'name' | 'goal'): HTMLInputElement {
  const inputs = [...dialog().querySelectorAll<HTMLInputElement>('input')].filter((entry) => entry.type !== 'radio')
  const found = kind === 'name' ? inputs[0] : inputs.find((entry) => entry.getAttribute('inputmode') === 'numeric')
  if (!found) throw new Error(`the dialog held no ${kind} field`)
  return found
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.habits = []
  service.reads = 0
  service.fail = false
  service.ticks.length = 0
  service.starts.length = 0
  service.stops.length = 0
  service.creates.length = 0
  service.updates.length = 0
  service.removes.length = 0
  service.now = NOW
  overlay.answer = true
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('reading the habits', () => {
  it('shows one row per habit, with what today holds', async () => {
    service.habits = [
      { counter: habit('h1', 'Water', { goal: 8 }), days: new Map([[TODAY, 3]]) },
      { counter: habit('h2', 'Meditate', { kind: 'stopwatch', goal: 600 }), days: new Map([[TODAY, 180]]) },
    ]

    await open()

    expect(rowFor('Water').textContent).toContain('3 / 8')
    // A habit that counts seconds is read as a duration, not as a number of anything.
    expect(rowFor('Meditate').textContent).toContain(durationLabel(180 * SECOND_MS))
    expect(rowFor('Meditate').textContent).not.toMatch(/\b180\b/)
    expect(service.reads).toBe(1)
  })

  it('reports a failed read and asks again when told to', async () => {
    service.fail = true
    await open()

    expect(screen().querySelector('[role="alert"]')?.textContent).toContain('the habits could not be read')

    service.fail = false
    const again = buttonNamed(t('common.retry'))
    expect(again).toBeTruthy()
    await press(again!)

    expect(service.reads).toBe(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('offers the first habit on an empty account', async () => {
    await open()

    expect(screen().textContent).toContain(t('todo.counters.empty'))
    await press(buttonNamed(t('todo.counters.new'))!)

    expect(field('name')).toBeTruthy()
  })

  it('is one of the screens that read their own rows, so the frame fetches no listing for it', () => {
    expect(readsOwnRows('counters')).toBe(true)
  })

  it('is offered by the sidebar and reached from the phone overflow, which is where the tabs leave it', () => {
    expect(surfacesFor('sidebar', { finishDayEnabled: true }).map((surface) => surface.view)).toContain('counters')
    expect(TODO_SURFACES.find((surface) => surface.view === 'counters')?.phone).toBeUndefined()
    // A screen the four tabs do not carry still has to come from somewhere on a phone, or it ships
    // unreachable: the overflow menu is that somewhere, and it is derived from this same table.
    expect(surfacesForPhoneMore({ finishDayEnabled: true }).map((surface) => surface.view)).toContain('counters')
  })

  it('leaves the calendar out of the overflow, because the header already carries its glyph', () => {
    expect(surfacesForPhoneMore({ finishDayEnabled: true }).map((surface) => surface.view)).not.toContain('calendar')
  })
})

describe('tapping a day', () => {
  it('writes to the day the answer called today, and shows the number it came back with', async () => {
    service.habits = [{ counter: habit('h1', 'Water', { goal: 8 }), days: new Map([[TODAY, 3]]) }]
    await open()

    await press(buttonNamed(t('todo.counters.tap'), rowFor('Water'))!)

    expect(service.ticks).toEqual([{ id: 'h1', delta: 1 }])  // no day: the server names today
    expect(rowFor('Water').textContent).toContain('4 / 8')
    // The row is re-read rather than guessed at: a screen that painted 4 from its own arithmetic would
    // still say 4 if the server had answered something else.
    expect(service.reads).toBe(2)
  })

  it('will not take a tap back from a day that holds none', async () => {
    service.habits = [{ counter: habit('h1', 'Water'), days: new Map() }]
    await open()

    const undo = buttonNamed(t('todo.counters.take_one'), rowFor('Water'))
    expect(undo).toBeTruthy()
    expect(undo!.disabled).toBe(true)

    await press(undo!)
    expect(service.ticks).toEqual([])
  })

  it('back-fills the day a heat cell names, not the one the screen is sitting on', async () => {
    const forgot = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 3 * DAY_MS).toISOString().slice(0, 10)
    service.habits = [{ counter: habit('h1', 'Journal'), days: new Map() }]
    await open()

    const name = new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium' }).format(new Date(`${forgot}T12:00:00Z`))
    const cell = [...rowFor('Journal').querySelectorAll<HTMLButtonElement>('button')]
      .find((entry) => (entry.getAttribute('aria-label') ?? '').includes(name))
    expect(cell, `the strip drew no cell named ${name}`).toBeTruthy()

    await press(cell!)

    expect(service.ticks).toEqual([{ id: 'h1', delta: 1, day: forgot }])
    expect(service.ticks[0]!.day).not.toBe(TODAY)
  })

  it('counts a run only against the target, and says so with the streak', async () => {
    const days = new Map([[TODAY, 3]])
    service.habits = [{ counter: habit('h1', 'Water', { goal: 8 }), days }]
    await open()

    // A month of tiles, not the year the answer carries: the strip is what a row can be read at. The
    // row's two taps and its edit button are buttons too, so the ceiling leaves room for those.
    expect(rowFor('Water').querySelectorAll('button').length).toBeLessThanOrEqual(40)
    expect(rowFor('Water').textContent).not.toContain(t('todo.counters.streak', { value: '1' }))
    expect(rowFor('Water').textContent).not.toContain(t('todo.counters.reached'))

    days.set(TODAY, 8)
    await press(buttonNamed(t('todo.counters.tap'), rowFor('Water'))!)
    expect(rowFor('Water').textContent).toContain(t('todo.counters.streak', { value: '1' }))
  })

  it('paints the day that met its target', async () => {
    service.habits = [{ counter: habit('h1', 'Water', { goal: 1 }), days: new Map([[TODAY, 1]]) }]
    await open()

    expect(rowFor('Water').textContent).toContain(t('todo.counters.reached'))
  })
})

describe('a habit that runs', () => {
  it('starts and stops on the same button, and never offers the taps', async () => {
    service.habits = [{ counter: habit('h1', 'Meditate', { kind: 'stopwatch', goal: 600 }), days: new Map() }]
    await open()

    expect(buttonNamed(t('todo.counters.tap'), rowFor('Meditate'))).toBeUndefined()

    await press(buttonNamed(t('todo.counters.start'), rowFor('Meditate'))!)
    expect(service.starts).toEqual(['h1'])
    expect(rowFor('Meditate').textContent).toContain(t('todo.counters.stop'))

    service.now = NOW + 5 * MINUTE_S * 1000
    await press(buttonNamed(t('todo.counters.stop'), rowFor('Meditate'))!)
    expect(service.stops).toEqual(['h1'])
    // What the day holds comes from the answer, not from the screen's own arithmetic.
    expect(rowFor('Meditate').textContent).toContain(durationLabel(300 * SECOND_MS))
    expect(rowFor('Meditate').textContent).not.toMatch(/\b300\b/)
  })

  it('is not offered to a habit that counts taps', async () => {
    service.habits = [{ counter: habit('h1', 'Push-ups'), days: new Map() }]
    await open()

    const row = rowFor('Push-ups')
    expect(buttonNamed(t('todo.counters.start'), row)).toBeUndefined()
    expect(buttonNamed(t('todo.counters.stop'), row)).toBeUndefined()
  })
})

describe('making and changing a habit', () => {
  it('creates one with a trimmed name, the kind picked, and no target when the field is empty', async () => {
    await open()
    await press(buttonNamed(t('todo.counters.new'))!)

    await type(field('name'), '  Read more  ')
    await press(dialogButton(t('todo.action.save'))!)

    expect(service.creates).toEqual([{ title: 'Read more', kind: 'clicks', goal: null }])
    expect(rowFor('Read more')).toBeTruthy()
  })

  it('keeps Save out of reach while the target is not a number the server would take', async () => {
    await open()
    await press(buttonNamed(t('todo.counters.new'))!)

    const save = dialogButton(t('todo.action.save'))!
    await type(field('name'), 'Walk')
    await type(field('goal'), String(MAX_COUNTER_DAY_AMOUNT + 1))

    expect(save.disabled).toBe(true)
    expect(document.body.textContent).toContain(t('todo.counters.goal_invalid', { max: String(MAX_COUNTER_DAY_AMOUNT) }))

    await type(field('goal'), '12')
    expect(save.disabled).toBe(false)

    await press(save)
    expect(service.creates[0]).toMatchObject({ goal: 12 })
  })

  it('opens the editor with the habit already in the fields and writes only the change', async () => {
    service.habits = [{ counter: habit('h1', 'Water', { goal: 8 }), days: new Map() }]
    await open()

    await press(buttonNamed(t('todo.counters.editor.edit'), rowFor('Water'))!)
    expect(field('name').value).toBe('Water')
    await type(field('goal'), '10')
    await press(dialogButton(t('todo.action.save'))!)

    expect(service.updates).toEqual([{ id: 'h1', body: { title: 'Water', kind: 'clicks', goal: 10 } }])
    expect(rowFor('Water').textContent).toContain('/ 10')
  })

  it('deletes a habit only after the reader says so, and takes its days with it', async () => {
    service.habits = [{ counter: habit('h1', 'Gone', { goal: 4 }), days: new Map([[TODAY, 2]]) }]
    await open()

    await press(buttonNamed(t('todo.counters.editor.edit'), rowFor('Gone'))!)
    await press(dialogButton(t('todo.action.delete'))!)

    expect(service.removes).toEqual(['h1'])
    expect(service.habits).toEqual([])
    expect(screen().textContent).toContain(t('todo.counters.empty'))
  })

  it('leaves the habit alone when the reader backs out of the deletion', async () => {
    overlay.answer = false
    service.habits = [{ counter: habit('h1', 'Staying'), days: new Map() }]
    await open()

    await press(buttonNamed(t('todo.counters.editor.edit'), rowFor('Staying'))!)
    await press(dialogButton(t('todo.action.delete'))!)

    expect(service.removes).toEqual([])
    expect(rowFor('Staying')).toBeTruthy()
  })
})
