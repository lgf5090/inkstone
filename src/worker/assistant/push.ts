/**
 * Web Push: the VAPID claim this Worker signs, and the one send it makes.
 *
 * Why this is written against `crypto.subtle` instead of a package: a push service accepts a request only
 * when it carries a proof that the deployment owns a key pair — the `Authorization: WebPush <jwt>.<public>`
 * header — and that proof is an ES256-signed JWT over the push service's own origin. WebCrypto already does
 * the key import, the signing and the verifying, so the dependency a `web-push` package would bring is a
 * second crypto stack in a Worker that ships one. The claim is small and the checks below are the whole of it.
 *
 * What this module guarantees about credentials:
 *  - the subscription triple (`endpoint` + `p256dh` + `auth`) never appears in a returned string. Anything
 *    this module hands back as `detail` — and the caller stores as `last_error`, and may one day log — has
 *    the endpoint replaced by `describeEndpoint`'s origin-plus-digest form, including when the push service
 *    echoes the URL back in its own error page;
 *  - nothing is exported, shared or restored (see the table comment in `assistant/schema.ts`);
 *  - an unconfigured deployment fails with the name of the variable to set. It never reports a send it did
 *    not make, and it never treats "no keys" as "nothing to do".
 *
 * The payload travels as the request body under the `aes128gcm` content coding with no RFC 8291 crypto
 * applied, which is what the protocol allows a sender to do and what the push services accept; the
 * consequence is that the body must carry no secret and no note text. The reader's notification centre is
 * the source of the content — a push here is a nudge that says "there is something to read".
 */

import type { Env } from '../env'
import { fromBase64Url, sha256Hex, toBase64Url, utf8 } from '../lib/encoding'
import { isRedirectResponse, NO_REDIRECT } from '../lib/no-redirect'
import { AssistantStore, type AssistantPushSubscription } from './store'

/** How long a push service may hold a nudge before dropping it. */
export const PUSH_TTL_SECONDS = 6 * 60 * 60

/** How long a signed claim stays acceptable to a push service. The protocol allows ten minutes to a day. */
const VAPID_CLAIM_TTL_SECONDS = 12 * 60 * 60

/** How much of a refusal's body is kept: enough to diagnose, never enough to become a log full of HTML. */
const PUSH_RESPONSE_PREVIEW_CHARS = 200

/** The width of one P-256 signature component in the fixed-width JWS form an ES256 claim needs. */
const ECDSA_COMPONENT_BYTES = 32

/** The size a push service accepts before it answers 413, per RFC 8030's message size limit. */
const PUSH_MAX_PAYLOAD_BYTES = 4096

/** How much of an endpoint's digest is enough to tell one device's URL from another's in a log line. */
const ENDPOINT_DIGEST_CHARS = 12

/** A refusal's shape, as the sender saw it. */
export type PushOutcome = 'sent' | 'expired' | 'failed'

/**
 * What one send cost.
 *
 * `statusCode` is the fact the service gave (0 when there was no answer at all); `detail` is safe to store
 * and to show an operator; `dropped` says the subscription row is gone — either the service declared the
 * endpoint dead, or the refusals reached the limit in the store.
 */
export interface PushSendResult {
  outcome: PushOutcome
  statusCode: number
  detail: string
  dropped: boolean
}

/**
 * The deployment's own VAPID configuration is missing or malformed.
 *
 * Thrown rather than returned because a caller cannot fix it per subscription: it is an operator's job, and
 * the only correct response to it is to say which variable is unset.
 */
export class PushConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PushConfigurationError'
  }
}

const SECRET_PUT = 'npx wrangler secret put'

/** A configured variable, or null: whitespace-only counts as unset, since nobody means a blank key. */
function configured(value: string | undefined): string | null {
  const text = value?.trim()
  return text ? text : null
}

/**
 * What is wrong with the VAPID setup, in words an operator can act on; null when it is usable.
 *
 * This is also what the browser is told when push is off, so it has to name the missing variable rather than
 * answer "not available": a UI that cannot say why is a UI that will be guessed at.
 */
export function vapidProblem(env: Env): string | null {
  const publicKey = configured(env.VAPID_PUBLIC_KEY)
  const privateKey = configured(env.VAPID_PRIVATE_KEY)
  if (!publicKey && !privateKey) {
    return `Web Push is not configured on this deployment: neither VAPID_PUBLIC_KEY nor VAPID_PRIVATE_KEY is set. Generate an ES256 (P-256) key pair and store them with \`${SECRET_PUT} VAPID_PUBLIC_KEY\` and \`${SECRET_PUT} VAPID_PRIVATE_KEY\`.`
  }
  if (!publicKey) {
    return `Web Push is not configured: VAPID_PUBLIC_KEY is unset while VAPID_PRIVATE_KEY is set. Store the base64url of the uncompressed P-256 point with \`${SECRET_PUT} VAPID_PUBLIC_KEY\`.`
  }
  if (!privateKey) {
    return `Web Push is not configured: VAPID_PRIVATE_KEY is unset while VAPID_PUBLIC_KEY is set. Store the private JWK (kty EC, crv P-256) with \`${SECRET_PUT} VAPID_PRIVATE_KEY\`.`
  }
  const point = decodePoint(publicKey)
  if (!point) {
    return 'VAPID_PUBLIC_KEY is not a usable push key: it has to be the base64url of an uncompressed P-256 point — 65 bytes beginning with 0x04, which is what the key pair generates. Re-generate it and store it again.'
  }
  if (!isPrivateJwk(privateKey)) {
    return 'VAPID_PRIVATE_KEY is not a usable ES256 key: it has to be a JSON Web Key with kty "EC", crv "P-256" and the d, x, y members. Store the private JWK itself with `' + SECRET_PUT + ' VAPID_PRIVATE_KEY`.'
  }
  const subject = configured(env.VAPID_SUBJECT)
  if (subject && !/^(mailto:|https:)/i.test(subject)) {
    return 'VAPID_SUBJECT has to be a contact the push service can reach: a mailto: address or an https: URL.'
  }
  return null
}

/** The origin a claim is presented to — the audience, and only the origin, never the endpoint. */
export function pushServiceOrigin(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new PushConfigurationError('That subscription endpoint is not a URL.')
  }
  if (url.protocol !== 'https:') {
    throw new PushConfigurationError('A push subscription endpoint has to be an https:// URL.')
  }
  return url.origin
}

/**
 * An endpoint rendered so it may be stored or shown: the push service's origin plus a digest.
 *
 * The digest still identifies one device's endpoint across rows and log lines — which is what a diagnosis
 * needs — without handing anybody the URL they would need to notify it.
 */
export async function describeEndpoint(endpoint: string): Promise<string> {
  const origin = (() => {
    try {
      return new URL(endpoint).origin
    } catch {
      return 'unknown push service'
    }
  })()
  return `${origin}#${(await sha256Hex(endpoint)).slice(0, ENDPOINT_DIGEST_CHARS)}`
}

/**
 * The shape of the subscription material a browser may hand over, and the bounds around it.
 *
 * A push endpoint is a URL at the service and a token inside it, and a subscription is only ever as good as
 * the device that made it: an unchecked string here becomes the row a send is later addressed to. The limits
 * are generous against what real services produce (a few hundred characters at most) and stop the case that
 * matters — a body of any size arriving as a credential.
 */
export const MAX_PUSH_ENDPOINT_CHARS = 2048
export const MAX_PUSH_KEY_CHARS = 512
/** A base64url token, the way the Push API spells it: no padding, no `+`, no `/`, no whitespace. */
const BASE64URL = /^[A-Za-z0-9_-]+$/

/** What is wrong with an endpoint as a subscription address; null when it is usable. */
export function pushEndpointProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'endpoint must be the URL the push service gave this device.'
  const endpoint = value.trim()
  if (!endpoint) return 'endpoint is required: it is the address the push service gave this device.'
  if (endpoint.length > MAX_PUSH_ENDPOINT_CHARS) return `endpoint is too long to be a push address (${endpoint.length} characters, ${MAX_PUSH_ENDPOINT_CHARS} at most).`
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return 'endpoint is not a URL.'
  }
  if (url.protocol !== 'https:') return `endpoint has to be an https:// address, not ${url.protocol}.`
  if (!url.hostname) return 'endpoint has no push service host to send to.'
  if (url.username || url.password) return 'endpoint must not carry credentials in the URL.'
  return null
}

/** What is wrong with one of a subscription's keys; null when it is a usable base64url token. */
export function pushKeyProblem(value: unknown, field: 'p256dh' | 'auth'): string | null {
  if (typeof value !== 'string') return `keys.${field} has to be the base64url text the browser produced.`
  const key = value.trim()
  if (!key) return `keys.${field} is required.`
  if (key.length > MAX_PUSH_KEY_CHARS) return `keys.${field} is too long (${key.length} characters, ${MAX_PUSH_KEY_CHARS} at most).`
  if (!BASE64URL.test(key)) return `keys.${field} is not base64url text.`
  // Decoding is the only way to tell a base64url-shaped string from a key: the shape alone accepts junk.
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(key)
  } catch {
    return `keys.${field} is not base64url text.`
  }
  if (!bytes.byteLength) return `keys.${field} is empty once decoded.`
  // The subscription's public key is an uncompressed P-256 point on every browser this app targets, and the
  // auth secret is a short random value; anything else cannot take part in a delivery, so it is refused here
  // rather than stored and failed over on every send.
  if (field === 'p256dh' && (bytes.byteLength !== 65 || bytes[0] !== 0x04)) {
    return 'keys.p256dh is not an uncompressed P-256 public key.'
  }
  if (field === 'auth' && bytes.byteLength > 64) return 'keys.auth is longer than a push auth secret can be.'
  return null
}

/** What a browser may be told about one of its own subscriptions, with the credential left out. */
export interface PushSubscriptionView {
  id: string
  /** The service's origin plus the first path segment, and an ellipsis: the head of an endpoint, not its token. */
  endpoint: string
  createdAt: number
  failures: number
  /** Written through `describeEndpoint`, so it never names the device's address. */
  lastError: string | null
}

/**
 * One subscription rendered for the surface that manages it.
 *
 * A reader needs to tell two devices apart, not to read a credential off the screen — the row's own id is the
 * handle a delete needs, and the service plus its path head is what says "this is the laptop's Firefox".
 * Handing back `endpoint` whole would put the ability to notify that machine into a browser log, a screenshot
 * and the reader's own clipboard, none of which the subscription was ever stored for.
 */
export function describeSubscription(subscription: AssistantPushSubscription): PushSubscriptionView {
  let head = 'unknown push service'
  try {
    const url = new URL(subscription.endpoint)
    const firstSegment = url.pathname.split('/').filter(Boolean)[0]
    head = firstSegment ? `${url.origin}/${firstSegment}` : url.origin
  } catch {
    // A row whose endpoint stopped parsing reads as the unusable thing it is rather than as a partial URL.
  }
  return {
    id: subscription.id,
    endpoint: `${head}…`,
    createdAt: subscription.createdAt,
    failures: subscription.failures,
    lastError: subscription.lastError,
  }
}

/**
 * Whether this deployment can push, and what a browser needs to subscribe to it.
 *
 * `enabled: false` always carries the reason, and the reason names the variable. An interface that got a bare
 * `false` could only invent an explanation, which is the dishonesty this whole file is written against.
 */
export function pushConfigStatus(env: Env): { enabled: boolean, publicKey: string | null, reason?: string } {
  const problem = vapidProblem(env)
  if (problem) return { enabled: false, publicKey: null, reason: problem }
  return { enabled: true, publicKey: configured(env.VAPID_PUBLIC_KEY) }
}

/**
 * The `Authorization` header value for one push service.
 *
 * `WebPush <base64url(header)>.<base64url(claims)>.<base64url(signature)>.<base64url(public key)>`: a JWS in
 * compact form plus the key it was signed with, so the service can verify the claim without a lookup.
 */
export async function createVapidAuthorization(endpoint: string, env: Env): Promise<string> {
  const problem = vapidProblem(env)
  if (problem) throw new PushConfigurationError(problem)
  const publicKey = configured(env.VAPID_PUBLIC_KEY)!
  const privateKey = configured(env.VAPID_PRIVATE_KEY)!
  const issuedAt = Math.floor(Date.now() / 1000)
  const claims: Record<string, unknown> = {
    aud: pushServiceOrigin(endpoint),
    exp: issuedAt + VAPID_CLAIM_TTL_SECONDS,
    iat: issuedAt,
  }
  const subject = configured(env.VAPID_SUBJECT)
  if (subject) claims.sub = subject
  const header = encodeJsonSegment({ typ: 'JWT', alg: 'ES256' })
  const payload = encodeJsonSegment(claims)
  const signingInput = `${header}.${payload}`
  const signature = await signEs256(signingInput, privateKey)
  return `WebPush ${signingInput}.${toBase64Url(signature)}.${publicKey}`
}

function encodeJsonSegment(value: Record<string, unknown>): string {
  return toBase64Url(utf8(JSON.stringify(value)))
}

/**
 * The ES256 signature over the compact claim, in the fixed-width form a JWS requires.
 *
 * WebCrypto hands back DER; the push service expects `r` and `s` padded to 32 bytes each and concatenated.
 * Shipping the DER bytes is the kind of mistake that reads as "401 from every service" rather than as a bug,
 * so the conversion is asserted in `tests/push-sender.test.ts` by verifying the signature against the public
 * key rather than by trusting its length.
 */
async function signEs256(message: string, privateJwk: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('jwk', privateJwkMembers(privateJwk) as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(message) as BufferSource)
  return toJwsSignature(new Uint8Array(signature))
}

/**
 * Whatever shape the runtime signed in, the claim goes out with `r` and `s` fixed-width and concatenated.
 *
 * WebCrypto is specified to return the DER pair and workerd does, so the conversion is the case that
 * matters in production; a runtime that already hands back the 64 bytes is passed through rather than
 * parsed. Either way the width is what the test verifies — a DER blob in a JWS reads as "every push service
 * rejects this deployment's keys", not as a bug.
 */
function toJwsSignature(signature: Uint8Array): Uint8Array {
  return signature.byteLength === ECDSA_COMPONENT_BYTES * 2 ? signature : derToFixedWidth(signature)
}

/** The five members an EC private JWK needs, and nothing else: `use` and `key_ops` are not ours to send. */
function privateJwkMembers(json: string): { kty: 'EC', crv: 'P-256', d: string, x: string, y: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new PushConfigurationError('VAPID_PRIVATE_KEY is not JSON: store the private JWK as the JSON text the generator prints.')
  }
  const members = parsed as Record<string, unknown>
  for (const name of ['kty', 'crv', 'd', 'x', 'y'] as const) {
    if (typeof members[name] !== 'string') {
      throw new PushConfigurationError(`VAPID_PRIVATE_KEY is missing its "${name}" member: it has to be a P-256 private JWK.`)
    }
  }
  if (members.kty !== 'EC' || members.crv !== 'P-256') {
    throw new PushConfigurationError('VAPID_PRIVATE_KEY has to be an EC / P-256 JWK — the curve Web Push signs with.')
  }
  return { kty: 'EC', crv: 'P-256', d: members.d as string, x: members.x as string, y: members.y as string }
}

function isPrivateJwk(json: string): boolean {
  try {
    privateJwkMembers(json)
    return true
  } catch {
    return false
  }
}

function decodePoint(base64url: string): Uint8Array | null {
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(base64url)
  } catch {
    return null
  }
  return bytes.byteLength === 65 && bytes[0] === 0x04 ? bytes : null
}

/**
 * DER's `SEQUENCE { INTEGER r, INTEGER s }` as the two fixed-width components a JWS signature is.
 *
 * Only the shapes a P-256 signer produces are accepted, and anything else throws: a silently mis-sliced
 * signature would be reported to the operator as a push service that does not like this deployment's keys.
 * Exported because workerd's WebCrypto takes this branch on every send — the DER form is what it signs — and
 * a conversion that production depends on is worth testing on its own.
 */
export function derToFixedWidth(der: Uint8Array): Uint8Array {
  const pair = new Uint8Array(ECDSA_COMPONENT_BYTES * 2)
  if (der[0] !== 0x30) throw new PushConfigurationError('The ES256 signature is not a DER sequence.')
  let cursor = readDerLength(der, 1).valueAt
  for (const slot of [0, ECDSA_COMPONENT_BYTES]) {
    if (der[cursor] !== 0x02) throw new PushConfigurationError('The ES256 signature does not hold two integers.')
    const integer = readDerLength(der, cursor + 1)
    let value = der.subarray(integer.valueAt, integer.valueAt + integer.length)
    cursor = integer.valueAt + integer.length
    // A leading zero byte is DER's sign bit, not part of the number; the rest is right-aligned into its slot.
    if (value[0] === 0x00) value = value.subarray(1)
    if (value.byteLength > ECDSA_COMPONENT_BYTES) throw new PushConfigurationError('The ES256 signature component is wider than P-256.')
    pair.set(value, slot + ECDSA_COMPONENT_BYTES - value.byteLength)
  }
  return pair
}

/**
 * One DER length field and where its value begins, short form or the long form a P-521 signer would use.
 *
 * The sequence's own length is read and discarded: the integers carry their own bounds, and a signature
 * longer than the two components simply fails the width check below.
 */
function readDerLength(der: Uint8Array, cursor: number): { length: number, valueAt: number } {
  const first = der[cursor]!
  if (first < 0x80) return { length: first, valueAt: cursor + 1 }
  const count = first & 0x7f
  if (!count || count > 2) throw new PushConfigurationError('The ES256 signature uses an unreadable length.')
  let length = 0
  for (let index = 0; index < count; index++) length = length * 256 + der[cursor + 1 + index]!
  return { length, valueAt: cursor + 1 + count }
}

/**
 * Hands one payload to the push service a subscription names, and records what came back.
 *
 * The status code is the only fact here: 201 is a queued message, 404 and 410 are the service saying the
 * endpoint is gone — so the subscription is deleted rather than kept as a credential that cannot be used —
 * and anything else is a refusal counted against the row until the limit drops it. A 200 is treated as a
 * refusal on purpose: RFC 8030 says 201, and a sender that read 200 as success would report a delivery no
 * service accepted.
 *
 * A deployment with no VAPID keys throws before any request is made (`PushConfigurationError`); the caller
 * surfaces that as "the server has no push keys", which is the truth, and never as a send.
 */
export async function sendPush(subscription: AssistantPushSubscription, payload: string, env: Env): Promise<PushSendResult> {
  const problem = vapidProblem(env)
  if (problem) throw new PushConfigurationError(problem)
  const store = new AssistantStore(env.DB, subscription.userId, env)
  const label = await describeEndpoint(subscription.endpoint)
  const body = utf8(payload)
  if (body.byteLength > PUSH_MAX_PAYLOAD_BYTES) {
    // Our fault, not the device's: the row is kept and the count is not touched, so one oversized message
    // cannot delete a working subscription.
    return { outcome: 'failed', statusCode: 0, detail: `the push payload is ${body.byteLength} bytes, over the ${PUSH_MAX_PAYLOAD_BYTES} a service accepts`, dropped: false }
  }
  const authorization = await createVapidAuthorization(subscription.endpoint, env)
  let response: Response
  try {
    response = await fetch(subscription.endpoint, {
      method: 'POST',
      // A push endpoint is an address, not a hop: following a redirect would carry this device's claim to an
      // origin nobody chose, so a 3xx is answered as the refusal it is. workerd has no `error` mode, hence
      // `manual` plus the check below rather than a redirect setting that would silently do nothing.
      redirect: NO_REDIRECT,
      headers: {
        Authorization: authorization,
        TTL: String(PUSH_TTL_SECONDS),
        'Content-Length': String(body.byteLength),
        'Content-Encoding': 'aes128gcm',
      },
      body,
    })
  } catch (error) {
    const detail = `the push service did not answer (${errorDetail(error, label)})`
    const failure = await store.notePushFailure(subscription.endpoint, detail)
    return { outcome: 'failed', statusCode: 0, detail, dropped: failure.dropped }
  }

  if (response.status === 201) {
    return { outcome: 'sent', statusCode: 201, detail: 'queued by the push service', dropped: false }
  }

  const preview = await responsePreview(response, label)
  if (isRedirectResponse(response)) {
    const detail = `the push service answered with a redirect (${response.status}) instead of accepting the message`
    const failure = await store.notePushFailure(subscription.endpoint, detail)
    return { outcome: 'failed', statusCode: response.status, detail, dropped: failure.dropped }
  }
  if (response.status === 404 || response.status === 410) {
    const detail = `the push service no longer knows this subscription (${response.status}${preview ? `: ${preview}` : ''})`
    return { outcome: 'expired', statusCode: response.status, detail, dropped: await store.deletePushSubscription(subscription.endpoint) }
  }

  const detail = `the push service answered ${response.status}${preview ? `: ${preview}` : ''}`
  const failure = await store.notePushFailure(subscription.endpoint, detail)
  return { outcome: 'failed', statusCode: response.status, detail, dropped: failure.dropped }
}

/**
 * The first few hundred characters of a refusal, with this request's endpoint taken out.
 *
 * A service that echoes the URL it refused would otherwise put a credential into `last_error`, into whatever
 * log line the caller writes from it, and into the error an operator reads.
 */
async function responsePreview(response: Response, label: string): Promise<string> {
  const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return redactEndpoint(text.slice(0, PUSH_RESPONSE_PREVIEW_CHARS), label)
}

/** Every endpoint-shaped URL in a fragment replaced by the origin-plus-digest form. */
function redactEndpoint(text: string, label: string): string {
  return text.replace(/https:\/\/[^\s"']{20,}/g, label)
}

/** An exception's own words, never a stack and never a URL. */
function errorDetail(error: unknown, label: string): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return redactEndpoint(message.slice(0, 200), label)
}
