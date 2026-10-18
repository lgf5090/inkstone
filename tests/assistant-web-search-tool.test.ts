// @vitest-environment node
/**
 * Searching the web when the model's own protocol cannot.
 *
 * Anthropic and Gemini have a vendor-side search that can simply be asked for; every other provider this
 * reader can bring a key for — which is most of them, and the common self-hosted case — does not, and the
 * switch used to be answered by guessing which of the reader's MCP tools had a searchy name. These cases
 * hold the first-party channel instead: the worker asks an engine the reader configured, through the same
 * guard that refuses a cloud metadata address, and the hits come back as sources the transcript already
 * knows how to show.
 *
 * Three things have to stay true while that happens, and each is a failure mode of a bolted-on tool:
 * the address is untrusted input, the turn's budgets and permission policy apply to this call like any
 * other, and a switch that cannot be honoured says so instead of writing an answer that looks searched.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantRunner } from '../src/worker/assistant/runner'
import { AssistantStore } from '../src/worker/assistant/store'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import { hitsFromSearchPayload, searchUrlFor, webSearchSources } from '../src/worker/assistant/web-search'
import { DEFAULT_ASSISTANT_SETTINGS, normalizeAssistantSettings, type AssistantMessage, type AssistantSettings, type ChatStreamEvent } from '../src/shared/assistant'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const ENGINE = 'https://search.example.test/search'

/** What the engine answers with, and what the answer's source cards have to name. */
const HITS = [
  { title: 'SearXNG docs', url: 'https://docs.searxng.org/', content: 'Self-hosted metasearch.' },
  { title: 'OpenSearch API', url: 'https://opensearch.org/docs/latest/', snippet: 'Query endpoints.' },
]

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let app: Hono<AppBindings>
/** The account as the fixture set it up: one OpenAI-compatible model, no search address, no MCP server. */
let base: AssistantSettings

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

function sse(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
const USAGE = frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })
/** One step that asks for a web search, in the shape an OpenAI-compatible server sends it. */
const SEARCH_CALL = [
  frame({ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'web_search', arguments: '{"query":"self hosted search"}' } }] } }] }),
  frame({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] }),
]
const FINAL_ANSWER = [
  frame({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'Two engines, both self-hostable.' } }] }),
  USAGE,
]
/** An Anthropic answer with nothing in it: the request is what this test reads, not the reply. */
const ANTHROPIC_EMPTY = [
  frame({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
]

/**
 * A wire that answers with the queued frames, and a search engine that answers with the hits.
 *
 * Both are one `fetch`, because that is what the worker actually has: the assertion worth making is which
 * address each call went to, so every one is recorded.
 */
function stubWires(engineAnswers = true): { providerBodies: string[], urls: string[] } {
  const providerBodies: string[] = []
  const urls: string[] = []
  let step = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: { body?: unknown }) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    urls.push(url)
    if (url.startsWith('https://search.example.test')) {
      return engineAnswers
        ? new Response(JSON.stringify({ query: 'self hosted search', results: HITS }), { headers: { 'content-type': 'application/json' } })
        : new Response('{}', { status: 503 })
    }
    providerBodies.push(String(init?.body ?? ''))
    // The model is written as if it were reading this turn's tool list: it asks for a search only when one
    // was offered, so a turn with no engine configured answers plainly instead of inventing a call.
    const frames = providerBodies.length === 1 && providerBodies[0]!.includes('"web_search"') ? SEARCH_CALL : FINAL_ANSWER
    return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
  }))
  return { providerBodies, urls }
}

/** An engine that always answers with the hits, for the cases that never reach a model. */
function stubEngine(): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    urls.push(String(typeof input === 'string' || input instanceof URL ? input : input.url))
    return new Response(JSON.stringify({ results: HITS }), { headers: { 'content-type': 'application/json' } })
  }))
  return { urls }
}

function settingsWithEndpoint(over: Partial<AssistantSettings> = {}): AssistantSettings {
  // The account's own settings, not the defaults: a turn needs the active model the fixture stored, and the
  // only thing under test here is the address beside it.
  return { ...base, webSearchEndpoint: ENGINE, ...over }
}

/** One turn, driven to its last event. */
async function drive(settings: AssistantSettings, message: string, webSearch: boolean): Promise<ChatStreamEvent[]> {
  const conversation = await store.createConversation('Search turn')
  const runToken = await store.claimRun(conversation.id)
  const runner = new AssistantRunner({
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings,
    runToken,
  })
  const events: ChatStreamEvent[] = []
  for await (const event of runner.chat({ conversationId: conversation.id, message, webSearch, signal: new AbortController().signal })) {
    events.push(event)
  }
  await store.releaseRun(conversation.id, runToken!)
  return events
}

function endedWith(events: ChatStreamEvent[]): AssistantMessage | undefined {
  return events.find((event) => event.type === 'done')?.finalMessage
}

/**
 * The answer as the row filed it.
 *
 * The sources of a turn live on the stored row, which is what a thread reopened later renders its chips
 * from; the event that ends a turn carries the row this store hands back, and that one has no sources on it.
 */
async function filedAnswer(events: ChatStreamEvent[]): Promise<AssistantMessage | undefined> {
  const answer = endedWith(events)
  if (!answer) return undefined
  const rows = await store.messages(answer.conversationId, 20)
  return rows.find((row) => row.id === answer.id)
}

/** A context for the executor only: what is under test is which tools a turn may reach, not a database. */
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

const offeredNames = (settings: AssistantSettings): string[] =>
  new ToolExecutor(executorContext(settings), { maxToolCalls: 8 }).available().map((definition) => definition.name)

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), {
    PUBLIC_URL: 'http://localhost',
    DO_AUTH_KEY: 'test-internal-key',
    // The real vault: one test provider carries a key, and a provider the store cannot store one for is a
    // turn that never reaches the wire being tested.
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
  })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  app = buildApp(USER)
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  const model = await store.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
  base = await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

describe('the configured search address', () => {
  it('takes a public address, and refuses one the worker must not be pointed at', async () => {
    expect((await respond('PATCH', '/api/assistant/settings', { webSearchEndpoint: ENGINE })).status).toBe(200)
    expect((await store.getSettings()).webSearchEndpoint).toBe(ENGINE)

    // The same class of address as a provider base URL: this one is fetched by the worker on a model's
    // say-so, so a link-local metadata address is not a setting, it is a request forgery waiting to run.
    for (const refused of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:8080/search',
      'https://search.internal/',
      'not-a-url',
      'https://user:pass@search.example.test/search',
    ]) {
      expect(await (await respond('PATCH', '/api/assistant/settings', { webSearchEndpoint: refused })).status, refused).toBe(400)
    }
    // Refused is not stored: the last good address stands, and a settings screen that read back a blank
    // would tell the reader their engine had been deleted.
    expect((await store.getSettings()).webSearchEndpoint).toBe(ENGINE)

    // Blank is an answer, not an error: it is how the reader turns the tool off.
    expect((await respond('PATCH', '/api/assistant/settings', { webSearchEndpoint: '   ' })).status).toBe(200)
    expect((await store.getSettings()).webSearchEndpoint).toBe('')
  })

  it('drops an unusable address rather than storing one, whoever wrote it', () => {
    // A backup file and a stored row go through the same rule as a settings request, so a value that
    // survived in one of them cannot reach the wire either.
    expect(normalizeAssistantSettings({ webSearchEndpoint: 'http://metadata.google.internal/' }).webSearchEndpoint).toBe('')
    expect(normalizeAssistantSettings({ webSearchEndpoint: ENGINE }).webSearchEndpoint).toBe(ENGINE)
    expect(normalizeAssistantSettings({ webSearchEndpoint: `https://a.test/${'x'.repeat(3000)}` }).webSearchEndpoint).toBe('')
    expect(normalizeAssistantSettings({}).webSearchEndpoint).toBe('')
  })
})

describe('the address a search is sent to', () => {
  it('is checked by the guard that refuses a metadata address, before anything is fetched', () => {
    expect(() => searchUrlFor('http://169.254.169.254/latest/meta-data/', 'q')).toThrow()
    expect(() => searchUrlFor('http://127.0.0.1:8383/search', 'q')).toThrow()
    expect(() => searchUrlFor('file:///etc/passwd', 'q')).toThrow()
    expect(() => searchUrlFor('https://localhost:8383/search', 'q')).toThrow()

    const asked = searchUrlFor(ENGINE, 'self hosted search')
    expect(asked.searchParams.get('q')).toBe('self hosted search')
    // SearXNG answers in HTML unless told otherwise, and an endpoint that was never asked for JSON is the
    // one case a reader would otherwise debug for an hour.
    expect(asked.searchParams.get('format')).toBe('json')
    // An address that already names its own format is left alone.
    expect(searchUrlFor(`${ENGINE}?format=jsonlite`, 'q').searchParams.get('format')).toBe('jsonlite')
  })

  it('reads the hits whichever shape the engine answers with', () => {
    const searxng = hitsFromSearchPayload({ query: 'x', results: [{ title: 'One', url: 'https://one.test/', content: 'first' }] })
    const openSearch = hitsFromSearchPayload({ organic: [{ title: 'Two', link: 'https://two.test/', snippet: 'second' }] })
    expect(searxng).toEqual([{ title: 'One', url: 'https://one.test/', snippet: 'first' }])
    expect(openSearch).toEqual([{ title: 'Two', url: 'https://two.test/', snippet: 'second' }])
    // An entry with no address the reader could open is dropped rather than handed on as a dead chip, and
    // a payload that is not a result list at all simply has no hits.
    expect(hitsFromSearchPayload({ results: [{ title: 'nowhere' }, { url: 'javascript:1' }] })).toEqual([])
    expect(hitsFromSearchPayload('nonsense')).toEqual([])
    expect(webSearchSources('list_tasks', { results: HITS })).toEqual([])
    expect(webSearchSources('web_search', { results: searxng })).toEqual([
      { url: 'https://one.test/', title: 'One', cited: 'first' },
    ])
  })
})

describe('which tools a turn may reach', () => {
  it('offers the search tool only to a reader who configured an engine', () => {
    expect(offeredNames(DEFAULT_ASSISTANT_SETTINGS)).not.toContain('web_search')
    expect(offeredNames(settingsWithEndpoint())).toContain('web_search')

    // The reader's policy is still the ceiling on it: a closed read class takes the tool away whatever the
    // settings say, because a tool the reader refused is not offered to make them change their mind.
    const closed: AssistantSettings = {
      ...settingsWithEndpoint(),
      toolModes: { ...DEFAULT_ASSISTANT_SETTINGS.toolModes, read: 'off' },
    }
    expect(offeredNames(closed)).not.toContain('web_search')
    // ...and an address that could not be stored still cannot be used by a turn assembled from one.
    expect(offeredNames({ ...DEFAULT_ASSISTANT_SETTINGS, webSearchEndpoint: '  ' })).not.toContain('web_search')
  })

  it('spends the turn\'s call budget and its duplicate refusal on a search', async () => {
    const engine = stubEngine()
    const executor = new ToolExecutor(executorContext(settingsWithEndpoint()), { maxToolCalls: 1 })
    const first = await executor.execute('web_search', { query: 'one' }, 'call1')
    expect(first).toMatchObject({ query: 'one' })
    expect((first as { results: unknown[] }).results).toHaveLength(HITS.length)
    expect(engine.urls).toHaveLength(1)
    expect(executor.budgetExhausted()).toBe(true)
    // The ceiling is judged before the wire is touched: a turn cannot search its way past the number the
    // reader set, which is the whole reason this is a tool call rather than a hook in the stream.
    await expect(executor.execute('web_search', { query: 'two' }, 'call2')).rejects.toThrow(/budget for this request is spent/)
    expect(engine.urls).toHaveLength(1)

    const repeat = new ToolExecutor(executorContext(settingsWithEndpoint()), { maxToolCalls: 8 })
    await repeat.execute('web_search', { query: 'same' }, 'call1')
    await expect(repeat.execute('web_search', { query: 'same' }, 'call2')).rejects.toThrow(/already made/)
  })

  it('judges the arguments the same way the schema the model was given says', async () => {
    const engine = stubEngine()
    const executor = new ToolExecutor(executorContext(settingsWithEndpoint()), { maxToolCalls: 8 })
    await expect(executor.execute('web_search', {}, 'call1')).rejects.toThrow(/Missing required argument "query"/)
    await expect(executor.execute('web_search', { query: 42 }, 'call2')).rejects.toThrow(/"query" must be text/)
    // Past the declared ceiling the query is clipped rather than refused, and the engine is sent what the
    // schema promised — a long question must not turn into a longer URL.
    await executor.execute('web_search', { query: 'x'.repeat(400) }, 'call3')
    const asked = new URL(engine.urls[engine.urls.length - 1]!)
    expect(asked.searchParams.get('q')).toHaveLength(200)
  })
})

describe('a turn that searches on a protocol with no vendor search', () => {
  it('asks its own engine and files the hits as the answer\'s sources', async () => {
    const wire = stubWires()
    const events = await drive(settingsWithEndpoint(), 'What can I self-host?', true)
    vi.unstubAllGlobals()

    // The switch was honoured: no "this model cannot search" notice, because something did search.
    expect(events.some((event) => event.type === 'notice')).toBe(false)
    expect(wire.urls.filter((url) => url.startsWith('https://search.example.test'))).toHaveLength(1)
    const searched = new URL(wire.urls.find((url) => url.startsWith('https://search.example.test'))!)
    expect(searched.searchParams.get('q')).toBe('self hosted search')
    expect(searched.searchParams.get('format')).toBe('json')

    // The tool was on the wire, and its answer came back as a tool result on the next step.
    expect(wire.providerBodies[0]).toContain('"web_search"')
    expect(wire.providerBodies[1] ?? '').toContain('https://docs.searxng.org/')

    const answer = endedWith(events)
    expect(answer?.status).toBe('complete')
    expect(answer?.content).toContain('self-hostable')
    expect(answer?.tools?.map((tool) => tool.name)).toEqual(['web_search'])
    // The pages the search found are filed as the answer's sources — the same channel a vendor's own search
    // writes to, and the reason the chips under the answer do not care which wire the pages came from.
    const filed = await filedAnswer(events)
    expect(filed?.sources?.map((source) => source.url)).toEqual([
      'https://docs.searxng.org/',
      'https://opensearch.org/docs/latest/',
    ])
    expect(filed?.sources?.[0]?.cited).toBe('Self-hosted metasearch.')
  })

  it('says so when the switch is on and nothing was configured to carry it', async () => {
    const wire = stubWires()
    const events = await drive(await store.getSettings(), 'What can I self-host?', true)
    vi.unstubAllGlobals()

    // No engine, no reader MCP server, and therefore no search: the reader is told, rather than reading an
    // unsearched answer as a searched one.
    expect(events.filter((event) => event.type === 'notice').map((event) => event.notice)).toEqual(['web_search_unavailable'])
    expect(wire.urls.some((url) => url.includes('search.example.test'))).toBe(false)
    expect(wire.providerBodies[0]).not.toContain('"web_search"')
    expect((await filedAnswer(events))?.sources ?? []).toEqual([])
  })

  it('never reaches an address the guard refuses, and reports the call as failed', async () => {
    const wire = stubWires(false)
    const events = await drive({ ...settingsWithEndpoint(), webSearchEndpoint: 'http://169.254.169.254/latest/meta-data/' }, 'Search the inside of the network', true)
    vi.unstubAllGlobals()

    expect(wire.urls.some((url) => url.includes('169.254.169.254'))).toBe(false)
    const tool = endedWith(events)?.tools?.[0]
    expect(tool?.status).toBe('error')
    expect(tool?.error).toContain('publicly reachable')
    // A search that did not happen cannot be cited: the answer stands, and the chip says it failed.
    expect((await filedAnswer(events))?.sources ?? []).toEqual([])
  })

  it('leaves the vendor\'s own search alone where the protocol has one', async () => {
    // The reader configured an engine and switched on search, but this protocol answers that with a tool
    // called `web_search` of its own. Two schemas with one name in one request is a request the provider
    // refuses outright, so the built-in tool steps aside wherever the vendor's exists.
    const conversation = await store.createConversation('Native search')
    const provider = await store.createProvider({ label: 'Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-anthropic-test-1' })
    const model = await store.createModel({ providerId: provider.id, model: 'claude-test', label: 'Claude test' })
    await store.saveSettings({ ...settingsWithEndpoint(), activeModelId: model.id })
    const urls: string[] = []
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: { body?: unknown }) => {
      urls.push(String(typeof input === 'string' || input instanceof URL ? input : input.url))
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(ANTHROPIC_EMPTY), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const runToken = await store.claimRun(conversation.id)
    const runner = new AssistantRunner({ store, env, ftsEnabled: false, origin: 'http://localhost', settings: await store.getSettings(), runToken })
    const events: ChatStreamEvent[] = []
    for await (const event of runner.chat({ conversationId: conversation.id, message: 'Search it', webSearch: true, signal: new AbortController().signal })) {
      events.push(event)
    }
    vi.unstubAllGlobals()
    await store.releaseRun(conversation.id, runToken!)

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('"web_search_20250305"')
    // Exactly one entry answering to the name, and it is the vendor's.
    expect(bodies[0].match(/"name":"web_search"/g)).toHaveLength(1)
    expect(urls.some((url) => url.includes('search.example.test'))).toBe(false)
    // Nothing was refused, so nothing was announced: the switch was carried out by the protocol itself.
    expect(events.some((event) => event.type === 'notice')).toBe(false)
  })
})
