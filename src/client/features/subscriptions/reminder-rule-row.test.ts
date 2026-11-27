import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import type { ReminderRuleInput } from '@shared/subscriptions/model'
import { installTestGlobals } from '../../lib/test-render'
import { ReminderRuleRow } from './ReminderRuleRow'

let host: HTMLDivElement
let root: Root
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
})

function render(onPatch: (patch: ReminderRuleInput) => void) {
  act(() => root.render(createElement('ul', null, createElement(ReminderRuleRow, {
    rule: { type: 'before_expiry', value: 7, unit: 'days', isEnabled: true },
    onPatch,
  }))))
  return host.querySelector<HTMLInputElement>('input[type="number"]')!
}

describe('reminder rule number drafts', () => {
  it('waits for blur before writing a typed value', async () => {
    const onPatch = vi.fn()
    const input = render(onPatch)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '14')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onPatch).not.toHaveBeenCalled()
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(onPatch).toHaveBeenCalledWith({ value: 14 })
  })

  it('does not submit zero when the field is cleared', async () => {
    const onPatch = vi.fn()
    const input = render(onPatch)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(onPatch).not.toHaveBeenCalled()
    expect(input.value).toBe('7')
  })
})
