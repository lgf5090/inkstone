/**
 * The picker draws its calendar from the shared locale derivation, where the `Intl` reading itself is
 * pinned (`lib/time.test.ts`). What is checked here is that the rendered picker follows that one
 * number: its weekday row and the cells spilling in front of the 1st are read off the same value, so
 * a change to the derivation cannot move one of them and leave the other on Sunday.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, setLocale } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import { KanbanDatePicker } from './kanban-date-picker'

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(async () => {
  await setLocale('en-US', false)
})

async function openCalendar(localeCode: 'en-US' | 'zh-CN') {
  await setLocale(localeCode, false)
  const rendered = renderElement(
    createElement(KanbanDatePicker, {
      propertyName: 'Due date',
      value: '2026-09-15',
      onChange: vi.fn(),
    }),
  )
  try {
    act(() => {
      rendered.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click()
    })
    const panel = rendered.container.querySelector<HTMLElement>('[role="dialog"]')
    expect(panel, 'the picker never opened').not.toBeNull()
    const textOf = (node: Element | undefined) => node?.textContent ?? ''
    const labels = [...panel!.querySelectorAll<Element>('div.grid > span')]
    const dayCells = [...panel!.querySelectorAll<Element>('div.grid button')]
    return {
      firstLabel: textOf(labels[0]),
      leadingCells: dayCells.slice(0, 3).map(textOf),
    }
  } finally {
    rendered.unmount()
  }
}

// 2024-01-07 is a Sunday, the same reference date the picker's own week row walks from.
function narrowWeekday(localeCode: string, jsDay: number): string {
  return new Intl.DateTimeFormat(localeCode, { weekday: 'narrow' }).format(new Date(2024, 0, 7 + jsDay))
}

describe('KanbanDatePicker calendar', () => {
  it('opens the Chinese calendar on the Monday column', async () => {
    // 2026-09-01 is a Tuesday, so a Monday-start month leads with one spilled day.
    const calendar = await openCalendar('zh-CN')
    expect(calendar.firstLabel).toBe(narrowWeekday('zh-CN', 1))
    expect(calendar.leadingCells).toEqual(['31', '1', '2'])
  })

  it('opens the English calendar on the Sunday column', async () => {
    const calendar = await openCalendar('en-US')
    expect(calendar.firstLabel).toBe(narrowWeekday('en-US', 0))
    expect(calendar.leadingCells).toEqual(['30', '31', '1'])
  })
})
