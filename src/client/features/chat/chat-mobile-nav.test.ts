// @vitest-environment jsdom
/**
 * The chat app's bottom bar on a phone.
 *
 * jsdom has no layout engine, so nothing here measures a pixel. What it measures is the structure the CSS
 * is written against: the bar carries all seven surfaces (no door to forget), every tab is named to
 * assistive tech, and each tab's content carries the chat's own scoped class instead of the notebook's
 * `.mobile-tab-content` — whose 56px per-tab minimum asked for 7 × 56 + 24 = 416px on a 360px phone. A tab
 * that carries the scoped class is a tab the bar can actually fit, because the scoped class is where the
 * smaller minimum and the icon-only breakpoint live.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ASSISTANT_VIEWS, useAssistant } from './assistant-store'
import { ChatApp } from './ChatApp'

/** Every surface but the bar itself: this file is about the navigation, not about what it shows. */
vi.mock('./ChatView', () => ({ ChatView: () => createElement('div', { 'data-surface': 'chat' }) }))
vi.mock('./MemoryView', () => ({ MemoryView: () => createElement('div', { 'data-surface': 'memory' }) }))
vi.mock('./TasksView', () => ({ TasksView: () => createElement('div', { 'data-surface': 'tasks' }) }))
vi.mock('./AutomationsView', () => ({ AutomationsView: () => createElement('div', { 'data-surface': 'automations' }) }))
vi.mock('./SkillsView', () => ({ SkillsView: () => createElement('div', { 'data-surface': 'skills' }) }))
vi.mock('./ProjectsView', () => ({ ProjectsView: () => createElement('div', { 'data-surface': 'projects' }) }))
vi.mock('./AssistantSettingsView', () => ({ AssistantSettingsView: () => createElement('div', { 'data-surface': 'settings' }) }))
vi.mock('./NotificationCenter', () => ({ NotificationCenter: () => null }))

const original = useAssistant.getState()
let root: Root
let host: HTMLElement

/** The phone bar; the desktop rail is the `md:flex` column beside the content. */
const bar = () => document.body.querySelector<HTMLElement>('nav.mobile-bottom-nav')
const rail = () => document.body.querySelector<HTMLElement>('nav[aria-label]:not(.mobile-bottom-nav)')
const tabButtons = () => [...bar()!.querySelectorAll<HTMLButtonElement>('button')]
const tabContents = () => [...bar()!.querySelectorAll<HTMLElement>('button > span')]

async function show(): Promise<void> {
  useAssistant.setState({ ...original, bootstrap: async () => {}, loaded: true, error: null, unread: 0, view: 'chat' })
  await act(async () => { root.render(createElement(ChatApp)) })
}

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
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('the chat app’s phone navigation', () => {
  it('gives the bar a tab per surface, each one named', async () => {
    await show()
    expect(bar(), 'the phone bar is not rendered').toBeTruthy()
    // No overflow door: seven destinations, all of them reachable without a second gesture.
    expect(tabButtons()).toHaveLength(ASSISTANT_VIEWS.length)
    for (const button of tabButtons()) {
      expect(button.getAttribute('aria-label'), 'a tab has no accessible name').toBeTruthy()
    }
    expect(tabButtons().filter((node) => node.getAttribute('aria-current') === 'page')).toHaveLength(1)
  })

  it('keeps the 56px notebook minimum out of the chat bar', async () => {
    await show()
    const contents = tabContents()
    expect(contents).toHaveLength(ASSISTANT_VIEWS.length)
    for (const span of contents) {
      // `classList` compares whole tokens, so the scoped name cannot pass for the notebook's own class.
      expect(span.classList.contains('chat-mobile-tab-content'), 'the tab still uses the notebook minimum').toBe(true)
      expect(span.classList.contains('mobile-tab-content')).toBe(false)
    }
    // The label is its own element, which is what the breakpoint rule hides while the name stays on the
    // button as `aria-label`.
    for (const span of contents) {
      expect(span.querySelector('.chat-mobile-tab-label'), 'the tab names itself outside a labelled span').toBeTruthy()
    }
  })

  it('switches surface from the bar, and leaves the desktop rail alone', async () => {
    await show()
    expect(bar()!.className).toContain('md:hidden')
    expect(rail()!.className).toContain('md:flex')
    const memory = tabButtons().find((node) => node.getAttribute('aria-label') === t('assistant.view.memory'))!
    act(() => { memory.click() })
    expect(useAssistant.getState().view).toBe('memory')
    expect(document.body.querySelector('[data-surface="memory"]')).toBeTruthy()
    expect(memory.getAttribute('aria-current')).toBe('page')
  })
})
