/**
 * The picker draws its calendar from the shared locale derivation, where the `Intl` reading itself is
 * pinned (`lib/time.test.ts`). What is checked here is that the rendered picker follows that one
 * number: its weekday row and the cells spilling in front of the 1st are read off the same value, so
 * a change to the derivation cannot move one of them and leave the other on Sunday.
 */
import { act, createElement, useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, setLocale } from '../lib/i18n'
import { installTestGlobals, renderElement } from '../lib/test-render'
import { DatePicker, TimeField, nudgeFor } from './date-picker'
import { Field } from './form'

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
    createElement(DatePicker, {
      label: 'Due date',
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

describe('DatePicker calendar', () => {
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

/** Mounts a field and clicks its trigger, so the helpers below can act on the open panel. */
function mountField(element: React.ReactElement) {
  const rendered = renderElement(element)
  act(() => {
    rendered.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click()
  })
  expect(rendered.container.querySelector('[role="dialog"]'), 'the field never opened').not.toBeNull()
  return rendered
}

function selectedCells(panel: HTMLElement): string[] {
  return [...panel.querySelectorAll<HTMLElement>('div.grid button')]
    .filter((node) => node.className.includes('bg-[var(--accent)]'))
    .map((node) => node.textContent?.trim() ?? '')
}

function clickWhere(nodes: NodeListOf<HTMLElement> | HTMLElement[], needle: string): boolean {
  const target = [...nodes].find((node) => node.textContent?.trim() === needle)
  if (!target) return false
  act(() => target.click())
  return true
}

function clickDay(panel: HTMLElement, day: string): void {
  const clicked = clickWhere(panel.querySelectorAll<HTMLElement>('div.grid button'), day)
  expect(clicked, `no ${day} cell in the open calendar`).toBe(true)
}

function clickSpinner(panel: HTMLElement, label: string): void {
  const button = panel.querySelector<HTMLElement>(`button[aria-label="${label}"]`)
  expect(button, `no ${label} control`).not.toBeNull()
  act(() => button!.click())
}

/**
 * A parent that keeps the value, the way every real caller does. Asserting through it is what proves
 * a second click reads the first one's result rather than the value the field was opened with.
 */
function ValueField({ initial, withTime }: { initial: string, withTime?: boolean }) {
  const [value, setValue] = useState(initial)
  return createElement(
    'div',
    { 'data-value': value },
    withTime
      ? createElement(DatePicker, { label: 'When', value, withTime: true, onChange: setValue })
      : createElement(TimeField, { label: 'Time', value, onChange: setValue }),
  )
}

function committed(container: HTMLElement): string {
  return container.querySelector<HTMLElement>('[data-value]')!.dataset.value ?? ''
}

describe('DatePicker withTime', () => {
  it('carries the clock reading across a day change and stays open', async () => {
    await setLocale('en-US', false)
    const onChange = vi.fn()
    const rendered = renderElement(
      createElement(DatePicker, { label: 'When', value: '2026-09-15T14:30', withTime: true, onChange }),
    )
    try {
      act(() => {
        rendered.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click()
      })
      const panel = rendered.container.querySelector<HTMLElement>('[role="dialog"]')!
      clickDay(panel, '20')
      expect(onChange).toHaveBeenLastCalledWith('2026-09-20T14:30')
      expect(panel.isConnected, 'a date+time field must not close on the day click').toBe(true)
    } finally {
      rendered.unmount()
    }
  })

  it('keeps the picked day when the clock is moved next', async () => {
    await setLocale('en-US', false)
    const { container, unmount } = mountField(createElement(ValueField, { initial: '2026-09-15T14:30', withTime: true }))
    try {
      clickDay(container.querySelector<HTMLElement>('[role="dialog"]')!, '20')
      expect(committed(container)).toBe('2026-09-20T14:30')
      clickSpinner(container.querySelector<HTMLElement>('[role="dialog"]')!, 'Increase minute')
      expect(committed(container)).toBe('2026-09-20T14:31')
    } finally {
      unmount()
    }
  })

  it('reads the stored stamp back into both halves', async () => {
    await setLocale('en-US', false)
    const { container, unmount } = mountField(
      createElement(DatePicker, { label: 'When', value: '2026-09-15T14:30', withTime: true, onChange: vi.fn() }),
    )
    try {
      const panel = container.querySelector<HTMLElement>('[role="dialog"]')!
      expect([...panel.querySelectorAll<HTMLElement>('div[role="group"] span')].map((node) => node.textContent))
        .toEqual(['14', '30'])
      expect(selectedCells(panel)).toEqual(['15'])
    } finally {
      unmount()
    }
  })

  it('shows the closed field as a date and a time, not as an ISO stamp', async () => {
    await setLocale('en-US', false)
    const rendered = renderElement(
      createElement(DatePicker, { label: 'When', value: '2026-09-15T14:30', withTime: true, onChange: vi.fn() }),
    )
    try {
      expect(rendered.container.textContent).toBe('When2026-09-15 14:30')
    } finally {
      rendered.unmount()
    }
  })
})

describe('TimeField', () => {
  it('wraps the hour and keeps it on the next edit', async () => {
    await setLocale('en-US', false)
    const { container, unmount } = mountField(createElement(ValueField, { initial: '00:05' }))
    try {
      const panel = () => container.querySelector<HTMLElement>('[role="dialog"]')!
      clickSpinner(panel(), 'Decrease hour')
      expect(committed(container)).toBe('23:05')
      clickSpinner(panel(), 'Increase minute')
      expect(committed(container)).toBe('23:06')
    } finally {
      unmount()
    }
  })

  it('falls back to nine when the stored time does not parse', async () => {
    await setLocale('en-US', false)
    const rendered = renderElement(createElement(TimeField, { label: 'Time', value: '9am', onChange: vi.fn() }))
    try {
      expect(rendered.container.textContent).toBe('Time09:00')
    } finally {
      rendered.unmount()
    }
  })
})

describe('nudgeFor', () => {
  const PHONE = { left: 0, right: 420, top: 0, bottom: 860 }

  it('pulls a panel back inside the far edge', () => {
    const nudge = nudgeFor({ anchor: { left: 211, bottom: 300, top: 268 }, panel: { width: 256, height: 300 }, viewport: PHONE })
    expect(nudge.x).toBe(-55)
  })

  it('leaves a panel that already fits where it is', () => {
    const nudge = nudgeFor({ anchor: { left: 150, bottom: 300, top: 268 }, panel: { width: 256, height: 300 }, viewport: PHONE })
    expect(nudge.x).toBe(0)
  })

  it('never takes the near edge past the margin', () => {
    const nudge = nudgeFor({ anchor: { left: 0, bottom: 300, top: 268 }, panel: { width: 256, height: 300 }, viewport: { left: 0, right: 200, top: 0, bottom: 860 } })
    expect(nudge.x).toBe(8)
  })

  it('flips above the field only when the top has room', () => {
    const tight = nudgeFor({ anchor: { left: 8, bottom: 800, top: 772 }, panel: { width: 256, height: 300 }, viewport: PHONE })
    expect(tight.up).toBe(true)
    const cramped = nudgeFor({ anchor: { left: 8, bottom: 170, top: 138 }, panel: { width: 256, height: 600 }, viewport: PHONE })
    expect(cramped.up).toBe(false)
  })
})

/**
 * The naming contract, which is the part a `Field` cannot enforce on its own.
 *
 * A `Field` hands its child an `id` and an `aria-labelledby`; a picker that ignored them would leave the
 * visible label pointing at nothing while the button named itself from a hidden span — the shape that
 * reads as two different controls, and as an unlabelled one, to a screen reader.
 */
describe('DatePicker labelling', () => {
  const trigger = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')

  it('names itself when nothing above it does', () => {
    const rendered = renderElement(createElement(DatePicker, { label: 'Due date', onChange: vi.fn() }))
    const button = trigger(rendered.container)!
    expect(button.getAttribute('aria-labelledby')).toBeNull()
    expect(button.querySelector('.sr-only')?.textContent).toBe('Due date')
    rendered.unmount()
  })

  it('takes the name from a surrounding Field and drops its own copy', () => {
    const rendered = renderElement(
      createElement(Field, {
        label: 'Expiry date',
        children: createElement(DatePicker, { label: 'Expiry date', onChange: vi.fn() }),
      }),
    )
    const button = trigger(rendered.container)!
    const label = rendered.container.querySelector('label')!
    expect(label.getAttribute('for'), 'the visible label points at nothing').toBe(button.id)
    expect(button.id, 'the picker took no id from its field').not.toBe('')
    expect(button.getAttribute('aria-labelledby')).toBe(label.id)
    expect(button.querySelector('.sr-only'), 'the same words are read twice').toBeNull()
    rendered.unmount()
  })

  it('hands a hint to the control, so the field description is announced with it', () => {
    const rendered = renderElement(
      createElement(Field, {
        label: 'Trial ends',
        hint: 'The day the free period turns into a bill.',
        children: createElement(DatePicker, { label: 'Trial ends', onChange: vi.fn() }),
      }),
    )
    const button = trigger(rendered.container)!
    const hintId = rendered.container.querySelector('p')!.id
    expect(button.getAttribute('aria-describedby'), 'the hint is not tied to the control').toContain(hintId)
    rendered.unmount()
  })

  it('shows and says an invalid date, and keeps its own box on a shared row', () => {
    const rendered = renderElement(
      createElement(DatePicker, { label: 'Expiry date', value: '', invalid: true, className: 'min-w-0 flex-1', onChange: vi.fn() }),
    )
    const box = trigger(rendered.container)!.parentElement!
    expect(box.className).toContain('border-[var(--danger)]')
    expect(box.className, 'the picker could not share its row').toContain('min-w-0')
    expect(trigger(rendered.container)!.getAttribute('aria-invalid')).toBe('true')
    rendered.unmount()
  })

  it('clears through its own affordance, which is why a caller needs no second button', () => {
    const onChange = vi.fn()
    const rendered = renderElement(createElement(DatePicker, { label: 'Trial ends', value: '2026-09-15', onChange }))
    const clear = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node !== trigger(rendered.container))
    expect(clear, 'a set date offers no way back to empty').toBeTruthy()
    act(() => { clear!.click() })
    expect(onChange).toHaveBeenCalledWith('')
    rendered.unmount()
  })
})
