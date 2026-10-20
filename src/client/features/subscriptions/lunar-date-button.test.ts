// @vitest-environment jsdom
/**
 * The lunar date picker that sits beside the form's native date field.
 *
 * The almanac table behind it is proved on its own in `tests/subscriptions-lunar.test.ts`; what is proved
 * here is the promise the control makes on top of that table: it never offers a day the table refuses, and
 * what it writes back is the day it is showing.
 *
 * Two facts outside this codebase anchor the fixtures, because a test that only re-reads the table would
 * pass even if the table were wrong. 2024-02-10 is the first day of the lunar year that begins in 2024,
 * published anywhere, and that year's first month has 29 days — so a thirtieth does not exist to be
 * picked. 2023-03-22 is the first day of that year's leap second month, which is the one case where a
 * month number names two different solar dates.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lunar2solar } from '@shared/subscriptions/lunar'
import { initI18n, t, type MessageKey } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { LunarDateButton } from './LunarDateButton'

// Keys, not labels: the catalog is only loaded once `initI18n` resolves, so a label read at module scope
// would be the key itself and every selector built from it would find nothing.
const YEAR: MessageKey = 'subscriptions.lunar.year'
const MONTH: MessageKey = 'subscriptions.lunar.month'
const DAY: MessageKey = 'subscriptions.lunar.day'

let root: Root | null = null
let picked: string[]

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  picked = []
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
})

function mount(value: string): void {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root?.render(createElement(LunarDateButton, { value, onPick: (date) => { picked.push(date) } })) })
}

async function press(node: Element | null | undefined, what: string): Promise<void> {
  expect(node, `${what} is not rendered`).toBeTruthy()
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

function field(key: MessageKey): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>(`select[aria-label="${t(key)}"]`)
}

function values(select: HTMLSelectElement | null): string[] {
  expect(select, 'the list is not rendered').toBeTruthy()
  return [...select!.options].map((option) => option.value)
}

async function choose(key: MessageKey, value: string): Promise<void> {
  const select = field(key)
  expect(select, `${key} is not rendered`).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function open(): Promise<void> {
  await press(document.querySelector(`[aria-label="${t('subscriptions.lunar.pick')}"]`), 'the picker button')
}

async function fill(): Promise<void> {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === t('subscriptions.lunar.fill'))
  await press(button, 'the fill button')
}

/** The solar date on screen, in the form the native field beside this one takes. */
function solarIso(solar: { year: number, month: number, day: number }): string {
  return `${solar.year}-${String(solar.month).padStart(2, '0')}-${String(solar.day).padStart(2, '0')}`
}

describe('the lunar picker', () => {
  it('opens on the lunar date the field already holds, and shortens the day list to fit it', async () => {
    mount('2024-02-10')
    await open()

    expect(field(YEAR)?.value).toBe('2024')
    expect(field(MONTH)?.value).toBe('1')
    expect(field(DAY)?.value).toBe('1')
    // The first month of the 2024 lunar year has 29 days. A list that ran to thirty would offer a date no
    // month has.
    const days = values(field(DAY))
    expect(days).toHaveLength(29)
    expect(days).not.toContain('30')
    expect(values(field(MONTH)), 'a year with no leap month must not offer one').toHaveLength(12)
  })

  it('names a leap month apart from the plain month of the same number', async () => {
    mount('2023-03-22')
    await open()

    // Two readings of "month two" are a month apart in the solar calendar, so they cannot share an option.
    const monthOptions = values(field(MONTH))
    expect(monthOptions).toContain('leap:2')
    expect(monthOptions).toHaveLength(13)
    expect(field(MONTH)?.value).toBe('leap:2')

    await choose(MONTH, '2')
    await fill()
    const plain = lunar2solar({ year: 2023, month: 2, day: 1, isLeap: false })
    expect(plain).not.toBeNull()
    expect(picked).toEqual([solarIso(plain!)])
    expect(solarIso(plain!)).not.toBe('2023-03-22')
  })

  it('writes exactly the solar date it is showing', async () => {
    mount('2024-02-10')
    await open()
    await choose(MONTH, '6')
    await choose(DAY, '15')
    await fill()

    const expected = lunar2solar({ year: 2024, month: 6, day: 15, isLeap: false })
    expect(expected).not.toBeNull()
    expect(picked).toEqual([solarIso(expected!)])
  })

  it('offers no day the table would refuse, for every month it lists', async () => {
    mount('2023-03-22')
    await open()

    for (const month of values(field(MONTH))) {
      await choose(MONTH, month)
      const isLeap = month.startsWith('leap:')
      const number = Number(isLeap ? month.slice('leap:'.length) : month)
      for (const day of values(field(DAY))) {
        expect(
          lunar2solar({ year: 2023, month: number, day: Number(day), isLeap }),
          `2023 month ${month} day ${day} is on offer but cannot be converted`,
        ).not.toBeNull()
      }
    }
  })

  it('drops a leap month the new year does not have, rather than refusing to fill', async () => {
    mount('2023-03-22')
    await open()
    expect(field(MONTH)?.value).toBe('leap:2')

    // 2024 has no leap month. The choice has to go on its own; a picker stuck on an impossible combination
    // would show a date it can never write.
    await choose(YEAR, '2024')
    expect(field(MONTH)?.value).toBe('2')
    await choose(DAY, '1')
    await fill()
    const expected = lunar2solar({ year: 2024, month: 2, day: 1, isLeap: false })
    expect(expected).not.toBeNull()
    expect(picked).toEqual([solarIso(expected!)])
  })
})
