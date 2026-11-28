// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ChannelState } from '@shared/subscriptions/model'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { SubscriptionSettings } from './SubscriptionSettings'

let root: Root
let host: HTMLElement

const telegram: ChannelState = {
  kind: 'telegram', enabled: false, configured: true, hint: '••••1234',
  config: { chatId: '42' }, configuredFields: ['botToken'],
  lastTestAt: '2026-11-28T08:00:00.000Z', lastTestStatus: 'success', lastTestError: '',
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
  vi.clearAllMocks()
})

async function show(onSaveChannel = vi.fn(async () => true)): Promise<void> {
  await act(async () => {
    root.render(createElement(SubscriptionSettings, {
      settings: DEFAULT_SETTINGS,
      channels: [telegram],
      currencies: [],
      categories: [],
      onClose: () => {},
      onSaveSettings: async () => true,
      onSaveChannel,
      onClearChannel: async () => true,
      onTestChannel: async () => {},
      onRotateToken: async () => null,
      onRotateCalendarToken: async () => null,
      onDiagnostics: () => {},
    }))
  })
  const channelsTab = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === t('subscriptions.settings.channels'))
  expect(channelsTab).toBeTruthy()
  await act(async () => { channelsTab!.click() })
}

describe('channel configuration', () => {
  it('expands from the named channel and shows safe saved values', async () => {
    await show()
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(t('subscriptions.channel.telegram')))
    expect(trigger).toBeTruthy()
    await act(async () => { trigger!.click() })
    const chat = [...document.querySelectorAll<HTMLInputElement>('input')]
      .find((input) => input.value === '42')
    expect(chat).toBeTruthy()
    expect(document.body.textContent).toContain(t('subscriptions.channel.secret_configured'))
    expect(document.body.textContent).toContain(t('subscriptions.channel.tested_at', { time: '2026-11-28 16:00:00' }))
  })

  it('marks a sensitive field for clearing and submits that intent', async () => {
    const onSave = vi.fn(async () => true)
    await show(onSave)
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes(t('subscriptions.channel.telegram')))!
        .click()
    })
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === t('subscriptions.channel.clear_field', { field: t('subscriptions.field.bot_token') }))
    expect(clear).toBeTruthy()
    await act(async () => { clear!.click() })
    expect(document.body.textContent).toContain(t('subscriptions.channel.clear_pending'))
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === t('subscriptions.channel.save'))!
        .click()
    })
    expect(onSave).toHaveBeenCalledWith('telegram', expect.objectContaining({ clearFields: ['botToken'] }))
  })
})
