import { act, createElement, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The notebook and the sync engine are both stubbed: what this file is about is which container the
// host puts down for which address, and mounting the real shell would spend the run on CodeMirror.
// The engine is counted by mount rather than by call, because a hook body runs once a render and the
// engine it owns is created once a mount.
const stubs = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
vi.mock('../../lib/sync', () => ({
  useSyncEngine: () => {
    useEffect(() => {
      stubs.mounts += 1
      return () => { stubs.unmounts += 1 }
    }, [])
  },
}))
vi.mock('./AppShell', () => ({
  AppShell: () => createElement('div', { 'data-notebook': '' }),
}))

import { initI18n, t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { AppRail } from './AppRail'
import { AppTabHost } from './AppTabHost'

let view: RenderedElement

function clickTab(path: string): void {
  const link = view.container.querySelector<HTMLAnchorElement>(`nav a[href="${path}"]`)
  if (!link) throw new Error(`the rail offers no link to ${path}`)
  act(() => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
}

function notebook(): HTMLElement | null {
  return view.container.querySelector('[data-notebook]')
}

function placeholderHeading(): string | null {
  return view.container.querySelector('section header span')?.textContent ?? null
}

beforeEach(async () => {
  localStorage.clear()
  stubs.mounts = 0
  stubs.unmounts = 0
  await initI18n()
  act(() => { window.history.replaceState(null, '', '/') })
})

afterEach(() => {
  view?.unmount()
})

describe('the tab host', () => {
  it('puts the notebook in the first container, at the bare origin', () => {
    view = renderElement(createElement(AppTabHost))
    expect(notebook()).not.toBeNull()
    expect(view.container.querySelector('nav')).not.toBeNull()
  })

  it('swaps the container without reloading, and keeps the rail up', () => {
    view = renderElement(createElement(AppTabHost))
    clickTab('/calendar')
    expect(window.location.pathname).toBe('/calendar')
    expect(notebook()).toBeNull()
    expect(placeholderHeading()).toBe(t('app.tabs.calendar'))
    expect(view.container.querySelectorAll('nav a[href]').length).toBe(10)
  })

  it('keeps the sync engine of the account mounted across a tab switch', () => {
    view = renderElement(createElement(AppTabHost))
    expect(stubs.mounts).toBe(1)
    clickTab('/todo')
    clickTab('/notes')
    clickTab('/music')
    expect(notebook()).toBeNull()
    // The engine answers for the account, not the screen: one mount for the whole session is the
    // point of hanging it off the host rather than leaving it inside the notebook.
    expect(stubs.unmounts).toBe(0)
  })

  it('names the container the address asked for, on both sides of the switch', () => {
    view = renderElement(createElement(AppTabHost))
    act(() => { navigateToPath('/reading') })
    expect(placeholderHeading()).toBe(t('app.tabs.reading'))
    expect(view.container.querySelector('nav a[href="/reading"][aria-current="page"]')).not.toBeNull()
  })

  it('renders the rail it is described by', () => {
    view = renderElement(createElement(AppRail))
    expect(view.container.querySelectorAll('nav a[href]').length).toBe(10)
  })
})
