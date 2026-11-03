// @vitest-environment jsdom
/**
 * The dialog's caret guard.
 *
 * `useDialogFocus` pulls the caret back when it falls out of a panel — a field that disappears, a
 * primary button that disables itself mid-save. The `focusout` that announces the change arrives
 * *before* the element taking the caret has it, so the restore runs while the document still reports
 * `body`: the guard read every mouse-driven move between fields as a loss and undid it. The page
 * outside a dialog kept focusing normally, which is why the defect looked like "inputs cannot be
 * clicked" once every settings form opened a dialog.
 */
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderElement } from '../lib/test-render'
import { Modal, caretLeavesPanel } from './overlay'

function dialog() {
  return createElement(Modal, {
    open: true,
    onClose: () => undefined,
    title: 'Dialog',
    children: [
      createElement('input', { key: 'first', 'aria-label': 'first' }),
      createElement('input', { key: 'second', 'aria-label': 'second' }),
    ],
  })
}

describe('the caret guard of a dialog', () => {
  it('does not read a move to another field in the panel as the caret leaving', () => {
    const panel = document.createElement('div')
    const inside = document.createElement('input')
    panel.append(inside)
    const outside = document.createElement('input')
    document.body.append(outside)
    expect(caretLeavesPanel({ relatedTarget: inside }, panel), 'a transfer inside the panel was answered as a loss').toBe(false)
    expect(caretLeavesPanel({ relatedTarget: null }, panel), 'a caret going to the page was left outside').toBe(true)
    expect(caretLeavesPanel({ relatedTarget: outside }, panel), 'a caret going to another surface was kept in').toBe(true)
    panel.remove()
    outside.remove()
  })

  it('leaves the caret alone while a move to a field in the panel is in flight', async () => {
    const rendered = renderElement(dialog())
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(panel, 'the dialog drew no panel').toBeTruthy()
    const close = panel!.querySelector<HTMLButtonElement>('button')
    const second = panel!.querySelector<HTMLInputElement>('input[aria-label="second"]')
    expect(close, 'the dialog drew no close button').toBeTruthy()
    expect(second, 'the dialog drew no second field').toBeTruthy()
    // The browser's ordering, kept by faking the gap: the document reports `body` while the next
    // field has not taken the caret yet. A restore here is the one that undid every click.
    const spy = vi.spyOn(close!, 'focus')
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document.body })
    try {
      act(() => {
        close!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: second }))
      })
      await act(async () => { await Promise.resolve() })
      expect(spy, 'the guard took the caret back during a transfer inside the panel').not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(document, 'activeElement')
      spy.mockRestore()
      rendered.unmount()
    }
  })

  it('still takes a caret back into the panel when it really falls out', async () => {
    const rendered = renderElement(dialog())
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(panel, 'the dialog drew no panel').toBeTruthy()
    const first = panel!.querySelector<HTMLInputElement>('input[aria-label="first"]')
    expect(first, 'the dialog drew no field').toBeTruthy()
    act(() => { first!.focus() })
    expect(document.activeElement).toBe(first)
    act(() => {
      first!.blur()
      first!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    })
    await act(async () => { await Promise.resolve() })
    expect(panel!.contains(document.activeElement), 'a lost caret was not pulled back into the dialog').toBe(true)
    rendered.unmount()
  })
})
