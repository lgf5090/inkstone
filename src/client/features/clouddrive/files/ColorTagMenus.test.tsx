// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { FolderColorMenu, TagEditorMenu } from './ColorTagMenus'

let view: RenderedElement | null = null

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

function setValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function enter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

beforeEach(async () => {
  await initI18n()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('CloudDrive organizer form errors', () => {
  it('associates a custom-colour refusal with the field and keeps keyboard focus there', async () => {
    const onPick = vi.fn()
    view = renderElement(createElement(FolderColorMenu, { value: null, onPick }))
    const input = view.container.querySelector<HTMLInputElement>('input')!
    act(() => {
      input.focus()
      setValue(input, 'not-a-color')
      enter(input)
    })
    await settle()

    const alert = view.container.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toBe(t('clouddrive.color.invalid'))
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(alert.id)
    expect(document.activeElement).toBe(input)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('associates duplicate-tag errors and still supports Enter to add a valid tag', async () => {
    const onAdd = vi.fn()
    view = renderElement(createElement(TagEditorMenu, {
      tags: [{ name: 'Work', color: ORGANIZER_COLORS[0] }],
      onAdd,
      onRemove: vi.fn(),
    }))
    const input = view.container.querySelector<HTMLInputElement>('input')!
    act(() => {
      input.focus()
      setValue(input, 'work')
      enter(input)
    })
    await settle()

    const alert = view.container.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toBe(t('clouddrive.error.conflict'))
    expect(input.getAttribute('aria-describedby')).toBe(alert.id)

    act(() => {
      setValue(input, 'Personal')
      enter(input)
    })
    await settle()
    expect(onAdd).toHaveBeenCalledWith('Personal', ORGANIZER_COLORS[0])
    expect(input.value).toBe('')
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('turns a rejected tag action into a field error instead of an unhandled rejection', async () => {
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    try {
      const onAdd = vi.fn().mockRejectedValue(new Error('refused'))
      view = renderElement(createElement(TagEditorMenu, { tags: [], onAdd, onRemove: vi.fn() }))
      const input = view.container.querySelector<HTMLInputElement>('input')!
      act(() => {
        setValue(input, 'Personal')
        enter(input)
      })
      await settle()

      const alert = view.container.querySelector<HTMLElement>('[role="alert"]')!
      expect(alert.textContent).toBe(t('clouddrive.toast.failed'))
      expect(input.getAttribute('aria-describedby')).toBe(alert.id)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('unhandledrejection', unhandled)
    }
  })
})
