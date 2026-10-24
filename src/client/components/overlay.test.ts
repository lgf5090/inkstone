import { act, createElement, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../lib/i18n'
import { ConfirmHost, Modal, confirm } from './overlay'

let container: HTMLDivElement
let root: Root
let trigger: HTMLButtonElement

beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  trigger = document.createElement('button')
  document.body.append(trigger)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  trigger.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mountHost() {
  act(() => root.render(createElement(ConfirmHost)))
}

function ask(title: string, description?: string) {
  let pending = Promise.resolve(false)
  act(() => {
    pending = confirm({ title, description, tone: 'danger' })
  })
  return { result: () => pending }
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]')!
}

function buttonIn(panel: HTMLElement, label: string) {
  return [...panel.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)!
}

describe('confirm', () => {
  it('cancels instead of opening a native dialog while no host is mounted', async () => {
    const native = vi.spyOn(window, 'confirm').mockImplementation(() => true)
    await expect(ask('Delete everything?').result()).resolves.toBe(false)
    expect(native).not.toHaveBeenCalled()
  })

  it('announces itself as a modal dialog labelled by its title and description', async () => {
    mountHost()
    const { result } = ask('Empty the trash?', 'Every note inside is gone.')
    const panel = dialog()
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent).toBe('Empty the trash?')
    expect(document.getElementById(panel.getAttribute('aria-describedby')!)?.textContent).toBe('Every note inside is gone.')
    await act(async () => { buttonIn(panel, t('common.cancel')).click() })
    await expect(result()).resolves.toBe(false)
  })

  it('moves focus into the panel and returns it to the opener on accept', async () => {
    mountHost()
    trigger.focus()
    const { result } = ask('Empty the trash?')
    const panel = dialog()
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(buttonIn(panel, t('common.cancel')))
    await act(async () => { buttonIn(panel, t('overlay.confirm')).click() })
    await expect(result()).resolves.toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on Escape and on a backdrop click, cancelling both times', async () => {
    mountHost()
    trigger.focus()
    const first = ask('Revoke this link?')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await expect(first.result()).resolves.toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    trigger.focus()
    const second = ask('Revoke this link?')
    const backdrop = dialog().parentElement!.firstElementChild!
    await act(async () => { backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await expect(second.result()).resolves.toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps Tab inside the panel and queues a second request behind the first', async () => {
    mountHost()
    const first = ask('Delete the attachment?')
    const second = ask('Clean unreferenced files?')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(dialog().textContent).toContain('Delete the attachment?')

    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    expect(dialog().contains(document.activeElement)).toBe(true)

    await act(async () => { buttonIn(dialog(), t('overlay.confirm')).click() })
    await expect(first.result()).resolves.toBe(true)
    expect(dialog().textContent).toContain('Clean unreferenced files?')
    await act(async () => { buttonIn(dialog(), t('common.cancel')).click() })
    await expect(second.result()).resolves.toBe(false)
  })
})

/**
 * The frame every settings dialog hangs in. A long body has to scroll inside the panel while the footer
 * stays put, and the panel's cap has to leave room for the backdrop's own padding — a dialog as tall as
 * the viewport pushed its footer under the fold, which is how the model editor was reported.
 */
describe('the dialog frame', () => {
  function mountDialog() {
    act(() => root.render(createElement(Modal, {
      open: true,
      onClose: () => undefined,
      title: 'Edit model',
      footer: createElement('button', { type: 'button', onClick: () => undefined }, 'Save'),
      children: createElement('div', { style: { height: '3000px' } }, 'body'),
    })))
  }

  it('scrolls the body under a footer that is not part of it', () => {
    mountDialog()
    const panel = dialog()
    const body = panel.querySelector<HTMLElement>('.overflow-y-auto')
    expect(body, 'the body is not a scroll container').toBeTruthy()
    // min-h-0 is what lets the body shrink inside the flex column instead of pushing the footer out.
    expect(body!.className).toContain('min-h-0')
    const save = buttonIn(panel, 'Save')
    expect(body!.contains(save), 'the footer scrolls away with the body').toBe(false)
    expect(panel.contains(save)).toBe(true)
  })

  it('caps its height below the backdrop padding, so the footer stays on screen', () => {
    mountDialog()
    const panel = dialog()
    // Mobile: the panel may reach the visual viewport. Desktop: the backdrop adds 2rem above and below.
    expect(panel.className).toContain('max-h-[calc(var(--app-viewport-height,100dvh)-env(safe-area-inset-top))]')
    expect(panel.className).toContain('md:max-h-[calc(var(--app-viewport-height,100dvh)-4rem)]')
  })
})

/** A field that takes the caret while the panel is being committed, the way `autoFocus` does. */
function CaretThief() {
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])
  return createElement('input', { ref, 'aria-label': 'Title' })
}

describe('the caret a dialog hands back', () => {
  let frame: HTMLDivElement

  beforeEach(() => {
    // The app frame is in the document on every real surface, so the fallback has something to land on
    // here too — and the first test below is only worth reading if it is there to be missed.
    frame = document.createElement('div')
    frame.setAttribute('data-app-frame', '')
    frame.tabIndex = -1
    document.body.append(frame)
  })

  afterEach(() => {
    frame.remove()
  })

  function mountModal(open: boolean, stealCaret = false) {
    act(() => root.render(createElement(Modal, {
      open,
      onClose: () => undefined,
      title: 'Edit task',
      children: stealCaret
        ? createElement(CaretThief)
        : createElement('button', { type: 'button' }, 'Save'),
    })))
  }

  it('hands the caret back to the trigger that is still on the page', () => {
    trigger.focus()
    mountModal(true)
    expect(document.activeElement, 'the dialog never took the caret').not.toBe(trigger)
    mountModal(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('lands on the app frame when the dialog closes over a deleted trigger', () => {
    trigger.focus()
    mountModal(true)
    // Deleting the row the dialog was opened from is what the reader just did; the trigger, its list item
    // and the control that would have received the caret are all out of the document now.
    trigger.remove()
    mountModal(false)
    expect(document.activeElement, 'the caret was dropped on the page body').toBe(frame)
  })

  it('keeps the reader in the app when the panel had taken the caret into itself', () => {
    trigger.focus()
    mountModal(true, true)
    // A field that steals the caret during the commit — the task editor's `autoFocus` title, measured in
    // a real browser to be what the hook finds when it asks where to go back to — leaves the hook holding
    // a node that dies with the panel. The trigger is still on the page; the hook simply never saw it,
    // and no fallback can invent what it never had.
    expect(document.activeElement, 'the panel never took the caret').not.toBe(trigger)
    expect(dialog().contains(document.activeElement)).toBe(true)
    mountModal(false, true)
    expect(trigger.isConnected).toBe(true)
    expect(document.activeElement, 'a doomed field left the caret on the page body').toBe(frame)
  })
})

describe('confirm focus', () => {
  function askWith(options: Parameters<typeof confirm>[0]) {
    let pending = Promise.resolve(false)
    act(() => {
      pending = confirm(options)
    })
    return pending
  }

  it('puts the first Enter on the safe answer when the action cannot be undone', async () => {
    mountHost()
    const asked = askWith({ title: 'Merge the tags?', tone: 'danger', confirmLabel: 'Merge', cancelLabel: 'Keep' })
    expect(document.activeElement).toBe(buttonIn(dialog(), 'Keep'))
    await act(async () => {
      buttonIn(dialog(), 'Keep').click()
    })
    await expect(asked).resolves.toBe(false)
  })

  it('keeps the primary action focused when the confirm only adds something', async () => {
    mountHost()
    const asked = askWith({ title: 'Create the tag page?', confirmLabel: 'Create', cancelLabel: 'Cancel' })
    expect(document.activeElement).toBe(buttonIn(dialog(), 'Create'))
    await act(async () => {
      buttonIn(dialog(), 'Create').click()
    })
    await expect(asked).resolves.toBe(true)
  })
})
