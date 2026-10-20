// @vitest-environment jsdom
/**
 * The rate boxes in the settings panel.
 *
 * What is pinned is the meaning of a box, not its position: the account's pins travel as one map on every
 * blur, so a box left empty is the reader asking for the feed back for that currency rather than a pin of
 * zero, and a box with a number in it is that number. The panel is also the only place a pin can be read,
 * so the saved value has to come back out of the box it was written into.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENCY_CODES, DEFAULT_SETTINGS, type ChannelState, type SubscriptionSettings } from '@shared/subscriptions/model'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { SubscriptionSettings as Panel } from './SubscriptionSettings'

const NO_CHANNELS: ChannelState[] = []

/** The same list the panel draws its boxes from, so a currency added to the app cannot be missed here. */
const RATE_ORDER: string[] = CURRENCY_CODES.filter((code) => code !== 'CNY')

const rateBoxes = () => [...document.querySelectorAll<HTMLInputElement>('[data-rate-boxes] input[type="number"]')]
const boxFor = (code: string): HTMLInputElement | undefined => rateBoxes()[RATE_ORDER.indexOf(code)]
const rowLabels = () => RATE_ORDER.map((code) => t('subscriptions.settings.rate_row', { currency: code }))

async function show(settings: Partial<SubscriptionSettings>, onSaveSettings = vi.fn(async () => true)): Promise<void> {
  const value = { ...DEFAULT_SETTINGS, ...settings }
  await act(async () => {
    root.render(createElement(Panel, {
      settings: value,
      channels: NO_CHANNELS,
      onClose: () => {},
      onSaveSettings: onSaveSettings as (patch: Record<string, unknown>) => Promise<boolean>,
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
  it('offers one per currency the app converts, and no box for the anchor', async () => {
    await show({})
    // Nine codes, less the yuan every other rate is measured against. The count is written out rather
    // than derived because a currency added to the app is a decision about this panel, not a detail.
    expect(RATE_ORDER).toHaveLength(8)
    expect(rateBoxes()).toHaveLength(RATE_ORDER.length)
    const text = document.body.textContent ?? ''
    for (const label of rowLabels()) expect(text).toContain(label)
    expect(text).not.toContain(t('subscriptions.settings.rate_row', { currency: 'CNY' }))
  })

  it('shows the pin the account already carries', async () => {
    await show({ rateOverrides: { USD: 7.2 } })
    expect(boxFor('USD')!.value).toBe('7.2')
  })

  it('sends every pin the boxes hold, not only the one that was touched', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({ rateOverrides: { USD: 7.2, JPY: 0.045 } }, onSaveSettings)
    await typeInto(boxFor('GBP'), '9.4')
    expect(onSaveSettings).toHaveBeenLastCalledWith({ rateOverrides: { USD: 7.2, JPY: 0.045, GBP: 9.4 } })
  })

  it('takes the feed back when a box is emptied', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({ rateOverrides: { USD: 7.2, JPY: 0.045 } }, onSaveSettings)
    await typeInto(boxFor('USD'), '')
    expect(onSaveSettings).toHaveBeenLastCalledWith({ rateOverrides: { JPY: 0.045 } })
  })

  it('offers one control that clears them all, and only when there is something to clear', async () => {
    const onSaveSettings = vi.fn(async () => true)
    await show({ rateOverrides: { USD: 7.2 } }, onSaveSettings)
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(t('subscriptions.settings.rates_clear')))
    expect(clear, 'a pinned account offers no way back to the feed').toBeTruthy()
    await act(async () => { clear!.click() })
    expect(onSaveSettings).toHaveBeenLastCalledWith({ rateOverrides: {} })

    await show({ rateOverrides: {} })
    expect([...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.textContent?.includes(t('subscriptions.settings.rates_clear')))).toBe(false)
  })
})
