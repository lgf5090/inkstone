/**
 * The engines the assistant's built-in `web_search` tool can be pointed at.
 *
 * The channel started as one free-text address and nothing else, which fitted a self-hosted SearXNG and
 * nothing else: every hosted engine asks for a key and answers on its own fields, so a reader who wanted
 * one of those got a keyless GET with `q` on the query string and a guess about the shape of the reply.
 * This table is what replaces the guessing — one entry per engine, each stating the address, the method,
 * how the key travels, where the query goes and which fields carry a result. `web-search.ts` reads these
 * fields and holds no per-engine code path, so the next engine is an entry rather than a branch.
 *
 * **Every entry below was read off the vendor's own documentation, and the citation is written on it.**
 * An engine whose request shape could not be verified is not offered at all: a picker row that sends a
 * guessed endpoint reads as a working option while it only ever fails, which is worse than absence.
 * DuckDuckGo has no general web-search API of its own (only a keyless Instant Answer endpoint that returns
 * an abstract, and scraping its HTML violates their terms), and Perplexity's Sonar contract could not be
 * reached from the machine this was written on, so neither is here.
 *
 * What a request may look like is data, but what a *reader* may type is not: a self-hosted address still
 * goes through `assertRelayableEndpoint`, and so does every vendor address in this table, because the
 * worker fetches them itself on a model's say-so.
 */
import type { MessageKey } from './locales/en-US'

/** How the vendor wants its key presented on the wire. */
export type WebSearchKeyCarrier = 'authorization-bearer' | 'x-subscription-token'

/** Where the query words are written: a query-string parameter, or a field of a JSON body. */
export type WebSearchQueryPlacement = 'search-param' | 'json-body'

export interface WebSearchEngineSpec {
  id: string
  /** The vendor's own name for the service, as a model-facing sentence may repeat it. */
  name: string
  /** The key the settings screen labels this pick with. */
  labelKey: MessageKey
  /** The one-line capability note shown where the reader picks it: what the search costs them. */
  noteKey: MessageKey
  /** Whether the address comes from the reader's settings rather than the host named here. */
  selfHosted: boolean
  /** Whether the engine answers only for a key, which is what decides where a reader stores one. */
  requiresKey: boolean
  /** The vendor's fixed address. Absent only for a self-hosted engine. */
  endpoint?: string
  method: 'GET' | 'POST'
  /**
   * How the key is carried, for an engine that needs one.
   *
   * Two shapes cover what is verified here: a bearer authorization value, and Brave's own header. A
   * hosted engine that wanted a third is a new value in this union, not a new code path in the caller.
   */
  keyCarrier?: WebSearchKeyCarrier
  queryPlacement: WebSearchQueryPlacement
  /** The parameter or body field the query words are written to. */
  queryField: string
  /**
   * The longest query this engine takes, where its own documentation names one.
   *
   * Clipping is the honest response to a bound: the tool lets the model ask in up to 200 characters, and an
   * engine that answers 400 for a longer question would turn a working turn into a failed search.
   */
  queryMaxChars?: number
  /** Whether to ask for JSON on the query string. A self-hosted engine answers in HTML unless it is told. */
  asksForJson: boolean
  /** Fixed fields added to the JSON body of every request, for an engine that takes one. */
  body?: Record<string, string | number | boolean>
  /**
   * Where the result list may sit in the reply, each candidate a path from the payload's root.
   *
   * An empty path means the payload is the list itself. More than one entry is only for a self-hosted
   * engine, whose answer shape belongs to whoever installed it; a vendor's own list is exactly one path.
   */
  resultPaths: readonly (readonly string[])[]
  /** What one hit's address, heading and words may be called, each in the order they are preferred. */
  urlKeys: readonly string[]
  titleKeys: readonly string[]
  snippetKeys: readonly string[]
  /**
   * What a refusal means, for a status this vendor documents and nobody else's guess about would not.
   *
   * Only the codes a vendor names for itself are written down; every other status is reported plainly with
   * its number, because an invented explanation of somebody else's 403 is a worse failure than none.
   */
  statusNotes?: Readonly<Record<number, string>>
}

/**
 * The longest engine key the worker will store.
 *
 * The same bound a provider's key is written to, and stated once: a token longer than this is a paste that
 * went wrong, and storing a clipped one would leave the reader with a key that only ever answers 401.
 */
export const MAX_SEARCH_KEY_CHARS = 4096

/**
 * How many hits one search asks for and hands on.
 *
 * One number for both: asking a hosted engine for more than the turn is given costs the reader per-request
 * money for results the model never sees, so the cap the tool reads with is the cap the request asks for.
 */
export const WEB_SEARCH_RESULT_LIMIT = 8

/**
 * The engine a reader who configured nothing gets.
 *
 * Self-hosted, because that is what every setup already in the field is: an address and no key. Defaulting
 * elsewhere would silently start sending a reader's queries to a vendor they never chose.
 */
export const DEFAULT_WEB_SEARCH_ENGINE_ID = 'self-hosted'

export const WEB_SEARCH_ENGINES: Readonly<Record<string, WebSearchEngineSpec>> = {
  /**
   * The reader's own instance, queried exactly as before.
   *
   * SearXNG and an OpenSearch-compatible endpoint are what answers with `results` / `organic`, and a
   * hand-written one answers with whatever it likes, which is why the field names are candidate lists
   * here rather than one verified name.
   */
  'self-hosted': {
    id: 'self-hosted',
    name: 'the configured search engine',
    labelKey: 'assistant.settings.web_search_engine.self_hosted',
    noteKey: 'assistant.settings.web_search_note.self_hosted',
    selfHosted: true,
    requiresKey: false,
    method: 'GET',
    queryPlacement: 'search-param',
    queryField: 'q',
    asksForJson: true,
    resultPaths: [[], ['results'], ['organic'], ['items']],
    urlKeys: ['url', 'link', 'href'],
    titleKeys: ['title', 'name'],
    snippetKeys: ['content', 'snippet', 'description', 'excerpt'],
  },

  /**
   * Tavily. Shape read off https://docs.tavily.com/documentation/api-reference/endpoint/search.
   *
   * `POST https://api.tavily.com/search` with `Authorization: Bearer <token>`. Their reference also shows
   * an `api_key` field in the body, which is the legacy form; the header is what their current examples
   * send, so that is what goes out, and no key is ever put where a stale spelling of it might be read.
   * Each hit carries `title`, `url` and `content` — `content` is the excerpt meant for a model.
   */
  tavily: {
    id: 'tavily',
    name: 'Tavily',
    labelKey: 'assistant.settings.web_search_engine.tavily',
    noteKey: 'assistant.settings.web_search_note.tavily',
    selfHosted: false,
    requiresKey: true,
    endpoint: 'https://api.tavily.com/search',
    method: 'POST',
    keyCarrier: 'authorization-bearer',
    queryPlacement: 'json-body',
    queryField: 'query',
    asksForJson: false,
    body: { max_results: WEB_SEARCH_RESULT_LIMIT, include_answer: false, include_raw_content: false },
    resultPaths: [['results']],
    urlKeys: ['url'],
    titleKeys: ['title'],
    snippetKeys: ['content'],
  },

  /**
   * Brave Search API. Shape read off https://api-dashboard.search.brave.com/app/documentation/web-search/get-started.
   *
   * `GET https://api.search.brave.com/res/v1/web/search?q=<words>` with the key in `X-Subscription-Token`,
   * which is the one engine here that will not take a bearer value. The list is nested at `web.results`,
   * each hit with `title`, `url` and `description` — and `extra_snippets`, which is only sent when the
   * request asks for it and is not needed to answer a model.
   *
   * The `count` parameter is left alone because the page states no bound for the free tier's own use of it
   * and the reply is capped on the way in anyway.
   */
  brave: {
    id: 'brave',
    name: 'Brave Search',
    labelKey: 'assistant.settings.web_search_engine.brave',
    noteKey: 'assistant.settings.web_search_note.brave',
    selfHosted: false,
    requiresKey: true,
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
    method: 'GET',
    keyCarrier: 'x-subscription-token',
    queryPlacement: 'search-param',
    queryField: 'q',
    asksForJson: false,
    resultPaths: [['web', 'results']],
    urlKeys: ['url'],
    titleKeys: ['title'],
    snippetKeys: ['description'],
  },

  /**
   * DeepSeek Search. Shape read off https://api-docs.deepseek.com/guides/search.
   *
   * `POST https://api.deepseek.com/v1/tools/search`, `Authorization: Bearer <key>` and a JSON content
   * type. `query` is 1-128 characters and may not be all whitespace; `count` is 1-50 and defaults to 10.
   * Two fields carry words per hit and only one of them is meant for a model: `snippet` is the 100-200
   * character line for a display, `summary` the 600-800 character one for reading, so `summary` is listed
   * first and `snippet` is the fallback for a reply that carries no summary.
   * `need_content: false` is deliberate: their `content` field is the page body, and asking for it would
   * blow past the byte ceiling a result list is held to.
   */
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek Search',
    labelKey: 'assistant.settings.web_search_engine.deepseek',
    noteKey: 'assistant.settings.web_search_note.deepseek',
    selfHosted: false,
    requiresKey: true,
    endpoint: 'https://api.deepseek.com/v1/tools/search',
    method: 'POST',
    keyCarrier: 'authorization-bearer',
    queryPlacement: 'json-body',
    queryField: 'query',
    queryMaxChars: 128,
    asksForJson: false,
    body: { count: WEB_SEARCH_RESULT_LIMIT, need_content: false },
    resultPaths: [['results']],
    urlKeys: ['url'],
    titleKeys: ['title'],
    snippetKeys: ['summary', 'snippet'],
    statusNotes: {
      401: 'no key was accepted, or it is not valid for this account',
      402: 'the account has no balance left, so the search could not be paid for',
      429: 'the account went over its per-second limit',
    },
  },

  /**
   * Perplexity Search API. Shape read off https://docs.perplexity.ai/api-reference/search-post.
   *
   * `POST https://api.perplexity.ai/search` with `Authorization: Bearer <key>` and a JSON body: `query`
   * (required), `max_results` (default 10, up to 20 for a web search). This is the structured search
   * endpoint, not the Sonar chat endpoint — the reply is a ranked `results[]` of `title`, `url`, `snippet`
   * and `last_updated`, and no answer of the vendor's own is generated over them, which is what makes it
   * fit the tool at all: a channel that handed back somebody else's finished answer would be presented to
   * the reader as this assistant's.
   *
   * `search_type` is left at its documented default of `web`. `fast` is cheaper and lower-latency, and
   * choosing it here would trade result quality for money the reader never agreed to spend differently.
   */
  perplexity: {
    id: 'perplexity',
    name: 'Perplexity Search',
    labelKey: 'assistant.settings.web_search_engine.perplexity',
    noteKey: 'assistant.settings.web_search_note.perplexity',
    selfHosted: false,
    requiresKey: true,
    endpoint: 'https://api.perplexity.ai/search',
    method: 'POST',
    keyCarrier: 'authorization-bearer',
    queryPlacement: 'json-body',
    queryField: 'query',
    asksForJson: false,
    body: { max_results: WEB_SEARCH_RESULT_LIMIT },
    resultPaths: [['results']],
    urlKeys: ['url'],
    titleKeys: ['title'],
    snippetKeys: ['snippet'],
  },
}

/** The ids a settings value may name, in the order the picker shows them. */
export const WEB_SEARCH_ENGINE_IDS: readonly string[] = Object.keys(WEB_SEARCH_ENGINES)

/** Whether a value names an engine this table can build a request for. */
export function isWebSearchEngineId(value: unknown): boolean {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WEB_SEARCH_ENGINES, value)
}

/**
 * The engine one settings value selects.
 *
 * An unknown id falls back to the self-hosted entry rather than throwing: a settings blob may come from a
 * stored row written by an older build or from a backup restored across versions, and a search tool that
 * reads the wrong shape is a failure the reader can see, while a crash on a settings read is not.
 */
export function webSearchEngineFor(value: unknown): WebSearchEngineSpec {
  return isWebSearchEngineId(value)
    ? WEB_SEARCH_ENGINES[value as string]!
    : WEB_SEARCH_ENGINES[DEFAULT_WEB_SEARCH_ENGINE_ID]!
}

/** The engine id a settings field may hold: a known id, or the default. */
export function webSearchEngineValue(value: unknown, fallback: string = DEFAULT_WEB_SEARCH_ENGINE_ID): string {
  return isWebSearchEngineId(value) ? (value as string) : fallback
}
