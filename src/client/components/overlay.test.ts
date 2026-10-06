import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../lib/i18n'
import { ConfirmHost, confirm } from './overlay'

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
