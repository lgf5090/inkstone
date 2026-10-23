/**
 * The page's answer to a template that reaches outside the deployment.
 *
 * Three names of Templater's `web` module (`InternalModuleWeb.ts`, AGPL-3.0-only) and one of its `system`
 * module's helpers need something the interpreter does not have: a network. The worker runs under the page's
 * `connect-src` and has no fetch of its own, so every address a template names is asked of *this* side,
 * which sends it to `src/worker/routes/templater.ts` — the one door in the app that will carry a
 * template-written address, and which refuses private targets, credentials in the address, redirects,
 * anything past ten seconds and sixty-four kilobytes. Those rules are not restated here; a second copy of an
 * address rule is how a blocked range gets unblocked by a typo.
 *
 * Four rules, each with a reason:
 *
 * - **the reply for `web.request` is passed through, not judged.** The frozen prelude reads
 *   `{ status, ok, contentType, text }` and refuses anything outside 2xx itself — deliberately stricter than
 *   upstream, whose guard is `status < 200 && status >= 300` and so never fires
 *   (`InternalModuleWeb.ts:48`, and the port plan's W3b row). A page host that refused first would take that
 *   decision away from the layer that pinned it, and would leave `worker/bootstrap.test.ts:1205` testing a
 *   path production no longer reaches.
 * - **a refusal is named by its code, never by its sentence.** The route answers with `{ error: { code,
 *   message } }`, and `message` is this deployment's English (`"The address did not answer"`). The code is
 *   the half with a locale key; it becomes the error code where the app already has one for it, and the
 *   `detail` everywhere, so a Chinese interface never shows a sentence this repo wrote.
 * - **`daily_quote` and `random_picture` are data, not prose.** Upstream composes the quote block and the
 *   image link inside the module; this port composes them in the prelude, because `size` and `include_size`
 *   are arguments the template passes to *it* and never cross the wire. So this host answers the record
 *   upstream's own interfaces name — `{ quote, author }` and `{ full, photog, photogUrl }` — and the alt
 *   text, the `|size` and the `&w=`/`&h=` suffix are `worker/bootstrap.ts`'s, pinned there by
 *   `worker/bootstrap.test.ts`.
 * - **the reader's switch is checked on every call.** `protocol.ts` records that the `web` profile is the
 *   ceiling and the setting is applied here, because this is the side that can see settings. It is
 *   *required* in {@link WebHostDeps} for that reason: a host that could compile without it would compile
 *   into a product where nothing consults the reader's choice.
 */
import { CLIENT_HEADER } from '@shared/constants'
import { routeApiError } from '../../../lib/api'
import {
  HOST_METHOD_CAPABILITY,
  HOST_METHODS,
  capabilitiesFor,
  type HostCall,
  type HostMethod,
  type HostResult,
  type TemplateRunContext,
} from '../protocol'
import { isTemplaterErrorCode, type TemplaterErrorCode } from '../errors'

/** What the proxy carries back: the four fields `worker/bootstrap.ts` reads. */
export interface ProxyReply {
  status: number
  ok: boolean
  contentType: string
  text: string
}

/** A fetch that reached the far side, or the code and measurement that say it did not. */
type Success = { ok: true; value: unknown }
type Refusal = { ok: false; code: TemplaterErrorCode; detail: string }
type RelayResult = { ok: true; reply: ProxyReply } | Refusal
type Outcome = Success | Refusal

/**
 * The addresses upstream reaches for, spelled as upstream spells them.
 *
 * Derived from Templater 2.26.0 (AGPL-3.0-only) src/core/functions/internal_functions/web/
 * InternalModuleWeb.ts:11-27, with Inkstone adaptations: the table is keyed so an unset entry answers
 * `undefined` rather than pretending to be a language, and the Unsplash relay is read through the proxy
 * like every other address, which upstream did not need because its own `requestUrl` bypassed nothing.
 */
const QUOTE_DATABASES: Record<string, string | undefined> = {
  en: 'https://raw.githubusercontent.com/Zachatoo/quotes-database/refs/heads/main/quotes.json',
  es: 'https://raw.githubusercontent.com/wulflo/frases-inventario/refs/heads/main/quotes.json',
}

/** Upstream's `DEFAULT_QUOTE_LANGUAGE`: any language without a registered database reads English. */
const DEFAULT_QUOTE_LANGUAGE = 'en'

/** Upstream's relay service for `random_picture` (`InternalModuleWeb.ts:95`). */
const UNSPLASH_ENDPOINT = 'https://templater-unsplash-2.fly.dev/'

/** The path `src/worker/routes/templater.ts` answers on. */
const PROXY_PATH = '/api/templater/fetch'

/**
 * How long the page waits for the proxy for itself.
 *
 * The route bounds what it fetches to ten seconds; this is that, plus the time to answer. Past it the wait
 * is this deployment's or the network's rather than the far side's, and a template held open until the
 * worker's five-minute idle guard would report a timeout the reader cannot act on.
 */
const PROXY_TIMEOUT_MS = 20_000

export interface WebHostDeps {
  /** The reader's `webRequestsEnabled`, read at the moment of the call rather than captured at startup. */
  webRequestsEnabled: () => boolean
  /**
   * The same-origin relay.
   *
   * Defaults to the real route and is injected only by a test: the host's whole security claim is that a
   * template's address leaves through one bounded door, and a wiring that could hand it some other door
   * would make that claim about the wiring rather than about the code.
   */
  fetchViaProxy?: (url: string) => Promise<RelayResult>
}

/** A callable host, shaped like `./page-host.ts` so the door can treat every host alike. */
export interface WebHost {
  (call: HostCall): Promise<HostResult>
  beginRun: (context: TemplateRunContext) => void
  endRun: (runId: string) => void
  liveRuns: () => number
}

/** The names this host answers, so the door can route on one list. */
export const WEB_HOST_METHODS: readonly HostMethod[] = ['web.request', 'web.dailyQuote', 'web.randomPicture']

/** The same bound `./page-host.ts` uses; a run registered there is registered here. */
const MAX_TRACKED_RUNS = 32

export function createWebHost(deps: WebHostDeps): WebHost {
  const relay = deps.fetchViaProxy ?? fetchThroughProxy
  const runs = new Map<string, TemplateRunContext>()

  function beginRun(context: TemplateRunContext): void {
    runs.set(context.runId, context)
    while (runs.size > MAX_TRACKED_RUNS) {
      const oldest = runs.keys().next()
      if (oldest.done === true || oldest.value === context.runId) break
      runs.delete(oldest.value)
      console.warn('[inkstone] templater web host dropped a run the page never released', oldest.value)
    }
  }

  // Releasing a run does not call off a fetch already in flight: the route bounds it to ten seconds and
  // sixty-four kilobytes, and the worker drops an answer for a run it has forgotten. A per-run abort
  // controller would be a third thing to forget to release, for the cost of one short request.
  function endRun(runId: string): void {
    runs.delete(runId)
  }

  async function onHostCall(call: HostCall): Promise<HostResult> {
    let outcome: Outcome
    try {
      outcome = await dispatch(call)
    }
    catch (error) {
      // Nothing may reject: the worker is waiting on this call, and a rejection here would be a run that
      // hangs until the idle guard takes the thread down.
      console.error('[inkstone] templater web host failed', call.method, error)
      outcome = fail('render-failed', `throw:${call.method}`)
    }
    return outcome.ok
      ? { runId: call.runId, callId: call.callId, ok: true, value: outcome.value }
      : { runId: call.runId, callId: call.callId, ok: false, code: outcome.code, detail: outcome.detail }
  }

  async function dispatch(call: HostCall): Promise<Outcome> {
    const method = asHostMethod(call.method)
    if (method === null || !WEB_HOST_METHODS.includes(method)) {
      console.error('[inkstone] templater web host asked about a method it does not own', call.method)
      return fail('render-failed', `web-host:${typeof call.method === 'string' ? call.method : 'unnamed'}`)
    }
    const run = runs.get(call.runId)
    if (run === undefined) return fail('render-failed', `run:${call.runId}`)
    const capabilities = capabilitiesFor(run.capabilities)
    if (capabilities[HOST_METHOD_CAPABILITY[method]] !== true) return fail('capability-blocked', method)
    // The ceiling says the run *may* reach out; the reader's switch says whether this deployment will.
    if (deps.webRequestsEnabled() !== true) return fail('web-disabled', method)

    const args = Array.isArray(call.args) ? call.args : []
    if (method === 'web.request') {
      const url = requestUrl(args[0])
      if (!url.ok) return url
      const relayed = await relay(url.value)
      // Passed through as the proxy answered it, so the prelude's own 2xx test is the one the template
      // hears. `ok` is the route's, and a far-side 404 arrives as a body, not as a failure of this host.
      return relayed.ok ? succeed(relayed.reply) : relayed
    }

    const fetched = method === 'web.dailyQuote'
      ? await fetchQuote(args[0], relay)
      : await fetchPicture(args[0], relay)
    return fetched
  }

  return Object.assign(onHostCall, { beginRun, endRun, liveRuns: () => runs.size })
}

function asHostMethod(value: unknown): HostMethod | null {
  return typeof value === 'string' && (HOST_METHODS as readonly string[]).includes(value)
    ? value as HostMethod
    : null
}

/** `tp.web.request(url, path?)` sends `[{ url }]`; anything else is a bug on this side of the wire. */
function requestUrl(value: unknown): { ok: true; value: string } | Refusal {
  const record = asRecord(value)
  const url = record?.url
  if (typeof url !== 'string') return fail('path-invalid', 'web.request:arg:0:type')
  if (url.trim() === '') return fail('path-invalid', 'web.request:arg:0:empty')
  return { ok: true, value: url }
}

/**
 * One quote database, picked the way upstream picks it, with one addition.
 *
 * Upstream keys the table with the two-letter codes Obsidian answers with and falls back to English for
 * anything else. This app's `locale` is a BCP 47 tag — `en-US`, `zh-CN` — so a bare-subtag lookup is what
 * makes a registered language findable at all; the fallback is upstream's, unchanged.
 */
export function quoteDatabase(language: string): string | undefined {
  const wanted = language.trim().toLowerCase()
  if (!wanted) return QUOTE_DATABASES[DEFAULT_QUOTE_LANGUAGE]
  return QUOTE_DATABASES[wanted] ?? QUOTE_DATABASES[wanted.split('-')[0] ?? ''] ?? QUOTE_DATABASES[DEFAULT_QUOTE_LANGUAGE]
}

/**
 * `tp.web.daily_quote(language?)`: one database, and one quote out of it at random.
 *
 * The language has already been resolved by the prelude — an explicit argument, then the reader's locale,
 * then `en` (`worker/bootstrap.ts`'s `quoteLanguage`) — so this answers the table and the fallback, which
 * is where the URLs live.
 */
async function fetchQuote(language: unknown, relay: (url: string) => Promise<RelayResult>): Promise<Outcome> {
  if (typeof language !== 'string') return fail('render-failed', 'web.dailyQuote:arg:0:type')
  const database = quoteDatabase(language)
  if (database === undefined) return fail('web-request-failed', 'web.dailyQuote')
  const relayed = await relay(database)
  if (!relayed.ok) return relayed
  const body = readReply(relayed.reply)
  if (!body.ok) return body
  const quotes = body.value
  if (!Array.isArray(quotes) || quotes.length === 0) return fail('web-request-failed', 'web.dailyQuote')
  const picked = quotes[Math.floor(Math.random() * quotes.length)]
  const record = asRecord(picked)
  const quote = record?.quote
  const author = record?.author
  // Upstream destructures whatever the random index landed on, so an entry missing its text throws there.
  // Here it is the answer that says so, with the member named.
  if (typeof quote !== 'string' || typeof author !== 'string') return fail('web-request-failed', 'web.dailyQuote')
  return succeed({ quote, author })
}

/**
 * `tp.web.random_picture(size, query?, include_size?)`: the relay service upstream uses, and its record.
 *
 * The query is encoded, which upstream does not do (`InternalModuleWeb.ts:96` concatenates it raw, so a
 * query holding `&` writes parameters into the address the proxy is told to fetch). The picture's own URL is
 * what the proxy fetched, and the relay answers it whole: this host does not touch it, because the size
 * suffix the prelude appends (`&w=`, `&h=`) is built on the assumption that `full` arrived as written.
 */
async function fetchPicture(query: unknown, relay: (url: string) => Promise<RelayResult>): Promise<Outcome> {
  if (query !== null && typeof query !== 'string') return fail('render-failed', 'web.randomPicture:arg:0:type')
  const address = query ? `${UNSPLASH_ENDPOINT}?${new URLSearchParams({ q: query }).toString()}` : UNSPLASH_ENDPOINT
  const relayed = await relay(address)
  if (!relayed.ok) return relayed
  const body = readReply(relayed.reply)
  if (!body.ok) return body
  const photo = asRecord(body.value)
  const fields = [photo?.full, photo?.photog, photo?.photogUrl]
  if (fields.some((field) => typeof field !== 'string')) return fail('web-request-failed', 'web.randomPicture')
  return succeed({ full: photo?.full, photog: photo?.photog, photogUrl: photo?.photogUrl })
}

/**
 * The proxy's body, read as JSON.
 *
 * A status outside 2xx is the failure the route reported, with the status as the measurement — the same
 * rule the prelude applies to a `tp.web.request` answer, so both paths disagree with upstream in the same
 * direction. A body that will not parse is `json`, which is the token the prelude uses for the same fact.
 */
function readReply(reply: ProxyReply): { ok: true; value: unknown } | Refusal {
  if (reply.status < 200 || reply.status > 299) return fail('web-request-failed', String(reply.status))
  try {
    return { ok: true, value: JSON.parse(reply.text) }
  }
  catch {
    return fail('web-request-failed', 'json')
  }
}

/**
 * The one door: POST the address, get the bounded text answer.
 *
 * This is the app's own route, so the request carries the client header the auth middleware requires for a
 * write and the session cookie it reads, and nothing else — no header a template could name. The failure
 * names are this deployment's own tokens: the route's code, or `timeout`/`offline` when the browser never
 * got an answer.
 */
async function fetchThroughProxy(url: string): Promise<RelayResult> {
  let response: Response
  try {
    response = await fetch(PROXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' },
      body: JSON.stringify({ url }),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })
  }
  catch (error) {
    const name = error instanceof Error ? error.name : ''
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    if (!timedOut) console.error('[inkstone] templater proxy request failed', error)
    return fail('web-request-failed', timedOut ? 'timeout' : 'offline')
  }

  const body = await readBody(response)
  if (!response.ok) {
    // `routeApiError` is the app's one reading of `{ error: { code, message } }`, and only its code is
    // used: the message is this deployment's English, and a detail is a measurement. A code the Templater
    // table already has a sentence for is named as itself; anything else — `too_many_attempts`,
    // `unauthenticated`, `bad_request` — is a fact about this request rather than about the template's
    // rights or its address, so it is reported as a request that did not come back.
    const failure = routeApiError(response.status, body)
    return isTemplaterErrorCode(failure.code)
      ? fail(failure.code, failure.code)
      : fail('web-request-failed', failure.code)
  }
  const reply = asReply(body)
  // A 200 that is not the four fields is a bug in this deployment, not a template failure, and it is
  // reported rather than answered as an empty body a template would then parse into nothing.
  return reply === null ? fail('web-request-failed', 'proxy-shape') : { ok: true, reply }
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  }
  catch {
    return null
  }
}

function asReply(value: unknown): ProxyReply | null {
  const record = asRecord(value)
  if (record === null) return null
  const { status, ok, contentType, text } = record
  if (typeof status !== 'number' || typeof ok !== 'boolean') return null
  if (typeof contentType !== 'string' || typeof text !== 'string') return null
  return { status, ok, contentType, text }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function succeed(value: unknown): Success {
  return { ok: true, value }
}

function fail(code: TemplaterErrorCode, detail: string): Refusal {
  return { ok: false, code, detail }
}
