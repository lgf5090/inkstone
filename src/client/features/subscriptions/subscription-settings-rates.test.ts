// @vitest-environment jsdom
/**
 * The rate boxes in the settings panel.
 *
 * What is pinned is the meaning of a box, not its position: the account's pins travel as one map on every
 * blur, so a box left empty is the reader asking for the feed back for that currency rather than a pin of
 * zero, and a box with a number in it is that number. The panel is also the only place a pin can be read,
 * so the saved value has to come back out of the box it was written into.
 *
 * The boxes are the currencies this account actually meets — its own plans, what it already pinned, the
 * currency the totals are added up in — rather than every currency the app knows, because the app now
 * knows thirty and a wall of thirty empty boxes answers a question nobody asked. Anything else is one
 * choice away, which is what the last two cases here pin.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ChannelState, type SubscriptionSettings } from '@shared/subscriptions/model'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { SubscriptionSettings as Panel } from './SubscriptionSettings'

const NO_CHANNELS: ChannelState[] = []

const rows = () => [...document.querySelectorAll<HTMLElement>('[data-rate-boxes] > *')]
const rowText = (row: HTMLElement) => row.querySelector('label')?.textContent ?? ''
const boxFor = (code: string): HTMLInputElement | undefined =>
  rows().find((row) => rowText(row).includes(code))?.querySelector('input[type="number"]') ?? undefined

async function show(options: {
  settings?: Partial<SubscriptionSettings>
  currencies?: string[]
  categories?: string[]
  onSaveSettings?: (patch: Record<string, unknown>) => Promise<boolean>
} = {}): Promise<void> {
  const value = { ...DEFAULT_SETTINGS, ...options.settings }
  await act(async () => {
    root.render(createElement(Panel, {
      settings: value,
      channels: NO_CHANNELS,
      currencies: options.currencies ?? [],
      categories: options.categories ?? [],
      onClose: () => {},
      onSaveSettings: options.onSaveSettings ?? (async () => true),
      onSaveChannel: async () => true,
      onClearChannel: async () => true,
      onTestChannel: async () => {},
      onRotateToken: async () => null,
      onDiagnostics: () => {},
    }))
  })
}

let root: Root
let host: HTMLElement

async function typeInto(input: HTMLInputElement | undefined, text: string): Promise<void> {
  if (!input) throw new Error('no rate box for that currency')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
}

async function choose(code: string): Promise<void> {
  // By the label's own `for`, which is what the panel's Field wires up: reaching for the select through
  // the markup around it would break the day the field's wrapper changes shape.
  const label = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find((node) => (node.textContent ?? '').includes(t('subscriptions.settings.rate_add')))
  const select = label?.htmlFor ? document.getElementById(label.htmlFor) as HTMLSelectElement | null : null
  expect(select, 'the add-a-currency list is not rendered').toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, code)
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('the rate boxes', () => {
  it('offers one per currency the account meets, and no box for the anchor', async () => {
    await show({ currencies: ['USD', 'JPY', 'CNY'], settings: { rateOverrides: { GBP: 9.1 } } })
    expect(rows()).toHaveLength(3)
    const text = document.body.textContent ?? ''
    for (const code of ['GBP', 'JPY', 'USD']) {
      expect(text).toContain(t('subscriptions.settings.rate_row', { currency: code }))
    }
    expect(text).not.toContain(t('subscriptions.settings.rate_row', { currency: 'CNY' }))
  })

  it('shows the pin the account already carries', async () => {
    await show({ settings: { rateOverrides: { USD: 7.2 } } })
    expect(boxFor('USD')!.value).toBe('7.2')
  })

  it('sends every pin the boxes hold, not only the one that was touched', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({ currencies: ['GBP'], settings: { rateOverrides: { USD: 7.2, JPY: 0.045 } }, onSaveSettings })
    await typeInto(boxFor('GBP'), '9.4')
    expect(onSaveSettings).toHaveBeenLastCalledWith({ rateOverrides: { USD: 7.2, JPY: 0.045, GBP: 9.4 } })
  })

  it('takes the feed back when a box is emptied', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({ settings: { rateOverrides: { USD: 7.2, JPY: 0.045 } }, onSaveSettings })
    await typeInto(boxFor('USD'), '')
    expect(onSaveSettings).toHaveBeenLastCalledWith({ rateOverrides: { JPY: 0.045 } })
  })

  it('offers one control that clears them all, and only when there is something to clear', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({ settings: { rateOverrides: { USD: 7.2 } }, onSaveSettings })
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(t('subscriptions.settings.rates_clear')))
    expect(clear, 'a pinned account offers no way back to the feed').toBeTruthy()
    await act(async () => { clear!.click() })
    expect(onSaveSettings).toHaveBeenLastCalledWith({ rateOverrides: {} })

    await show({ settings: { rateOverrides: {} } })
    expect([...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.textContent?.includes(t('subscriptions.settings.rates_clear')))).toBe(false)
  })

  it('lets a currency the account does not use still be pinned', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({ currencies: ['USD'], onSaveSettings })
    expect(boxFor('SGD')).toBeUndefined()

    await choose('SGD')
    expect(boxFor('SGD'), 'choosing a currency drew no box').toBeTruthy()
    await typeInto(boxFor('SGD'), '5.4')
    expect(onSaveSettings).toHaveBeenLastCalledWith({ rateOverrides: { SGD: 5.4 } })
  })

  it('says so when a currency has no built-in reference to fall back on', async () => {
    await show({ currencies: ['USD', 'SGD'] })
    const text = (row: HTMLElement) => rowText(row) + (row.textContent ?? '')
    const usd = rows().find((row) => text(row).includes('USD'))!
    const sgd = rows().find((row) => text(row).includes('SGD'))!
    expect(usd.textContent).toContain('6.98')
    expect(sgd.textContent).toContain(t('subscriptions.settings.rate_no_fallback'))
    expect(sgd.textContent).not.toContain('6.98')
  })
})

describe('the category ceilings', () => {
  const ceilingRows = () => [...document.querySelectorAll<HTMLElement>('[data-category-budget-boxes] > *')]
  const ceilingBoxFor = (name: string): HTMLInputElement | undefined =>
    ceilingRows().find((row) => rowText(row).includes(name))?.querySelector('input[type="number"]') ?? undefined

  async function chooseCategory(name: string): Promise<void> {
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')]
      .find((node) => (node.textContent ?? '').includes(t('subscriptions.settings.category_budget_add')))
    const select = label?.htmlFor ? document.getElementById(label.htmlFor) as HTMLSelectElement | null : null
    expect(select, 'the add-a-category list is not rendered').toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, name)
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  const buttonNamed = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes(name))

  it('draws one box per ceiling the account carries', async () => {
    await show({ categories: ['family', 'travel'], settings: { budgetCategories: { family: 500 } } })
    expect(ceilingRows()).toHaveLength(1)
    expect(ceilingBoxFor('family')!.value).toBe('500')
  })

  it('sends the whole map, and reads a blank box as a ceiling given up', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({
      categories: ['family', 'travel'],
      settings: { budgetCategories: { family: 500, travel: 100 } },
      onSaveSettings,
    })
    await typeInto(ceilingBoxFor('travel'), '')
    expect(onSaveSettings).toHaveBeenLastCalledWith({ budgetCategories: { family: 500 } })
  })

  it('adds a category from the list and caps it', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({ categories: ['family', 'travel'], settings: { budgetCategories: { family: 500 } }, onSaveSettings })
    await chooseCategory('travel')
    expect(ceilingBoxFor('travel'), 'choosing a category drew no box').toBeTruthy()
    await typeInto(ceilingBoxFor('travel'), '300')
    expect(onSaveSettings).toHaveBeenLastCalledWith({ budgetCategories: { family: 500, travel: 300 } })
  })

  it('clears every ceiling, and offers no button when there is nothing to clear', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({ categories: ['family'], settings: { budgetCategories: { family: 500 } }, onSaveSettings })
    const clear = buttonNamed(t('subscriptions.settings.category_budgets_clear'))
    expect(clear, 'a capped account offers no way back to uncapped').toBeTruthy()
    await act(async () => { clear!.click() })
    expect(onSaveSettings).toHaveBeenLastCalledWith({ budgetCategories: {} })

    await show({ categories: ['family'], settings: { budgetCategories: {} } })
    expect(buttonNamed(t('subscriptions.settings.category_budgets_clear'))).toBeUndefined()
  })

  it('explains an empty category list instead of offering a select with nothing in it', async () => {
    await show({ categories: [] })
    expect(document.body.textContent ?? '').toContain(t('subscriptions.settings.category_budgets_none'))
    expect([...document.querySelectorAll<HTMLSelectElement>('select')]
      .some((node) => (node.textContent ?? '').includes(t('subscriptions.settings.category_budget_add_placeholder')))).toBe(false)
  })
})
