/**
 * The state behind the push rows in assistant settings.
 *
 * Its own file because the question it answers is not the assistant's: it is this browser's. The reader is
 * deciding whether one device may be woken up, and the facts that decide it live in three places that agree
 * only by convention — what the deployment was configured with (`GET /push/config`), what the browser will
 * allow (`Notification.permission`, `window.isSecureContext`, the presence of `PushManager`), and what the
 * account already holds (`GET /push/subscriptions`, echoed back by the two write routes). The transcript
 * store has no business carrying any of them.
 *
 * The honesty rule the whole file is built on: a switch that cannot work is not offered. Every state that
 * makes the press meaningless — no VAPID keys on the server, a browser that has been told to block
 * notifications, an insecure address, a browser with no push at all — is a sentence the reader is given
 * instead, with the server's own reason for the first one.
 */
import { create } from 'zustand'
import { ApiError, api, type PushConfig, type PushSubscriptionPayload, type PushSubscriptionRow } from '../../lib/api'
import type { MessageKey } from '../../lib/i18n'

/** Whether this browser could be given a push subscription at all. */
export type DeviceSupport = 'available' | 'insecure' | 'unsupported'

/** The answer `Notification.permission` gives, plus the case where the browser has no such API. */
export type PermissionChoice = 'granted' | 'default' | 'denied' | 'unavailable'

/**
 * A write that did not land: the app's own sentence, and what the route said about the field it refused.
 *
 * Two halves because they are two facts, which is the shape `LoadFailure` already prints — a headline the
 * catalog translated, and the server's English under it as the thing the reader can act on.
 */
export interface PushFailure {
  headline: MessageKey
  detail: string | null
}

/** The three browser facts `deviceSupportFor` reads, passed in so the decision can be tested as itself. */
export interface PushEnvironmentProbe {
  secure: boolean
  serviceWorker: boolean
  pushManager: boolean
}

export function deviceSupportFor(probe: PushEnvironmentProbe): DeviceSupport {
  if (!probe.secure) return 'insecure'
  if (!probe.serviceWorker || !probe.pushManager) return 'unsupported'
  return 'available'
}

export function currentDeviceSupport(): DeviceSupport {
  if (typeof window === 'undefined') return 'unsupported'
  return deviceSupportFor({
    secure: window.isSecureContext,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
  })
}

export function currentPermission(): PermissionChoice {
  if (typeof Notification === 'undefined') return 'unavailable'
  return Notification.permission
}

/**
 * The triple the route wants, out of whatever the browser handed back.
 *
 * `toJSON()` is spelled optional in the platform types because a subscription may be one the browser will
 * not let a page read, so the three parts are checked here rather than assumed: handing the route an
 * endpoint with no keys behind it would be a stored row that can never be sent to.
 *
 * The parameter is the shape this function actually reads rather than `PushSubscription` itself: the
 * platform type is a class with a dozen members no settings screen can construct, and a test that has to
 * answer for all of them is a test of the fake rather than of the check.
 */
export interface SubscriptionShape {
  readonly endpoint: string
  toJSON(): { endpoint?: string | null, keys?: { p256dh?: string | null, auth?: string | null } }
}

export function subscriptionPayload(subscription: SubscriptionShape): PushSubscriptionPayload | null {
  const json = subscription.toJSON()
  const endpoint = json.endpoint ?? subscription.endpoint
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!endpoint || !p256dh || !auth) return null
  return { endpoint, keys: { p256dh, auth } }
}

/** The character the route puts on the end of every masked endpoint it hands back. */
const MASKED_SUFFIX = '…'

/**
 * Which row of the account's list is this device.
 *
 * The list only carries the head of each endpoint, and the head is a literal prefix of the whole thing, so
 * the one row this page can prove is its own is the row whose head starts its endpoint — longest head wins
 * when two rows share a push service. That is the whole matching rule, which is deliberate: the server owns
 * how an endpoint is masked, and a client that reimplements it is free to drift from the answer it is
 * comparing against.
 */
export function rowForEndpoint(endpoint: string | null, rows: readonly PushSubscriptionRow[]): PushSubscriptionRow | null {
  if (!endpoint) return null
  const matches = rows.filter((row) => endpoint.startsWith(row.endpoint.endsWith(MASKED_SUFFIX)
    ? row.endpoint.slice(0, -MASKED_SUFFIX.length)
    : row.endpoint))
  if (!matches.length) return null
  return matches.reduce((longest, row) => (row.endpoint.length > longest.endpoint.length ? row : longest))
}

function refusal(headline: MessageKey, error: unknown): PushFailure {
  // A refused write is not a quiet no-op: the route names the field it turned down, and that is the only
  // part of this the reader could not work out from the screen.
  return { headline, detail: error instanceof ApiError ? error.serverMessage ?? null : null }
}

/** What the config read kept, with nothing but the route's line beside the screen's own headline. */
function readRefusal(error: unknown): { detail: string | null } {
  return { detail: error instanceof ApiError ? error.serverMessage ?? null : null }
}

/**
 * The browser's own push manager, or nothing.
 *
 * `ready` rather than `getRegistration`: the settings screen is only reachable from a booted app, and a
 * deployment that offers push is a deployment that registered a worker at start-up (`store/pwa.ts`). A
 * browser that would never answer here has already been named by `currentDeviceSupport`, which is checked
 * before this is ever called.
 */
async function livePushManager(): Promise<PushManager | null> {
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager
}

interface PushDevicesState {
  /** Null until the read came back, which is what separates "not asked yet" from "answered no". */
  config: PushConfig | null
  configFailure: { detail: string | null } | null
  /**
   * The account's devices.
   *
   * Null is "not read yet" — nothing may be claimed about the account either way. An empty array is the
   * server saying the account holds no subscription, which is a different fact and gets a different sentence.
   */
  rows: PushSubscriptionRow[] | null
  /** The device read itself refused; kept apart from the write failure because they retry different things. */
  rowsFailure: { detail: string | null } | null
  deviceEndpoint: string | null
  support: DeviceSupport
  permission: PermissionChoice
  busy: 'enable' | 'disable' | null
  actionFailure: PushFailure | null
  /** The row whose removal is in flight, so only that row's own control goes quiet. */
  revoking: string | null
  /** The row a removal refused, kept with its id because retrying has to ask for the same device. */
  revokeFailure: { id: string, detail: string | null } | null
  /** Asks the server whether this deployment can push at all. Safe to retry. */
  loadConfig: () => Promise<void>
  /** Reads the account's device list. Safe to retry, and the only way the list appears without a write. */
  loadRows: () => Promise<void>
  /** Re-reads the browser's side: permission, the APIs it has, and the subscription it holds. */
  readDevice: () => Promise<void>
  /** Subscribes this device. Only ever called from a press, which is the gesture `requestPermission` needs. */
  enable: () => Promise<void>
  /** Unsubscribes this device and drops its row from the account. */
  disable: () => Promise<void>
  /** Removes one row of the list — this account's own device or another's — by its id. */
  revoke: (id: string) => Promise<void>
}

export const usePushDevices = create<PushDevicesState>((set, get) => ({
  config: null,
  configFailure: null,
  rows: null,
  rowsFailure: null,
  deviceEndpoint: null,
  support: currentDeviceSupport(),
  permission: currentPermission(),
  busy: null,
  actionFailure: null,
  revoking: null,
  revokeFailure: null,

  loadConfig: async () => {
    set({ configFailure: null })
    try {
      set({ config: await api.assistant.pushConfig() })
    } catch (error) {
      // Nothing was read, so nothing may be claimed: the switch stays off the screen because the answer
      // that would justify it never arrived.
      set({ config: null, configFailure: readRefusal(error) })
    }
  },

  loadRows: async () => {
    set({ rowsFailure: null })
    try {
      const { subscriptions } = await api.assistant.pushSubscriptions()
      set({ rows: subscriptions })
    } catch (error) {
      // A list that would not come back is not an empty account, and the screen must not say it is. What the
      // route said is kept beside the headline so the reader has the field-level reason, same as a write.
      set({ rows: null, rowsFailure: readRefusal(error) })
    }
  },

  readDevice: async () => {
    set({ support: currentDeviceSupport(), permission: currentPermission() })
    if (currentDeviceSupport() !== 'available') return
    try {
      const subscription = await (await livePushManager())?.getSubscription()
      set({ deviceEndpoint: subscription?.endpoint ?? null })
    } catch {
      // Best-effort by design: this only decorates the row list with what the browser already holds, and a
      // reader who presses the switch walks the same path again with the failure in front of them.
      set({ deviceEndpoint: null })
    }
  },

  enable: async () => {
    const publicKey = get().config?.publicKey
    if (!publicKey || get().busy) return
    set({ busy: 'enable', actionFailure: null })
    try {
      // The permission ask sits inside the press. A screen that asked on mount would be a dialog in front
      // of a reader who had not yet said they wanted any of this.
      const permission = await Notification.requestPermission()
      set({ permission })
      if (permission !== 'granted') {
        set({ busy: null })
        return
      }
      const subscription = await (await livePushManager())!.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      })
      const payload = subscriptionPayload(subscription)
      if (!payload) {
        set({ busy: null, actionFailure: { headline: 'assistant.push.no_keys', detail: null } })
        return
      }
      const { subscriptions } = await api.assistant.subscribePush(payload)
      set({ rows: subscriptions, deviceEndpoint: payload.endpoint, busy: null })
    } catch (error) {
      set({ busy: null, actionFailure: refusal('assistant.push.enable_failed', error) })
    }
  },

  disable: async () => {
    if (get().busy) return
    set({ busy: 'disable', actionFailure: null })
    const endpoint = get().deviceEndpoint
    try {
      const subscription = await (await livePushManager())?.getSubscription()
      if (subscription) await subscription.unsubscribe()
      if (endpoint) {
        // The route names a row by its id and the list carries only endpoint heads, so the row that is
        // genuinely this browser's is found by matching the whole endpoint the browser holds against them —
        // and by the time a device can be turned off, that list has been read: the mount reads it, and the
        // write that made this endpoint is answered with it.
        //
        // No matching row is not a failure to report. It means the account no longer carries this device —
        // a send the push service refused with 404 or 410 drops the row itself — and the browser has just
        // been unsubscribed, so there is nothing left here to remove. A list that would not read at all is
        // said by its own `rowsFailure` line, above this row, and never dressed up as an empty account.
        const own = rowForEndpoint(endpoint, get().rows ?? [])
        if (own) set({ rows: (await api.assistant.unsubscribePush(own.id)).subscriptions })
      }
      set({ deviceEndpoint: null, busy: null })
    } catch (error) {
      set({ busy: null, actionFailure: refusal('assistant.push.disable_failed', error) })
    }
  },

  revoke: async (id: string) => {
    if (get().busy || get().revoking) return
    set({ revoking: id, revokeFailure: null })
    try {
      set({ rows: (await api.assistant.unsubscribePush(id)).subscriptions, revoking: null })
    } catch (error) {
      // Kept together with the id it refused, because the retry has to ask for the same device and not for
      // the switch beside it: a reader revoking the laptop from the phone must not be sent through their own
      // browser's subscription.
      set({ revoking: null, revokeFailure: { id, detail: error instanceof ApiError ? error.serverMessage ?? null : null } })
    }
  },
}))
