import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { APP_TABS } from './app-tabs'
import { AppTabPlaceholder } from './AppTabPlaceholder'

let view: RenderedElement

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
})

afterEach(() => {
  view?.unmount()
})

describe('the container a tab shows before its app exists', () => {
  for (const tab of APP_TABS) {
    it(`says plainly that ${tab.id} has no app behind it yet`, () => {
      view = renderElement(createElement(AppTabPlaceholder, { tabId: tab.id }))
      const label = t(tab.labelKey)
      const text = view.container.textContent ?? ''
      expect(text).toContain(label)
      expect(text).toContain(t('app.tabs.placeholder_hint'))
      // The header and the body name the same container, and nothing else is claimed about it.
      expect(view.container.querySelectorAll('header').length).toBe(1)
      expect(view.container.querySelectorAll('button').length).toBe(0)
    })
  }

  it('is a section the rail can hand an address to, not a dialog over the notebook', () => {
    view = renderElement(createElement(AppTabPlaceholder, { tabId: 'todo' }))
    expect(view.container.querySelector('section')).not.toBeNull()
    expect(document.body.querySelectorAll('[role="dialog"]').length).toBe(0)
  })
})
