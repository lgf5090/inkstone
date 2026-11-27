import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { CalendarConnections } from './CalendarConnections'

vi.mock('./api', () => ({
  createCalDavConnection: vi.fn(async () => ({})),
  startConnectionOAuth: vi.fn(async () => ({ url: 'https://example.com/oauth' })),
  deleteConnection: vi.fn(async () => {}),
}))

let view: RenderedElement | null = null

function panel(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!node) throw new Error('the connections dialog did not render a panel')
  return node
}

function control(label: string): HTMLInputElement | HTMLSelectElement {
  const field = [...panel().querySelectorAll<HTMLLabelElement>('label')]
    .find(candidate => candidate.textContent?.trim() === label)
  const control = field?.control
  if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement)) {
    throw new Error(`the "${label}" field has no labelled control`)
  }
  return control
}

afterEach(() => {
  view?.unmount()
  view = null
})

describe('CalendarConnections fields', () => {
  it('keeps project Field labels and hint descriptions associated with their controls', async () => {
    await initI18n()
    view = renderElement(createElement(CalendarConnections, {
      open: true,
      onClose: () => {},
      connections: [],
      onChanged: vi.fn(async () => {}),
    }))

    const server = control(t('calendar.connections.server'))
    const serverHint = panel().querySelector<HTMLElement>(`#${server.getAttribute('aria-describedby')}`)
    expect(server.type).toBe('url')
    expect(serverHint?.textContent).toBe(t('calendar.connections.server_hint'))
    expect(server.labels?.[0]?.textContent?.trim()).toBe(t('calendar.connections.server'))

    const password = control(t('calendar.connections.password'))
    const passwordHint = panel().querySelector<HTMLElement>(`#${password.getAttribute('aria-describedby')}`)
    expect(password.type).toBe('password')
    expect(passwordHint?.textContent).toBe(t('calendar.connections.password_hint'))
    expect(password.labels?.[0]?.textContent?.trim()).toBe(t('calendar.connections.password'))
    expect(control(t('calendar.connections.username')).getAttribute('autocomplete')).toBe('username')
    expect(control(t('calendar.connections.provider')).tagName).toBe('SELECT')
  })

  it('removes the iCloud server field without losing the credential labels', async () => {
    await initI18n()
    view = renderElement(createElement(CalendarConnections, {
      open: true,
      onClose: () => {},
      connections: [],
      onChanged: vi.fn(async () => {}),
    }))
    const provider = control(t('calendar.connections.provider'))
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(provider, 'icloud')
      provider.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect([...panel().querySelectorAll<HTMLLabelElement>('label')].some(label => label.textContent?.trim() === t('calendar.connections.server'))).toBe(false)
    expect(control(t('calendar.connections.username')).labels?.[0]?.textContent?.trim()).toBe(t('calendar.connections.username'))
    expect(control(t('calendar.connections.password')).labels?.[0]?.textContent?.trim()).toBe(t('calendar.connections.password'))
  })
})
