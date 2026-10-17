/**
 * Talking to a model provider.
 *
 * Three wire protocols cover the services a reader can bring a key for: the OpenAI chat-completions
 * shape (which DeepSeek, Kimi, Qwen, OpenRouter, vLLM, Ollama and a hundred others imitate), Anthropic's
 * messages API, and Google's Gemini. Each is a streaming, tool-calling endpoint, and each fragments a
 * tool call's arguments across events, so the accumulation below is the part that has to be right — a
 * dropped `arguments` chunk is a tool that silently receives `{}`.
 *
 * The key is put on the request here and nowhere else: no route echoes it, and the browser never holds
 * it. Every address is vetted by the same guard the existing AI relay uses, and redirects are refused,
 * or a reader-supplied base URL would hand the worker an address it never checked.
 *
 * A provider that rate-limits, blinks, or refuses a key is not a turn that has to fail. `retry` is how a
 * caller says a second attempt is worth making, and `rotateKey` is what makes one worth anything on an
 * account that holds several: the retry is attempted only while nothing has been streamed yet, because
 * words the reader has already watched arrive cannot be unsaid by sending the request again.
 *
 * What is *sent* is decided here too, because it is a fact about the wire and not about the turn. Two of
 * those decisions are about money: the head of an Anthropic request — instructions and tool schemas — is
 * the one part of a multi-step turn that never changes, so it is marked as cacheable when it is long
 * enough for the vendor to keep it; and `structured` asks for JSON where a protocol has a field for the
 * request, which is only a request, so a caller reading an answer back still has to cope with prose.
 */

import { assertRelayableEndpoint, pickRelayHeaders } from '@shared/ai-proxy-guard'
import { estimateTokens, isSourceUrl, type AssistantProtocol, type AssistantReasoning, type ReasoningDialect } from '@shared/assistant'
import { anthropicReasoning, geminiThinkingConfig, openAiReasoningFields, reasoningDialect } from '@shared/reasoning'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'

export interface ToolSchema {
  name: string
  description: string
  /** A JSON Schema object, built by `toolSchemaFor` from the tool's own declared parameters. */
  parameters: Record<string, unknown>
}

export interface ToolCallRecord {
  id: string
  name: string
  args: unknown
  result: string
  error: boolean
}

/** One turn of history as the providers need it: text, plus the calls an assistant turn made. */
export interface ModelTurn {
  role: 'user' | 'assistant'
  content: string
  calls?: ToolCallRecord[]
  /**
   * Images the model is shown with this turn, as data URLs. The reader's text stays in `content`; these
   * ride beside it, which is what each protocol's own multi-part shape expects.
   */
  images?: { mime: string, dataUrl: string }[]
}

export type UpstreamEvent
  = | { type: 'text', delta: string }
    | { type: 'reasoning', delta: string }
    | { type: 'tool-call', id: string, name: string, args: unknown }
    /** Pages the vendor reported as consulted, named the way the vendor names them. */
    | { type: 'sources', sources: UpstreamSource[] }
    | { type: 'usage', inputTokens: number, outputTokens: number }
    /** The model was cut off at the output cap rather than stopping by itself. */
    | { type: 'truncated' }
    /** The provider stopped the answer under one of its own rules. */
    | { type: 'stop-reason', reason: UpstreamStopReason }

/**
 * A finish that is not the model having simply run out of things to say.
 *
 * All three mean "what you are reading was cut short by a rule", and a stream that ends on one otherwise
 * looks exactly like a reply that arrived whole. `stop`, `stop_sequence` and `tool_calls` are deliberately
 * absent: a model that ended on its own marker answered as much as it meant to.
 */
export type UpstreamStopReason = 'refusal' | 'content_filter' | 'safety'

/**
 * The names the vendors give a rule-driven stop, as they spell them.
 *
 * One table rather than a branch per wire, because the vendors borrow each other's vocabulary: a relay
 * that imitates OpenAI may answer `refusal` where OpenAI would answer `content_filter`.
 */
const STOP_REASONS: Record<string, UpstreamStopReason> = {
  refusal: 'refusal',
  content_filter: 'content_filter',
  // Gemini names the same block several ways, and upper-cases everything.
  SAFETY: 'safety',
  IMAGE_SAFETY: 'safety',
  RECITATION: 'safety',
  PROHIBITED_CONTENT: 'content_filter',
  BLOCKLIST: 'content_filter',
  SPII: 'content_filter',
}

/** The rule a vendor's finish name stands for, or null when the model stopped for no rule at all. */
function stopReasonFor(value: unknown): UpstreamStopReason | null {
  return typeof value === 'string' ? STOP_REASONS[value] ?? null : null
}

export interface UpstreamSource {
  url: string
  title: string
  cited?: string
}

/**
 * The pages named inside one vendor's payload, whichever shape it uses.
 *
 * Three services report a search differently — OpenAI annotates the message, Anthropic sends a result
 * block beside the text that leans on it, Gemini hangs grounding metadata off the candidate — and none
 * of the three is guessable from the others. One reader per shape, called from the parser that already
 * holds the frame, because a second pass over the finished stream would be a second parser to keep in
 * step with the first.
 */
export function sourcesFromOpenAi(annotations: unknown): UpstreamSource[] {
  if (!Array.isArray(annotations)) return []
  const out: UpstreamSource[] = []
  for (const entry of annotations) {
    const citation = (entry as Record<string, unknown>)?.url_citation as Record<string, unknown> | undefined
    const url = citation?.url
    if (!isSourceUrl(url)) continue
    out.push({ url, title: typeof citation?.title === 'string' && citation.title.trim() ? citation.title.trim() : url })
  }
  return out
}

export function sourcesFromAnthropicBlock(block: Record<string, unknown>): UpstreamSource[] {
  if (block.type !== 'web_search_tool_result') return []
  if (!Array.isArray(block.content)) return []
  const out: UpstreamSource[] = []
  for (const entry of block.content) {
    const result = entry as Record<string, unknown>
    if (result.type !== 'web_search_result') continue
    const url = result.url
    if (!isSourceUrl(url)) continue
    out.push({ url, title: typeof result.title === 'string' && result.title.trim() ? result.title.trim() : url })
  }
  return out
}

export function sourcesFromAnthropicCitations(citations: unknown): UpstreamSource[] {
  if (!Array.isArray(citations)) return []
  const out: UpstreamSource[] = []
  for (const entry of citations) {
    const citation = entry as Record<string, unknown>
    const url = citation.url
    if (!isSourceUrl(url)) continue
    out.push({
      url,
      title: typeof citation.title === 'string' && citation.title.trim() ? citation.title.trim() : url,
      ...(typeof citation.cited_text === 'string' && citation.cited_text.trim() ? { cited: citation.cited_text.trim().slice(0, 400) } : {}),
    })
  }
  return out
}

export function sourcesFromGemini(metadata: unknown): UpstreamSource[] {
  const chunks = (metadata as Record<string, unknown> | undefined)?.groundingChunks
  if (!Array.isArray(chunks)) return []
  const out: UpstreamSource[] = []
  for (const entry of chunks) {
    const web = (entry as Record<string, unknown>)?.web as Record<string, unknown> | undefined
    const url = web?.uri
    if (!isSourceUrl(url)) continue
    out.push({ url, title: typeof web?.title === 'string' && web.title.trim() ? web.title.trim() : url })
  }
  return out
}

export interface UpstreamRequest {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  turns: ModelTurn[]
  tools: ToolSchema[]
  maxOutputTokens: number
  /** Null leaves the vendor's own sampling default untouched. */
  temperature: number | null
  /** Null means the same for Top-P. */
  topP?: number | null
  /** Extra fields the reader typed into the model's own parameter list. */
  extraBody?: Record<string, string | number | boolean>
  /** How much the model is asked to think. `auto` sends nothing and lets the vendor decide. */
  reasoning: AssistantReasoning
  /**
   * The vendor's thinking shape when the reader pinned it on the provider.
   *
   * Null leaves the decision to `reasoningDialect`, which reads the address and the model's own name —
   * right for every service that announces itself and no help at all for a gateway that does not.
   */
  reasoningDialect?: ReasoningDialect | null
  /**
   * The reader asked for a live web search this turn.
   *
   * Only two of the three protocols have a vendor-side search tool to say that with; where there is none,
   * the runner does something else rather than sending a field that would be ignored.
   */
  webSearch?: boolean
  /**
   * Ask for the answer as one JSON object rather than as prose.
   *
   * This is a request, not a guarantee: two of the three wires have a field for it, and a relay is free to
   * ignore the one it has. So the caller still has to read JSON out of text — this only makes the answer
   * likely to *be* JSON, which is what turns a parser that guesses into a parser that rarely has to.
   */
  structured?: boolean
  /** Absent means one attempt: the caller is the one that knows whether repeating a failure is useful. */
  retry?: UpstreamRetry
  signal: AbortSignal
}

/**
 * How a failed attempt is followed up.
 *
 * A provider that rate-limits, goes down for a moment, or refuses one key is usually answering fine a
 * second later, so the same request is worth sending again. `attempts` is how many extra tries are
 * allowed, and `rotateKey` is what makes a retry worth anything on an account holding several keys: a
 * 429 or a 401 is the one failure a different key fixes, and the ring hands the next attempt the least
 * recently used one.
 */
export interface UpstreamRetry {
  /** Extra attempts after the first. */
  attempts: number
  /** The first backoff in ms, doubled per attempt. Overridable so a test does not sit on the clock. */
  baseMs?: number
  /** The key for the next attempt. Absent leaves the same key on the wire. */
  rotateKey?: () => Promise<string>
  /**
   * Told about each attempt that failed, before anything is decided about retrying.
   *
   * The caller is the only one that knows which of the reader's keys was on the wire — the request carries
   * a key, not a row id — and "which key is broken" is a thing the settings screen has to be able to say.
   * Awaited, so a key that failed twice in one turn is counted twice rather than once.
   */
  onAttemptFailed?: (error: UpstreamError, apiKey: string) => void | Promise<void>
}

export class UpstreamError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate' | 'quota' | 'unreachable' | 'unsupported' | 'bad-request' | 'timeout',
    message: string,
    readonly status?: number,
    /**
     * How long the provider asked the caller to wait, in ms, when it said so.
     *
     * A 429 usually names a number, and guessing shorter than it only earns another 429 — so this is
     * believed over the caller's own backoff when it is present.
     */
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

/** A stream that stalls must not hold the request open forever. */
const FIRST_CHUNK_TIMEOUT_MS = 60_000
const IDLE_CHUNK_TIMEOUT_MS = 90_000

/** The backoff a retry starts from, how far it may grow, and the longest wait a `Retry-After` can ask. */
const RETRY_BASE_MS = 400
const RETRY_MAX_MS = 8_000
const RETRY_AFTER_CAP_MS = 30_000

/**
 * One request to a provider, with the caller's retry policy applied to it.
 *
 * The retry lives here rather than in the runner because it is a fact about the wire — the request never
 * reached a model, or was refused before one byte of an answer came back — and every caller that talks to
 * a provider gets the same behaviour for free. The one thing it will not do is repeat a call that has
 * already streamed: `produced` is set by the first event yielded, and a failure after it is the turn's own
 * to report rather than something to paper over with a second answer.
 */
export async function* streamUpstream(
  protocol: AssistantProtocol,
  request: UpstreamRequest,
): AsyncGenerator<UpstreamEvent> {
  const attempts = Math.max(0, request.retry?.attempts ?? 0)
  let apiKey = request.apiKey
  for (let attempt = 0; ; attempt++) {
    let produced = false
    try {
      for await (const event of streamOnce(protocol, { ...request, apiKey })) {
        produced = true
        yield event
      }
      return
    } catch (error) {
      // Every failed attempt is reported, including one that will not be retried: a key that is refused
      // once is still the key that was refused, and the retry path is where that is still known.
      if (error instanceof UpstreamError) await request.retry?.onAttemptFailed?.(error, apiKey)
      if (produced || attempt >= attempts || !retryable(error)) throw error
      const next = await nextAttemptKey(error, request.retry, apiKey)
      // Null is "no other key to try", which is what a rejection naming the key itself comes to when the
      // ring holds only the one that was just refused.
      if (next === null) throw error
      await wait(backoffMs(attempt, request.retry, error), request.signal)
      apiKey = next
    }
  }
}

async function* streamOnce(
  protocol: AssistantProtocol,
  request: UpstreamRequest,
): AsyncGenerator<UpstreamEvent> {
  switch (protocol) {
    case 'anthropic':
      return yield* streamAnthropic(request)
    case 'gemini':
      return yield* streamGemini(request)
    default:
      return yield* streamOpenAi(request)
  }
}

/**
 * Whether a second attempt could plausibly answer where the first did not.
 *
 * Everything the provider says about its own availability, its rate, or the key is worth repeating. What
 * it says about the request is not: a body it refused on its own terms will be refused again, and the
 * caller's fallback chain is the place that decides what to do about a model it does not know.
 */
function retryable(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return false
  return error.kind !== 'bad-request' && error.kind !== 'unsupported'
}

/**
 * The key the next attempt is sent with, or null when there is nothing left to change.
 *
 * A ring of one hands the same key back, and repeating a rejection that names the key is only a wait: the
 * two kinds that mean "this key is spent" therefore stop here rather than burning the caller's budget on
 * attempts that cannot succeed. A rate limit is the exception, because it is about the moment rather than
 * the key, and a moment passes.
 */
async function nextAttemptKey(
  error: unknown,
  retry: UpstreamRetry | undefined,
  current: string,
): Promise<string | null> {
  const spent = error instanceof UpstreamError && (error.kind === 'auth' || error.kind === 'quota')
  if (!retry?.rotateKey) return spent ? null : current
  const next = await retry.rotateKey()
  return next === current && spent ? null : next
}

/** How long to wait before an attempt, with jitter so a fleet of turns does not retry in lockstep. */
function backoffMs(attempt: number, retry: UpstreamRetry | undefined, error: unknown): number {
  const after = error instanceof UpstreamError ? error.retryAfterMs : undefined
  if (after !== undefined) return Math.min(after, RETRY_AFTER_CAP_MS)
  const base = Math.max(0, retry?.baseMs ?? RETRY_BASE_MS)
  const scaled = Math.min(base * 2 ** attempt, RETRY_MAX_MS)
  return scaled + Math.random() * scaled * 0.25
}

/** A pause a reader's stop can cut short, so a retry never outlives the turn it belongs to. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// --------------------------------------------------------------------- fetch

interface PreparedRequest {
  url: string
  init: RequestInit
}

async function postStream(prepared: PreparedRequest, signal: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const detach = () => signal.removeEventListener('abort', onAbort)
  let response: Response
  try {
    response = await fetch(prepared.url, { ...prepared.init, signal: controller.signal })
  } catch (error) {
    detach()
    if (signal.aborted) throw new AbortError()
    throw new UpstreamError('unreachable', error instanceof Error ? error.message : 'The provider could not be reached')
  }
  if (isRedirectResponse(response)) {
    detach()
    throw new UpstreamError('unreachable', 'The provider answered with a redirect, which the assistant refuses to follow')
  }
  if (!response.ok) {
    const failure = await describeFailure(response)
    detach()
    throw failure
  }
  if (!response.body) {
    detach()
    throw new UpstreamError('unreachable', 'The provider returned an empty response body')
  }
  // The listener stays attached for the life of the body: a reader who closes the tab has to stop the
  // download, not merely the request that started it. Detaching after the headers arrived would leave
  // the model writing into a stream nobody reads until the idle timer gave up.
  return response
}

/** A name the runner can branch on without reading a message string. */
export class AbortError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortError'
  }
}

/**
 * The provider's own reason, taken out of its body and made safe to show.
 *
 * A 400 almost always names the field it objected to — `max_tokens must be ≤ 8192` is the difference
 * between a reader fixing a setting and a reader guessing for an hour — and dropping it left a dead-end
 * sentence with nothing to act on. Only the structured error field is read, never the raw body: a relay
 * can put anything in there, so this is a short single line of plain text, not a quotation.
 */
function providerReason(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const nested = record.error && typeof record.error === 'object'
    ? (record.error as Record<string, unknown>).message
    : undefined
  const said = nested ?? record.message ?? record.detail
  if (typeof said !== 'string' || !said.trim()) return null
  const oneLine = said.replace(/[\u0000-\u001f\u2028\u2029]+/g, ' ').trim()
  return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine
}

async function describeFailure(response: Response): Promise<UpstreamError> {
  const text = (await response.text().catch(() => '')).slice(0, 600)
  const lower = text.toLowerCase()
  const after = retryAfterMs(response)
  if (response.status === 401 || response.status === 403) {
    return new UpstreamError('auth', 'The provider rejected the API key.', response.status)
  }
  if (response.status === 429) {
    const quota = /quota|exhausted|insufficient|billing|balance/.test(lower)
    return new UpstreamError(quota ? 'quota' : 'rate', quota
      ? 'The provider reports the account is out of quota.'
      : 'The provider is rate-limiting this account. Try again shortly.', response.status, after)
  }
  if (response.status === 404 || /model|not found|unsupported/.test(lower)) {
    return new UpstreamError('unsupported', `The provider does not know that model (${response.status}).`, response.status)
  }
  if (response.status >= 500) {
    return new UpstreamError('unreachable', `The provider is unavailable (${response.status}).`, response.status, after)
  }
  const reason = providerReason(text)
  return new UpstreamError('bad-request', reason
    ? `The provider rejected the request (${response.status}): ${reason}`
    : `The provider rejected the request (${response.status}).`, response.status)
}

/**
 * How long the provider asked the caller to wait, in ms.
 *
 * The header is either a number of seconds or an HTTP date, and both are seen in the wild. A value that is
 * neither is ignored rather than guessed at, because a wrong number here would be worse than the backoff.
 */
function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim()
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/**
 * Reads a server-sent-events body, yielding each frame's `data:` payload.
 *
 * Frames are split on the blank line rather than per line, because a JSON payload may itself contain a
 * newline inside a string; and an idle stream is cancelled, so a provider that stops answering cannot
 * hold a reader's conversation open.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  /** Overridable so a stalled-stream test does not have to sit on the real minute-long timer. */
  timeouts: { first?: number, idle?: number } = {},
): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  const firstMs = timeouts.first ?? FIRST_CHUNK_TIMEOUT_MS
  const idleMs = timeouts.idle ?? IDLE_CHUNK_TIMEOUT_MS
  let buffer = ''
  let idle: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const arm = (ms: number) => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      timedOut = true
      void reader.cancel().catch(() => {})
    }, ms)
  }
  try {
    arm(firstMs)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        // A cancel from the idle timer arrives as an ordinary end of stream. Reported as one, a
        // provider that went silent would save a half answer as if it were the whole answer.
        if (timedOut) throw new UpstreamError('timeout', 'The provider stopped answering before the end.')
        break
      }
      arm(idleMs)
      // Some gateways frame their events with CRLF; a blank line is a blank line either way, and a
      // carriage return surviving into a `data:` payload would only break the JSON parse after it.
      // The whole buffer is normalised because a CRLF pair can be split across two chunks.
      buffer = (buffer + value).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data && data !== '[DONE]') yield data
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof Error && error.name === 'AbortError') throw new AbortError()
    throw error
  } finally {
    if (idle) clearTimeout(idle)
    try {
      reader.releaseLock()
    } catch {
      /* the stream was already released by the cancel above */
    }
  }
}

function vettedUrl(endpoint: string): URL {
  try {
    return assertRelayableEndpoint(endpoint)
  } catch (error) {
    throw new UpstreamError('bad-request', error instanceof Error ? error.message : 'Invalid provider address')
  }
}

function jsonHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...extra,
  }
  // Only the allowlisted names survive, so a caller cannot smuggle a cookie or an origin header upstream.
  return pickRelayHeaders({ ...headers, authorization: apiKey ? `Bearer ${apiKey}` : '' }) as Record<string, string>
}

// -------------------------------------------------------------------- OpenAI

/** The thinking shape this request has to satisfy: the reader's pin, or what the address and model say. */
function dialectOf(protocol: AssistantProtocol, request: UpstreamRequest): ReasoningDialect {
  return reasoningDialect(protocol, request.baseUrl, request.model, request.reasoningDialect)
}

function openAiBody(request: UpstreamRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: request.system }]
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: openAiUserContent(turn) })
      continue
    }
    const calls = turn.calls ?? []
    if (!calls.length) {
      messages.push({ role: 'assistant', content: turn.content })
      continue
    }
    messages.push({
      role: 'assistant',
      content: turn.content || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
    })
    for (const call of calls) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: call.result })
    }
  }
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.topP == null ? {} : { top_p: request.topP }),
    max_tokens: request.maxOutputTokens,
    // The JSON mode every OpenAI-compatible server is expected to read, rather than the schema-carrying
    // form only the newest ones do: a field a relay refuses is worse than one it ignores.
    ...(request.structured ? { response_format: { type: 'json_object' } } : {}),
    ...openAiReasoningFields(dialectOf('openai', request), request.reasoning),
    ...request.extraBody,
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
  }
}

/** A user turn with pictures is a part list; one without is the plain string every server accepts. */
function openAiUserContent(turn: ModelTurn): unknown {
  if (!turn.images?.length) return turn.content
  return [
    { type: 'text', text: turn.content },
    ...turn.images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
  ]
}

async function* streamOpenAi(request: UpstreamRequest): AsyncGenerator<UpstreamEvent> {
  const url = vettedUrl(openAiEndpoint(request.baseUrl))
  const response = await postStream({
    url: url.toString(),
    init: {
      method: 'POST',
      headers: jsonHeaders(request.apiKey),
      body: JSON.stringify(openAiBody(request)),
      redirect: NO_REDIRECT,
    },
  }, request.signal)

  const pending = new Map<number, { id: string, name: string, args: string }>()
  for await (const data of readSse(response.body!, request.signal)) {
    const parsed = parseFrame(data)
    if (!parsed) continue
    const usage = parsed.usage as Record<string, unknown> | undefined
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: numberOr(usage.prompt_tokens) ?? 0,
        outputTokens: numberOr(usage.completion_tokens) ?? 0,
      }
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
    if (!choice) continue
    const delta = (choice.delta ?? {}) as Record<string, unknown>
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content }
    // DeepSeek-R1 and friends stream their chain of thought on a separate field.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      yield { type: 'reasoning', delta: delta.reasoning_content as string }
    }
    // A searched answer arrives with its citations as annotations on the text, one frame per delta.
    const annotations = sourcesFromOpenAi(delta.annotations)
    if (annotations.length) yield { type: 'sources', sources: annotations }
    const calls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : []
    for (const call of calls) {
      const slot = numberOr(call.index) ?? 0
      const fn = (call.function ?? {}) as Record<string, unknown>
      const entry = pending.get(slot) ?? { id: '', name: '', args: '' }
      if (typeof call.id === 'string') entry.id = call.id
      if (typeof fn.name === 'string') entry.name += fn.name
      if (typeof fn.arguments === 'string') entry.args += fn.arguments
      pending.set(slot, entry)
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== 'tool_calls') {
      for (const entry of flush(pending)) yield entry
      // `length` is the cap: the answer stops mid-sentence, and a turn filed as finished would leave
      // the reader guessing whether the model was done or simply out of room.
      if (choice.finish_reason === 'length') yield { type: 'truncated' }
      const blocked = stopReasonFor(choice.finish_reason)
      if (blocked) yield { type: 'stop-reason', reason: blocked }
    }
  }
  for (const entry of flush(pending)) yield entry
}

function flush(pending: Map<number, { id: string, name: string, args: string }>): UpstreamEvent[] {
  const out: UpstreamEvent[] = []
  for (const [slot, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    if (!entry.name) continue
    out.push({ type: 'tool-call', id: entry.id || `${entry.name}-${slot}`, name: entry.name, args: parseArgs(entry.args) })
    pending.delete(slot)
  }
  return out
}

export function openAiEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/chat/completions')) return base
  // A reader pastes a host, not a path ("https://api.openai.com"), and the OpenAI-compatible
  // services answer under /v1; a base that already carries a path is left exactly as written.
  const afterHost = base.replace(/^[a-z]+:\/\//i, '')
  return afterHost.includes('/') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    // A truncated argument object is reported as an empty call, which the executor rejects by name and
    // the model sees as a tool error — better than feeding it a half-parsed object.
    return {}
  }
}

// ---------------------------------------------------------------- Anthropic

/**
 * The shortest prefix Anthropic keeps at all.
 *
 * A breakpoint is bought, not free: the vendor charges a write premium on the prefix it marks and only
 * answers cheaply on the turns that find it. Below its own floor nothing is ever found, so the honest
 * request is the one that asks for nothing. This is the floor published for the Sonnet and Opus models;
 * Haiku's is higher, and a prefix between the two is written and then not kept — one wasted premium on
 * the shortest requests, which is why the gate is not tuned per model.
 */
const ANTHROPIC_MIN_CACHE_PREFIX_TOKENS = 1_024

/** The ephemeral breakpoint Anthropic's docs name, with no ttl: the default lifetime is the one wanted. */
type AnthropicCacheControl = { type: 'ephemeral' }

/**
 * Where an Anthropic request is worth putting a breakpoint, or null when it is not.
 *
 * Measured on the system prompt and the tool schemas together, because in the vendor's own render order
 * that pair *is* the head of the prompt — and it is the head that repeats: every step of a turn sends the
 * same instructions and the same schemas, and a turn that calls three tools sends them four times over.
 * The conversation is deliberately not marked: it changes with every turn, and a breakpoint that no later
 * request reaches is only the write cost.
 */
function anthropicCacheBreakpoint(
  system: string,
  tools: readonly Record<string, unknown>[],
): AnthropicCacheControl | null {
  const prefix = estimateTokens(system) + estimateTokens(JSON.stringify(tools))
  return prefix >= ANTHROPIC_MIN_CACHE_PREFIX_TOKENS ? { type: 'ephemeral' } : null
}

async function* streamAnthropic(request: UpstreamRequest): AsyncGenerator<UpstreamEvent> {
  const url = vettedUrl(anthropicEndpoint(request.baseUrl))
  const blocks: Record<string, unknown>[] = []
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      blocks.push({
        role: 'user',
        content: turn.images?.length
          ? [
              { type: 'text', text: turn.content },
              ...turn.images.map((image) => ({
                type: 'image',
                source: { type: 'base64', media_type: image.mime, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) },
              })),
            ]
          : turn.content,
      })
      continue
    }
    const calls = turn.calls ?? []
    const content: Record<string, unknown>[] = []
    if (turn.content) content.push({ type: 'text', text: turn.content })
    for (const call of calls) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} })
    }
    if (!content.length) content.push({ type: 'text', text: ' ' })
    blocks.push({ role: 'assistant', content })
    const results = calls.map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: call.result,
      ...(call.error ? { is_error: true } : {}),
    }))
    if (results.length) blocks.push({ role: 'user', content: results })
  }
  const thinking = anthropicReasoning(dialectOf('anthropic', request), request.reasoning, request.maxOutputTokens)
  const tools: Record<string, unknown>[] = [
    ...request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    // The vendor's own search tool. Asking for it by its dated type is what makes the
    // composer's switch real on this protocol instead of a field that gets ignored.
    ...(request.webSearch ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] : []),
  ]
  // Two breakpoints on the one part of the request that never changes: the last schema entry ends the
  // tools block, and the system blocks follow it, so between them they cover the whole cached head.
  const cache = anthropicCacheBreakpoint(request.system, tools)
  if (cache && tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1]!, cache_control: cache }
  // A breakpoint only exists on a block, so a cacheable request sends its instructions as a block list;
  // one empty text block is refused by the vendor, so an empty system stays the string it already is.
  const system = cache && request.system.trim()
    ? [{ type: 'text', text: request.system, cache_control: cache }]
    : request.system
  const response = await postStream({
    url: url.toString(),
    init: {
      method: 'POST',
      headers: anthropicHeaders(request.apiKey),
      body: JSON.stringify({
        model: request.model,
        system,
        messages: blocks,
        max_tokens: request.maxOutputTokens,
        // Whether the reader's sampling settings may travel at all is the model's own rule, not this
        // request's: see `anthropicReasoning` for which models refuse them and why.
        ...(thinking.sampling && request.temperature !== null ? { temperature: request.temperature } : {}),
        ...(thinking.sampling && request.topP != null ? { top_p: request.topP } : {}),
        ...thinking.fields,
        stream: true,
        // `request.structured` sends nothing here, and that is the answer rather than a guess: this wire
        // has no JSON-mode field to set — the vendor's documented route to a constrained shape is a tool
        // definition, and inventing a `response_format` key here would be a 400 waiting for a reader.
        ...request.extraBody,
        ...(tools.length ? { tools } : {}),
      }),
      redirect: NO_REDIRECT,
    },
  }, request.signal)

  interface OpenBlock { kind: string, id: string, name: string, json: string }
  const open = new Map<number, OpenBlock>()
  // Anthropic reports the prompt size once, at the start, and the answer size at the end; the two
  // arrive in different events and the reader's usage meter needs both.
  let inputTokens = 0
  for await (const data of readSse(response.body!, request.signal)) {
    const parsed = parseFrame(data)
    if (!parsed) continue
    const type = parsed.type
    if (type === 'message_start') {
      const message = (parsed.message ?? {}) as Record<string, unknown>
      const start = (message.usage ?? {}) as Record<string, unknown>
      inputTokens = numberOr(start.input_tokens) ?? 0
    } else if (type === 'content_block_start') {
      const index = numberOr((parsed.index as number | undefined)) ?? 0
      const block = (parsed.content_block ?? {}) as Record<string, unknown>
      // A search is a block of its own, and it arrives whole: the results are in it before the text
      // that leans on them is streamed.
      const searched = sourcesFromAnthropicBlock(block)
      if (searched.length) yield { type: 'sources', sources: searched }
      open.set(index, {
        kind: String(block.type ?? ''),
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        json: '',
      })
    } else if (type === 'content_block_delta') {
      const index = numberOr((parsed.index as number | undefined)) ?? 0
      const delta = (parsed.delta ?? {}) as Record<string, unknown>
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        yield { type: 'text', delta: delta.text }
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        yield { type: 'reasoning', delta: delta.thinking }
      } else if (delta.type === 'citations_delta') {
        const cited = sourcesFromAnthropicCitations([delta.citation])
        if (cited.length) yield { type: 'sources', sources: cited }
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const block = open.get(index)
        if (block) block.json += delta.partial_json
      }
    } else if (type === 'content_block_stop') {
      const index = numberOr((parsed.index as number | undefined)) ?? 0
      const block = open.get(index)
      open.delete(index)
      if (block?.kind === 'tool_use') {
        yield { type: 'tool-call', id: block.id || `${block.name}-${index}`, name: block.name, args: parseArgs(block.json) }
      }
    } else if (type === 'message_delta') {
      // Anthropic says why it stopped in the same event that carries the answer's size.
      const stopReason = (parsed.delta as Record<string, unknown> | undefined)?.stop_reason
      if (stopReason === 'max_tokens') yield { type: 'truncated' }
      const blocked = stopReasonFor(stopReason)
      if (blocked) yield { type: 'stop-reason', reason: blocked }
      const usage = (parsed.usage ?? {}) as Record<string, unknown>
      const input = numberOr(usage.input_tokens) ?? inputTokens
      const output = numberOr(usage.output_tokens)
      if (input > 0 || output !== undefined) {
        yield { type: 'usage', inputTokens: input, outputTokens: output ?? 0 }
      }
    }
  }
}

export function anthropicEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/messages')) return base
  if (base.endsWith('/v1')) return `${base}/messages`
  return `${base}/v1/messages`
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  const merged = pickRelayHeaders({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }) as Record<string, string>
  if (!merged['x-api-key']) throw new UpstreamError('auth', 'This provider needs an API key before it can be used.')
  return merged
}

// ------------------------------------------------------------------- Gemini

async function* streamGemini(request: UpstreamRequest): AsyncGenerator<UpstreamEvent> {
  const url = vettedUrl(geminiEndpoint(request.baseUrl, request.model))
  const contents: Record<string, unknown>[] = []
  for (const turn of request.turns) {
    const parts: Record<string, unknown>[] = []
    if (turn.content) parts.push({ text: turn.content })
    for (const image of turn.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mime, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) } })
    }
    for (const call of turn.calls ?? []) {
      parts.push({ functionCall: { name: call.name, args: (call.args as Record<string, unknown>) ?? {} } })
    }
    for (const call of turn.calls ?? []) {
      parts.push({ functionResponse: { name: call.name, response: { result: call.result } } })
    }
    if (!parts.length) parts.push({ text: ' ' })
    contents.push({ role: turn.role === 'assistant' ? 'model' : 'user', parts })
  }
  const response = await postStream({
    url: url.toString(),
    init: {
      method: 'POST',
      headers: jsonHeaders(request.apiKey),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents,
        generationConfig: {
          ...(request.temperature === null ? {} : { temperature: request.temperature }),
          ...(request.topP == null ? {} : { topP: request.topP }),
          maxOutputTokens: request.maxOutputTokens,
          ...(request.structured ? { responseMimeType: 'application/json' } : {}),
          ...geminiThinkingConfig(dialectOf('gemini', request), request.reasoning, request.model),
        },
        // One `tools` array: Google's grounding entry is a sibling of the function declarations, and a
        // second `tools` key in this object would silently drop whichever came first.
        ...(request.tools.length || request.webSearch
          ? {
              tools: [
                ...(request.webSearch ? [{ googleSearch: {} }] : []),
                ...(request.tools.length
                  ? [{
                      functionDeclarations: request.tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                      })),
                    }]
                  : []),
              ],
            }
          : {}),
      }),
      redirect: NO_REDIRECT,
    },
  }, request.signal)

  let callIndex = 0
  for await (const data of readSse(response.body!, request.signal)) {
    const parsed = parseFrame(data)
    if (!parsed) continue
    const usage = (parsed.usageMetadata ?? parsed.usage_metadata) as Record<string, unknown> | undefined
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: numberOr(usage.promptTokenCount ?? usage.prompt_tokens) ?? 0,
        outputTokens: numberOr(usage.candidatesTokenCount ?? usage.candidates_tokens) ?? 0,
      }
    }
    const candidate = Array.isArray(parsed.candidates) ? (parsed.candidates[0] as Record<string, unknown>) : undefined
    const parts = ((candidate?.content as Record<string, unknown> | undefined)?.parts ?? []) as Record<string, unknown>[]
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        yield part.thought === true ? { type: 'reasoning', delta: part.text } : { type: 'text', delta: part.text }
      }
      const call = part.functionCall as Record<string, unknown> | undefined
      if (call && typeof call.name === 'string') {
        callIndex++
        yield {
          type: 'tool-call',
          id: `${call.name}-${callIndex}`,
          name: call.name,
          args: (call.args as Record<string, unknown>) ?? {},
        }
      }
    }
    // Gemini hangs the pages it grounded on off the candidate rather than the text, and repeats the
    // whole list as the answer streams, so the runner de-duplicates by url rather than here.
    const grounded = sourcesFromGemini(candidate?.groundingMetadata)
    if (grounded.length) yield { type: 'sources', sources: grounded }
    // Gemini names the reason on the last candidate, which often carries no parts at all.
    if (candidate?.finishReason === 'MAX_TOKENS') yield { type: 'truncated' }
    const blocked = stopReasonFor(candidate?.finishReason)
    if (blocked) yield { type: 'stop-reason', reason: blocked }
  }
}

/**
 * Gemini puts the model in the path and takes the key from a header rather than the query, so the address
 * is assembled rather than configured. `alt=sse` is what makes the response a stream of frames instead of
 * one JSON array.
 */
export function geminiEndpoint(baseUrl: string, model: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const trimmed = base.replace(/\/v1beta$/, '').replace(/\/models$/, '')
  return `${trimmed}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
}

// -------------------------------------------------------------------- shared

function parseFrame(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function numberOr(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}
