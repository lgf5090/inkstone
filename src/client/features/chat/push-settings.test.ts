// @vitest-environment jsdom
/**
 * The push rows in assistant settings, driven from the presses a reader actually has.
 *
 * Three things are proved here and none of them is the store's arithmetic. First, that a switch only
 * appears when pressing it would do something: no VAPID keys on the server, a browser that blocks
 * notifications, an insecure address or a browser with no push at all each get a sentence naming which one
 * it is — and for the server's half the sentence is the server's own, because `GET /push/config` names the
 * variable that was never set. Second, that `requestPermission()` is spent by a press and never by a mount.
 * Third, the chain a reader needs to work: press on → the browser's `PushManager.subscribe` with the key
 * this route handed out → a real POST to `/api/assistant/push/subscriptions` → the device listed, and
 * removable again. Fourth, that the list itself is read: mounting the screen asks
 * `GET /api/assistant/push/subscriptions`, so an account that has devices shows them before anything is
 * written and an account that has none is told so by the server rather than by the screen's own silence.
 *
 * jsdom ships no `Notification`, no `PushManager` and no service worker, so all three are stood up as
 * concrete fakes; `fetch` is stubbed so the assertions are about the requests that actually went out.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushSubscriptionRow } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { PushDevicesSection } from './PushDevicesSection'
import { usePushDevices } from './push-devices'

const PUBLIC_KEY = 'BFakeVapidPublicKeyBase64UrlValue'
const FULL_ENDPOINT = 'https://push.example.org/s/abcdef0123456789'
/** What the route echoes back for that endpoint: the origin and the first path segment, then the ellipsis. */
const ENDPOINT_HEAD = 'https://push.example.org/s…'
const CONFIG_PATH = '/api/assistant/push/config'
const SUBSCRIPTIONS_PATH = '/api/assistant/push/subscriptions'

interface ConfigAnswer {
  status: number
  body: Record<string, unknown>
}

class FakeSubscription {
  unsubscribed = false
  readonly unsubscribe = vi.fn(async () => {
    this.unsubscribed = true
    return true
  })

  constructor(readonly endpoint: string) {}

  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: 'p256dhValue', auth: 'authValue' } }
  }
}

class FakePushManager {
  readonly subscribe = vi.fn(async (options: { userVisibleOnly?: boolean, applicationServerKey?: string | null }) => {
    subscribeOptions.push(options)
    held = new FakeSubscription(FULL_ENDPOINT)
    return held
  })
  readonly getSubscription = vi.fn(async () => held)
}

let root: Root
let host: HTMLElement
let configAnswer: ConfigAnswer | null
let hangConfig = false
/** What `GET /push/subscriptions` answers: the account's list before anything was written here. */
let listAnswer: ConfigAnswer | null
let hangList = false
/** What each write answers with as the account's list. */
let listAfterWrite: PushSubscriptionRow[]
let requests: Array<{ method: string, url: string, body: Record<string, unknown> | null }>
let subscribeOptions: Array<{ userVisibleOnly?: boolean, applicationServerKey?: string | null }>
let held: FakeSubscription | null
let permission: NotificationPermission
let permissionAsks: number
let pushManager: FakePushManager

function row(id: string, endpoint: string, over: Partial<PushSubscriptionRow> = {}): PushSubscriptionRow {
  return { id, endpoint, createdAt: 1_700_000_000_000, failures: 0, lastError: null, ...over }
}

function configured(): ConfigAnswer {
  return { status: 200, body: { enabled: true, publicKey: PUBLIC_KEY } }
}

function unconfigured(): ConfigAnswer {
  return { status: 200, body: { enabled: false, publicKey: null, reason: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set on this deployment.' } }
}

/** Stages what the account's device read answers with. */
function listContains(devices: PushSubscriptionRow[]): void {
  listAnswer = { status: 200, body: { subscriptions: devices } }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function installBrowser(options: { secure?: boolean, pushManager?: boolean } = {}): void {
  pushManager = new FakePushManager()
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: options.secure ?? true })
  if (options.pushManager ?? true) {
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} })
  } else {
    Reflect.deleteProperty(window, 'PushManager')
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    get: () => ({
      ready: Promise.resolve({ pushManager }),
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
  class FakeNotification {
    static get permission(): NotificationPermission { return permission }
    static readonly requestPermission = vi.fn(async () => {
      permissionAsks++
      return permission
    })
  }
  vi.stubGlobal('Notification', FakeNotification)
}

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({
      method,
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null,
    })
    if (url.endsWith(CONFIG_PATH)) {
      if (hangConfig) return new Promise<Response>(() => {})
      if (!configAnswer) return json({ error: { code: 'internal', message: 'no answer staged' } }, 500)
      return json(configAnswer.body, configAnswer.status)
    }
    if (url.endsWith(SUBSCRIPTIONS_PATH)) {
      // The read is its own answer: the list the account holds is what `GET` returns, staged apart from what
      // a write echoes back, so a case can tell "nothing was read" from "nothing is subscribed".
      if (method === 'GET') {
        if (hangList) return new Promise<Response>(() => {})
        if (!listAnswer) return json({ error: { code: 'internal', message: 'no list answer staged' } }, 500)
        return json(listAnswer.body, listAnswer.status)
      }
      if (refuseWrite) return json({ error: { code: 'bad_request', message: 'keys.p256dh must be 88 characters.' } }, 400)
      return json({ removed: method === 'DELETE', subscriptions: listAfterWrite }, method === 'POST' ? 201 : 200)
    }
    return json({ error: { code: 'not_found', message: 'nothing at this path' } }, 404)
  }))
}

let refuseWrite = false

const switches = () => [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
const alerts = () => [...document.querySelectorAll<HTMLElement>('[role="alert"]')]
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const buttonNamed = (name: string) => buttons().find((node) => (node.textContent ?? '').includes(name))
const listItems = () => [...document.querySelectorAll<HTMLElement>('ul[aria-label] > li')]
const text = () => document.body.textContent ?? ''

async function mount(): Promise<void> {
  await act(async () => { root.render(createElement(PushDevicesSection)) })
}

/**
 * Presses a real control and lets the chain it started settle.
 *
 * The press runs `requestPermission` → `pushManager.subscribe` → a `fetch`, so one microtask is not the end
 * of it; a macrotask tick is what lets every link in that chain report before the case reads the screen.
 */
async function press(node: HTMLElement | undefined): Promise<void> {
  expect(node, 'the control the case is about is not on the screen').toBeTruthy()
  await act(async () => {
    node!.click()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  configAnswer = configured()
  hangConfig = false
  // A cold read that answered "no devices" is the ordinary case; a case that wants rows stages them itself.
  listAnswer = { status: 200, body: { subscriptions: [] } }
  hangList = false
  refuseWrite = false
  listAfterWrite = [row('r1', ENDPOINT_HEAD)]
  requests = []
  subscribeOptions = []
  held = null
  permission = 'default'
  permissionAsks = 0
  installBrowser()
  installFetch()
  // Merged rather than replaced: the store's own actions have to survive the reset, since the component
  // calls them the moment it mounts.
  usePushDevices.setState({
    config: null,
    configFailure: null,
    rows: null,
    rowsFailure: null,
    deviceEndpoint: null,
    support: 'available',
    permission: 'default',
    busy: null,
    actionFailure: null,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'serviceWorker')
  Reflect.deleteProperty(window, 'PushManager')
})

describe('the switch that may not appear', () => {
  it('offers nothing while the config read has not answered', async () => {
    hangConfig = true
    await mount()
    expect(switches(), 'a switch was offered before the server had said anything').toHaveLength(0)
  })

  it('names the unconfigured server in its own words and shows no switch', async () => {
    configAnswer = unconfigured()
    await mount()
    expect(switches(), 'an unconfigured deployment was offered a switch that could do nothing').toHaveLength(0)
    expect(text()).toContain(t('assistant.push.server_off'))
    expect(text()).toContain('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set on this deployment.')
    expect(text()).toContain(t('assistant.push.server_off_hint'))
  })

  it('keeps the permission ask for the press instead of spending it on mount', async () => {
    await mount()
    expect(permissionAsks, 'the browser was asked to allow notifications before anything was pressed').toBe(0)
    await press(switches()[0])
    expect(permissionAsks, 'pressing the switch never reached the browser’s permission ask').toBe(1)
  })

  it('says so when the browser blocks notifications, and offers the check that can fix it', async () => {
    permission = 'denied'
    await mount()
    expect(switches(), 'a blocked browser was offered a switch').toHaveLength(0)
    expect(text()).toContain(t('assistant.push.denied'))

    permission = 'granted'
    await press(buttonNamed(t('assistant.push.recheck')))
    expect(switches(), 'the re-check was a label, not a working read').toHaveLength(1)
  })

  it('names an insecure address as the reason there is nothing to offer', async () => {
    installBrowser({ secure: false })
    await mount()
    expect(switches()).toHaveLength(0)
    expect(text()).toContain(t('assistant.push.insecure'))
  })

  it('names a browser with no push as the reason there is nothing to offer', async () => {
    installBrowser({ pushManager: false })
    await mount()
    expect(switches()).toHaveLength(0)
    expect(text()).toContain(t('assistant.push.unsupported'))
  })

  it('refuses a config it could not read with the route’s line, and asks again on retry', async () => {
    configAnswer = { status: 500, body: { error: { code: 'internal', message: 'D1 is not bound on this deployment.' } } }
    await mount()
    expect(switches()).toHaveLength(0)
    expect(alerts().map((node) => node.textContent).join(' ')).toContain(t('assistant.push.load_failed'))
    expect(text()).toContain('D1 is not bound on this deployment.')
    expect(requests.filter((entry) => entry.url.endsWith(CONFIG_PATH))).toHaveLength(1)

    configAnswer = configured()
    const retry = buttonNamed(t('common.retry'))
    await press(retry)
    expect(requests.filter((entry) => entry.url.endsWith(CONFIG_PATH))).toHaveLength(2)
    expect(switches(), 'the second read succeeded and still no switch appeared').toHaveLength(1)
  })
})

describe('turning this device on', () => {
  it('walks from the press to the browser, to the route, and back to the list', async () => {
    permission = 'granted'
    await mount()
    const control = switches()[0]
    expect(control, 'no switch on a configured deployment with a willing browser').toBeTruthy()
    expect(control.getAttribute('aria-checked')).toBe('false')
    await press(control)

    // The key the route named, not one the page invented.
    expect(subscribeOptions).toHaveLength(1)
    expect(subscribeOptions[0]!.applicationServerKey).toBe(PUBLIC_KEY)
    expect(subscribeOptions[0]!.userVisibleOnly).toBe(true)

    const posted = requests.find((entry) => entry.method === 'POST' && entry.url.endsWith(SUBSCRIPTIONS_PATH))
    expect(posted, 'nothing was ever POSTed to the subscription route').toBeTruthy()
    expect(posted!.body).toMatchObject({ endpoint: FULL_ENDPOINT, keys: { p256dh: 'p256dhValue', auth: 'authValue' } })
    expect(JSON.stringify(posted!.body)).not.toContain(PUBLIC_KEY)

    expect(switches()[0]!.getAttribute('aria-checked'), 'the switch did not come back on').toBe('true')
    const items = listItems()
    expect(items, 'the device never appeared in the list').toHaveLength(1)
    expect(items[0]!.textContent).toContain(ENDPOINT_HEAD)
    expect(items[0]!.textContent).toContain(t('assistant.push.revoke'))
  })

  it('prints the head the route gave and never the whole endpoint', async () => {
    permission = 'granted'
    await mount()
    await press(switches()[0])
    expect(text()).toContain(ENDPOINT_HEAD)
    expect(text(), 'the credential-shaped tail reached the screen').not.toContain('abcdef0123456789')
  })

  it('keeps the refusal the route wrote, and retries the same write', async () => {
    permission = 'granted'
    refuseWrite = true
    await mount()
    await press(switches()[0])
    expect(alerts(), 'a refused subscription said nothing').toHaveLength(1)
    expect(text()).toContain(t('assistant.push.enable_failed'))
    expect(text()).toContain('keys.p256dh must be 88 characters.')
    expect(listItems(), 'a refused write still listed a device').toHaveLength(0)

    refuseWrite = false
    await press(buttonNamed(t('common.retry')))
    expect(listItems()).toHaveLength(1)
  })

  it('says the account has nothing subscribed once its device read says so', async () => {
    permission = 'granted'
    listAfterWrite = []
    await mount()
    expect(text()).toContain(t('assistant.push.devices_empty'))
    expect(text()).not.toContain(t('assistant.push.devices_reading'))
    await press(switches()[0])
    expect(listItems()).toHaveLength(0)
    expect(text()).toContain(t('assistant.push.devices_empty'))
  })
})

describe('reading the account’s devices before anything is written', () => {
  it('asks the device route on mount and prints what it answers', async () => {
    listContains([row('r1', ENDPOINT_HEAD), row('r2', 'https://other.test/push…', { failures: 3, lastError: 'the push service answered 500' })])
    await mount()
    const reads = requests.filter((entry) => entry.method === 'GET' && entry.url.endsWith(SUBSCRIPTIONS_PATH))
    expect(reads, 'the screen never asked the server which devices this account has').toHaveLength(1)
    const items = listItems()
    expect(items, 'the devices the route named never reached the list').toHaveLength(2)
    expect(items[0]!.textContent).toContain(ENDPOINT_HEAD)
    expect(items[1]!.textContent).toContain('https://other.test/push…')
    expect(items[1]!.textContent).toContain('the push service answered 500')
    expect(text()).not.toContain(t('assistant.push.devices_reading'))
  })

  it('gets there without spending a write', async () => {
    listContains([row('r1', ENDPOINT_HEAD)])
    await mount()
    const written = requests.filter((entry) => entry.method !== 'GET')
    expect(written, 'the device list arrived only because something was written').toEqual([])
  })

  it('names the read still running instead of guessing at its answer', async () => {
    hangList = true
    await mount()
    expect(text()).toContain(t('assistant.push.devices_reading'))
    expect(listItems()).toHaveLength(0)
    expect(alerts(), 'a read still in flight was reported as a failure').toHaveLength(0)
    expect(text(), 'a read that has not answered was reported as an empty account').not.toContain(t('assistant.push.devices_empty'))
  })

  it('refuses to call an unread list an empty account, and asks again on retry', async () => {
    listAnswer = { status: 500, body: { error: { code: 'internal', message: 'D1 is unavailable on this deployment.' } } }
    await mount()
    expect(text(), 'a list that would not come back was reported as no devices').not.toContain(t('assistant.push.devices_empty'))
    expect(alerts().map((node) => node.textContent).join(' ')).toContain(t('assistant.push.devices_failed'))
    expect(text()).toContain('D1 is unavailable on this deployment.')

    listAnswer = { status: 200, body: { subscriptions: [row('r1', ENDPOINT_HEAD)] } }
    await press(buttonNamed(t('common.retry')))
    expect(requests.filter((entry) => entry.method === 'GET' && entry.url.endsWith(SUBSCRIPTIONS_PATH))).toHaveLength(2)
    expect(listItems()).toHaveLength(1)
    expect(alerts(), 'the second read succeeded and still reported a failure').toHaveLength(0)
  })
})

describe('turning this device off', () => {
  it('unsubscribes the browser and deletes the endpoint it held', async () => {
    permission = 'granted'
    await mount()
    await press(switches()[0])
    const subscription = held
    expect(subscription).toBeTruthy()

    await press(switches()[0])
    expect(subscription!.unsubscribe).toHaveBeenCalled()
    const deleted = requests.find((entry) => entry.method === 'DELETE' && entry.url.endsWith(SUBSCRIPTIONS_PATH))
    expect(deleted, 'nothing was DELETEd when the switch went off').toBeTruthy()
    expect(deleted!.body).toEqual({ endpoint: FULL_ENDPOINT })
    expect(switches()[0]!.getAttribute('aria-checked')).toBe('false')
  })

  it('removes the device from the row list with the same write', async () => {
    permission = 'granted'
    listAfterWrite = [row('r1', ENDPOINT_HEAD), row('r2', 'https://other.test/push…')]
    await mount()
    await press(switches()[0])
    expect(listItems()).toHaveLength(2)
    // Only the row this page can prove is its own gets a door out; the other says what it is.
    expect(buttonNamed(t('assistant.push.revoke'))).toBeTruthy()
    expect(text()).toContain(t('assistant.push.other_rows_locked'))
    expect(listItems()[1]!.textContent).toContain(t('assistant.push.not_this_device'))

    listAfterWrite = [row('r2', 'https://other.test/push…')]
    await press(buttonNamed(t('assistant.push.revoke')))
    expect(listItems()).toHaveLength(1)
    expect(listItems()[0]!.textContent).toContain('https://other.test/push…')
  })
})
