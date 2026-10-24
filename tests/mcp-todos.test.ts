// @vitest-environment node
/**
 * The to-do tools the MCP server publishes, and the scopes they answer under.
 *
 * A note key is not a task key: an agent that may read the reader's notes must not read their tasks by
 * accident, and a key minted before the to-do family existed must still carry exactly what it was minted
 * with. Those two rules are the whole file. Every case speaks the real protocol over a linked transport,
 * the way `mcp-search-semantic-status.test.ts` does, because what is under test is the boundary a client
 * actually sees: the scope check in front of a tool, the shape of the refusal, and what a task answer is
 * allowed to name.
 */
import { DatabaseSync } from 'node:sqlite'
import { InMemoryTransport, type JSONObject } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/worker/env'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { createInkstoneMcpServer } from '../src/worker/mcp/server'
import { createMcpApiKey, verifyMcpApiKey } from '../src/worker/mcp/api-keys'
import {
  getMcpPreferences,
  grantedMcpScopes,
  MCP_NOTE_SCOPES,
  MCP_SCOPES,
  MCP_SUPPORTED_SCOPES,
  putMcpPreferences,
} from '../src/worker/mcp/settings'
import { sha256Hex } from '../src/worker/lib/encoding'
import { MAX_TASK_TITLE_CHARS } from '../src/shared/assistant'
import { MAX_TASK_DESCRIPTION_CHARS } from '../src/shared/todos/model'
import { MAX_TASK_TOOL_DESCRIPTION_CHARS } from '../src/worker/mcp/todos'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const TIMEZONE = 'Asia/Shanghai'
/** The note body a task may reference but must never repeat. */
const NOTE_BODY = 'The tide gates at the harbour mouth were rebuilt in spring.'

const READ = [MCP_SCOPES.todoRead]
const WRITE = [MCP_SCOPES.todoRead, MCP_SCOPES.todoWrite]
const DANGER = [MCP_SCOPES.todoRead, MCP_SCOPES.todoWrite, MCP_SCOPES.todoDanger]

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

function seedUser(id: string): void {
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, '', '', 'owner', '{}', 1, 1)`,
  ).run(id, `user-${id}`, `user-${id}`)
}

function seedNote(id: string, owner: string, content: string): void {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'Harbour', 'harbour', ?, ?, 1, 8, 8, 0, 0, 0, 0, 'hash', 1, 1, NULL)`,
  ).run(id, owner, content, content)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB, USER, env)
  // The reader's own zone: every due date in this file is read in it, exactly as the HTTP route reads it.
  await store.saveSettings({ ...(await store.getSettings()), timezone: TIMEZONE })
  seedUser(USER)
  seedUser(OTHER)
})

/** The account's own MCP switches: the two that gate writes, and the one that gates to-do reads. */
async function switchPreferences(write: boolean, trash: boolean, todoRead = true): Promise<void> {
  await putMcpPreferences(env.DB, USER, {
    writeEnabled: write,
    trashEnabled: trash,
    todoReadEnabled: todoRead,
    emailEnabled: false,
    disabledTools: [],
    updatedAt: Date.now(),
  })
}

interface RpcMessage {
  id?: number | string
  result?: {
    isError?: boolean
    content?: { type: string; text?: string }[]
    structuredContent?: Record<string, unknown>
    tools?: Record<string, unknown>[]
  }
  error?: { code: number; message: string }
}

/**
 * One server per call, over a handshake, as the client in `mcp-search-semantic-status.test.ts` runs it.
 *
 * The scopes are the argument rather than the fixture because the boundary under test is the grant, and a
 * server built once for the whole file would carry the first case's scopes into every later one.
 */
async function withServer<T>(
  scopes: readonly string[],
  use: (ask: (method: string, params?: JSONObject) => Promise<RpcMessage>) => Promise<T>,
): Promise<T> {
  const server = createInkstoneMcpServer({
    env,
    auth: { userId: USER, role: 'owner', scopes: [...scopes] },
    origin: 'https://todos.test',
    ftsEnabled: false,
    executionCtx: { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
  })
  const [client, serverSide] = InMemoryTransport.createLinkedPair()
  const waiting = new Map<number, (message: RpcMessage) => void>()
  client.onmessage = (message) => {
    const id = (message as RpcMessage).id
    if (typeof id === 'number') waiting.get(id)?.(message as RpcMessage)
  }
  await server.connect(serverSide)
  await client.start()
  let nextId = 1
  const ask = (method: string, params: JSONObject = {}) => new Promise<RpcMessage>((resolve) => {
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
  return use(ask)
}

/** One `tools/call`, answered as the JSON body the client reads plus whether it says it failed. */
async function callTool(
  scopes: readonly string[],
  name: string,
  args: JSONObject = {},
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const message = await withServer(scopes, async (ask) => ask('tools/call', { name, arguments: args }))
  if (message.error) {
    // A rejection the SDK made before the handler ran — a schema refusal — still has to be readable here,
    // or a case that expects one would be asserting against an empty body.
    return { ok: false, body: { error: { code: 'invalid_request', message: message.error.message } } }
  }
  const text = message.result?.content?.[0]?.text ?? '{}'
  // The SDK answers a schema refusal with `isError` and a plain sentence rather than a JSON body, so the
  // refusal is read the way a client reads it: text first, JSON when the server actually answered in JSON.
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { error: { code: 'invalid_request', message: text } }
  }
  return { ok: !(message.result?.isError ?? false), body }
}

/** Every tool a server offers, with the annotations a client builds its behaviour from. */
async function listedTools(scopes: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
  const listed = await withServer(scopes, async (ask) => ask('tools/list'))
  const tools = (listed.result?.tools ?? []) as Record<string, unknown>[]
  return new Map(tools.map((tool) => [String(tool.name), tool]))
}

/** The `{code, message, status}` every tool failure carries, read straight off the refused call. */
async function failureOf(
  scopes: readonly string[],
  name: string,
  args: JSONObject = {},
): Promise<{ code: string; message: string; status: number }> {
  const outcome = await callTool(scopes, name, args)
  expect(outcome.ok).toBe(false)
  const error = outcome.body.error as { code: string; message: string; status: number } | undefined
  expect(error, `the refusal carries an error body: ${JSON.stringify(outcome.body)}`).toBeDefined()
  return error as { code: string; message: string; status: number }
}

describe('the to-do tools answer under scopes of their own', () => {
  it('refuses a to-do read to a note-only key, in the shape every other refusal has', async () => {
    const refused = await failureOf([MCP_SCOPES.read], 'list_todos')
    expect(refused).toMatchObject({ code: 'forbidden', status: 403, message: `OAuth scope required: ${MCP_SCOPES.todoRead}` })

    // The same shape a note refusal already has: the rule is one rule, not a second one for tasks.
    const noteRefused = await failureOf(READ, 'list_notes')
    expect(noteRefused).toMatchObject({ code: 'forbidden', status: 403, message: `OAuth scope required: ${MCP_SCOPES.read}` })
  })

  it('publishes the read tools as read-only, the writes as writes and the delete as destructive', async () => {
    const tools = await listedTools(DANGER)
    for (const name of ['list_todos', 'get_todo', 'list_todo_lists']) {
      expect(tools.get(name), `${name} is published`).toBeDefined()
      expect(tools.get(name)!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    }
    for (const name of ['create_todo', 'update_todo', 'complete_todo']) {
      expect(tools.get(name)!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    }
    expect(tools.get('delete_todo')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })

  it('answers get_todo for a key that holds nothing but todos:read', async () => {
    const task = await store.createTask({ title: 'File the return' })
    const outcome = await callTool(READ, 'get_todo', { task_id: task.id })
    expect(outcome.ok).toBe(true)
    expect(outcome.body).toMatchObject({ task: { id: task.id, title: 'File the return' } })
  })
})

describe('to-do reads answer to an account switch of their own', () => {
  it('refuses every read while the switch is off, in the shape a missing scope has', async () => {
    const task = await store.createTask({ title: 'Not for the agent' })
    await switchPreferences(true, true, false)

    const withoutScope = await failureOf([MCP_SCOPES.read], 'list_todos')
    for (const [name, args] of [
      ['list_todos', {}],
      ['get_todo', { task_id: task.id }],
      ['list_todo_lists', {}],
    ] as const) {
      const refused = await failureOf(READ, name, args)
      // A key that carries the scope but whose account has the switch off is refused exactly as a key
      // that never carried it: the scope is withheld, not answered with a second kind of error.
      expect({ name, ...refused }).toEqual({ name, ...withoutScope })
    }
  })

  it('answers again as soon as the switch is back on', async () => {
    await switchPreferences(true, true, false)
    expect((await callTool(READ, 'list_todos')).ok).toBe(false)

    await switchPreferences(true, true, true)
    // The same isolate and the same cached preferences: flipping the switch has to drop the cached answer.
    const outcome = await callTool(READ, 'list_todos')
    expect(outcome.ok).toBe(true)
  })

  it('leaves to-do writes and deletes to their own switches', async () => {
    await switchPreferences(true, true, false)

    const created = await callTool(WRITE, 'create_todo', {
      operation_id: 'op-read-off-write-on',
      title: 'Still writable',
    })
    expect(created.ok).toBe(true)
    const id = (created.body as { task: Record<string, unknown> }).task.id as string

    const deleted = await callTool(DANGER, 'delete_todo', {
      operation_id: 'op-read-off-delete-on',
      task_id: id,
    })
    expect(deleted.ok).toBe(true)
    expect(await store.getTask(id)).toBeNull()
  })

  it('reads by default for an account that never touched the switch', async () => {
    expect((await getMcpPreferences(env.DB, USER)).todoReadEnabled).toBe(true)
    expect((await callTool(READ, 'list_todos')).ok).toBe(true)
  })
})

describe('an id that belongs to somebody else', () => {
  it('answers every to-do tool with a miss rather than a refusal', async () => {
    const foreign = await new AssistantStore(env.DB, OTHER, env).createTask({ title: 'Borrowed task' })
    await switchPreferences(true, true)
    for (const [name, args] of [
      ['get_todo', { task_id: foreign.id }],
      ['update_todo', { operation_id: 'op-update-foreign-1', task_id: foreign.id, starred: true }],
      ['complete_todo', { operation_id: 'op-complete-foreign-1', task_id: foreign.id }],
      ['delete_todo', { operation_id: 'op-delete-foreign-1', task_id: foreign.id }],
    ] as const) {
      const refused = await failureOf(DANGER, name, args)
      // A 403 would confirm the row exists, which is the leak the route already refuses to make.
      expect({ name, ...refused }).toMatchObject({ name, code: 'not_found', status: 404 })
    }
  })

  it('answers a foreign note reference with a miss', async () => {
    seedNote('0123456789abcdefghjkmnpqr1', OTHER, 'Somebody else\'s note.')
    await switchPreferences(true, false)
    const refused = await failureOf(
      [...WRITE, MCP_SCOPES.read],
      'create_todo',
      { operation_id: 'op-note-foreign-1', title: 'Chase the loan', note: '0123456789abcdefghjkmnpqr1' },
    )
    expect(refused).toMatchObject({ code: 'not_found', status: 404 })
  })
})

describe('delete needs its own consent', () => {
  it('leaves the task untouched when todos:danger was never granted', async () => {
    const task = await store.createTask({ title: 'Pay the invoice' })
    await switchPreferences(true, true)

    const refused = await failureOf(WRITE, 'delete_todo', { operation_id: 'op-delete-no-consent', task_id: task.id })
    expect(refused).toMatchObject({ code: 'forbidden', status: 403, message: `OAuth scope required: ${MCP_SCOPES.todoDanger}` })
    expect(await store.getTask(task.id)).not.toBeNull()
  })

  it('also stops when the account itself has MCP trash switched off', async () => {
    const task = await store.createTask({ title: 'Shred the drafts' })
    await switchPreferences(true, false)

    const refused = await failureOf(DANGER, 'delete_todo', { operation_id: 'op-delete-switch-off', task_id: task.id })
    expect(refused).toMatchObject({ code: 'forbidden', status: 403 })
    expect(refused.message).toMatch(/disabled in Inkstone settings/)
    expect(await store.getTask(task.id)).not.toBeNull()
  })

  it('deletes once the scope is granted and the account allows it', async () => {
    const task = await store.createTask({ title: 'Retire the old form' })
    await switchPreferences(true, true)

    const outcome = await callTool(DANGER, 'delete_todo', { operation_id: 'op-delete-consented', task_id: task.id })
    expect(outcome.ok).toBe(true)
    expect(await store.getTask(task.id)).toBeNull()
  })
})

describe('the answers use the model, not a second copy of it', () => {
  it('files the next occurrence of a repeating task instead of only ticking it', async () => {
    const task = await store.createTask({
      title: 'Weekly report',
      dueAt: Date.UTC(2026, 2, 5, 1, 0),
      repeat: { freq: 'weekly', interval: 1 },
    })
    await switchPreferences(true, false)

    const outcome = await callTool(WRITE, 'complete_todo', { operation_id: 'op-complete-repeat-1', task_id: task.id })
    expect(outcome.ok).toBe(true)
    const { completed, next } = outcome.body as { completed: Record<string, unknown>; next: Record<string, unknown> }
    expect(completed).toMatchObject({ status: 'done' })
    // Seven days on, counted from the old due date and kept at the same wall clock in the reader's zone.
    expect(new Date(Number(next.due_at)).toISOString()).toBe('2026-03-12T01:00:00.000Z')
    expect(next.id).not.toBe(completed.id)
  })

  it('says nothing about a next occurrence for a task that does not repeat', async () => {
    const task = await store.createTask({ title: 'One-off' })
    await switchPreferences(true, false)

    const outcome = await callTool(WRITE, 'complete_todo', { operation_id: 'op-complete-once-1', task_id: task.id })
    expect(outcome.ok).toBe(true)
    expect(outcome.body).not.toHaveProperty('next')
  })

  it('refuses a title past the model constant, with its own limit named, and writes nothing', async () => {
    await switchPreferences(true, false)
    const tooLong = 'x'.repeat(MAX_TASK_TITLE_CHARS + 1)

    const outcome = await callTool(WRITE, 'create_todo', { operation_id: 'op-title-too-long-1', title: tooLong })
    expect(outcome.ok).toBe(false)
    // The number the refusal quotes is the one the shared model publishes, so the MCP layer cannot have
    // quietly re-forked the ceiling the store and the app use.
    expect(JSON.stringify(outcome.body)).toContain(String(MAX_TASK_TITLE_CHARS))
    expect(await store.listTasks({ view: 'all' })).toHaveLength(0)
  })

  it('refuses a literal 301-character title, so the tool schema cannot be looser than the model', async () => {
    await switchPreferences(true, false)
    const outcome = await callTool(WRITE, 'create_todo', {
      operation_id: 'op-title-301-literal',
      title: 'x'.repeat(301),
    })
    expect(outcome.ok).toBe(false)
    // 301 is spelled out rather than derived: this case must go red if the schema or the model constant is
    // raised, while the case above follows whatever number the model publishes.
    expect(JSON.stringify(outcome.body)).toContain(String(MAX_TASK_TITLE_CHARS))
    expect(await store.listTasks({ view: 'all' })).toHaveLength(0)
  })

  it('refuses a description past the agent payload ceiling, which is not the HTTP form ceiling', async () => {
    await switchPreferences(true, false)
    const outcome = await callTool(WRITE, 'create_todo', {
      operation_id: 'op-description-too-long-1',
      title: 'Long note',
      description: 'x'.repeat(MAX_TASK_TOOL_DESCRIPTION_CHARS + 1),
    })
    expect(outcome.ok).toBe(false)
    // The number the refusal quotes is the MCP tools' own constant, so a schema that re-typed 2,000
    // would fail here as soon as the two drifted apart.
    expect(JSON.stringify(outcome.body)).toContain(String(MAX_TASK_TOOL_DESCRIPTION_CHARS))
    // The agent ceiling is deliberately below the 10,000 a person may type into the to-do form; this
    // case exists so the divergence stays a decision rather than becoming a second copy of one number.
    expect(MAX_TASK_TOOL_DESCRIPTION_CHARS).toBeLessThan(MAX_TASK_DESCRIPTION_CHARS)
    expect(await store.listTasks({ view: 'all' })).toHaveLength(0)
  })

  it('reads a bare due date as the end of the reader local day, the way the HTTP route does', async () => {
    await switchPreferences(true, false)
    const outcome = await callTool(WRITE, 'create_todo', {
      operation_id: 'op-due-local-day-1',
      title: 'Water the fern',
      due: '2026-03-05',
    })
    expect(outcome.ok).toBe(true)
    const task = (outcome.body as { task: Record<string, unknown> }).task
    // 2026-03-05 23:59 in Shanghai, which is 15:59 UTC — the same instant `parseLocalTime` gives the route.
    expect(new Date(Number(task.due_at)).toISOString()).toBe('2026-03-05T15:59:00.000Z')
  })

  it('answers a listing with the reader counts and the zone they are measured in', async () => {
    await store.createTask({ title: 'Overdue thing', dueAt: Date.UTC(2020, 0, 1) })
    await store.createTask({ title: 'Later thing' })

    const outcome = await callTool(READ, 'list_todos', { view: 'overdue' })
    expect(outcome.ok).toBe(true)
    const page = outcome.body as { tasks: unknown[]; count: number; counts: Record<string, number>; timezone: string }
    expect(page.count).toBe(page.tasks.length)
    expect(page.counts).toMatchObject({ overdue: 1, open: 2 })
    expect(page.timezone).toBe(TIMEZONE)
  })

  it('lists the reader lists with what is still open in each', async () => {
    const list = await store.createTaskList({ name: 'Home' })
    await store.createTask({ title: 'Fix the gate', listId: list.id })

    const outcome = await callTool(READ, 'list_todo_lists')
    expect(outcome.ok).toBe(true)
    expect((outcome.body as { lists: Record<string, unknown>[] }).lists).toEqual([
      { id: list.id, name: 'Home', open: 1, total: 1 },
    ])
  })

  it('walks the page with limit and offset, and filters by the list and tag the reader named', async () => {
    const list = await store.createTaskList({ name: 'Home' })
    for (const title of ['Rake the leaves', 'Oil the hinge', 'Mend the fence']) {
      await store.createTask({ title, listId: list.id, tags: ['weekend'] })
    }

    const firstPage = await callTool(READ, 'list_todos', { view: 'open', limit: 2, offset: 0 })
    const secondPage = await callTool(READ, 'list_todos', { view: 'open', limit: 2, offset: 2 })
    const ids = [
      ...(firstPage.body as { tasks: Record<string, unknown>[] }).tasks,
      ...(secondPage.body as { tasks: Record<string, unknown>[] }).tasks,
    ].map((task) => task.id)
    expect(ids).toHaveLength(3)
    // Two pages of a stable order: the second carries what the first did not, and nothing twice.
    expect(new Set(ids).size).toBe(3)

    const byList = await callTool(READ, 'list_todos', { view: 'open', list: 'home' })
    expect((byList.body as { tasks: Record<string, unknown>[] }).tasks).toHaveLength(3)
    expect((byList.body as { tasks: Record<string, unknown>[] }).tasks[0]).toMatchObject({ list_id: list.id, tags: ['weekend'] })

    const byTag = await callTool(READ, 'list_todos', { view: 'open', tag: '#Weekend' })
    expect((byTag.body as { count: number }).count).toBe(3)

    // A list the account does not have is refused rather than silently filed in the inbox.
    const unknown = await failureOf(READ, 'list_todos', { list: 'Somewhere else' })
    expect(unknown).toMatchObject({ code: 'bad_request', status: 400 })
  })

  it('files the next occurrence when the patch names done as the status', async () => {
    const task = await store.createTask({
      title: 'Monthly statement',
      dueAt: Date.UTC(2026, 2, 5, 1, 0),
      repeat: { freq: 'monthly', interval: 1 },
    })
    await switchPreferences(true, false)

    const outcome = await callTool(WRITE, 'update_todo', {
      operation_id: 'op-update-done-1',
      task_id: task.id,
      status: 'done',
    })
    expect(outcome.ok).toBe(true)
    const body = outcome.body as { task: Record<string, unknown>; next: Record<string, unknown> }
    expect(body.task.status).toBe('done')
    expect(new Date(Number(body.next.due_at)).toISOString()).toBe('2026-04-05T01:00:00.000Z')
  })

  it('replays one operation_id as the task it first made, without writing a second', async () => {
    await switchPreferences(true, false)
    const args = { operation_id: 'op-create-retry-1', title: 'Book the dentist' }

    const first = await callTool(WRITE, 'create_todo', args)
    const again = await callTool(WRITE, 'create_todo', args)
    expect(first.ok).toBe(true)
    expect(again.ok).toBe(true)
    expect(again.body).toEqual(first.body)
    expect(await store.listTasks({ view: 'all' })).toHaveLength(1)
  })
})

describe('a pending operation names no particular object', () => {
  it('asks for the affected item, not a note, when the earlier call may still be completing', async () => {
    await switchPreferences(true, false)
    const args = { operation_id: 'op-pending-neutral-1', title: 'Water the fern' }
    expect((await callTool(WRITE, 'create_todo', args)).ok).toBe(true)

    // Leave the row looking like a call that committed but never stored its answer: the retry has nothing
    // to recover from, which is the branch that tells the caller what to read before trying again.
    sqlite.prepare(
      `UPDATE mcp_operations SET response_json = ?1 WHERE user_id = ?2 AND operation_id = ?3`,
    ).run(JSON.stringify({ pending: true }), USER, args.operation_id)

    const refused = await failureOf(WRITE, 'create_todo', args)
    expect(refused).toMatchObject({ code: 'conflict', status: 409 })
    // The same sentence answers a note write and a task write, so it must not name either one.
    expect(refused.message.toLowerCase()).not.toContain('note')
    expect(refused.message).toContain('affected item')
    expect(await store.listTasks({ view: 'all' })).toHaveLength(1)
  })
})

describe('a task may name a note, and nothing else about it', () => {
  it('keeps the note body out of a to-do answer, and the reference out of a key that may not read notes', async () => {
    const noteId = '0123456789abcdefghjkmnpqr2'
    seedNote(noteId, USER, NOTE_BODY)
    const task = await store.createTask({ title: 'Rebuild the gate', noteId })

    const withNotes = await callTool([...READ, MCP_SCOPES.read], 'get_todo', { task_id: task.id })
    expect(withNotes.ok).toBe(true)
    expect((withNotes.body as { task: Record<string, unknown> }).task.note_id).toBe(noteId)
    expect(JSON.stringify(withNotes.body)).not.toContain(NOTE_BODY)

    const withoutNotes = await callTool(READ, 'get_todo', { task_id: task.id })
    expect(withoutNotes.ok).toBe(true)
    expect(JSON.stringify(withoutNotes.body)).not.toContain(noteId)
    expect((withoutNotes.body as { task: Record<string, unknown> }).task).not.toHaveProperty('note_id')
  })

  it('will not file a note reference for a key that may not read notes', async () => {
    const noteId = '0123456789abcdefghjkmnpqr3'
    seedNote(noteId, USER, NOTE_BODY)
    await switchPreferences(true, false)

    const refused = await failureOf(WRITE, 'create_todo', {
      operation_id: 'op-note-needs-read-1',
      title: 'Mention the gates',
      note: noteId,
    })
    expect(refused).toMatchObject({ code: 'forbidden', status: 403, message: `OAuth scope required: ${MCP_SCOPES.read}` })
    expect(await store.listTasks({ view: 'all' })).toHaveLength(0)
  })

  it('never names a conversation, which no to-do tool can read', async () => {
    const task = await store.createTask({ title: 'From a chat', conversationId: '0123456789abcdefghjkmnpqr9' })
    const outcome = await callTool(READ, 'get_todo', { task_id: task.id })
    expect(outcome.ok).toBe(true)
    expect(JSON.stringify(outcome.body)).not.toContain('conversation')
  })
})

describe('no key grows because the to-do family exists', () => {
  it('mints a default key with the note family only, even when the account allows write and trash', async () => {
    await switchPreferences(true, true)
    const minted = await createMcpApiKey(env.DB, USER, 'automation')
    expect(minted.record.scopes).toEqual([MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.trash])
    expect(minted.record.scopes.some((scope) => scope.startsWith('todos:'))).toBe(false)

    const verified = await verifyMcpApiKey(env.DB, minted.token)
    expect(verified?.scopes).toEqual([MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.trash])
  })

  it('carries a to-do scope only when the key was asked for it, and only as far as the account allows', async () => {
    await switchPreferences(true, true)
    const reading = await createMcpApiKey(env.DB, USER, 'reader', [MCP_SCOPES.todoRead])
    expect(reading.record.scopes).toEqual([MCP_SCOPES.read, MCP_SCOPES.todoRead])

    const deleting = await createMcpApiKey(env.DB, USER, 'sweeper', [MCP_SCOPES.todoDanger])
    expect(deleting.record.scopes).toEqual([MCP_SCOPES.read, MCP_SCOPES.todoDanger])

    // The account switches still decide: a write the reader has not switched on cannot be asked for.
    await putMcpPreferences(env.DB, USER, {
      writeEnabled: false, trashEnabled: false, todoReadEnabled: true, emailEnabled: false, disabledTools: [], updatedAt: Date.now(),
    })
    const refused = await createMcpApiKey(env.DB, USER, 'greedy', [MCP_SCOPES.todoWrite, MCP_SCOPES.todoDanger])
    expect(refused.record.scopes).toEqual([MCP_SCOPES.read])
  })

  it('withholds todos:read from a new key while the account switch is off', async () => {
    await switchPreferences(false, false, false)
    const reading = await createMcpApiKey(env.DB, USER, 'reader', [MCP_SCOPES.todoRead])
    expect(reading.record.scopes).toEqual([MCP_SCOPES.read])
  })

  it('leaves a key stored before the family existed carrying exactly what it stored', async () => {
    const token = 'ink_' + 'a'.repeat(43)
    sqlite.prepare(
      `INSERT INTO mcp_api_keys (id, user_id, name, key_hash, scopes, created_at, last_used_at, revoked_at)
       VALUES ('legacy-key', ?, 'legacy', ?, 'notes:read', 1, NULL, NULL)`,
    ).run(USER, await sha256Hex(token))

    const verified = await verifyMcpApiKey(env.DB, token)
    expect(verified?.scopes).toEqual([MCP_SCOPES.read])
  })

  it('keeps the note ceiling handing out no to-do scope, and the full ceiling naming each one it may', () => {
    const open = { writeEnabled: true, trashEnabled: true, todoReadEnabled: true, emailEnabled: false, disabledTools: [], updatedAt: 0 }
    expect(grantedMcpScopes(MCP_NOTE_SCOPES, open))
      .toEqual([MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.trash])
    expect(grantedMcpScopes(MCP_SUPPORTED_SCOPES, open)).toEqual([
      MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.trash,
      MCP_SCOPES.todoRead, MCP_SCOPES.todoWrite, MCP_SCOPES.todoDanger,
    ])
    expect(grantedMcpScopes(MCP_SUPPORTED_SCOPES, { ...open, writeEnabled: false, trashEnabled: false }))
      .toEqual([MCP_SCOPES.read, MCP_SCOPES.todoRead])
    // The read switch withholds its scope alone; the writes still answer to the two switches above.
    expect(grantedMcpScopes(MCP_SUPPORTED_SCOPES, { ...open, todoReadEnabled: false }))
      .toEqual([MCP_SCOPES.read, MCP_SCOPES.write, MCP_SCOPES.trash, MCP_SCOPES.todoWrite, MCP_SCOPES.todoDanger])
  })
})
