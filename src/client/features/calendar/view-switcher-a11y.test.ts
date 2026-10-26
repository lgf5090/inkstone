import { beforeEach, describe, expect, it } from 'vitest'
import { observeViewSwitcher, syncViewSwitcherPressed } from './view-switcher-a11y'

function bar(): HTMLElement {
  document.body.innerHTML = `
    <div class="df-view-switcher">
      <button class="df-view-switcher-btn" data-active="false">日</button>
      <button class="df-view-switcher-btn" data-active="true">周</button>
      <button class="df-view-switcher-btn" data-active="false">月</button>
    </div>
  `
  return document.querySelector<HTMLElement>('.df-view-switcher')!
}

function pressed(): Array<string | null> {
  return [...document.querySelectorAll('.df-view-switcher-btn')].map(node => node.getAttribute('aria-pressed'))
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('the view switcher state', () => {
  it('mirrors data-active into aria-pressed', () => {
    bar()
    expect(syncViewSwitcherPressed(document)).toBe(3)
    expect(pressed()).toEqual(['false', 'true', 'false'])
  })

  it('follows the library when the active view changes', async () => {
    const element = bar()
    const stop = observeViewSwitcher(document)
    expect(pressed()).toEqual(['false', 'true', 'false'])
    const buttons = [...element.querySelectorAll('.df-view-switcher-btn')]
    buttons[0]!.setAttribute('data-active', 'true')
    buttons[1]!.setAttribute('data-active', 'false')
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pressed()).toEqual(['true', 'false', 'false'])
    stop()
  })

  it('stops following once detached', async () => {
    const element = bar()
    const stop = observeViewSwitcher(document)
    stop()
    element.querySelectorAll('.df-view-switcher-btn')[0]!.setAttribute('data-active', 'true')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pressed()[0]).toBe('false')
  })

  it('does nothing when the bar is absent', () => {
    expect(syncViewSwitcherPressed(document)).toBe(0)
    expect(() => observeViewSwitcher(document)()).not.toThrow()
  })
})
