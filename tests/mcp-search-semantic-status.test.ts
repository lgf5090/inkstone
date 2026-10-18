import { DatabaseSync } from 'node:sqlite'
import { InMemoryTransport, type JSONObject } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { encodeVector } from '../src/worker/mcp/ai-search'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { createInkstoneMcpServer } from '../src/worker/mcp/server'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The MCP `search` tool tells a client which half of the retrieval answered.
 *
 * `searchMcpNotes()` reports `semantic_status` and `notice` so a page cannot claim to have searched by
 * meaning when the index refused, and the assistant's own note tool passes that page straight through. The
 * `search` tool did not: it rebuilt the response as `{ results, mode }` and dropped both fields, so the
 * rule "say honestly which half produced these hits" held in the app and quietly did not hold on the
 * machine-facing surface — an MCP client reading a keyword page after a `mode: 'semantic'` request could
 * not tell a refusal apart from a searched-and-empty answer, and had to guess from `mode` alone.
 *
 * These cases speak the real protocol, because the defect lives in the tool's registered shape: what the
 * client gets is `structuredContent` plus the JSON schema the tool publishes, and both are asserted here.
 */

const USER = 'user-1'
/** The only note the keyword half can find: it carries the words of the query. */
const HARBOUR_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz01'
/** Shares no word with the query, and is the note the vector half is expected to reach. */
const FAR_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz02'
const PREF_KEY = `ai-search-enabled:${USER}`
const UNIT_VECTOR = [1, 0, 0, 0]

let sqlite: DatabaseSync
/** Bindings with an AI stub, so a semantic request can be answered as well as refused. */
let env: Env
/** The same vault without `env.AI`: the deployment cannot embed at all. */
let noAiEnv: Env

function seedNote(id: string, title: string, content: string, updatedAt: number) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 4, 4, 0, 0, 0, 0, 'hash', 1, ?, NULL)`,
  ).run(id, USER, title, title.toLowerCase(), content, content, updatedAt)
}

function seed() {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  seedNote(HARBOUR_NOTE, 'Tide gates', 'The tide gates at the harbour mouth were rebuilt in spring.', 1_700_000_000_100)
  seedNote(FAR_NOTE, 'Sofa care', 'Dust the cushions and turn the memory foam once a week.', 1_700_000_000_200)
  sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PREF_KEY, '1')
  // Both notes sit at cosine 1 with the query, so the vector half answers with a hit the keyword half has
  // never seen: the page that comes back is a meaning page, and has to say so.
  const vector = sqlite.prepare(
    'INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at, norm) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const id of [HARBOUR_NOTE, FAR_NOTE]) {
    vector.run(USER, id, '@cf/baai/bge-m3', new Uint8Array(encodeVector(new Float32Array(UNIT_VECTOR))), 1_700_000_000_000, 1)
  }
  env = {
    DB: makeD1(sqlite),
    AI: {
      run: async (_model: string, call: { text: string[] }) => ({
        data: call.text.map(() => ({ embedding: UNIT_VECTOR })),
      }),
    },
  } as unknown as Env
  noAiEnv = { DB: env.DB } as unknown as Env
}

interface JsonRpcMessage {
  id?: number | string
  result?: {
    tools?: { name: string; description?: string; outputSchema?: { properties?: Record<string, unknown> } }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
}

/**
 * One round trip against a server built on `onEnv`: handshake, then `request`, then hang up.
 *
 * The handshake is repeated per case rather than shared because the environment is what each case is
 * testing — a deployment with an AI binding and one without cannot serve the same client — and the server
 * holds no state a second question would need.
 */
async function askServer<T>(
  onEnv: Env,
  request: (ask: (method: string, params?: JSONObject) => Promise<JsonRpcMessage>) => Promise<T>,
): Promise<T> {
  const server = createInkstoneMcpServer({
    env: onEnv,
    auth: { userId: USER, role: 'owner', scopes: ['notes:read'] },
    origin: 'https://notes.test',
    ftsEnabled: false,
    executionCtx: { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  })
  const [client, serverSide] = InMemoryTransport.createLinkedPair()
  const waiting = new Map<number, (message: JsonRpcMessage) => void>()
  client.onmessage = (message) => {
    const id = (message as JsonRpcMessage).id
    if (typeof id === 'number') waiting.get(id)?.(message as JsonRpcMessage)
  }
  await server.connect(serverSide)
  await client.start()
  let nextId = 1
  const ask = (method: string, params: JSONObject = {}) => new Promise<JsonRpcMessage>((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    void client.send({ jsonrpc: '2.0', id, method, params })
  })
  await ask('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'inkstone-test', version: '1' },
  })
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return request(ask)
}

/** The `search` tool's entry in `tools/list`, as the schema and description a client is handed. */
async function listedSearchTool(): Promise<Record<string, unknown>> {
  const tools = await askServer(env, async (ask) => (await ask('tools/list')).result?.tools ?? [])
  return JSON.parse(JSON.stringify(tools.find((entry) => entry.name === 'search') ?? {})) as Record<string, unknown>
}

/** One `tools/call` of the `search` tool, answered as the `structuredContent` the client reads. */
async function callSearch(onEnv: Env, args: JSONObject): Promise<Record<string, unknown>> {
  const page = await askServer(onEnv, async (ask) => (await ask('tools/call', { name: 'search', arguments: args })).result)
  expect(page?.isError ?? false).toBe(false)
  return page?.structuredContent ?? {}
}

beforeEach(() => seed())

describe('the search tool\'s account of which half answered', () => {
  it('publishes the retrieval state in the schema a client reads', async () => {
    const tool = await listedSearchTool()
    const properties = (tool.outputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    // A field a client cannot see in the schema is a field it has to guess at, which is the thing this
    // change exists to stop. `mode` is declared too: it was returned but never published.
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['mode', 'semantic_status', 'notice']))
    expect(String(tool.description)).toMatch(/semantic_status/)
  })

  it('says which half answered a refused semantic request instead of leaving the client to infer it', async () => {
    const page = await callSearch(noAiEnv, { query: 'harbour tide gates rebuilt', mode: 'semantic' })
    // Nothing could be embedded here, so the hits really did come from keywords, and the client is told
    // both facts rather than handed `mode: 'lexical'` and left to wonder whether the index was searched.
    expect(page.mode).toBe('lexical')
    expect(page.semantic_status).toBe('unanswered')
    expect(String(page.notice)).toMatch(/could not be searched/i)
    expect((page.results as { id: string }[]).map((hit) => hit.id)).toEqual([HARBOUR_NOTE])
  })

  it('reports a meaning page that answered as matched, with nothing to explain', async () => {
    const page = await callSearch(env, { query: 'locks that hold the water back', mode: 'semantic' })
    expect(page.mode).toBe('semantic')
    expect(page.semantic_status).toBe('matched')
    expect(page.notice).toBeNull()
    expect((page.results as { id: string }[]).length).toBeGreaterThan(0)
  })

  // Control for both cases above, and the compatibility rule the change has to respect: a caller who never
  // asked for meaning gets exactly the page that caller got before the state fields existed — same hits,
  // same mode, nothing appended to explain a half nobody requested.
  it('leaves a keyword-only search saying what it said before, apart from naming the state', async () => {
    const page = await callSearch(env, { query: 'harbour tide gates rebuilt in spring', mode: 'lexical' })
    expect(page.mode).toBe('lexical')
    expect((page.results as { id: string }[]).map((hit) => hit.id)).toEqual([HARBOUR_NOTE])
    expect(page.semantic_status).toBe('not_requested')
    expect(page.notice).toBeNull()
    // The hits stay citation-ready and no narrower than today: id, title and url, and nothing else.
    expect(Object.keys((page.results as Record<string, unknown>[])[0] ?? {})).toEqual(['id', 'title', 'url'])
  })
})
