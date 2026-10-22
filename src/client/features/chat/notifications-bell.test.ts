// @vitest-environment jsdom
/**
 * The bell, and the centre it raises.
 *
 * Two headers wear this one control — the assistant's own and the subscriptions page — so what is pinned
 * here is what both of them promise: one badge arithmetic, one list read for the tick that asks twice, a
 * press that goes to whoever owns the drawer rather than to a copy of the open state.
 *
 * The rows are pinned for the one thing a delivery promises and a schedule cannot enforce: a notice about a
 * plan carries the door back to that plan, and a notice from a routine does not.
 */
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantNotification } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { api } from '../../lib/api'
import { useAssistant } from './assistant-store'
import { NotificationCenter, NotificationsBell } from './NotificationCenter'

const opened = vi.hoisted(() => vi.fn())
/** What the endpoint answers, so the centre can be shown with rows the store has not just discarded. */
const feed = vi.hoisted(() => ({ rows: [] as AssistantNotification[], unread: 0 }))

vi.mock('../subscriptions/open-subscription', () => ({
  openSubscriptionById: (id: string) => opened(id),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    assistant: {
      notifications: vi.fn(async () => ({ notifications: feed.rows, unread: feed.unread })),
      markNotificationsRead: vi.fn(async () => ({ unread: 0 })),
      deleteNotification: vi.fn(async () => ({ unread: 0 })),
    },
  },
}))

/** A delivery about a plan: the in-app channel writes the pointer, and the row is supposed to honour it. */
const PLAN_DELIVERY: AssistantNotification = {
  id: 'n1',
  title: 'Netflix renews in 3 days',
  body: 'Netflix renews on 2026-11-02.',
  automationId: null,
  subscriptionId: 'sub-1',
  link: null,
  readAt: null,
  createdAt: 1,
}

/** The same row from a routine that was never about anything the app can open. */
const ROUTINE_DELIVERY: AssistantNotification = { ...PLAN_DELIVERY, id: 'n2', subscriptionId: null }

const original = useAssistant.getState()
let root: Root
let host: HTMLElement

const bellNode = () =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${t('assistant.notifications.title')}"]`)
const drawer = () => document.querySelector<HTMLElement>('[data-surface="drawer"]')
const named = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .find((button) => button.getAttribute('aria-label') === label)

type BellProps = ComponentProps<typeof NotificationsBell>

async function showBell(patch: Partial<ReturnType<typeof useAssistant.getState>> = {}, props: Partial<BellProps> = {}): Promise<void> {
  // The read a mounting bell kicks off answers with the same numbers the test asked the store for; other-
  // wise it lands a second later and wipes the badge out from under the assertion.
  feed.rows = patch.notifications ?? []
  feed.unread = patch.unread ?? 0
  // Torn down before the store is told anything, and rebuilt after: a bell re-rendered in place keeps its
  // mount effect, and the question this file asks of a bell is what it does when it arrives at a page. A
  // store write with the older tree still subscribed is also an update React saw coming from nowhere.
  await act(async () => { root.unmount() })
  root = createRoot(host)
  useAssistant.setState({ ...original, notifications: [], unread: 0, ...patch })
  await act(async () => {
    root.render(createElement(NotificationsBell, { open: false, onOpen: () => {}, onClose: () => {}, ...props }))
  })
}

/** Mounts the centre the way the bell does — open, with the rows the endpoint is answering. */
async function showRows(notifications: AssistantNotification[]): Promise<() => void> {
  feed.rows = notifications
  feed.unread = notifications.filter((row) => row.readAt === null).length
  const onClose = vi.fn()
  useAssistant.setState({ ...original, notifications, unread: feed.unread })
  await act(async () => {
    root.render(createElement(NotificationCenter, { open: true, onClose }))
  })
  return onClose
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  feed.rows = []
  feed.unread = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  // Drain a read the case below started and did not wait for: it would otherwise land after the tree is
  // gone, and the warning would be charged to whichever case runs next.
  await act(async () => {})
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

describe('the bell a header wears', () => {
  it('draws the count the reader has not read yet', async () => {
    await showBell({ unread: 3 })
    expect(bellNode(), 'no bell was drawn').toBeTruthy()
    expect(bellNode()!.textContent).toContain('3')
  })

  it('caps the badge instead of widening the header', async () => {
    await showBell({ unread: 14 })
    expect(bellNode()!.textContent).toContain('9+')
  })

  it('leaves the badge out when nothing is waiting, and keeps the same name either way', async () => {
    await showBell({ unread: 0 })
    expect(bellNode()!.textContent).not.toMatch(/\d/)
    expect(bellNode()!.getAttribute('aria-label')).toBe(t('assistant.notifications.title'))
  })

  it('reads the list once for a header that asks twice in the same tick', async () => {
    // Two bells, or one bell and a container bootstrapping behind it: whichever arrived first answers.
    useAssistant.setState({ ...original, notifications: [], unread: 0 })
    await act(async () => {
      root.render(createElement('div', null, [
        createElement(NotificationsBell, { key: 'a', open: false, onOpen: () => {}, onClose: () => {} }),
        createElement(NotificationsBell, { key: 'b', open: false, onOpen: () => {}, onClose: () => {} }),
      ]))
    })
    expect(api.assistant.notifications).toHaveBeenCalledTimes(1)
  })

  it('asks again for the next page it stands on, rather than trusting a stale zero', async () => {
    await showBell()
    expect(api.assistant.notifications).toHaveBeenCalledTimes(1)
    await showBell()
    expect(api.assistant.notifications).toHaveBeenCalledTimes(2)
  })

  it('hands the press to whoever owns the drawer', async () => {
    const onOpen = vi.fn()
    await showBell({ unread: 0 }, { onOpen })
    await act(async () => { bellNode()!.click() })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(drawer(), 'a bell that was told to stay closed raised a drawer').toBeNull()
  })

  it('mounts the centre it was told to show', async () => {
    feed.rows = [PLAN_DELIVERY]
    feed.unread = 1
    useAssistant.setState({ ...original, notifications: [], unread: 0 })
    await act(async () => {
      root.render(createElement(NotificationsBell, { open: true, onOpen: () => {}, onClose: () => {} }))
    })
    expect(drawer(), 'an open bell drew no centre').toBeTruthy()
    expect(drawer()!.textContent).toContain(PLAN_DELIVERY.title)
  })
})

describe('a row the centre shows', () => {
  it('offers to open the plan the delivery was about, and steps aside when it does', async () => {
    const onClose = await showRows([PLAN_DELIVERY])
    const action = named(t('assistant.notifications.open_subscription'))
    expect(action, 'a delivery about a plan drew no door back to it').toBeTruthy()
    await act(async () => { action!.click() })
    expect(opened).toHaveBeenCalledWith('sub-1')
    expect(onClose, 'the centre stayed on top of the panel the reader asked to see').toHaveBeenCalledTimes(1)
  })

  it('offers no door when the delivery came from a routine', async () => {
    await showRows([ROUTINE_DELIVERY])
    expect(named(t('assistant.notifications.open_subscription'))).toBeUndefined()
    expect(named(t('assistant.notifications.delete')), 'a row with nothing to open has nothing to delete either').toBeTruthy()
  })
})
