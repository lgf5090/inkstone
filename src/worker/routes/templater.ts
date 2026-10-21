/**
 * The one network path a template can use.
 *
 * A template runs inside a Web Worker under the page's `connect-src`, so it has no network of its own and
 * `tp.web.request` can only be answered from here. That makes this route a `fetch` aimed by somebody
 * else's text at an address of somebody else's choosing — the shape every other relay in this app refuses
 * to be. So it goes through the same door as the notification channels: `checkTarget` for the address rules
 * and `outbound` for the bounded request, which together give http(s) only, no credentials in the address,
 * no private or link-local target, no redirect followed, ten seconds and sixty-four kilobytes. Neither rule
 * is restated here, because a second copy of an address rule is how a range that was already blocked gets
 * unblocked by a typo.
 *
 * What leaves is text and nothing else. A template parses JSON or pastes a string, so a body it cannot read
 * has no use, while a route that carried bytes of any type would be a way to pull a file out of whatever
 * this deployment can reach — with the reader's own session cookie in front of it. A non-textual answer is
 * therefore refused by name rather than base64'd, and the answer the caller does get is exactly the four
 * fields `src/client/lib/templater/worker/bootstrap.ts` reads back: `status`, `ok`, `contentType`, `text`.
 *
 * Two things are deliberately not this route's job. Whether the reader allows web calls at all is a
 * setting, and only the page can see settings — `protocol.ts` records that the `web` profile is the ceiling
 * and the page host applies the switch on the call. And the per-run caps belong to the interpreter, which
 * is the only place that knows a call came from a template rather than from a reader pressing a button.
 */
import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { createMinuteBudget } from '../lib/rate-limit'
import { requireAuth } from '../middleware/auth'
import { OUTBOUND_MAX_BYTES, checkTarget, outbound, redact } from '../subscriptions/channels/http'

export const templaterRoutes = new Hono<AppBindings>()

templaterRoutes.use('*', requireAuth)

/**
 * How many proxied fetches one account may start per minute.
 *
 * `createMinuteBudget` counts per wall-clock minute, so this is the per-minute number rather than an hourly
 * one. The brief's sixty-an-hour would be one call a minute here, and a template that reads one record per
 * note in a list — the ordinary shape of `tp.web.request` in a daily-note template — would stop at the
 * second note. What has to be bounded is a runaway loop, since the interpreter lets one run make two
 * hundred host calls with thirty-two of them outstanding: twenty a minute is a dozen remote lookups plus
 * retries for a template that means it, and the most one account can now hold open in a minute is twenty
 * requests of sixty-four kilobytes each, for ten seconds each.
 */
const FETCHES_PER_MINUTE = 20

const takeBudget = createMinuteBudget(FETCHES_PER_MINUTE, 'Too many web requests from this account. Try again in a minute.')

/** The ceiling the chat's own page reader puts on an address, so both doors refuse the same shape of input. */
const MAX_URL_CHARS = 2048
const UPSTREAM_ACCEPT = 'application/json, text/plain, */*'
const UPSTREAM_AGENT = 'Inkstone template proxy'

/** How much of a declared media type may be echoed back; it is text from whoever was fetched, not from us. */
const CONTENT_TYPE_MAX_CHARS = 80

/**
 * The failure names the reader's interface already has sentences for.
 *
 * These are the codes of `src/client/lib/templater/errors.ts`, unchanged, so the page host can name a
 * refusal with the same key it uses for every other template failure. They are not members of the app-wide
 * `ApiErrorCode` union and are not added to it: that union is what every surface in the app translates,
 * and a code only this route's own caller can answer would reach the rest of it as an untranslated English
 * line. What a refusal looks like on the wire is unchanged — the same `{ error: { code, message } }` that
 * `lib/errors.ts` writes, which is what the client's `routeApiError` already parses.
 */
type WebFailureCode = 'web-blocked' | 'web-request-failed' | 'capability-blocked'

templaterRoutes.post('/fetch', async (c) => {
  const body = await readJson<{ url?: unknown }>(c, JSON_BODY_LIMITS.small)
  const requested = body.url
  if (typeof requested !== 'string') throw ApiError.badRequest('A web address must be sent as text')
  if (!requested || requested.length > MAX_URL_CHARS) {
    throw ApiError.badRequest(`A web address must be between 1 and ${MAX_URL_CHARS} characters`)
  }
  const userId = c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  // Spent before the address is judged, not after: a probe that names a blocked host is the same scan as
  // one that names a reachable one, and a budget that only counts what got out would never fill during the
  // attempt it exists to slow down.
  takeBudget(userId)

  const target = checkTarget(requested)
  if (!target.url) {
    // The guard's reasons are four canned sentences that name no part of the address, so they can be said
    // back as they stand. Nothing the far side wrote ever reaches a caller through this route.
    noteRefusal(requested, 0, 'blocked')
    return refuse(c, 403, 'web-blocked', target.error)
  }

  // GET, with only this file's own two headers: a caller that could name its own headers could send this
  // deployment's cookies or an internal host's credentials along with the request.
  const result = await outbound(target.url.toString(), {
    method: 'GET',
    headers: { accept: UPSTREAM_ACCEPT, 'user-agent': UPSTREAM_AGENT },
    maxBytes: OUTBOUND_MAX_BYTES,
  })
  const status = result.status

  // Outbound never follows a move — `checkTarget` judged the address that was typed, and a hop nobody
  // checked is not that address — so a 3xx here is the refusal it came back with, not a body.
  if (status >= 300 && status < 400) {
    noteRefusal(target.url, status, 'redirect')
    return refuse(c, 403, 'web-blocked', 'The address moved somewhere else, and this proxy does not follow a move')
  }
  if (status === 0) {
    noteRefusal(target.url, status, 'unreachable')
    return refuse(c, 502, 'web-request-failed', 'The address did not answer')
  }

  const contentType = safeContentType(result.contentType)
  if (!isTextualType(contentType)) {
    noteRefusal(target.url, status, 'not-text')
    return refuse(c, 415, 'capability-blocked', 'The answer is not text, which a template has no way to use', { contentType })
  }

  // The cap `outbound` read to, applied to what it handed back. `outbound` stops at sixty-four kilobytes
  // silently, because a webhook does not care whether the reply it is discarding was longer. A caller that
  // returns a body does: a truncated document handed back as though it arrived whole is read as the whole
  // thing, and here it would reach the template as a JSON parse error that blames the template. So an
  // answer that filled the cap is refused out loud instead. A body of exactly the cap is refused with it —
  // the one case where that is a false refusal, and it is the safe direction to be wrong in.
  if (new TextEncoder().encode(result.text).byteLength >= OUTBOUND_MAX_BYTES) {
    noteRefusal(target.url, status, 'too-large')
    return refuse(c, 413, 'web-request-failed', 'The answer is longer than the text this proxy carries', { maxBytes: OUTBOUND_MAX_BYTES })
  }

  return c.json({ status, ok: result.ok, contentType, text: result.text })
})

/**
 * A refusal, in the shape every other route's failure already arrives in.
 *
 * `code` is one of {@link WebFailureCode} and is the half the interface translates. `message` is this
 * deployment's own English sentence about the same fact, for a surface with room under it, and never a part
 * of the address or of the body.
 */
function refuse(
  c: Context<AppBindings>,
  status: 403 | 413 | 415 | 502,
  code: WebFailureCode,
  message: string,
  details?: Record<string, string | number>,
): Response {
  return c.json({ error: { code, message, ...(details ? { details } : {}) } }, status)
}

/**
 * The media type, flattened to something it is safe to repeat.
 *
 * It is a header somebody else's server chose, and it travels into a response body a page may print, so
 * control characters go and the length is bounded before anything reads it.
 */
function safeContentType(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, CONTENT_TYPE_MAX_CHARS)
}

/**
 * The answer types a template can read.
 *
 * `text/` covers a plain page and an HTML one alike, and the three structured shapes a `tp.web.request`
 * path walks. An unset type is refused too: guessing one from the first bytes of a body would be this
 * deployment deciding what somebody else's server meant, and that guess is the thing that turns a text
 * proxy into a byte proxy.
 */
function isTextualType(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  if (!type) return false
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || type.endsWith('+json')
}

/**
 * One line about one refusal: the host, the path with its query taken off, the status, and a reason out of
 * a closed list of this file's own words.
 *
 * The query goes because a query is where a caller puts the token, and so does the user info a
 * credential-bearing address carries — both of which `hostname` and `pathname` cannot express. `redact` then
 * runs over what is left of the path for the other place secrets travel: the `/send/bot…:AAH…` shape a
 * notification address is made of. Neither the response body nor the reason the far side gave is ever
 * logged: the first is whatever the template asked for, and the second is text this deployment does not
 * control, while the reasons above carry everything an operator needs to find the request again.
 */
function noteRefusal(target: URL | string, status: number, reason: string): void {
  const address = typeof target === 'string' ? parseAttempt(target) : target
  const host = address?.hostname ?? '(unreadable)'
  const path = address ? redact(address.pathname) : '(unreadable)'
  console.warn(`[inkstone] templater web fetch refused host=${host} path=${path} status=${status} reason=${reason}`)
}

/**
 * The address a refusal was about, read again as a URL so a refused one can be logged by host and path the
 * way a reachable one is.
 *
 * `checkTarget` answers null for two different mistakes — text that is not an address at all, and an address
 * it refused on its scheme, its credentials or its host — and the second is the one an operator needs named.
 * Failing here costs a log line with no host in it and nothing else, because the value is only ever
 * printed by field.
 */
function parseAttempt(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}
