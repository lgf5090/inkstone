import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { NoteLockPasswordDialog, type NoteLockPasswordRequest } from './note-lock-actions'

let rendered: RenderedElement | undefined

function request(mode: 'new' | 'existing' = 'new'): NoteLockPasswordRequest {
  return {
    options: {
      title: t('notelock.lock_title'),
      description: t('notelock.lock_desc'),
      confirmLabel: t('notelock.lock_confirm'),
      mode,
    },
    resolve: vi.fn(),
  }
}

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function flushStrength(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

beforeEach(async () => {
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = undefined
})

describe('note lock password dialog', () => {
  it('shows shared strength feedback and blocks a mismatched confirmation', async () => {
    const pending = request()
    const finish = vi.fn()
    rendered = renderElement(createElement(NoteLockPasswordDialog, { request: pending, finish }))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const inputs = dialog.querySelectorAll<HTMLInputElement>('input[type="password"]')
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(t('notelock.lock_confirm')))!

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(inputs[0])
    expect(inputs).toHaveLength(2)
    expect(confirm.disabled).toBe(true)

    setValue(inputs[0]!, '123')
    await flushStrength()
    expect(dialog.querySelector('[data-testid="password-strength-indicator"]')).not.toBeNull()
    expect(dialog.querySelector('[data-testid="strength-label"]')?.textContent).toBeTruthy()

    setValue(inputs[1]!, '456')
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(t('notelock.password_mismatch'))
    expect(inputs[1]!.getAttribute('aria-invalid')).toBe('true')
    expect(confirm.disabled).toBe(true)

    setValue(inputs[1]!, '123')
    expect(dialog.querySelector('[role="alert"]')).toBeNull()
    expect(confirm.disabled).toBe(false)
    act(() => confirm.click())
    expect(finish).toHaveBeenCalledWith(pending, '123')
  })

  it('uses the same surrounding-whitespace policy as key derivation', () => {
    const pending = request()
    const finish = vi.fn()
    rendered = renderElement(createElement(NoteLockPasswordDialog, { request: pending, finish }))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const inputs = dialog.querySelectorAll<HTMLInputElement>('input[type="password"]')
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(t('notelock.lock_confirm')))!

    setValue(inputs[0]!, '  correct horse  ')
    setValue(inputs[1]!, 'correct horse')
    expect(dialog.querySelector('[role="alert"]')).toBeNull()
    expect(confirm.disabled).toBe(false)
    act(() => confirm.click())
    expect(finish).toHaveBeenCalledWith(pending, 'correct horse')
  })

  it('asks only for the existing password when unlocking or removing encryption', () => {
    const pending = request('existing')
    rendered = renderElement(createElement(NoteLockPasswordDialog, { request: pending, finish: vi.fn() }))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.querySelectorAll('input[type="password"]')).toHaveLength(1)
    expect(dialog.querySelector('[data-testid="password-strength-indicator"]')).toBeNull()
    expect(dialog.querySelector('input')?.getAttribute('autocomplete')).toBe('current-password')
  })
})
