import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { navigateToPath } from '../../lib/app-history'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { APP_TABS } from './app-tabs'
import { AppRail } from './AppRail'

let view: RenderedElement

function tabs(): HTMLAnchorElement[] {
  return [...view.container.querySelectorAll<HTMLAnchorElement>('nav[aria-label] a[href]')]
}

function currentTab(): string | null {
  return tabs().find((tab) => tab.getAttribute('aria-current') === 'page')?.getAttribute('href') ?? null
}

function click(anchor: HTMLAnchorElement, modifiers: Partial<MouseEventInit> = {}): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...modifiers })
  act(() => { anchor.dispatchEvent(event) })
  return event.defaultPrevented
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  useSession.setState({
    user: { id: 'u', login: 'owner', username: 'owner', name: 'Owner', avatarUrl: '', role: 'owner', createdAt: 0 },
  })
  act(() => { window.history.replaceState(null, '', '/') })
  view = renderElement(createElement(AppRail))
})

afterEach(() => {
  view.unmount()
})

describe('the app tab rail', () => {
  it('offers one link per container, in the order the registry lists them', () => {
    const links = tabs()
    expect(links.map((link) => link.getAttribute('href'))).toEqual(APP_TABS.map((tab) => tab.path))
    for (const tab of APP_TABS) {
      const link = links.find((entry) => entry.getAttribute('href') === tab.path)!
      expect(link.getAttribute('aria-label')).toBe(t(tab.labelKey))
      expect(link.getAttribute('aria-label')).not.toBe(tab.labelKey)
    }
  })

  it('marks the notebook current at the bare origin, and nothing else', () => {
    expect(currentTab()).toBe('/notes')
  })

  it('moves the current mark with the address', () => {
    for (const tab of APP_TABS) {
      act(() => { navigateToPath(tab.path) })
      expect(currentTab()).toBe(tab.path)
    }
  })

  it('swaps the container in place when a button is clicked', () => {
    const calendar = tabs().find((link) => link.getAttribute('href') === '/calendar')!
    expect(click(calendar)).toBe(true)
    expect(window.location.pathname).toBe('/calendar')
    expect(currentTab()).toBe('/calendar')
  })

  it('leaves a click the browser owns alone', () => {
    const chat = tabs().find((link) => link.getAttribute('href') === '/chat')!
    // Middle-click and modifier-click are open-in-a-new-tab and friends; intercepting them would
    // turn a rail that links real addresses into one that only appears to.
    expect(click(chat, { ctrlKey: true })).toBe(false)
    expect(click(chat, { metaKey: true })).toBe(false)
    expect(click(chat, { shiftKey: true })).toBe(false)
    expect(click(chat, { altKey: true })).toBe(false)
    expect(window.location.pathname).toBe('/')
  })

  it('follows the back button', () => {
    act(() => { navigateToPath('/reading') })
    expect(currentTab()).toBe('/reading')
    act(() => {
      window.history.replaceState(null, '', '/tools')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(currentTab()).toBe('/tools')
  })

  it('names itself for a reader who hears the rail rather than sees it', () => {
    expect(view.container.querySelector('nav')?.getAttribute('aria-label')).toBe(t('app.tabs.navigation'))
  })
})
