/**
 * The assistant's own web search, for a provider whose protocol has none.
 *
 * Anthropic and Gemini can be asked to search and do it on their own servers; an OpenAI-compatible relay —
 * which is what DeepSeek, Kimi, Qwen, OpenRouter, vLLM and a local Ollama all look like — has no such
 * field, so the switch has to be carried by something the worker runs itself. It asks one engine, named in
 * `@shared/web-search-engines`, and hands the hits back as a tool result. The engine table says where the
 * address is, what method the vendor takes, how its key travels, and which fields of its answer carry a
 * result; nothing below branches on an engine id, so a new engine is a new entry and not a new path here.
 *
 * The address is untrusted input of exactly the class a provider's base URL is — a self-hosted one is typed
 * by the reader — so every outbound address goes through the same guard, including a vendor's fixed host,
 * which is written down by a person in this repository rather than by the reader. Redirects are refused for
 * the same reason, because a public address that answers 302 is a public address only until it is followed.
 *
 * A search that fails is reported as one: the turn is not allowed to read as an answer built on nothing.
 */

import { assertRelayableEndpoint } from '@shared/ai-proxy-guard'
import { isSourceUrl, WEB_SEARCH_TOOL_NAME, type AssistantSource } from '@shared/assistant'
import { WEB_SEARCH_ENGINES, WEB_SEARCH_RESULT_LIMIT, type WebSearchEngineSpec } from '@shared/web-search-engines'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'

/** How much of one hit's snippet travels. */
const SNIPPET_CHARS = 400

/** How much of a snippet a citation card shows. The same bound a note citation's `cited` carries. */
const CITED_CHARS = 300

/** How long the engine may take before the turn is told it did not answer. */
const SEARCH_TIMEOUT_MS = 8_000

/** A result list is kilobytes, not a page: past this the endpoint is not answering with results. */
const MAX_RESPONSE_BYTES = 512 * 1024

/** The endpoint or the vendor went wrong in a way the reader can be told about, in words the tool returns as its error. */
export class WebSearchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebSearchError'
  }
}

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

/** One search, stated as the pieces an engine's entry describes. */
export interface WebSearchRequest {
  /** The chosen engine's declared shape. Passed in rather than read off an id so the caller resolves the id once. */
  engine: WebSearchEngineSpec
  /** The address to ask: the reader's own for a self-hosted engine, the vendor's fixed one otherwise. */
  endpoint: string
  query: string
  /** The reader's key for the engine. Never logged, never put in a URL, and required when the engine says it is. */
  apiKey?: string
  signal?: AbortSignal
}

function textOf(entry: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * The list one declared path points at, or nothing.
 *
 * An empty path names the payload itself, which is how an endpoint that answers with a bare array is read:
 * it is not answering a different question, only from a different place.
 */
function listAt(payload: unknown, path: readonly string[]): unknown[] | null {
  let node: unknown = payload
  for (const step of path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null
    node = (node as Record<string, unknown>)[step]
  }
  return Array.isArray(node) ? node : null
}

/**
 * The hits inside an engine's answer, in the order it put them.
 *
 * Nothing here is guessed at beyond what the engine's own entry declares: an entry with no usable address is
 * dropped, because a hit the model cannot cite and a reader cannot open is worse than one fewer result.
 */
export function hitsFromPayload(payload: unknown, engine: WebSearchEngineSpec): WebSearchHit[] {
  let list: unknown[] | null = null
  for (const path of engine.resultPaths) {
    const candidate = listAt(payload, path)
    if (candidate) {
      list = candidate
      break
    }
  }
  if (!list) return []
  const out: WebSearchHit[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (out.length >= WEB_SEARCH_RESULT_LIMIT) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const url = textOf(record, engine.urlKeys)
    if (!isSourceUrl(url) || seen.has(url)) continue
    seen.add(url)
    out.push({
      title: (textOf(record, engine.titleKeys) || url).slice(0, 200),
      url,
      snippet: textOf(record, engine.snippetKeys).slice(0, SNIPPET_CHARS),
    })
  }
  return out
}

/**
 * The generic reader, kept for the shapes this tool grew up with.
 *
 * Two things go through it and neither is a vendor's payload: a self-hosted engine, whose answer shape
 * belongs to whoever installed it, and this tool's own result envelope — `{ results: hits }` — which
 * `webSearchSources` reads back when the citations under an answer are filed.
 */
export function hitsFromSearchPayload(payload: unknown): WebSearchHit[] {
  return hitsFromPayload(payload, WEB_SEARCH_ENGINES['self-hosted']!)
}

/** The query as far as this engine will take it: clipped to its own documented bound, if it names one. */
function queryFor(engine: WebSearchEngineSpec, query: string): string {
  const words = query.trim()
  return engine.queryMaxChars ? words.slice(0, engine.queryMaxChars) : words
}

/**
 * The address one query is sent to.
 *
 * Guarded before anything is fetched, whichever address it is. A parameter engine writes the query into
 * `q` — or whatever its entry names — and a self-hosted one is also told to answer in JSON, because an
 * engine that is not asked for JSON answers in HTML and the failure would then read as a broken endpoint
 * rather than as the missing parameter the reader can add.
 */
export function searchUrlFor(engine: WebSearchEngineSpec, endpoint: string, query: string): URL {
  let target: URL
  try {
    target = assertRelayableEndpoint(endpoint)
  } catch (error) {
    throw new WebSearchError(error instanceof Error ? error.message : 'The search endpoint address is not usable.')
  }
  if (engine.queryPlacement !== 'search-param') return target
  const words = queryFor(engine, query)
  if (!words) throw new WebSearchError('The search was asked for with no words in it.')
  target.searchParams.set(engine.queryField, words)
  if (engine.asksForJson && !target.searchParams.has('format')) target.searchParams.set('format', 'json')
  return target
}

/** The body one query is sent in, or null for an engine that takes its words on the address. */
export function searchBodyFor(engine: WebSearchEngineSpec, query: string): string | null {
  if (engine.queryPlacement !== 'json-body') return null
  const words = queryFor(engine, query)
  if (!words) throw new WebSearchError('The search was asked for with no words in it.')
  return JSON.stringify({ [engine.queryField]: words, ...engine.body })
}

/**
 * The headers one request goes out with.
 *
 * Where a key belongs is the engine's own claim, and one shape only: the value never reaches the address,
 * because a query string is written into access logs a vendor keeps and a reader did not agree to.
 */
function headersFor(engine: WebSearchEngineSpec, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'Inkstone-Search/1.0' }
  if (engine.method === 'POST') headers['content-type'] = 'application/json'
  if (!engine.requiresKey) return headers
  const key = apiKey.trim()
  if (!key) throw new WebSearchError(`${engine.name} needs a key, and none is stored for it.`)
  if (engine.keyCarrier === 'x-subscription-token') headers['X-Subscription-Token'] = key
  else if (engine.keyCarrier === 'authorization-bearer') headers.authorization = `Bearer ${key}`
  // An entry that needs a key without saying how to hand it over would send it nowhere, which is a bug in
  // the table rather than in a reader's settings, and is said as one.
  else throw new WebSearchError(`${engine.name} is configured without a way to send its key.`)
  return headers
}

/** What a refusal says back, in the words the model is handed: the vendor's own meaning where it gave one. */
function refusalFor(engine: WebSearchEngineSpec, status: number): string {
  const note = engine.statusNotes?.[status]
  const who = engine.selfHosted ? 'The search endpoint' : engine.name
  return note
    ? `${who} refused the search with HTTP ${status}: ${note}.`
    : `${who} returned ${status}.`
}

/**
 * Ask one engine one question.
 *
 * The caller's signal is honoured: a reader who stops the turn stops the search rather than leaving a
 * request in the air behind them.
 */
export async function searchWeb(request: WebSearchRequest): Promise<WebSearchHit[]> {
  const { engine, endpoint, query, signal } = request
  const target = searchUrlFor(engine, endpoint, query)
  const body = searchBodyFor(engine, query)
  const headers = headersFor(engine, request.apiKey ?? '')
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(target.toString(), {
      method: engine.method,
      redirect: NO_REDIRECT,
      headers,
      ...(body === null ? {} : { body }),
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new WebSearchError('The search was cancelled with the turn.')
    const timedOut = error instanceof Error && error.name === 'AbortError'
    throw new WebSearchError(timedOut
      ? `${engine.name} did not answer within ${Math.round(SEARCH_TIMEOUT_MS / 1000)} seconds.`
      : `${engine.name} could not be reached.`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  const who = engine.selfHosted ? 'The search endpoint' : engine.name
  if (isRedirectResponse(response)) throw new WebSearchError(`${who} redirected, which the assistant refuses to follow.`)
  if (!response.ok) throw new WebSearchError(refusalFor(engine, response.status))
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_RESPONSE_BYTES) throw new WebSearchError(`${who} answered with more than a result list holds.`)
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (mime && !/^(?:application\/json|text\/)/.test(mime)) {
    throw new WebSearchError(`${who} answered with ${mime}, which is not a result list.`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new WebSearchError(`${who} answered with more than a result list holds.`)
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new WebSearchError(`${who} answered with something that is not JSON.`)
  }
  return hitsFromPayload(payload, engine)
}

/**
 * The pages one search call found, as citations.
 *
 * Same channel a vendor's own search uses, so the chips under an answer, the count a turn files, and the
 * rollback a failover performs on an attempt that did not land all behave identically for a search the
 * worker ran itself — whichever engine carried it out.
 */
export function webSearchSources(name: string, result: unknown): AssistantSource[] {
  if (name !== WEB_SEARCH_TOOL_NAME) return []
  return hitsFromSearchPayload(result).map((hit) => ({
    url: hit.url,
    title: hit.title,
    ...(hit.snippet ? { cited: hit.snippet.slice(0, CITED_CHARS) } : {}),
  }))
}
