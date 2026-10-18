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

/**
 * Which row of the account's list this browser was told is its own.
 *
 * Matched by row id and by nothing else. The list carries an origin and a digest, so there is no endpoint
 * text left to compare against the endpoint this browser holds — and a client that compared any part of an
 * endpoint would be comparing the credential. The id is not a secret: it names one row of this account, and
 * the route that acts on it re-scopes the lookup to the signed-in account anyway.
 */
export function rowForId(id: string | null, rows: readonly PushSubscriptionRow[]): PushSubscriptionRow | null {
  if (!id) return null
  return rows.find((row) => row.id === id) ?? null
}

/**
 * Where this browser remembers which row its own subscription became.
 *
 * The write is the only moment the account says "this endpoint is that row", and a reader who subscribed
 * last week is looking at the screen with no write behind it. Without the record the row would still be
 * listed and still removable, only never labelled as this device's — so the record is kept here, in this
 * browser, and it is the row id rather than anything derived from the endpoint.
 */
export const PUSH_DEVICE_ROW_STORAGE_KEY = 'inkstone:push-device-row:v1'

/** The longest row id a stored record may carry; a hand-edited value is dropped rather than looked up. */
const MAX_STORED_ROW_ID_CHARS = 64

function deviceRowStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function readStoredDeviceRow(): string | null {
  const source = deviceRowStorage()
  if (!source) return null
  try {
    const stored = source.getItem(PUSH_DEVICE_ROW_STORAGE_KEY)
    if (stored === null) return null
    const id = stored.trim()
    return id && id.length <= MAX_STORED_ROW_ID_CHARS ? id : null
  } catch {
    // A browser that will not hand back its record costs only the "this device" label on the row, never a
    // way out: every row of the list still carries its own revoke.
    return null
  }
}

function writeStoredDeviceRow(id: string | null): void {
  const source = deviceRowStorage()
  if (!source) return
  try {
    if (id === null) source.removeItem(PUSH_DEVICE_ROW_STORAGE_KEY)
    else source.setItem(PUSH_DEVICE_ROW_STORAGE_KEY, id)
  } catch { /* Best-effort: the next write re-records it, and nothing about this device's own state depends on the copy. */ }
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
  /**
   * The row of `rows` that is this browser, as the account named it when this device was subscribed.
   *
   * An id, never endpoint text: the list carries a digest of each endpoint, so nothing here can be matched
   * against the credential the browser holds. Null means this browser has never been told, which is a
   * different fact from "this account holds no device" and gets a different label on the row.
   */
  deviceId: string | null
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
  deviceId: null,
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
    // The row this browser was told is its own comes back with the browser's own state, not out of the
    // endpoint: a reader who subscribed on an earlier visit has nothing written here to identify it.
    set({ support: currentDeviceSupport(), permission: currentPermission(), deviceId: readStoredDeviceRow() })
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
      const { subscriptions, deviceId } = await api.assistant.subscribePush(payload)
      // The route says which row this endpoint became. Kept for the next visit, because the list itself can
      // never say it: every endpoint on it is a digest.
      writeStoredDeviceRow(deviceId)
      set({ rows: subscriptions, deviceEndpoint: payload.endpoint, deviceId, busy: null })
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
        // The row that is this browser's is the one the account named when this device was subscribed, kept
        // locally as an id — never one found by comparing endpoint text, since the list carries digests and
        // the browser holds the credential. By the time a device can be turned off, the list has been read:
        // the mount reads it, and the write that made this endpoint is answered with it.
        //
        // No matching row is not a failure to report. It means this browser never learned its row — an
        // account that subscribed before this record existed, a device the push service already dropped, a
        // list that would not read (said by its own `rowsFailure` line above this row, never dressed up as
        // an empty account). The browser has just been unsubscribed either way, and the row stays on the
        // list with its own revoke beside it.
        const own = rowForId(get().deviceId, get().rows ?? [])
        if (own) set({ rows: (await api.assistant.unsubscribePush(own.id)).subscriptions })
      }
      // Either the row is gone or this browser never had one to point at; in both cases the record has
      // finished its job and must not be offered to the next subscription as if it were still a device.
      writeStoredDeviceRow(null)
      set({ deviceEndpoint: null, deviceId: null, busy: null })
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
