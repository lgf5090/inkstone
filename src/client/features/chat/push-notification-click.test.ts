// @vitest-environment jsdom
/**
 * The other half of `notificationclick`: the page the notice sends the reader to.
 *
 * The worker holds nothing worth showing — the payload is an empty shell, so the notice says only that
 * something is waiting — which means pressing it has to land the reader in the notification centre, or the
 * gesture ends in a tab that looks exactly like the one they were already on. Two ways in, and both are the
 * worker's: an existing page gets a message because reloading it would cost the reader their draft, and a
 * window opened from nothing carries the intent in its address because there is no page to talk to yet.
 *
 * jsdom lays nothing out, so every claim here is about which drawer the app mounted and what the address
 * bar was left holding.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { ChatApp } from './ChatApp'

const harness = vi.hoisted(() => ({
  /** Every `open` the drawer was mounted with, in order, so a drawer that never opens is visible. */
  opens: [] as boolean[],
}))

vi.mock('./ChatView', () => ({ ChatView: () => null }))
vi.mock('./MemoryView', () => ({ MemoryView: () => null }))
vi.mock('./TasksView', () => ({ TasksView: () => null }))
vi.mock('./AutomationsView', () => ({ AutomationsView: () => null }))
vi.mock('./SkillsView', () => ({ SkillsView: () => null }))
vi.mock('./ProjectsView', () => ({ ProjectsView: () => null }))
vi.mock('./AssistantSettingsView', () => ({ AssistantSettingsView: () => null }))
vi.mock('./NotificationCenter', () => {
  const center = ({ open }: { open: boolean }) => {
    if (!harness.opens.includes(open)) harness.opens.push(open)
    return open ? createElement('div', { 'data-notification-drawer': '1' }) : null
  }
  return {
    NotificationCenter: center,
    // The header wears the bell, and the bell is what mounts the centre; the stub delegates, so the push
    // half — which is what this file is about — still lands on a drawer it can look at.
    NotificationsBell: ({ open }: { open: boolean }) => createElement(center, { open }),
  }
})
// The service worker half is not what this file is about, and `initializePwa` would register a real one.
vi.mock('../../store/pwa', () => ({
  initializePwa: () => {},
  requestOfflineWarmup: () => {},
  usePwa: () => false,
}))

const original = useAssistant.getState()
let root: Root
let host: HTMLElement
let worker: EventTarget

const drawer = () => document.querySelector('[data-notification-drawer]')

async function show(): Promise<void> {
  useAssistant.setState({ ...original, bootstrap: async () => {}, loaded: true, error: null, unread: 0, view: 'chat' })
  await act(async () => { root.render(createElement(ChatApp)) })
}

/** Stands up `navigator.serviceWorker` as an event target the worker's postMessage can reach. */
function installServiceWorkerChannel(): void {
  worker = Object.assign(new EventTarget(), {
    controller: null,
    ready: Promise.resolve({}),
  })
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    get: () => worker,
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.opens.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
  useAssistant.setState(original, true)
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

describe('pressing a push notice', () => {
  it('opens the notification centre when the worker messages the page', async () => {
    installServiceWorkerChannel()
    await show()
    expect(drawer(), 'the centre was already open before anything asked for it').toBeNull()

    await act(async () => {
      worker.dispatchEvent(new MessageEvent('message', { data: { type: 'OPEN_NOTIFICATION_CENTER' } }))
    })
    expect(drawer(), 'the worker named the centre and the page ignored it').toBeTruthy()
  })

  it('opens it from the address a cold window was opened with, and takes the intent back out', async () => {
    window.history.replaceState(null, '', '/chat?notifications=1')
    await show()
    expect(drawer(), 'the opened address carries the intent and nothing read it').toBeTruthy()
    expect(window.location.search, 'the intent outlived the drawer, so a reload reopens it').toBe('')
    expect(window.location.pathname).toBe('/chat')
  })

  it('stays shut for a message about something else', async () => {
    installServiceWorkerChannel()
    await show()
    await act(async () => {
      worker.dispatchEvent(new MessageEvent('message', { data: { type: 'OFFLINE_CACHE_STATUS', status: 'ready' } }))
    })
    expect(drawer(), 'an unrelated worker message opened the centre').toBeNull()
  })
})
