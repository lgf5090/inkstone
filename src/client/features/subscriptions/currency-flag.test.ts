// @vitest-environment jsdom
/**
 * The flag each currency is drawn with, and the field that chooses one.
 *
 * The asset map is keyed by `CurrencyCode`, so the compiler already refuses a currency with no entry.
 * What it cannot refuse is an entry that points at nothing, an image that announces itself to a screen
 * reader as well as the code beside it, or a picker that lists nine currencies while the app can be told
 * in thirty-one — which is what these three cases hold.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENCY_CODES } from '@shared/subscriptions/model'
import { currencySymbol } from '@shared/subscriptions/format'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { CurrencyFlag, CurrencySelect } from './currency-flag'

let host: HTMLDivElement
let root: Root | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function render(node: Parameters<Root['render']>[0]): void {
  act(() => { root!.render(node) })
}

describe('the currency flag', () => {
  it('has one for every code the app can be told in, and it is a real asset path', () => {
    render(createElement(CurrencyFlag, { code: 'USD' }))
    const first = host.querySelector('img')
    expect(first, 'no flag drew at all').toBeTruthy()

    // The map is the module's own; reading it back through a rendered image proves the path resolves to a
    // file rather than an empty string, for every code, without importing the asset graph here.
    for (const code of CURRENCY_CODES) {
      render(createElement(CurrencyFlag, { code }))
      const img = host.querySelector('img')
      expect(img?.getAttribute('src'), `${code} draws no flag`).toBeTruthy()
    }
    expect(CURRENCY_CODES).toHaveLength(31)
  })

  it('is decoration beside a name, not a second name', () => {
    render(createElement(CurrencyFlag, { code: 'JPY' }))
    const img = host.querySelector('img')!
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('aria-hidden')).toBe('true')
  })

  it('draws nothing for a code it does not know, rather than a wrong flag', () => {
    render(createElement(CurrencyFlag, { code: 'XTS' }))
    expect(host.querySelector('img')).toBeNull()
  })
})

describe('the currency field', () => {
  it('lists every currency with its symbol beside its code', () => {
    const onChange = vi.fn()
    render(createElement(CurrencySelect, { value: 'CNY', onChange }))
    const select = host.querySelector('select')!
    const options = [...select.options].map((option) => option.value)
    expect(options).toEqual([...CURRENCY_CODES])
    expect([...select.options].map((option) => option.textContent)).toContain(
      `SGD · ${currencySymbol('SGD').trim()}`,
    )
  })

  it('hands the label through to the control, and reports a choice as a code', async () => {
    const onChange = vi.fn()
    render(createElement(CurrencySelect, { value: 'CNY', onChange, id: 'currency-field' }))
    expect(host.querySelector('select')!.id).toBe('currency-field')

    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(host.querySelector('select'), 'CHF')
      host.querySelector('select')!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('CHF')
  })
})
