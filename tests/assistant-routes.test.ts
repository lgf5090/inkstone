// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import type { AppBindings } from '../src/worker/env'
import type {
  AssistantConversation,
  AssistantMemory,
  AssistantProvider,
  AssistantSettings,
  Automation,
  ChatStreamEvent,
  Task,
} from '../src/shared/assistant'
import { DEFAULT_SEMANTIC_MODEL } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { AI_EMBEDDING_MODEL } from '../src/worker/mcp/ai-search'

/** The chat's own object store: bytes in, bytes out, keyed by the path the route chose. */
const chatR2 = {
  objects: new Map<string, Uint8Array>(),
  async put(key: string, value: Uint8Array | string) {
    this.objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value)
    return { key }
  },
  async get(key: string) {
    const bytes = this.objects.get(key)
    if (!bytes) return null
    return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  },
  async delete(key: string) {
    this.objects.delete(key)
  },
}

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: Record<string, unknown>
const turnTasks: Promise<unknown>[] = []
const ctx = { waitUntil: (task: Promise<unknown>) => { turnTasks.push(task) } } as ExecutionContext

/** Lets the streamed turn's background work land before the assertions read the database. */
async function settleTurns(): Promise<void> {
  await Promise.all(turnTasks.splice(0))
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

const openAiFrame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
/** A call the model asks for, then the answer that follows its result. */
const TOOL_CALL_FRAMES = [
  openAiFrame({ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_tasks', arguments: '{}' } }] } }] }),
  openAiFrame({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] }),
]
const FINAL_FRAMES = [
  openAiFrame({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'Nothing is on the list.' } }] }),
  openAiFrame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 6 } }),
]

/** A public OpenAI-compatible provider with one model, made active by the route itself. */
async function useExampleModel(): Promise<void> {
  await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
    label: 'Example',
    protocol: 'openai',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test-value-9876',
    models: ['example-model'],
  })
  const settings = await call<{ settings: AssistantSettings }>('GET', '/api/assistant/settings')
  expect(settings.settings.activeModelId).toBeTruthy()
}

function asUser(userId: string): void {
  app = buildApp(userId)
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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env as never, ctx)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text || '{}') as T
}

async function status(method: string, path: string, body?: unknown): Promise<number> {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env as never, ctx)
  await response.text()
  return response.status
}

/** Reads the SSE body of a chat turn into its events. */
async function chatEvents(body: Record<string, unknown>): Promise<ChatStreamEvent[]> {
  const response = await app.fetch(new Request('http://localhost/api/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env as never, ctx)
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.slice(5)) as ChatStreamEvent)
}

function insert<T extends { id: string }>(table: string, row: Record<string, unknown>): void {
  const columns = ['user_id', ...Object.keys(row)]
  const placeholders = columns.map(() => '?').join(', ')
  sqlite.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
    .run(USER, ...Object.values(row))
}

/**
 * The real vault, with a fake Durable Object state.
 *
 * A stub would only prove the route calls something; this proves the `ai:` scope the assistant added is
 * accepted by the vault's own allowlist, and that the bytes written to `chat_providers` are not the
 * key.
 */
const vaultStorage = new Map<string, unknown>()

function fakeVaultState() {
  return {
    storage: {
      async get(key: string) {
        return vaultStorage.get(key)
      },
      async put(key: string, value: unknown) {
        vaultStorage.set(key, value)
      },
    },
    // The DO harness serialises this on the state, not on storage; the vault's master key is read
    // through it, so a per-instance map would hand back a different key on every request.
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = {
    DB: makeD1(sqlite),
    DO_AUTH_KEY: 'test-internal-key',
    CREDENTIAL_VAULT: {
      idFromName: () => 'vault',
      // A DO stub is called as `fetch(url, init)` by the helper, exactly as the platform calls it.
      get: () => ({
        fetch: async (input: string | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init)
          return await new CredentialVault(fakeVaultState(), env as never).fetch(request)
        },
      }),
    },
    PUBLIC_URL: 'http://localhost',
    FILES: chatR2,
  }
  app = buildApp(USER)
})

describe('conversations', () => {
  it('creates, lists and renames one', async () => {
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Planning' })
    expect(created.conversation.title).toBe('Planning')
    const listed = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    expect(listed.conversations).toHaveLength(1)
    const renamed = await call<{ conversation: AssistantConversation }>('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { title: 'Renamed' })
    expect(renamed.conversation.title).toBe('Renamed')
  })

  it('refuses to delete another account\'s conversation', async () => {
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Mine' })
    asUser(OTHER)
    expect(await status('DELETE', `/api/assistant/conversations/${created.conversation.id}`)).toBe(404)
    asUser(USER)
    const listed = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    expect(listed.conversations).toHaveLength(1)
  })
})

describe('memories', () => {
  async function createMemory(content: string, category = 'fact'): Promise<AssistantMemory> {
    const result = await call<{ memory: AssistantMemory }>('POST', '/api/assistant/memories', { content, category })
    return result.memory
  }

  it('stores a stated date only when the text says one', async () => {
    const dated = await createMemory('Works as a designer since 2024-03')
    expect(dated.validFrom).toBe('2024-03')
    const plain = await createMemory('Prefers concise answers')
    expect(plain.validFrom).toBeNull()
  })

  it('refreshes an identical current memory instead of duplicating it', async () => {
    const first = await createMemory('Lives in Shanghai', 'fact')
    const again = await createMemory('lives in shanghai', 'fact')
    // The stored wording is the reader's own; a case-insensitive repeat only refreshes it.
    expect(again.id).toBe(first.id)
    const list = await call<{ memories: AssistantMemory[] }>('GET', '/api/assistant/memories')
    expect(list.memories).toHaveLength(1)
  })

  it('keeps the older version of a changed fact as history', async () => {
    const before = await createMemory('I live in Shanghai', 'fact')
    const after = await createMemory('I moved to Beijing, no longer live in Shanghai', 'fact')
    const list = await call<{ memories: AssistantMemory[] }>('GET', '/api/assistant/memories')
    const retired = list.memories.find((memory) => memory.id === before.id)
    expect(retired?.status).toBe('historical')
    expect(retired?.supersededBy).toBe(after.id)
  })

  it('leaves an ambiguous conflict for the reader to decide', async () => {
    await createMemory('I am married', 'fact')
    const created = await call<{ memory: AssistantMemory, reviews: number }>('POST', '/api/assistant/memories', {
      content: 'My partner and I are expecting a child',
      category: 'fact',
    })
    const reviews = await call<{ reviews: { id: string }[] }>('GET', '/api/assistant/memories/reviews')
    if (created.reviews > 0) {
      expect(reviews.reviews).toHaveLength(created.reviews)
      const resolved = await call<{ kept: number }>('POST', `/api/assistant/memories/reviews/${reviews.reviews[0]!.id}`, { action: 'keep_both' })
      expect(resolved.kept).toBe(2)
      const after = await call<{ reviews: unknown[] }>('GET', '/api/assistant/memories/reviews')
      expect(after.reviews).toHaveLength(0)
    }
  })

  it('corrects a fact and shows the chain', async () => {
    const before = await createMemory('Drives a Volkswagen', 'fact')
    const corrected = await call<{ memory: AssistantMemory }>('POST', `/api/assistant/memories/${before.id}/correct`, { content: 'Sold the Volkswagen, now rides a bicycle' })
    const history = await call<{ previous: AssistantMemory[] }>('GET', `/api/assistant/memories/${corrected.memory.id}/history`)
    expect(history.previous.map((entry) => entry.id)).toContain(before.id)
  })

  it('rejects an unknown category rather than storing it', async () => {
    expect(await status('POST', '/api/assistant/memories', { content: 'Something', category: 'vibes' })).toBe(400)
  })
})

describe('tasks', () => {
  it('reads a local due date in the reader timezone', async () => {
    await call('PATCH', '/api/assistant/settings', { timezone: 'Asia/Shanghai' })
    const created = await call<{ task: Task }>('POST', '/api/assistant/tasks', { title: 'File the return', dueAt: '2026-12-31T23:30' })
    // 23:30 in UTC+8 is 15:30 UTC the same day.
    expect(new Date(created.task.dueAt!).toISOString()).toBe('2026-12-31T15:30:00.000Z')
  })

  it('keeps a completed task out of the open list', async () => {
    const created = await call<{ task: Task }>('POST', '/api/assistant/tasks', { title: 'Call the plumber' })
    await call('PATCH', `/api/assistant/tasks/${created.task.id}`, { status: 'done' })
    const open = await call<{ tasks: Task[] }>('GET', '/api/assistant/tasks?status=open')
    expect(open.tasks.map((task) => task.id)).not.toContain(created.task.id)
    const done = await call<{ tasks: Task[] }>('GET', '/api/assistant/tasks?view=completed')
    expect(done.tasks.map((task) => task.id)).toContain(created.task.id)
  })

  it('refuses a project that does not exist', async () => {
    expect(await status('POST', '/api/assistant/tasks', { title: 'x', projectId: '0000000000abcdefghijklmnopqrzz' })).toBe(400)
  })
})

describe('automations', () => {
  it('computes the next run in the reader timezone and refuses a past time', async () => {
    await call('PATCH', '/api/assistant/settings', { timezone: 'Asia/Shanghai' })
    const created = await call<{ automation: Automation }>('POST', '/api/assistant/automations', {
      name: 'Stretch',
      kind: 'reminder',
      message: 'Stand up',
      schedule: { type: 'once', at: '2030-05-01T09:00' },
    })
    expect(new Date(created.automation.nextRun!).toISOString()).toBe('2030-05-01T01:00:00.000Z')
    expect(await status('POST', '/api/assistant/automations', {
      name: 'Old',
      kind: 'reminder',
      message: 'x',
      schedule: { type: 'once', at: '2000-01-01T09:00' },
    })).toBe(400)
  })

  it('pauses when disabled and schedules again when re-enabled', async () => {
    const created = await call<{ automation: Automation }>('POST', '/api/assistant/automations', {
      name: 'Daily',
      kind: 'task_digest',
      message: '',
      schedule: { type: 'daily', time: '09:00' },
    })
    const paused = await call<{ automation: Automation }>('PATCH', `/api/assistant/automations/${created.automation.id}`, { enabled: false })
    expect(paused.automation.status).toBe('paused')
    expect(paused.automation.nextRun).toBeNull()
    const resumed = await call<{ automation: Automation }>('PATCH', `/api/assistant/automations/${created.automation.id}`, { enabled: true })
    expect(resumed.automation.nextRun).not.toBeNull()
  })

  it('moves every schedule when the timezone changes', async () => {
    const created = await call<{ automation: Automation }>('POST', '/api/assistant/automations', {
      name: 'Digest',
      kind: 'task_digest',
      message: '',
      schedule: { type: 'daily', time: '09:00' },
    })
    const before = created.automation.nextRun!
    await call('PATCH', '/api/assistant/settings', { timezone: 'America/Los_Angeles' })
    const after = (await call<{ automations: Automation[] }>('GET', '/api/assistant/automations')).automations[0]!
    expect(after.nextRun).not.toBe(before)
    // The run still has to land at nine o'clock *in Los Angeles*, whatever that is in UTC.
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(after.nextRun!))
    expect(`${parts.find((part) => part.type === 'hour')!.value}:${parts.find((part) => part.type === 'minute')!.value}`).toBe('09:00')
    expect(after.nextRun!).toBeGreaterThan(Date.now())
  })

  it('refuses a schedule shape it does not understand', async () => {
    expect(await status('POST', '/api/assistant/automations', {
      name: 'Bad',
      kind: 'reminder',
      message: 'x',
      schedule: { type: 'weekly', days: [9], time: '09:00' },
    })).toBe(400)
  })
})

describe('notifications', () => {
  it('counts unread, marks one read and deletes it', async () => {
    insert('chat_notifications', { id: 'n1', title: 'Reminder', body: 'Water the plants', created_at: Date.now() })
    insert('chat_notifications', { id: 'n2', title: 'Reminder', body: 'Stretch', created_at: Date.now(), read_at: Date.now() })
    const listed = await call<{ notifications: { id: string }[], unread: number }>('GET', '/api/assistant/notifications')
    expect(listed.unread).toBe(1)
    await call('POST', '/api/assistant/notifications/read', { id: 'n1' })
    const after = await call<{ unread: number }>('GET', '/api/assistant/notifications')
    expect(after.unread).toBe(0)
  })
})

describe('settings', () => {
  it('clamps a limit that is out of range instead of storing it', async () => {
    const result = await call<{ settings: AssistantSettings }>('PATCH', '/api/assistant/settings', {
      limits: { maxOutputTokens: 999_999, maxToolCalls: -4 },
    })
    expect(result.settings.limits.maxOutputTokens).toBe(8192)
    expect(result.settings.limits.maxToolCalls).toBe(0)
  })

  it('round-trips every settings field the client can patch', async () => {
    const before = await call<{ settings: AssistantSettings }>('GET', '/api/assistant/settings')
    const flipped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(before.settings)) {
      if (typeof value === 'boolean') flipped[key] = !value
    }
    expect(Object.keys(flipped).length).toBeGreaterThanOrEqual(6)
    const patched = await call<{ settings: AssistantSettings }>('PATCH', '/api/assistant/settings', flipped)
    for (const key of Object.keys(flipped)) {
      expect((patched.settings as unknown as Record<string, unknown>)[key], `${key} was dropped by the patch route`).toBe(flipped[key])
    }
    // Limits and the model id travel through the same route.
    const limits = await call<{ settings: AssistantSettings }>('PATCH', '/api/assistant/settings', {
      limits: { ...before.settings.limits, maxEmbeddingsPerDay: 7 },
      activeModelId: null,
      semanticMemory: true,
    })
    expect(limits.settings.limits.maxEmbeddingsPerDay).toBe(7)
    expect(limits.settings.activeModelId).toBeNull()
    expect(limits.settings.semanticMemory).toBe(true)
    await call('PATCH', '/api/assistant/settings', before.settings)
  })

  it('drops an unknown timezone rather than breaking every date', async () => {
    const result = await call<{ settings: AssistantSettings }>('PATCH', '/api/assistant/settings', { timezone: 'Mars/Olympus' })
    expect(result.settings.timezone).toBe('UTC')
  })
})

describe('providers', () => {
  it('never returns the stored key', async () => {
    const created = await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
      label: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret-value-123456',
      models: ['deepseek-chat'],
    })
    expect(created.provider.hasKey).toBe(true)
    const listed = await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')
    expect(JSON.stringify(listed)).not.toContain('sk-secret-value')
    const raw = sqlite.prepare('SELECT key_ciphertext FROM chat_providers').get() as { key_ciphertext: string }
    expect(raw.key_ciphertext).not.toContain('sk-secret-value')
    expect(created.provider.baseUrl).toBe('https://api.deepseek.com')
  })

  it('refuses a private provider address', async () => {
    expect(await status('POST', '/api/assistant/providers', {
      label: 'LAN',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
    })).toBe(400)
    expect(await status('POST', '/api/assistant/providers', {
      label: 'Meta',
      protocol: 'openai',
      baseUrl: 'http://169.254.169.254/latest',
    })).toBe(400)
  })

  it('picks the first model as active and clears it when the provider goes', async () => {
    const created = await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
      label: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat'],
    })
    const settings = await call<{ settings: AssistantSettings }>('GET', '/api/assistant/settings')
    expect(settings.settings.activeModelId).toBeTruthy()
    await call('DELETE', `/api/assistant/providers/${created.provider.id}`)
    const after = await call<{ settings: AssistantSettings }>('GET', '/api/assistant/settings')
    expect(after.settings.activeModelId).toBeNull()
  })
})

describe('offline chat', () => {
  it('streams the same events and persists both messages', async () => {
    await call('PATCH', '/api/assistant/settings', { offlineMode: true })
    const events = await chatEvents({ message: 'Remind me to stretch' })
    const types = events.map((event) => event.type)
    expect(types).toContain('start')
    expect(types).toContain('text')
    expect(types).toContain('done')
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ conversation: AssistantConversation, messages: { role: string }[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(detail.conversation.title).toBe('Remind me to stretch')
  })

  it('refuses a second turn while one holds the conversation', async () => {
    await call('PATCH', '/api/assistant/settings', { offlineMode: true })
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Busy' })
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env as never)
    expect(await store.claimRun(created.conversation.id)).toBe(true)
    expect(await status('POST', '/api/assistant/chat', { conversationId: created.conversation.id, message: 'hello' })).toBe(409)
    await store.releaseRun(created.conversation.id)
    expect(await status('POST', '/api/assistant/chat', { conversationId: created.conversation.id, message: 'hello' })).toBe(200)
  })
})

describe('lease and streaming turn', () => {
  it('releases the offline conversation it created', async () => {
    await call('PATCH', '/api/assistant/settings', { offlineMode: true })
    const events = await chatEvents({ message: 'hello there' })
    await settleTurns()
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ streaming: boolean }>('GET', `/api/assistant/conversations/${conversationId}`)
    // A claim nobody released would keep the conversation locked for the length of the lease.
    expect(detail.streaming).toBe(false)
  })

  it('claims a brand-new conversation and renews the lease on every step', async () => {
    await useExampleModel()
    const observed: { url: string, leaseUntil: number }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const rows = sqlite.prepare('SELECT lease_until FROM chat_active_runs').all() as { lease_until: number }[]
      observed.push({ url: String(input), leaseUntil: rows[0]?.lease_until ?? 0 })
      if (observed.length === 1) {
        // Age the lease the way a long turn does, so the second step has to renew it to be seen.
        sqlite.prepare('UPDATE chat_active_runs SET lease_until = ?').run(1)
        return new Response(sse(TOOL_CALL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events = await chatEvents({ message: 'what is on my list?' })
    await settleTurns()
    vi.unstubAllGlobals()

    expect(observed.map((entry) => entry.url)).toEqual([
      'https://api.example.com/v1/chat/completions',
      'https://api.example.com/v1/chat/completions',
    ])
    expect(observed[0]!.leaseUntil).toBeGreaterThan(Date.now())
    expect(observed[1]!.leaseUntil).toBeGreaterThan(1)

    const chips = events.filter((event) => event.type === 'tool') as { tool: { name: string, status: string } }[]
    expect(chips.map((event) => event.tool.status)).toContain('success')
    expect(chips[0]!.tool.name).toBe('list_tasks')
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.some((event) => event.type === 'usage')).toBe(true)

    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: { role: string, content: string, status: string }[], streaming: boolean }>(
      'GET', `/api/assistant/conversations/${conversationId}`,
    )
    expect(detail.streaming).toBe(false)
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(detail.messages[1]!.content).toContain('Nothing is on the list.')
    expect(detail.messages[1]!.status).toBe('complete')

    const usage = await call<{ today: Record<string, number> }>('GET', '/api/assistant/usage')
    // The meter is written with the answer's own column names; a mismatch there fails the statement
    // and the turn is filed as an error even though the reply arrived whole.
    expect(usage.today.requests).toBe(2)
    expect(usage.today.inputTokens).toBe(20)
    expect(usage.today.outputTokens).toBe(6)
    expect(usage.today.toolCalls).toBe(1)
  })

})

const oid = (seed: string) => `${seed}${'0'.repeat(26)}`.slice(0, 26)
const FOLDER_A = oid('fa1')
const FOLDER_B = oid('fb1')
const FOLDER_OTHER = oid('fc1')
const TAG_RED = oid('ta1')
const TAG_BLUE = oid('tb1')

function addFolder(id: string, name: string, parentId: string | null = null, userId = USER): void {
  const at = Date.now()
  const columns = ['id', 'user_id', 'parent_id', 'name', 'position', 'created_at', 'updated_at']
  sqlite.prepare(`INSERT INTO folders (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(id, userId, parentId, name, 1, at, at)
}

function addTag(id: string, name: string, userId = USER): void {
  sqlite.prepare('INSERT INTO tags (id, user_id, name, is_manual, is_pinned, created_at) VALUES (?, ?, ?, 1, 0, ?)')
    .run(id, userId, name, Date.now())
}

/** A stand-in for the Workers AI binding: deterministic, cheap, and shaped like the real answer. */
function stubAi(model: string) {
  const calls: string[][] = []
  return {
    calls,
    run: async (requested: string, input: { text: string[] }) => {
      expect(requested).toBe(model)
      calls.push(input.text)
      return {
        data: input.text.map((line) => ({
          embedding: Array.from({ length: 8 }, (_, index) => {
            let hash = index + 1
            for (const character of line) hash = (hash * 31 + character.codePointAt(0)!) % 1024
            return hash / 1024
          }),
        })),
      }
    },
  }
}

describe('semantic memory recall', () => {
  it('embeds a memory as it is saved and reports it', async () => {
    const ai = stubAi(AI_EMBEDDING_MODEL)
    env.AI = ai
    try {
      await call('POST', '/api/assistant/memories', { content: '读者喜欢喝手冲咖啡', category: 'preference' })
      const status = await call<{ vectors: number, pending: number, today: number, available: boolean }>('GET', '/api/assistant/semantic')
      expect(status.available).toBe(true)
      expect(status.vectors).toBe(1)
      expect(status.pending).toBe(0)
      expect(status.today).toBe(1)
      expect(ai.calls.length).toBe(1)
    } finally {
      delete env.AI
    }
  })

  it('stops at the reader’s daily embedding cap and reindexing finishes the job', async () => {
    const ai = stubAi(AI_EMBEDDING_MODEL)
    env.AI = ai
    try {
      await call('PATCH', '/api/assistant/settings', { limits: { maxEmbeddingsPerDay: 1 } })
      await call('POST', '/api/assistant/memories', { content: '第一条事实', category: 'fact' })
      await call('POST', '/api/assistant/memories', { content: '第二条事实', category: 'fact' })
      let status = await call<{ vectors: number, pending: number }>('GET', '/api/assistant/semantic')
      expect(status.vectors).toBe(1)
      expect(status.pending).toBe(1)
      const reindexed = await call<{ embedded: number, capped: boolean }>('POST', '/api/assistant/semantic/reindex')
      expect(reindexed).toEqual({ embedded: 0, capped: true })
      await call('PATCH', '/api/assistant/settings', { limits: { maxEmbeddingsPerDay: 50 } })
      const second = await call<{ embedded: number, capped: boolean }>('POST', '/api/assistant/semantic/reindex')
      expect(second.embedded).toBe(1)
      status = await call<{ vectors: number, pending: number }>('GET', '/api/assistant/semantic')
      expect(status.vectors).toBe(2)
      expect(status.pending).toBe(0)
    } finally {
      delete env.AI
    }
  })

  it('deletes the vectors without touching the memories', async () => {
    env.AI = stubAi(AI_EMBEDDING_MODEL)
    try {
      await call('POST', '/api/assistant/memories', { content: '读者住在杭州', category: 'place' })
      expect((await call<{ vectors: number }>('GET', '/api/assistant/semantic')).vectors).toBe(1)
      expect((await call<{ deleted: number }>('DELETE', '/api/assistant/semantic')).deleted).toBe(1)
      const memories = await call<{ memories: AssistantMemory[] }>('GET', '/api/assistant/memories')
      expect(memories.memories).toHaveLength(1)
      const status = await call<{ vectors: number, pending: number }>('GET', '/api/assistant/semantic')
      expect(status.vectors).toBe(0)
      expect(status.pending).toBe(1)
    } finally {
      delete env.AI
    }
  })

  it('embeds with the model the reader chose and rebuilds when it changes', async () => {
    const ALT_MODEL = '@cf/baai/bge-small-en-v1.5'
    env.AI = stubAi(AI_EMBEDDING_MODEL)
    try {
      await call('POST', '/api/assistant/memories', { content: '读者喜欢喝绿茶' })
      expect((await call<{ vectors: number }>('GET', '/api/assistant/semantic')).vectors).toBe(1)
    } finally {
      delete env.AI
    }
    const other = stubAi(ALT_MODEL)
    env.AI = other
    try {
      await call('PATCH', '/api/assistant/settings', { semanticModel: ALT_MODEL })
      await settleTurns()
      const status = await call<{ vectors: number, pending: number, model: string }>('GET', '/api/assistant/semantic')
      expect(status.model).toBe(ALT_MODEL)
      // The old encoder's vectors are gone and the background rebuild replaced them with new ones.
      expect(status.vectors).toBe(1)
      expect(status.pending).toBe(0)
      expect(other.calls).toHaveLength(1)
    } finally {
      delete env.AI
    }
  })

  it('drops the old encoder’s vectors even when no rebuild can run', async () => {
    env.AI = stubAi(AI_EMBEDDING_MODEL)
    try {
      await call('POST', '/api/assistant/memories', { content: '读者喜欢喝美式' })
      expect((await call<{ vectors: number }>('GET', '/api/assistant/semantic')).vectors).toBe(1)
    } finally {
      delete env.AI
    }
    // With no AI binding the rebuild is skipped, so the only thing standing between the reader and a
    // count of vectors nothing can score is the clear that comes with the model change.
    await call('PATCH', '/api/assistant/settings', { semanticModel: '@cf/baai/bge-small-en-v1.5' })
    const status = await call<{ vectors: number, pending: number }>('GET', '/api/assistant/semantic')
    expect(status.vectors).toBe(0)
    expect(status.pending).toBe(1)
  })

  it('refuses a model id that is not a Workers AI model', async () => {
    const saved = await call<{ settings: AssistantSettings }>('PATCH', '/api/assistant/settings', { semanticModel: '../../../../etc/passwd' })
    expect(saved.settings.semanticModel).toBe(DEFAULT_SEMANTIC_MODEL)
    const again = await call<{ settings: AssistantSettings }>('PATCH', '/api/assistant/settings', { semanticModel: 'gpt-4' })
    expect(again.settings.semanticModel).toBe(DEFAULT_SEMANTIC_MODEL)
  })

  it('embeds the question during a turn, not only the memory write', async () => {
    await useExampleModel()
    const ai = stubAi(AI_EMBEDDING_MODEL)
    env.AI = ai
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    try {
      await call('POST', '/api/assistant/memories', { content: '读者喜欢喝手冲咖啡' })
      const before = ai.calls.length
      const events = await chatEvents({ message: '我平时喝什么咖啡？' })
      await settleTurns()
      expect(events.some((event) => event.type === 'done')).toBe(true)
      // The write embedded the memory; the turn has to embed the question or the vector list is empty
      // and the reader's semantic recall is a switch that does nothing.
      expect(ai.calls.length, 'the turn never embedded the query').toBeGreaterThan(before)
      expect(ai.calls.at(-1)).toEqual(['我平时喝什么咖啡？'])
    } finally {
      vi.unstubAllGlobals()
      delete env.AI
    }
  })

  it('forgets the vector along with the memory', async () => {
    env.AI = stubAi(AI_EMBEDDING_MODEL)
    try {
      const created = await call<{ memory: AssistantMemory }>('POST', '/api/assistant/memories', { content: '读者搬去了成都' })
      expect((await call<{ vectors: number }>('GET', '/api/assistant/semantic')).vectors).toBe(1)
      await call('DELETE', `/api/assistant/memories/${created.memory.id}`)
      const status = await call<{ vectors: number, pending: number }>('GET', '/api/assistant/semantic')
      expect(status).toMatchObject({ vectors: 0, pending: 0 })
    } finally {
      delete env.AI
    }
  })

  it('saves memories normally when the deployment has no AI binding', async () => {
    expect(env.AI).toBeUndefined()
    const created = await call<{ memory: AssistantMemory }>('POST', '/api/assistant/memories', { content: '读者养了一只猫', category: 'fact' })
    expect(created.memory.content).toContain('猫')
    const status = await call<{ available: boolean, vectors: number }>('GET', '/api/assistant/semantic')
    expect(status.available).toBe(false)
    expect(status.vectors).toBe(0)
  })
})

describe('filing conversations', () => {
  it('moves a conversation into a note folder and back out', async () => {
    addFolder(FOLDER_A, '项目')
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Kickoff' })
    expect(created.conversation.folderId).toBeNull()

    const moved = await call<{ conversation: AssistantConversation }>('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { folderId: FOLDER_A })
    expect(moved.conversation.folderId).toBe(FOLDER_A)

    const inFolder = await call<{ conversations: AssistantConversation[] }>('GET', `/api/assistant/conversations?folder=${FOLDER_A}`)
    expect(inFolder.conversations.map((entry) => entry.id)).toEqual([created.conversation.id])
    // Both read paths spell the columns out by hand, so the list has to carry the folder too.
    expect(inFolder.conversations[0]!.folderId).toBe(FOLDER_A)
    const unfiled = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?folder=none')
    expect(unfiled.conversations.map((entry) => entry.id)).not.toContain(created.conversation.id)

    const summary = await call<{ folders: { id: string, name: string, count: number }[], unfiled: number }>('GET', '/api/assistant/folders')
    expect(summary.folders.find((folder) => folder.id === FOLDER_A)?.count).toBe(1)
    expect(summary.unfiled).toBe(unfiled.conversations.length)

    await call('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { folderId: null })
    const after = await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${created.conversation.id}`)
    expect(after.conversation.folderId).toBeNull()
  })

  it('shows a parent folder what its subfolders hold', async () => {
    addFolder(FOLDER_A, '项目')
    addFolder(FOLDER_B, '子任务', FOLDER_A)
    const deep = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Deep', folderId: FOLDER_B })
    const parent = await call<{ conversations: AssistantConversation[] }>('GET', `/api/assistant/conversations?folder=${FOLDER_A}`)
    expect(parent.conversations.map((entry) => entry.id)).toEqual([deep.conversation.id])
    // The folder count stays per-folder, so the tree can show where things actually sit.
    const summary = await call<{ folders: { id: string, count: number }[] }>('GET', '/api/assistant/folders')
    expect(summary.folders.find((folder) => folder.id === FOLDER_A)?.count).toBe(0)
    expect(summary.folders.find((folder) => folder.id === FOLDER_B)?.count).toBe(1)
  })

  it('refuses a folder belonging to someone else', async () => {
    addFolder(FOLDER_OTHER, 'Neighbour', null, OTHER)
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Mine' })
    expect(await status('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { folderId: FOLDER_OTHER })).toBe(400)
    expect(await status('POST', '/api/assistant/conversations', { title: 'X', folderId: FOLDER_OTHER })).toBe(400)
  })

  it('labels conversations with the notebook tags and counts them', async () => {
    addTag(TAG_RED, 'urgent')
    addTag(TAG_BLUE, 'someday')
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Triage' })
    const id = created.conversation.id
    expect(await status('POST', `/api/assistant/conversations/${id}/tags`, { tagId: 'nope' })).toBe(404)
    await call('POST', `/api/assistant/conversations/${id}/tags`, { tagId: TAG_RED })
    await call('POST', `/api/assistant/conversations/${id}/tags`, { tagId: TAG_BLUE })
    // Twice is a no-op, not a duplicate row.
    await call('POST', `/api/assistant/conversations/${id}/tags`, { tagId: TAG_RED })

    const list = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    const row = list.conversations.find((entry) => entry.id === id)
    expect(row?.tags?.map((tag) => tag.name).sort()).toEqual(['someday', 'urgent'])
    const filtered = await call<{ conversations: AssistantConversation[] }>('GET', `/api/assistant/conversations?tag=${TAG_RED}`)
    expect(filtered.conversations.map((entry) => entry.id)).toEqual([id])
    const tags = await call<{ tags: { id: string, name: string, count: number }[] }>('GET', '/api/assistant/tags')
    expect(tags.tags.find((tag) => tag.id === TAG_RED)?.count).toBe(1)
    expect(tags.tags.find((tag) => tag.id === TAG_BLUE)?.count).toBe(1)

    await call('DELETE', `/api/assistant/conversations/${id}/tags/${TAG_BLUE}`)
    const after = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    expect(after.conversations.find((entry) => entry.id === id)?.tags?.map((tag) => tag.name)).toEqual(['urgent'])

    await call('DELETE', `/api/assistant/conversations/${id}`)
    const left = sqlite.prepare('SELECT count(*) AS n FROM chat_conversation_tags').get() as { n: number }
    expect(left.n).toBe(0)
  })

  it('carries the folder and the tags through a backup round-trip', async () => {
    addFolder(FOLDER_A, '项目')
    addTag(TAG_RED, 'urgent')
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Filed', folderId: FOLDER_A })
    const id = created.conversation.id
    await call('POST', `/api/assistant/conversations/${id}/tags`, { tagId: TAG_RED })
    const payload = await call('GET', '/api/assistant/export') as Record<string, unknown>
    expect(JSON.stringify(payload)).toContain(TAG_RED)

    await call('DELETE', `/api/assistant/conversations/${id}`)
    expect((await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')).conversations).toHaveLength(0)
    await call('POST', '/api/assistant/import', payload)
    const restored = (await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')).conversations.find((entry) => entry.id === id)
    expect(restored?.folderId).toBe(FOLDER_A)
    expect(restored?.tags?.map((tag) => tag.name)).toEqual(['urgent'])
  })

  it('drops a folder or tag the reader no longer has instead of dangling it', async () => {
    addFolder(FOLDER_A, '项目')
    addTag(TAG_RED, 'urgent')
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Elsewhere', folderId: FOLDER_A })
    await call('POST', `/api/assistant/conversations/${created.conversation.id}/tags`, { tagId: TAG_RED })
    const payload = await call('GET', '/api/assistant/export') as Record<string, unknown>

    // The other account has neither the folder nor the tag.
    asUser(OTHER)
    await call('POST', '/api/assistant/import', payload)
    const list = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    const moved = list.conversations.find((entry) => entry.title === 'Elsewhere')
    expect(moved).toBeTruthy()
    expect(moved!.folderId).toBeNull()
    expect(moved!.tags ?? []).toHaveLength(0)
    asUser(USER)
  })

  it('keeps one account tags out of another', async () => {
    addTag(TAG_RED, 'shared-name')
    addTag(TAG_BLUE, 'theirs', OTHER)
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Ours' })
    expect(await status('POST', `/api/assistant/conversations/${created.conversation.id}/tags`, { tagId: TAG_BLUE })).toBe(400)
    asUser(OTHER)
    expect(await status('POST', `/api/assistant/conversations/${created.conversation.id}/tags`, { tagId: TAG_BLUE })).toBe(404)
    asUser(USER)
  })
})

describe('starring and pinning', () => {
  it('keeps the two flags apart on both read paths', async () => {
    const one = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Starred only' })
    const two = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Both' })
    const idOne = one.conversation.id
    const idTwo = two.conversation.id
    expect(one.conversation.starred, 'a new conversation starts unstarred').toBe(false)

    await call('PATCH', `/api/assistant/conversations/${idOne}`, { starred: true })
    await call('PATCH', `/api/assistant/conversations/${idTwo}`, { starred: true, pinned: true })

    const starred = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?starred=1')
    expect(starred.conversations.map((entry) => entry.id).sort()).toEqual([idOne, idTwo].sort())
    const pinned = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?pinned=1')
    expect(pinned.conversations.map((entry) => entry.id)).toEqual([idTwo])
    // The list and the thread each spell out their own column list, so both have to carry the flag.
    const thread = await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${idOne}`)
    expect(thread.conversation.starred).toBe(true)
    expect(thread.conversation.pinned).toBe(false)

    await call('PATCH', `/api/assistant/conversations/${idOne}`, { starred: false })
    const after = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?starred=1')
    expect(after.conversations.map((entry) => entry.id)).toEqual([idTwo])
  })

  it('carries the flag through a backup round-trip', async () => {
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Kept' })
    const id = created.conversation.id
    await call('PATCH', `/api/assistant/conversations/${id}`, { starred: true })
    const payload = await call('GET', '/api/assistant/export') as Record<string, unknown>
    await call('DELETE', `/api/assistant/conversations/${id}`)
    await call('POST', '/api/assistant/import', payload)
    const restored = (await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')).conversations.find((entry) => entry.id === id)
    // The import rebuilds each row field by field, so a column it does not name is written as NULL —
    // and a NOT NULL column makes the whole row disappear under INSERT OR IGNORE.
    expect(restored?.starred).toBe(true)
  })

  it('leaves the flag of another account alone', async () => {
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Mine' })
    asUser(OTHER)
    expect(await status('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { starred: true })).toBe(404)
    asUser(USER)
    const row = sqlite.prepare('SELECT starred FROM chat_conversations WHERE id = ?').get(created.conversation.id) as { starred: number }
    expect(row.starred).toBe(0)
  })
})

describe('search', () => {
  it('finds conversations by title and by message body', async () => {
    const tea = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: '喝茶习惯' })
    const events = await chatEvents({ conversationId: tea.conversation.id, message: '我平时喜欢喝绿茶' })
    expect(events.some((event) => event.type === 'done' || event.type === 'error')).toBe(true)
    const coffee = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Coffee chat' })

    const byTitle = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?q=喝茶')
    expect(byTitle.conversations.map((entry) => entry.id)).toEqual([tea.conversation.id])
    const byBody = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?q=绿茶')
    expect(byBody.conversations.map((entry) => entry.id)).toEqual([tea.conversation.id])
    const byLatin = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?q=coffee')
    expect(byLatin.conversations.map((entry) => entry.id)).toEqual([coffee.conversation.id])
    // LIKE metacharacters are data, not a pattern: they must match nothing rather than throw.
    const none = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?q=%25zz')
    expect(none.conversations).toEqual([])
  })

  it('searches memories and tasks without qualifying an aliased table', async () => {
    await call('POST', '/api/assistant/memories', { content: '读者住在上海', category: 'place' })
    await call('POST', '/api/assistant/tasks', { title: '给妈妈打电话' })
    const memories = await call<{ memories: AssistantMemory[] }>('GET', '/api/assistant/memories?q=上海')
    expect(memories.memories).toHaveLength(1)
    const tasks = await call<{ tasks: Task[] }>('GET', '/api/assistant/tasks?q=妈妈')
    expect(tasks.tasks).toHaveLength(1)
    expect(await status('GET', '/api/assistant/memories?q=%25')).toBe(200)
    expect(await status('GET', '/api/assistant/tasks?q=_')).toBe(200)
  })
})

describe('backup', () => {
  it('exports and re-imports without inventing a provider', async () => {
    await call('POST', '/api/assistant/memories', { content: 'Prefers morning meetings', category: 'preference' })
    await call('POST', '/api/assistant/tasks', { title: 'Review the draft' })
    const payload = await call('GET', '/api/assistant/export') as Record<string, unknown>
    const text = JSON.stringify(payload)
    expect(text).toContain('Prefers morning meetings')
    asUser(OTHER)
    const result = await call<{ imported: { memories: number, tasks: number } }>('POST', '/api/assistant/import', payload)
    expect(result.imported.memories).toBe(1)
    expect(result.imported.tasks).toBe(1)
    const providers = await call<{ providers: unknown[] }>('GET', '/api/assistant/providers')
    expect(providers.providers).toHaveLength(0)
    const memories = await call<{ memories: AssistantMemory[] }>('GET', '/api/assistant/memories')
    expect(memories.memories[0]!.source).toBe('import')
    asUser(USER)
    const mine = await call<{ memories: AssistantMemory[] }>('GET', '/api/assistant/memories')
    expect(mine.memories).toHaveLength(1)
  })

  it('imports a new automation paused', async () => {
    const created = await call<{ automation: Automation }>('POST', '/api/assistant/automations', {
      name: 'Weekly review',
      kind: 'task_digest',
      message: '',
      schedule: { type: 'weekly', days: [5], time: '17:00' },
    })
    const payload = await call('GET', '/api/assistant/export') as Record<string, unknown>
    asUser(OTHER)
    const result = await call<{ imported: { automations: number } }>('POST', '/api/assistant/import', payload)
    expect(result.imported.automations).toBe(1)
    const list = await call<{ automations: Automation[] }>('GET', '/api/assistant/automations')
    expect(list.automations[0]!.enabled).toBe(false)
    expect(list.automations[0]!.id).toBe(created.automation.id)
  })

  it('refuses a file from another app', async () => {
    expect(await status('POST', '/api/assistant/import', { format: 'not-inkstone', version: 1, data: {} })).toBe(400)
  })
})

async function uploadFile(name: string, content: string | Uint8Array, mime: string): Promise<{ attachment: { id: string, kind: string, key: string, filename: string, size: number } }> {
  const form = new FormData()
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  form.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), name)
  const response = await app.fetch(new Request('http://localhost/api/assistant/files', { method: 'POST', body: form }), env as never, ctx)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text) as { attachment: { id: string, kind: string, key: string, filename: string, size: number } }
}

describe('chat attachments', () => {
  it('stores a text file under the chat prefix and reads it back', async () => {
    const uploaded = await uploadFile('notes.md', '# 标题\n读者提到的重点', 'text/markdown')
    expect(uploaded.attachment.kind).toBe('file')
    expect(uploaded.attachment.key).toMatch(/^chat\/files\/0123456789abcdefghjkmnpqrs\/[0-9a-z]+\.md$/)
    expect(chatR2.objects.has(uploaded.attachment.key)).toBe(true)
    const served = await app.fetch(
      new Request(`http://localhost/api/assistant/files/${uploaded.attachment.id}`),
      env as never, ctx,
    )
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('text/markdown')
    expect(await served.text()).toContain('读者提到的重点')

    const removed = await call<{ deleted: boolean }>('DELETE', `/api/assistant/files/${uploaded.attachment.id}`)
    expect(removed.deleted).toBe(true)
    expect(chatR2.objects.has(uploaded.attachment.key)).toBe(false)
  })

  it('puts an image under chat/images and a document under chat/files', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
    const image = await uploadFile('shot.png', png, 'image/png')
    expect(image.attachment.kind).toBe('image')
    expect(image.attachment.key.startsWith('chat/images/')).toBe(true)
    const csv = await uploadFile('data.csv', 'a,b\n1,2', 'text/csv')
    expect(csv.attachment.key.startsWith('chat/files/')).toBe(true)
    expect(csv.attachment.key).toMatch(/\.csv$/)
  })

  it('refuses an empty file and never leaves the object behind', async () => {
    const before = chatR2.objects.size
    let failure = ''
    try {
      await uploadFile('empty.txt', '', 'text/plain')
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    expect(failure).toContain('empty')
    // The store is shared across the file, so the claim is that nothing was added, not that it is empty.
    expect(chatR2.objects.size).toBe(before)
  })

  it('feeds an attached file to the model and keeps it on the next turn', async () => {
    await useExampleModel()
    const uploaded = await uploadFile('购物清单.txt', '买咖啡豆和燕麦奶', 'text/plain')
    const events = await chatEvents({ message: '我附的文件里要买什么？', attachments: [uploaded.attachment.id] })
    await settleTurns()
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    const userTurn = detail.messages.find((entry) => entry.role === 'user')!
    expect(userTurn.attachments).toEqual([uploaded.attachment.id])
    // The stored row is what the reader typed; the file joins the model's view, not the transcript.
    expect(userTurn.content).toBe('我附的文件里要买什么？')
    // The body the model is fed carries the file, so a second turn can still be told what it said.
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    await chatEvents({ conversationId, message: '再说一遍清单里的东西' })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(bodies.some((body) => body.includes('买咖啡豆和燕麦奶'))).toBe(true)
  })

  it('sends a picture as an image part when the model can see', async () => {
    await useExampleModel()
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
    const uploaded = await uploadFile('photo.png', png, 'image/png')
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events = await chatEvents({ message: '这张图里是什么？', attachments: [uploaded.attachment.id] })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(events.some((event) => event.type === 'done')).toBe(true)
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies[0]).toContain('"type":"image_url"')
    expect(bodies[0]).toContain('data:image/png;base64,')
  })

  it('names the picture instead of sending it when the model cannot see', async () => {
    await useExampleModel()
    const models = await call<{ models: { id: string }[] }>('GET', '/api/assistant/models')
    await call('PATCH', `/api/assistant/models/${models.models[0]!.id}`, { vision: false })
    const uploaded = await uploadFile('photo.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png')
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    await chatEvents({ message: '这张图里是什么？', attachments: [uploaded.attachment.id] })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(bodies[0]).not.toContain('image_url')
    expect(bodies[0]).toContain('this model is not marked as able to')
  })

  it('drops an id that is not a real attachment before it reaches the model', async () => {
    await useExampleModel()
    const events = await chatEvents({ message: '附件呢？', attachments: ['nope', '../etc/passwd', '0123456789abcdefghjkmnpqrs'] })
    await settleTurns()
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    // A shape that is not an id never becomes a row, and neither does an id the reader does not own.
    expect(detail.messages.find((entry) => entry.role === 'user')?.attachments ?? []).toEqual([])
  })

  it('carries the attachment ids through a backup round-trip', async () => {
    const uploaded = await uploadFile('keep.txt', '要留在备份里', 'text/plain')
    await useExampleModel()
    const events = await chatEvents({ message: '记住这个附件', attachments: [uploaded.attachment.id] })
    await settleTurns()
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const payload = await call('GET', '/api/assistant/export') as Record<string, unknown>
    expect(JSON.stringify(payload)).toContain(uploaded.attachment.id)
    await call('DELETE', `/api/assistant/conversations/${conversationId}`)
    await call('POST', '/api/assistant/import', payload)
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    const restored = detail.messages.find((entry) => entry.role === 'user')
    // The import rebuilds each row field by field, so a column it does not name is written as NULL and
    // the NOT NULL column makes the whole message disappear under INSERT OR IGNORE.
    expect(restored?.attachments).toEqual([uploaded.attachment.id])
  })

  it('ignores an attachment id that is not the reader’s own', async () => {
    const uploaded = await uploadFile('mine.txt', 'private', 'text/plain')
    asUser(OTHER)
    const listed = await call<{ files: { id: string }[] }>('GET', '/api/assistant/files')
    expect(listed.files.map((entry) => entry.id)).not.toContain(uploaded.attachment.id)
    expect(await status('GET', `/api/assistant/files/${uploaded.attachment.id}`)).toBe(404)
    expect(await status('DELETE', `/api/assistant/files/${uploaded.attachment.id}`)).toBe(200)
    asUser(USER)
    // The other account's row is untouched, and so is its object.
    expect(chatR2.objects.has(uploaded.attachment.key)).toBe(true)
  })
})
