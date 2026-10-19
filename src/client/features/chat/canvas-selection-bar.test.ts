// @vitest-environment jsdom
/**
 * The bar over a canvas selection.
 *
 * What it owns is the handover: the seven actions are buttons with names, the chosen one reaches the
 * parent, and Escape gives the editor its keyboard back. The position arithmetic is the same function
 * the answer bar already tests.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { CanvasSelectionBar } from './CanvasSelectionBar'

let root: Root
let host: HTMLElement

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

describe('the canvas selection bar', () => {
  it('offers every action by name and hands the chosen one to the parent', () => {
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    act(() => root.render(createElement(CanvasSelectionBar, {
      selection: { from: 0, to: 3, text: 'abc', rect: { top: 120, left: 120, width: 60, height: 18 } },
      onAction,
      onDismiss,
    })))
    const bar = document.querySelector('[role="toolbar"]')
    expect(bar, 'the bar did not render').toBeTruthy()
    expect(bar!.getAttribute('aria-label')).toBe(t('assistant.canvas.selection_actions'))
    expect(bar!.querySelectorAll('[data-canvas-action]')).toHaveLength(7)

    const rewrite = bar!.querySelector<HTMLButtonElement>('[data-canvas-action="rewrite"]')!
    expect(rewrite.getAttribute('aria-label')).toBe(t('assistant.edit.rewrite'))
    act(() => { rewrite.click() })
    expect(onAction).toHaveBeenCalledWith('rewrite')
  })

  it('closes on Escape', () => {
    const onDismiss = vi.fn()
    act(() => root.render(createElement(CanvasSelectionBar, {
      selection: { from: 0, to: 3, text: 'abc', rect: { top: 120, left: 120, width: 60, height: 18 } },
      onAction: vi.fn(),
      onDismiss,
    })))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onDismiss).toHaveBeenCalled()
  })
})
