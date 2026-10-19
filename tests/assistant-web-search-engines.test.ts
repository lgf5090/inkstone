// @vitest-environment node
/**
 * A search engine is a shape, not a guess.
 *
 * The channel used to be one free-text address and nothing else: a keyless GET with `q` and `format=json`,
 * with the field names of the reply guessed at. That reads a self-hosted SearXNG and nothing else, while the
 * hosted engines a reader would actually pick — each of which wants a key and its own request — could not be
 * offered at all. These cases hold the table instead: what each vendor's entry says about the wire is
 * asserted on the wire, per engine, from the request that goes out to the field that feeds a snippet.
 *
 * Two things are worth more than the happy path here. A key is only ever allowed to travel the way that
 * vendor documents, because a token written into a query string ends up in somebody's access log; and a
 * refusal has to come back as a failure the model reads, because a turn that searched nothing and cited
 * something is the failure this whole channel exists not to be.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import { WebSearchError, searchBodyFor, searchUrlFor, searchWeb } from '../src/worker/assistant/web-search'
import { DEFAULT_ASSISTANT_SETTINGS, normalizeAssistantSettings, webSearchConfigured, type AssistantSettings } from '../src/shared/assistant'
import { WEB_SEARCH_ENGINES } from '../src/shared/web-search-engines'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

/** The worker's own bound on a snippet's length; a longer excerpt is clipped, not passed through. */
const SNIPPET_BOUND = 400

/** A test key, in the shape a vendor's token has. Nothing here is a credential anybody issued. */
const KEY = 'sk-test-0000000000000000abcd'

/** One outbound request as the fetch stub saw it. */
interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

/**
 * A wire that records what was asked of it and answers with one payload.
 *
 * The assertions this file makes are all about the request — a vendor's shape is only honoured by the bytes
 * that leave — so the answer is the boring half and the call log is the thing under test.
 */
function stubWire(answer: { status?: number, body?: unknown, contentType?: string } = {}): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: { method?: string, headers?: unknown, body?: unknown }) => {
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>)
    sent.push({
      url: String(typeof input === 'string' || input instanceof URL ? input : input.url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(headers.entries()),
      body: init?.body === undefined || init?.body === null ? null : String(init.body),
    })
    return new Response(JSON.stringify(answer.body ?? { results: [] }), {
      status: answer.status ?? 200,
      headers: { 'content-type': answer.contentType ?? 'application/json' },
    })
  }))
  return sent
}

function request(over: Partial<Parameters<typeof searchWeb>[0]> = {}) {
  return searchWeb({
    engine: WEB_SEARCH_ENGINES['self-hosted']!,
    endpoint: 'https://search.example.test/search',
    query: 'self hosted search',
    ...over,
  })
}

/** A context for the gate only: what is under test is which tools a turn may reach, not a database. */
function executorContext(settings: AssistantSettings, over: Partial<ToolContext> = {}): ToolContext {
  return {
    store: {} as ToolContext['store'],
    env: {} as Env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings,
    timezone: 'UTC',
    dayEnd: 1_700_000_000_000,
    mode: 'chat',
    conversationId: 'c1',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    ...over,
  }
}

const offeredNames = (settings: AssistantSettings, over: Partial<ToolContext> = {}): string[] =>
  new ToolExecutor(executorContext(settings, over), { maxToolCalls: 8 }).available().map((definition) => definition.name)

const TAVILY_SETTINGS: AssistantSettings = { ...DEFAULT_ASSISTANT_SETTINGS, webSearchEngine: 'tavily' }

describe('what each engine sends', () => {
  it('posts Tavily the query in the body and the key in the bearer header', async () => {
    const sent = stubWire({ body: { results: [{ title: 'Tavily docs', url: 'https://docs.tavily.com/', content: 'A hosted search index.', score: 0.9 }] } })
    const hits = await request({ engine: WEB_SEARCH_ENGINES.tavily!, endpoint: 'https://api.tavily.com/search', apiKey: KEY })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('POST')
    expect(sent[0]!.url).toBe('https://api.tavily.com/search')
    // The header form, not the legacy `api_key` body field: one is what their reference sends today.
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(sent[0]!.body).toBeTruthy()
    expect(sent[0]!.body).toContain('"query":"self hosted search"')
    expect(sent[0]!.body).toContain('"max_results":8')
    expect(sent[0]!.headers['content-type']).toBe('application/json')
    // A token belongs in a header: a query string is written into logs the vendor keeps.
    expect(sent[0]!.url).not.toContain(KEY)
    expect(sent[0]!.body).not.toContain(KEY)
    expect(sent[0]!.body).not.toContain('api_key')

    expect(hits).toEqual([{ title: 'Tavily docs', url: 'https://docs.tavily.com/', snippet: 'A hosted search index.' }])
    vi.unstubAllGlobals()
  })

  it('gets Brave the key in its own header and the query on the address', async () => {
    const sent = stubWire({
      body: { web: { results: [{ title: 'Brave docs', url: 'https://search.brave.com/help', description: 'An independent index.', age: '2 days' }] } },
    })
    const hits = await request({ engine: WEB_SEARCH_ENGINES.brave!, endpoint: 'https://api.search.brave.com/res/v1/web/search', apiKey: KEY })

    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('GET')
    const asked = new URL(sent[0]!['url']!)
    expect(asked.origin + asked.pathname).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(asked.searchParams.get('q')).toBe('self hosted search')
    // A parameter engine that takes a key takes it in the header Brave names, not in `Authorization`.
    expect(sent[0]!.headers['x-subscription-token']).toBe(KEY)
    expect(sent[0]!.headers.authorization).toBeUndefined()
    expect(sent[0]!.url).not.toContain(KEY)
    expect(sent[0]!.body).toBeNull()
    // `format=json` is a self-hosted courtesy; Brave does not define it, so it is not sent.
    expect(asked.searchParams.has('format')).toBe(false)

    expect(hits).toEqual([{ title: 'Brave docs', url: 'https://search.brave.com/help', snippet: 'An independent index.' }])
    vi.unstubAllGlobals()
  })

  it('posts DeepSeek the query and its own limits, and reads the summary rather than the display snippet', async () => {
    const summary = `${'DeepSeek published the model with tool calls and a long context. '.repeat(20)}`
    const sent = stubWire({
      body: {
        results: [{
          title: 'DeepSeek V4',
          url: 'https://example.test/v4',
          snippet: 'The 100 to 200 character line meant for a display.',
          summary,
          content: 'The whole page body, which was never asked for.',
          authority: 3,
        }],
      },
    })
    const hits = await request({ engine: WEB_SEARCH_ENGINES.deepseek!, endpoint: 'https://api.deepseek.com/v1/tools/search', apiKey: KEY })

    expect(sent[0]!.method).toBe('POST')
    expect(sent[0]!.url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>
    expect(body.query).toBe('self hosted search')
    expect(body.count).toBe(8)
    // Asking for the page body would answer with a page, and a page is past what a result list may weigh.
    expect(body.need_content).toBe(false)

    // Their own documentation splits the two: `snippet` is for a display, `summary` is the one meant for a
    // model. Reading the short field instead would still pass a shape test and quietly search worse.
    expect(hits[0]!.snippet).toBe(summary.slice(0, SNIPPET_BOUND))
    expect(hits[0]!.snippet).not.toBe('The 100 to 200 character line meant for a display.')
    // Inside the bound the tool has always held a snippet to.
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(SNIPPET_BOUND)
    vi.unstubAllGlobals()
  })

  it('falls back to the display line when DeepSeek sends no summary', async () => {
    stubWire({ body: { results: [{ title: 'No summary', url: 'https://example.test/x', snippet: 'Only the short line.', content: '' }] } })
    const hits = await request({ engine: WEB_SEARCH_ENGINES.deepseek!, endpoint: 'https://api.deepseek.com/v1/tools/search', apiKey: KEY })
    expect(hits[0]!.snippet).toBe('Only the short line.')
    vi.unstubAllGlobals()
  })

  it('clips a DeepSeek query to the length its own documentation gives it', async () => {
    const sent = stubWire()
    // The tool lets a model ask in up to 200 characters; DeepSeek answers 400 past 128, so the bound is
    // applied on the way out rather than arriving back as a failed search.
    await request({ engine: WEB_SEARCH_ENGINES.deepseek!, endpoint: 'https://api.deepseek.com/v1/tools/search', apiKey: KEY, query: 'x'.repeat(200) })
    const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>
    expect(body.query).toHaveLength(128)
    vi.unstubAllGlobals()
  })

  it('sends a self-hosted engine the words and the format parameter it has always sent', async () => {
    const sent = stubWire({ body: { organic: [{ title: 'One', link: 'https://one.test/', snippet: 'first' }] } })
    const hits = await request()
    expect(sent[0]!.method).toBe('GET')
    const asked = new URL(sent[0]!.url!)
    expect(asked.searchParams.get('q')).toBe('self hosted search')
    expect(asked.searchParams.get('format')).toBe('json')
    expect(sent[0]!.headers.authorization).toBeUndefined()
    // The guessed-at field names are still guessed-at for a self-hosted engine, which is the point of it.
    expect(hits).toEqual([{ title: 'One', url: 'https://one.test/', snippet: 'first' }])
    vi.unstubAllGlobals()
  })
})

describe('what a search reports when it did not happen', () => {
  it('says what a vendor documents a status to mean', async () => {
    stubWire({ status: 402, body: { error: { message: 'Insufficient Balance', type: 'insufficient_balance_error', param: null, code: 'error_code' } } })
    let balance = ''
    try {
      await request({ engine: WEB_SEARCH_ENGINES.deepseek!, endpoint: 'https://api.deepseek.com/v1/tools/search', apiKey: KEY })
    } catch (error) {
      balance = (error as Error).message
    }
    expect(balance).toContain('402')
    // Their own page names this one: the account has nothing left to pay the search with. A model that reads
    // only "returned 402" cannot tell the reader what to do about it.
    expect(balance).toMatch(/balance/i)
    expect(balance).toContain('DeepSeek Search')
    await expect(request({ engine: WEB_SEARCH_ENGINES.deepseek!, endpoint: 'https://api.deepseek.com/v1/tools/search', apiKey: KEY }))
      .rejects.toThrow(WebSearchError)
    vi.unstubAllGlobals()
  })

  it('posts Perplexity the query and its own cap, and reads the ranked pages it returns', async () => {
    const sent = stubWire({
      body: {
        results: [
          { title: 'Example Article', url: 'https://example.test/article', snippet: 'A short excerpt from the page.', date: '2025-09-25T00:00:00Z', last_updated: '2025-09-25' },
          // A hit with no address is dropped rather than handed on: the model could cite it and no reader
          // could open it.
          { title: 'No url', snippet: 'Nothing to link to.' },
        ],
      },
    })
    const hits = await request({ engine: WEB_SEARCH_ENGINES.perplexity!, endpoint: 'https://api.perplexity.ai/search', apiKey: KEY })

    expect(sent[0]!.method).toBe('POST')
    expect(sent[0]!.url).toBe('https://api.perplexity.ai/search')
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(sent[0]!.body!) as Record<string, unknown>
    expect(body.query).toBe('self hosted search')
    expect(body.max_results).toBe(8)
    // This is the search endpoint and not the Sonar chat one: the reply is a list of pages, so nothing here
    // sends a prompt or expects an answer the vendor wrote. A channel that handed back somebody else's
    // finished answer would be presented to the reader as this assistant's own.
    expect(body.messages).toBeUndefined()
    expect(hits.map((hit) => hit.url)).toEqual(['https://example.test/article'])
    expect(hits[0]!.snippet).toBe('A short excerpt from the page.')
    vi.unstubAllGlobals()
  })

  it('reports a status nobody documented for itself plainly, with the number it was', async () => {
    stubWire({ status: 429 })
    await expect(request({ engine: WEB_SEARCH_ENGINES.tavily!, endpoint: 'https://api.tavily.com/search', apiKey: KEY }))
      .rejects.toThrow(/Tavily returned 429/)
    vi.unstubAllGlobals()
  })

  it('reports a refused key as a failure rather than as no results', async () => {
    stubWire({ status: 401 })
    await expect(request({ engine: WEB_SEARCH_ENGINES.brave!, endpoint: 'https://api.search.brave.com/res/v1/web/search', apiKey: KEY }))
      .rejects.toThrow(/Brave Search returned 401/)
    vi.unstubAllGlobals()
  })

  it('will not send a keyed engine that has no key, and never reaches the wire for it', async () => {
    const sent = stubWire()
    await expect(request({ engine: WEB_SEARCH_ENGINES.tavily!, endpoint: 'https://api.tavily.com/search' }))
      .rejects.toThrow(/Tavily needs a key, and none is stored for it/)
    expect(sent).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('guards a vendor address the same way it guards one the reader typed', async () => {
    const sent = stubWire()
    // The address in the table is public; a caller that handed over something else is refused by the same
    // guard, because the worker is the one holding the network position either way.
    await expect(request({ engine: WEB_SEARCH_ENGINES.tavily!, endpoint: 'http://169.254.169.254/latest/meta-data/', apiKey: KEY }))
      .rejects.toThrow()
    await expect(request({ engine: WEB_SEARCH_ENGINES['self-hosted']!, endpoint: 'http://127.0.0.1:8383/search' })).rejects.toThrow()
    expect(sent).toHaveLength(0)
    vi.unstubAllGlobals()
  })

  it('refuses to search with no words, before it costs anybody a request', async () => {
    const sent = stubWire()
    await expect(request({ engine: WEB_SEARCH_ENGINES.deepseek!, endpoint: 'https://api.deepseek.com/v1/tools/search', apiKey: KEY, query: '   ' }))
      .rejects.toThrow(/no words in it/)
    await expect(request({ engine: WEB_SEARCH_ENGINES.brave!, endpoint: 'https://api.search.brave.com/res/v1/web/search', apiKey: KEY, query: '   ' }))
      .rejects.toThrow(/no words in it/)
    // A parameter engine takes no body at all, words or otherwise.
    expect(searchBodyFor(WEB_SEARCH_ENGINES.brave!, 'anything')).toBeNull()
    expect(sent).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})

describe('the gate that offers the search tool', () => {
  it('takes a keyed engine away when no key is stored for it', () => {
    // The whole point of the second argument: settings alone cannot see a key, and an engine named in them
    // without its credential is a tool call that can only fail.
    expect(webSearchConfigured(TAVILY_SETTINGS, false)).toBe(false)
    expect(webSearchConfigured(TAVILY_SETTINGS, true)).toBe(true)
    expect(offeredNames(TAVILY_SETTINGS, { webSearchKey: null })).not.toContain('web_search')
    expect(offeredNames(TAVILY_SETTINGS)).not.toContain('web_search')
    expect(offeredNames(TAVILY_SETTINGS, { webSearchKey: KEY })).toContain('web_search')
  })

  it('keeps asking a self-hosted engine what its address says, exactly as before', () => {
    expect(offeredNames(DEFAULT_ASSISTANT_SETTINGS, { webSearchKey: KEY })).not.toContain('web_search')
    expect(offeredNames({ ...DEFAULT_ASSISTANT_SETTINGS, webSearchEndpoint: 'https://searx.example.test/search' })).toContain('web_search')
    // A key stored for some other engine cannot put a self-hosted search on the table by itself.
    expect(offeredNames(DEFAULT_ASSISTANT_SETTINGS, { webSearchKey: KEY })).not.toContain('web_search')
  })

  it('reads an unknown engine id as the self-hosted default, whoever wrote it', () => {
    expect(normalizeAssistantSettings({ webSearchEngine: 'altavista' }).webSearchEngine).toBe('self-hosted')
    expect(normalizeAssistantSettings({ webSearchEngine: 'tavily' }).webSearchEngine).toBe('tavily')
    expect(normalizeAssistantSettings({}).webSearchEngine).toBe('self-hosted')
    expect(webSearchEngineShapeIsDataOnly()).toBe(true)
  })
})

/**
 * Every entry must be describable without a code path.
 *
 * The table is the design: an engine that needs a key has to say how it travels, and an entry that names a
 * vendor host has to be a public https address the relay guard will let the worker reach. A new id that
 * breaks either is caught here rather than on a reader's turn.
 */
function webSearchEngineShapeIsDataOnly(): boolean {
  for (const engine of Object.values(WEB_SEARCH_ENGINES)) {
    if (engine.requiresKey && !engine.keyCarrier) return false
    if (engine.selfHosted === (engine.endpoint !== undefined)) return false
    if (!engine.resultPaths.length) return false
    if (!engine.urlKeys.length || !engine.titleKeys.length || !engine.snippetKeys.length) return false
  }
  return true
}

// ------------------------------------------------- the key's own routes

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let app: Hono<AppBindings>

/** The vault's storage, held the way the platform holds it: one map per instance, not per request. */
const vaultStorage = new Map<string, unknown>()

function fakeVaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) { return vaultStorage.get(key) },
      async put(key: string, value: unknown) { vaultStorage.set(key, value) },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return await fn() },
  } as unknown as DurableObjectState
}

function buildApp(userId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
  return instance
}

async function respond(method: string, path: string, body?: unknown): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {} as ExecutionContext)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  vaultStorage.clear()
  env = testBindings(makeD1(sqlite), {
    PUBLIC_URL: 'http://localhost',
    DO_AUTH_KEY: 'test-internal-key',
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
  })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  app = buildApp(USER)
})

describe('an engine key where it belongs', () => {
  it('stores one per engine, encrypted, and answers only with its last four characters', async () => {
    const written = await respond('PUT', '/api/assistant/search-keys/tavily', { apiKey: KEY })
    expect(written.status).toBe(200)
    const payload = await written.text()
    expect(payload).toContain('"hasKey":true')
    expect(payload).toContain('"keyHint":"abcd"')
    // The response is the whole of what a client gets, and neither the key nor its ciphertext is in it.
    expect(payload).not.toContain(KEY)
    expect(payload).not.toContain('ciphertext')

    const row = sqlite.prepare('SELECT key_ciphertext, key_hint FROM chat_search_keys WHERE user_id = ?').get(USER) as { key_ciphertext: string, key_hint: string }
    expect(row.key_ciphertext).toBeTruthy()
    expect(row.key_ciphertext).not.toContain(KEY)
    expect(row.key_hint).toBe('abcd')
    // The settings blob is plaintext and travels in a backup, so the engine choice may live in it and the
    // key may not: this reads the stored row and looks for the credential that was just accepted.
    await store.saveSettings({ ...DEFAULT_ASSISTANT_SETTINGS, webSearchEngine: 'tavily' })
    const config = sqlite.prepare(`SELECT config FROM chat_settings WHERE user_id = ?`).get(USER) as { config: string }
    expect(config.config).toContain('tavily')
    expect(config.config).not.toContain(KEY)
    expect(config.config).not.toContain('ciphertext')

    expect(await store.searchApiKey('tavily')).toBe(KEY)
    expect(await store.searchApiKey('brave')).toBe('')
    expect(await store.searchKeyEngines()).toEqual(['tavily'])
  })

  it('replaces the key an engine holds rather than keeping a second one', async () => {
    await respond('PUT', '/api/assistant/search-keys/brave', { apiKey: KEY })
    const replaced = 'sk-test-0000000000000000wxyz'
    expect((await respond('PUT', '/api/assistant/search-keys/brave', { apiKey: replaced })).status).toBe(200)
    const rows = sqlite.prepare('SELECT engine, key_hint FROM chat_search_keys WHERE user_id = ?').all(USER) as Array<{ engine: string, key_hint: string }>
    expect(rows).toEqual([{ engine: 'brave', key_hint: 'wxyz' }])
    expect(await store.searchApiKey('brave')).toBe(replaced)
  })

  it('forgets a key, and says so the second time it is asked', async () => {
    await respond('PUT', '/api/assistant/search-keys/deepseek', { apiKey: KEY })
    expect((await respond('DELETE', '/api/assistant/search-keys/deepseek')).status).toBe(200)
    expect(await store.searchApiKey('deepseek')).toBe('')
    expect((await respond('DELETE', '/api/assistant/search-keys/deepseek')).status).toBe(404)
    const listing = await (await respond('GET', '/api/assistant/search-keys')).json() as { keys: unknown[] }
    expect(listing.keys).toEqual([])
  })

  it('refuses an engine it does not know, an empty key, and one too long to store', async () => {
    expect((await respond('PUT', '/api/assistant/search-keys/altavista', { apiKey: KEY })).status).toBe(400)
    expect((await respond('PUT', '/api/assistant/search-keys/tavily', { apiKey: '   ' })).status).toBe(400)
    expect((await respond('PUT', '/api/assistant/search-keys/tavily', {})).status).toBe(400)
    // Clipping a token into the vault would store a key that only ever answers 401.
    expect((await respond('PUT', '/api/assistant/search-keys/tavily', { apiKey: `sk-test-${'x'.repeat(5_000)}` })).status).toBe(400)
    expect((await respond('GET', '/api/assistant/search-keys')).status).toBe(200)
    expect(await store.searchKeyEngines()).toEqual([])
  })

  it('takes the engine choice as a setting, and only a known one', async () => {
    expect((await respond('PATCH', '/api/assistant/settings', { webSearchEngine: 'tavily' })).status).toBe(200)
    expect((await store.getSettings()).webSearchEngine).toBe('tavily')
    // A turn assembled from these settings still has no key, so the tool is not on it.
    expect(offeredNames(await store.getSettings())).not.toContain('web_search')
    expect((await respond('PATCH', '/api/assistant/settings', { webSearchEngine: 'duckduckgo' })).status).toBe(400)
    expect((await store.getSettings()).webSearchEngine).toBe('tavily')
    expect((await respond('PATCH', '/api/assistant/settings', { webSearchEngine: 'self-hosted' })).status).toBe(200)
    expect((await store.getSettings()).webSearchEngine).toBe('self-hosted')

    await respond('PUT', '/api/assistant/search-keys/tavily', { apiKey: KEY })
    await respond('PATCH', '/api/assistant/settings', { webSearchEngine: 'tavily' })
    // The turn that has both: the engine named in settings and the key stored beside the account.
    expect(offeredNames(await store.getSettings(), { webSearchKey: await store.searchApiKey('tavily') })).toContain('web_search')
  })

  it('leaves a reader who configured nothing on the address they already had', async () => {
    const stored = await store.saveSettings({ ...DEFAULT_ASSISTANT_SETTINGS, webSearchEndpoint: 'https://searx.example.test/search' })
    expect(stored.webSearchEngine).toBe('self-hosted')
    expect(webSearchConfigured(stored)).toBe(true)
    expect(searchUrlFor(WEB_SEARCH_ENGINES[stored.webSearchEngine]!, stored.webSearchEndpoint, 'q').searchParams.get('format')).toBe('json')
  })

  /**
   * The one fact about a credential that the settings response is allowed to carry.
   *
   * The composer's chip says why search is off, and "your engine is waiting for a key" is only honest if the
   * server is the one saying it — the key itself never leaves the vault, and the settings blob is plaintext.
   * So this is a read-out: it must follow the engine the reader actually picked, and a client must not be able
   * to write it, or a forged `true` would put a working search claim back on a chip that has nothing behind it.
   */
  it('says which engine is holding a key, and refuses to be told that by a client', async () => {
    const settingsOf = async (): Promise<AssistantSettings> =>
      ((await (await respond('GET', '/api/assistant/settings')).json()) as { settings: AssistantSettings }).settings

    await respond('PATCH', '/api/assistant/settings', { webSearchEngine: 'tavily' })
    expect((await settingsOf()).webSearchKeyStored).toBe(false)

    await respond('PUT', '/api/assistant/search-keys/tavily', { apiKey: KEY })
    expect((await settingsOf()).webSearchKeyStored).toBe(true)

    // A key for one engine is not a key for another: the answer follows the pick, not the account.
    await respond('PATCH', '/api/assistant/settings', { webSearchEngine: 'brave' })
    expect((await settingsOf()).webSearchKeyStored).toBe(false)
    // And an engine that needs no key is never told it is missing one.
    await respond('PATCH', '/api/assistant/settings', { webSearchEngine: 'self-hosted' })
    expect((await settingsOf()).webSearchKeyStored).toBe(false)

    // The field is not an input: the PATCH loop forwards only `ASSISTANT_SETTING_KEYS`, and this is not one of
    // them, so neither the answer nor the stored blob can be made to hold a claimed key.
    await respond('PATCH', '/api/assistant/settings', { webSearchEngine: 'tavily', webSearchKeyStored: true })
    expect((await settingsOf()).webSearchKeyStored).toBe(true)
    expect(await store.getSettings()).not.toHaveProperty('webSearchKeyStored')
  })
})
