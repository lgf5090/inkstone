/**
 * The assistant's own web search, for a provider whose protocol has none.
 *
 * Anthropic and Gemini can be asked to search and do it on their own servers; an OpenAI-compatible relay —
 * which is what DeepSeek, Kimi, Qwen, OpenRouter, vLLM and a local Ollama all look like — has no such
 * field, so a reader who turns the switch on got a guess about the name of one of their MCP tools. This is
 * the channel that actually works everywhere: the worker asks an address the reader configured, in a shape
 * two common self-hosted engines answer with (SearXNG and an OpenSearch-compatible endpoint), and hands the
 * hits back as a tool result. No key, no service, no dependency.
 *
 * The address is untrusted input of exactly the class a provider's base URL is: the worker fetches it with
 * its own network position, on a model's say-so, so it goes through the same guard — which is what refuses a
 * cloud metadata address or a host on the deployment's own network. Redirects are refused for the same
 * reason, because a public address that answers 302 is a public address only until it is followed.
 *
 * A search that fails is reported as one: the turn is not allowed to read as an answer built on nothing.
 */

import { assertRelayableEndpoint } from '@shared/ai-proxy-guard'
import { isSourceUrl, WEB_SEARCH_TOOL_NAME, type AssistantSource } from '@shared/assistant'
import { NO_REDIRECT, isRedirectResponse } from '../lib/no-redirect'

/** How many hits one search hands to the model. Past this a turn is browsing rather than asking. */
const RESULT_LIMIT = 8

/** How much of one hit's snippet travels. */
const SNIPPET_CHARS = 400

/** How much of a snippet a citation card shows. The same bound a note citation's `cited` carries. */
const CITED_CHARS = 300

/** How long the engine may take before the turn is told it did not answer. */
const SEARCH_TIMEOUT_MS = 8_000

/** A result list is kilobytes, not a page: past this the endpoint is not answering with results. */
const MAX_RESPONSE_BYTES = 512 * 1024

/**
 * Where a result list may live in an engine's payload.
 *
 * `results` is what SearXNG and most self-hosted aggregators use, `organic` what an OpenSearch-compatible
 * endpoint uses, `items` what a hand-written one reaches for. A list is also accepted at the top level,
 * because an endpoint that answers with a bare array is not answering a different question.
 */
const RESULT_KEYS = ['results', 'organic', 'items'] as const

/** What one hit's address may be called. */
const URL_KEYS = ['url', 'link', 'href'] as const

/** What one hit's heading may be called. */
const TITLE_KEYS = ['title', 'name'] as const

/** What one hit's words may be called. */
const SNIPPET_KEYS = ['content', 'snippet', 'description', 'excerpt'] as const

/** The endpoint went wrong in a way the reader can be told about, in words the tool returns as its error. */
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

function textOf(entry: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * The hits inside an engine's answer, in the order it put them.
 *
 * Nothing here is guessed at beyond the field names above: an entry with no usable address is dropped,
 * because a hit the model cannot cite and a reader cannot open is worse than one fewer result.
 */
export function hitsFromSearchPayload(payload: unknown): WebSearchHit[] {
  let list: unknown[] | null = null
  if (Array.isArray(payload)) list = payload
  else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    for (const key of RESULT_KEYS) {
      if (Array.isArray(record[key])) {
        list = record[key] as unknown[]
        break
      }
    }
  }
  if (!list) return []
  const out: WebSearchHit[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (out.length >= RESULT_LIMIT) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const url = textOf(record, URL_KEYS)
    if (!isSourceUrl(url) || seen.has(url)) continue
    seen.add(url)
    out.push({
      title: (textOf(record, TITLE_KEYS) || url).slice(0, 200),
      url,
      snippet: textOf(record, SNIPPET_KEYS).slice(0, SNIPPET_CHARS),
    })
  }
  return out
}

/** The address one query is sent to: the configured URL carrying `q`, and `format=json` unless it says otherwise. */
export function searchUrlFor(endpoint: string, query: string): URL {
  let target: URL
  try {
    target = assertRelayableEndpoint(endpoint)
  } catch (error) {
    throw new WebSearchError(error instanceof Error ? error.message : 'The search endpoint address is not usable.')
  }
  target.searchParams.set('q', query)
  // An engine that is not told to answer in JSON answers in HTML, and the failure would then be reported
  // as a broken endpoint rather than as the missing parameter the reader can add.
  if (!target.searchParams.has('format')) target.searchParams.set('format', 'json')
  return target
}

/**
 * Ask the reader's own engine one question.
 *
 * The caller's signal is honoured: a reader who stops the turn stops the search rather than leaving a
 * request in the air behind them.
 */
export async function searchWeb(endpoint: string, query: string, signal?: AbortSignal): Promise<WebSearchHit[]> {
  const target = searchUrlFor(endpoint, query)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(target.toString(), {
      redirect: NO_REDIRECT,
      headers: { accept: 'application/json', 'user-agent': 'Inkstone-Search/1.0' },
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new WebSearchError('The search was cancelled with the turn.')
    const timedOut = error instanceof Error && error.name === 'AbortError'
    throw new WebSearchError(timedOut
      ? `The search endpoint did not answer within ${Math.round(SEARCH_TIMEOUT_MS / 1000)} seconds.`
      : 'The search endpoint could not be reached.')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (isRedirectResponse(response)) throw new WebSearchError('The search endpoint redirected, which the assistant refuses to follow.')
  if (!response.ok) throw new WebSearchError(`The search endpoint returned ${response.status}.`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_RESPONSE_BYTES) throw new WebSearchError('The search endpoint answered with more than a result list holds.')
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (mime && !/^(?:application\/json|text\/)/.test(mime)) {
    throw new WebSearchError(`The search endpoint answered with ${mime}, which is not a result list.`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new WebSearchError('The search endpoint answered with more than a result list holds.')
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new WebSearchError('The search endpoint answered with something that is not JSON.')
  }
  return hitsFromSearchPayload(payload)
}

/**
 * The pages one search call found, as citations.
 *
 * Same channel a vendor's own search uses, so the chips under an answer, the count a turn files, and the
 * rollback a failover performs on an attempt that did not land all behave identically for a search the
 * worker ran itself.
 */
export function webSearchSources(name: string, result: unknown): AssistantSource[] {
  if (name !== WEB_SEARCH_TOOL_NAME) return []
  return hitsFromSearchPayload(result).map((hit) => ({
    url: hit.url,
    title: hit.title,
    ...(hit.snippet ? { cited: hit.snippet.slice(0, CITED_CHARS) } : {}),
  }))
}
