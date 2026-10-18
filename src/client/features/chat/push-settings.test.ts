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
import { PUSH_DEVICE_ROW_STORAGE_KEY, usePushDevices } from './push-devices'

const PUBLIC_KEY = 'BFakeVapidPublicKeyBase64UrlValue'
const FULL_ENDPOINT = 'https://push.example.org/s/abcdef0123456789'
/**
 * What the route answers for that endpoint: its origin and a digest of the whole thing.
 *
 * Deliberately not a prefix of `FULL_ENDPOINT` — the first path segment of an endpoint is where a short-path
 * push service puts the token, so nothing of the path may come back. The screen therefore has another way to
 * point at the reader's own row, and the cases below prove which one it uses.
 */
const MASKED_ENDPOINT = 'https://push.example.org#Kp9mZ3tQ'
/** A second device's label, spelled the same way and carrying nothing of its endpoint. */
const OTHER_MASKED_ENDPOINT = 'https://other.test#Qv3nY8kP'
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
    if (url.includes(SUBSCRIPTIONS_PATH)) {
      if (method === 'DELETE') {
        // A revoke is addressed by the row's id, in the path — the whole endpoint is never sent for it.
        if (refuseRevoke) return json({ error: { code: 'not_found', message: 'No device subscribed for this account carries that id.' } }, 404)
        return json({ removed: true, subscriptions: listAfterWrite })
      }
      // The read is its own answer: the list the account holds is what `GET` returns, staged apart from what
      // a write echoes back, so a case can tell "nothing was read" from "nothing is subscribed".
      if (method === 'GET') {
        if (hangList) return new Promise<Response>(() => {})
        if (!listAnswer) return json({ error: { code: 'internal', message: 'no list answer staged' } }, 500)
        return json(listAnswer.body, listAnswer.status)
      }
      if (refuseWrite) return json({ error: { code: 'bad_request', message: 'keys.p256dh must be 88 characters.' } }, 400)
      // The write names the row this browser's endpoint became — the only handle the screen has for
      // "this device", since every endpoint on the list is a digest and none is a prefix of anything.
      return json({ subscriptions: listAfterWrite, deviceId: writeDeviceId }, 201)
    }
    return json({ error: { code: 'not_found', message: 'nothing at this path' } }, 404)
  }))
}

let refuseWrite = false
let refuseRevoke = false
/** Which row of `listAfterWrite` the subscription write claims this browser's endpoint resolved to. */
let writeDeviceId = 'r1'

const switches = () => [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
/**
 * The sentences that send the reader to the switch above the list, read against the switch they name.
 *
 * Pinned the way `composer-a11y-final.test.ts` pins a disabled control's reason: the claim is taken off the
 * rendered tree and the thing it claims is looked for in the same tree, so a sentence pointing at a control
 * nobody drew cannot pass — which is the mistake this screen has now made three times.
 */
function switchClaims(): string[] {
  return [...document.querySelectorAll<HTMLElement>('p')]
    .filter((node) => (node.textContent ?? '').includes(t('assistant.push.devices_empty')))
    .map((node) => (node.closest('section')?.querySelector('[role="switch"]')
      ? 'names the switch that is on the screen'
      : 'names a switch that is not on the screen'))
}
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
  refuseRevoke = false
  writeDeviceId = 'r1'
  // This browser remembers its own row across visits; every case starts with a browser that never was here.
  localStorage.clear()
  listAfterWrite = [row('r1', MASKED_ENDPOINT)]
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
    deviceId: null,
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

  it('names the unconfigured server without drawing a switch, and keeps the route’s line as detail', async () => {
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
    expect(items[0]!.textContent).toContain(MASKED_ENDPOINT)
    expect(items[0]!.textContent).toContain(t('assistant.push.revoke'))
    // The write's answer is what marks this row as the browser's own, and the browser keeps that id for the
    // next visit: the list carries digests, so nothing on it could be matched against an endpoint.
    expect(localStorage.getItem(PUSH_DEVICE_ROW_STORAGE_KEY)).toBe('r1')
  })

  it('prints the digest label the route gave and no part of the endpoint behind it', async () => {
    permission = 'granted'
    await mount()
    await press(switches()[0])
    expect(text()).toContain(MASKED_ENDPOINT)
    expect(text(), 'the credential-shaped tail reached the screen').not.toContain('abcdef0123456789')
    for (const segment of new URL(FULL_ENDPOINT).pathname.split('/').filter(Boolean)) {
      if (segment.length < 8) continue
      expect(text(), `the screen printed a whole path segment of the endpoint: ${segment}`).not.toContain(segment)
    }
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
    listContains([row('r1', MASKED_ENDPOINT), row('r2', OTHER_MASKED_ENDPOINT, { failures: 3, lastError: 'the push service answered 500' })])
    await mount()
    const reads = requests.filter((entry) => entry.method === 'GET' && entry.url.endsWith(SUBSCRIPTIONS_PATH))
    expect(reads, 'the screen never asked the server which devices this account has').toHaveLength(1)
    const items = listItems()
    expect(items, 'the devices the route named never reached the list').toHaveLength(2)
    expect(items[0]!.textContent).toContain(MASKED_ENDPOINT)
    expect(items[1]!.textContent).toContain(OTHER_MASKED_ENDPOINT)
    expect(items[1]!.textContent).toContain('the push service answered 500')
    expect(text()).not.toContain(t('assistant.push.devices_reading'))
  })

  it('gets there without spending a write', async () => {
    listContains([row('r1', MASKED_ENDPOINT)])
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

    listAnswer = { status: 200, body: { subscriptions: [row('r1', MASKED_ENDPOINT)] } }
    await press(buttonNamed(t('common.retry')))
    expect(requests.filter((entry) => entry.method === 'GET' && entry.url.endsWith(SUBSCRIPTIONS_PATH))).toHaveLength(2)
    expect(listItems()).toHaveLength(1)
    expect(alerts(), 'the second read succeeded and still reported a failure').toHaveLength(0)
  })
})

describe('turning this device off', () => {
  it('unsubscribes the browser and deletes the row the write named for it', async () => {
    permission = 'granted'
    await mount()
    await press(switches()[0])
    const subscription = held
    expect(subscription).toBeTruthy()

    await press(switches()[0])
    expect(subscription!.unsubscribe).toHaveBeenCalled()
    const deleted = requests.filter((entry) => entry.method === 'DELETE')
    expect(deleted, 'nothing was DELETEd when the switch went off').toHaveLength(1)
    // Addressed by the row's id, with no body: the whole endpoint stays in the browser that made it.
    expect(deleted[0]!.url).toContain(`${SUBSCRIPTIONS_PATH}/r1`)
    expect(deleted[0]!.body).toBeNull()
    expect(JSON.stringify(deleted[0]!.url), 'the credential-shaped tail reached the request').not.toContain('abcdef0123456789')
    expect(switches()[0]!.getAttribute('aria-checked')).toBe('false')
    // A row that has been removed leaves no record behind to be mistaken for the next subscription.
    expect(localStorage.getItem(PUSH_DEVICE_ROW_STORAGE_KEY)).toBeNull()
  })

  it('turns off the row an earlier visit was told is this browser’s, by its id alone', async () => {
    // The cold case: the browser still holds the subscription it made on an earlier visit and nothing at all
    // has been written in this one. The label the read answers with shares no character with the endpoint the
    // browser holds, so a client that compared endpoint text would find nothing here to turn off; the row id
    // the earlier visit was given is the only thing that can name it.
    permission = 'granted'
    held = new FakeSubscription(FULL_ENDPOINT)
    localStorage.setItem(PUSH_DEVICE_ROW_STORAGE_KEY, 'r7')
    listContains([row('r7', OTHER_MASKED_ENDPOINT), row('r1', MASKED_ENDPOINT)])
    await mount()
    expect(switches()[0]!.getAttribute('aria-checked'), 'the subscription the browser holds was not read back').toBe('true')
    expect(listItems()[0]!.textContent, 'the remembered row was not labelled as this device').toContain(t('assistant.push.revoke'))
    expect(listItems()[1]!.textContent).toContain(t('assistant.push.not_this_device'))

    await press(switches()[0])
    const deleted = requests.filter((entry) => entry.method === 'DELETE')
    expect(deleted, 'a device the read named could not be turned off').toHaveLength(1)
    expect(deleted[0]!.url).toContain(`${SUBSCRIPTIONS_PATH}/r7`)
    expect(deleted[0]!.body).toBeNull()
    expect(JSON.stringify(deleted[0]!.url), 'the endpoint was sent to address the delete').not.toContain('abcdef0123456789')
    expect(localStorage.getItem(PUSH_DEVICE_ROW_STORAGE_KEY)).toBeNull()
  })

  it('marks the row the write named even when another row carries the same label', async () => {
    // The control against any matching on endpoint text: two rows whose labels are identical characters, so
    // only the id the write returned can say which of them is this device.
    permission = 'granted'
    const twins = [row('r1', MASKED_ENDPOINT), row('r2', MASKED_ENDPOINT)]
    listContains(twins)
    listAfterWrite = twins
    writeDeviceId = 'r2'
    await mount()
    await press(switches()[0])
    expect(listItems()).toHaveLength(2)
    expect(listItems()[0]!.textContent).toContain(t('assistant.push.not_this_device'))
    expect(listItems()[1]!.textContent, 'the row the write named was not marked as this device').toContain(t('assistant.push.revoke'))

    listAfterWrite = [row('r1', MASKED_ENDPOINT)]
    await press(switches()[0])
    const deleted = requests.filter((entry) => entry.method === 'DELETE')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]!.url, 'the switch went through the wrong row').toContain(`${SUBSCRIPTIONS_PATH}/r2`)
  })

  it('takes the browser off in silence when no row was ever named for it', async () => {
    // A device this screen never subscribed has no row id to spend, and guessing one from endpoint text is the
    // leak the redaction exists to stop. The browser is unsubscribed, nothing is deleted, and every row keeps
    // its own revoke — which is the truth on the screen rather than a failure invented for it.
    permission = 'granted'
    held = new FakeSubscription(FULL_ENDPOINT)
    listContains([row('r1', MASKED_ENDPOINT), row('r2', OTHER_MASKED_ENDPOINT)])
    await mount()
    await press(switches()[0])
    expect(held!.unsubscribe, 'the browser kept its subscription').toHaveBeenCalled()
    expect(requests.filter((entry) => entry.method === 'DELETE'), 'a row was deleted on a guess').toEqual([])
    expect(alerts(), 'a device the account never named was reported as a failure').toHaveLength(0)
    expect(buttonNamed(t('assistant.push.revoke_other')), 'a row lost its own way out').toBeTruthy()
    expect(switches()[0]!.getAttribute('aria-checked')).toBe('false')
  })
})

describe('revoking any device of the account', () => {
  /** Two devices, one of them this browser's, as both the read and the writes describe them. */
  function twoDevices(): void {
    const rows = [row('r1', MASKED_ENDPOINT), row('r2', OTHER_MASKED_ENDPOINT)]
    listContains(rows)
    listAfterWrite = rows
  }

  /** Subscribes this browser so the list holds one row this page can prove is its own. */
  async function subscribeThisDevice(): Promise<void> {
    await press(switches()[0])
    expect(listItems()).toHaveLength(2)
  }

  it('puts a way out on every row and says what a revoke costs that device', async () => {
    permission = 'granted'
    twoDevices()
    await mount()
    await subscribeThisDevice()
    expect(buttonNamed(t('assistant.push.revoke')), 'this device lost its own door out').toBeTruthy()
    expect(buttonNamed(t('assistant.push.revoke_other')), 'a second device has no way to be removed').toBeTruthy()
    expect(listItems()[1]!.textContent).toContain(t('assistant.push.not_this_device'))
    expect(text()).toContain(t('assistant.push.revoke_hint'))
  })

  it('revokes another device by the id its row carries', async () => {
    permission = 'granted'
    twoDevices()
    await mount()
    await subscribeThisDevice()
    listAfterWrite = [row('r1', MASKED_ENDPOINT)]
    await press(buttonNamed(t('assistant.push.revoke_other')))

    const deleted = requests.filter((entry) => entry.method === 'DELETE')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]!.url).toContain(`${SUBSCRIPTIONS_PATH}/r2`)
    expect(deleted[0]!.body).toBeNull()
    expect(JSON.stringify(deleted[0]), 'a revoke still sent the whole endpoint').not.toContain('abcdef0123456789')
    const items = listItems()
    expect(items, 'the revoked device stayed on the list').toHaveLength(1)
    expect(items[0]!.textContent).toContain(MASKED_ENDPOINT)
    expect(items[0]!.textContent, 'the remaining device was mislabelled as another one').not.toContain(t('assistant.push.not_this_device'))
  })

  it('keeps the route’s line when a revoke is refused, and retries the same row', async () => {
    permission = 'granted'
    twoDevices()
    await mount()
    await subscribeThisDevice()
    refuseRevoke = true
    await press(buttonNamed(t('assistant.push.revoke_other')))
    expect(alerts(), 'a refused revoke said nothing').toHaveLength(1)
    expect(text()).toContain(t('assistant.push.revoke_failed'))
    expect(text()).toContain('No device subscribed for this account carries that id.')
    expect(listItems()).toHaveLength(2)

    refuseRevoke = false
    listAfterWrite = [row('r1', MASKED_ENDPOINT)]
    await press(buttonNamed(t('common.retry')))
    const deleted = requests.filter((entry) => entry.method === 'DELETE')
    expect(deleted, 'the retry never asked for the same device again').toHaveLength(2)
    // The retry re-names r2, the row that failed — not this browser's own row, and not a second press of
    // the switch that subscribed this one.
    expect(deleted[1]!.url).toContain(`${SUBSCRIPTIONS_PATH}/r2`)
    expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(1)
    expect(listItems()).toHaveLength(1)
    expect(alerts(), 'the retry succeeded and the failure stayed on the screen').toHaveLength(0)
  })
})

describe('the sentence that sends the reader to the switch above the list', () => {
  it('is not drawn where the deployment cannot push, and neither is the block that held it', async () => {
    configAnswer = unconfigured()
    await mount()
    expect(switches(), 'an unconfigured deployment drew a switch').toHaveLength(0)
    expect(switchClaims(), 'the screen told the reader to use a switch it never drew').toEqual([])
    expect(text(), 'the device list was drawn beside a notice saying nothing can be pushed')
      .not.toContain(t('assistant.push.devices'))
  })

  it('is not drawn where the browser was told no, and the list says its emptiness without pointing', async () => {
    permission = 'denied'
    await mount()
    expect(switches(), 'a blocked browser was drawn a switch').toHaveLength(0)
    expect(buttonNamed(t('assistant.push.recheck')), 'the row drew neither a switch nor the check').toBeTruthy()
    expect(switchClaims(), 'the empty list pointed above at a switch this browser never got').toEqual([])
    expect(text()).toContain(t('assistant.push.devices_none'))
  })

  it('is drawn, and names the switch that is really on the screen, when both halves allow it', async () => {
    await mount()
    expect(switches(), 'a configured deployment with a willing browser lost its switch').toHaveLength(1)
    expect(switchClaims(), 'the empty list no longer names the switch above it')
      .toEqual(['names the switch that is on the screen'])
  })

  it('keeps the route’s own English behind the disclosure that opens it, under the localized sentence', async () => {
    configAnswer = unconfigured()
    await mount()
    const status = document.querySelector<HTMLElement>('[role="status"]')
    expect(status, 'the unconfigured deployment said nothing').toBeTruthy()
    const reason = [...status!.querySelectorAll<HTMLElement>('p')]
      .find((node) => (node.textContent ?? '').includes('VAPID_PUBLIC_KEY'))
    expect(reason, 'the line naming the variables an operator has to set never reached the screen').toBeTruthy()
    // The sentence the screen says is the localized one, and the deployment's own words are reached from it
    // rather than read out as the body of a page the reader came to in their own language.
    expect(status!.querySelector('p')!.textContent, "the deployment's own English is the first thing the screen says")
      .toBe(t('assistant.push.server_off'))
    const disclosure = reason!.closest('details')
    expect(disclosure, "the deployment's own English is printed as the body of the screen").toBeTruthy()
    const summary = disclosure!.querySelector('summary')
    expect(summary, 'the technical detail has nothing to open it with').toBeTruthy()
    expect(summary!.textContent).toBe(t('assistant.push.server_off_detail'))
  })
})
