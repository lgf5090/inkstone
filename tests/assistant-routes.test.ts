// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { shareRoutes } from '../src/worker/routes/share'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import type { AppBindings, Env } from '../src/worker/env'
import type {
  AssistantAnswerVersion,
  AssistantArtifact,
  AssistantArtifactVersion,
  AssistantConversation,
  AssistantMessage,
  AssistantMemory,
  AssistantMcpServer,
  AssistantMcpTool,
  AssistantModel,
  AssistantProvider,
  AssistantSettings,
  AssistantSkill,
  Automation,
  ChatStreamEvent,
  Project,
  Task,
} from '../src/shared/assistant'
import { DEFAULT_SEMANTIC_MODEL, MAX_ANSWER_VERSIONS, MAX_ARTIFACTS_PER_CONVERSATION, MAX_ARTIFACT_VERSIONS, MAX_MCP_TIMEOUT_SECONDS, MAX_SKILL_CONTENT_CHARS, MAX_SKILL_ICON_CHARS, MAX_SKILL_TITLE_CHARS, MAX_REASONING_CHARS, MAX_TOKEN_CEILING, MAX_TURN_SCOPES, MAX_TURN_TOOLS, ASSISTANT_TOOL_BY_NAME } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { toBase64 } from '../src/worker/lib/encoding'
import { purgeExpiredEphemeralConversations } from '../src/worker/assistant/store'
import { isModelBestEndpoint, modelBestSocketUrl } from '../src/worker/assistant/realtime'
import { testBindings, testDurableObjectNamespace, testR2Bucket } from './doubles/bindings'
import { AI_EMBEDDING_MODEL } from '../src/worker/mcp/ai-search'

/** The chat's own object store: bytes in, bytes out, keyed by the path the route chose. */
const chatR2 = testR2Bucket()

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: Env
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
  // The public half of the app is mounted here too: a published conversation is read by somebody with
  // no account, so the two halves are one subject from the reader's side.
  instance.route('/api/public', shareRoutes)
  return instance
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text || '{}') as T
}

async function status(method: string, path: string, body?: unknown): Promise<number> {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx)
  await response.text()
  return response.status
}

/** Reads the SSE body of a chat turn into its events. */
async function chatEvents(body: Record<string, unknown>): Promise<ChatStreamEvent[]> {
  const response = await app.fetch(new Request('http://localhost/api/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env, ctx)
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.slice(5)) as ChatStreamEvent)
}

// `node:sqlite` refuses anything outside its own input types, so a fixture row that carried a boolean
// or a nested object fails here rather than at the driver.
function insert<T extends { id: string }>(table: string, row: Record<string, SQLInputValue>): void {
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
  env = testBindings(makeD1(sqlite), {
    DO_AUTH_KEY: 'test-internal-key',
    // The real vault, called the way the platform calls it: `idFromName`, then `get(id).fetch(url, init)`.
    CREDENTIAL_VAULT: testDurableObjectNamespace(
      async (request) => await new CredentialVault(fakeVaultState(), env).fetch(request),
    ),
    PUBLIC_URL: 'http://localhost',
    FILES: chatR2,
  })
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

describe('drafts', () => {
  const newConversation = async (title = 'Planning') =>
    (await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title })).conversation

  it('keeps a reply as a draft, renames it and deletes it', async () => {
    const conversation = await newConversation()
    const made = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts`,
      { title: 'A plan', content: '# A plan\n\nFirst, the thing.' },
    )
    expect(made.artifact.title).toBe('A plan')
    expect(made.artifact.content).toBe('# A plan\n\nFirst, the thing.')
    expect(made.artifact.noteId).toBeNull()

    const listed = await call<{ artifacts: AssistantArtifact[] }>('GET', `/api/assistant/conversations/${conversation.id}/artifacts`)
    expect(listed.artifacts.map((entry) => entry.id)).toEqual([made.artifact.id])

    const renamed = await call<{ artifact: AssistantArtifact }>(
      'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}`,
      { title: 'A better plan', content: 'Rewritten.' },
    )
    expect(renamed.artifact.title).toBe('A better plan')
    expect(renamed.artifact.content).toBe('Rewritten.')

    expect(await status('DELETE', `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}`)).toBe(200)
    const after = await call<{ artifacts: AssistantArtifact[] }>('GET', `/api/assistant/conversations/${conversation.id}/artifacts`)
    expect(after.artifacts).toHaveLength(0)
  })

  it('links a draft to a note, and unlinks it again', async () => {
    const conversation = await newConversation()
    const made = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'Draft', content: 'Body' },
    )
    const url = `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}`
    const noteId = '01hzzzzzzzzzzzzzzzzzzzzz01'
    expect((await call<{ artifact: AssistantArtifact }>('PATCH', url, { noteId })).artifact.noteId).toBe(noteId)
    // A write that does not name the link is not a statement about it.
    expect((await call<{ artifact: AssistantArtifact }>('PATCH', url, { title: 'Renamed' })).artifact.noteId).toBe(noteId)
    // Null is the unlink, and it has to survive a title-only write afterwards.
    expect((await call<{ artifact: AssistantArtifact }>('PATCH', url, { noteId: null })).artifact.noteId).toBeNull()
    expect((await call<{ artifact: AssistantArtifact }>('PATCH', url, { content: 'New body' })).artifact.noteId).toBeNull()
  })

  it('keeps the body it is not sent, and takes an emptied one', async () => {
    const conversation = await newConversation()
    const made = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'Draft', content: 'Body' },
    )
    // A title-only write must not blank the body: the two fields are committed on the same debounce from
    // the panel, and one arriving alone is not a statement about the other.
    const titled = await call<{ artifact: AssistantArtifact }>(
      'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}`, { title: 'Renamed' },
    )
    expect(titled.artifact.content).toBe('Body')
    // Empty is a real answer here, unlike on creation: the reader cleared the draft on purpose.
    const emptied = await call<{ artifact: AssistantArtifact }>(
      'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}`, { content: '' },
    )
    expect(emptied.artifact.content).toBe('')
    expect(emptied.artifact.title).toBe('Renamed')
  })

  it('takes an empty body, and refuses a draft of another conversation', async () => {
    const conversation = await newConversation()
    const other = await newConversation('Elsewhere')
    // A new draft is empty until the reader types into it; the panel's "new draft" entry depends on this.
    const blank = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'x', content: '   ' },
    )
    expect(blank.artifact.content).toBe('   ')
    // A missing body is still a malformed request, not an empty draft.
    expect(await status('POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'x' })).toBe(400)

    const made = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'Mine', content: 'Body' },
    )
    // The draft's own conversation is in the path, so naming a different one reaches nothing.
    expect(await status('PATCH', `/api/assistant/conversations/${other.id}/artifacts/${made.artifact.id}`, { title: 'NOPE' })).toBe(404)
    expect(await status('DELETE', `/api/assistant/conversations/${other.id}/artifacts/${made.artifact.id}`)).toBe(404)
    // And a conversation that is not this account's is refused before the draft is even read.
    asUser(OTHER)
    expect(await status('GET', `/api/assistant/conversations/${conversation.id}/artifacts`)).toBe(404)
    expect(await status('POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'x', content: 'Body' })).toBe(404)
  })

  it('takes its drafts and their history with it when the conversation goes', async () => {
    const conversation = await newConversation()
    const made = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'One', content: 'Body' },
    )
    await call(
      'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}`,
      { content: 'Second body', source: 'assistant', baseVersion: 1 },
    )
    expect(await status('DELETE', `/api/assistant/conversations/${conversation.id}`)).toBe(200)
    // The rows are gone rather than orphaned: the listing is by conversation, so nothing could read them.
    const remaining = sqlite.prepare('SELECT count(*) AS n FROM chat_artifacts WHERE user_id = ?').get(USER) as { n: number }
    const versions = sqlite.prepare('SELECT count(*) AS n FROM chat_artifact_versions WHERE user_id = ?').get(USER) as { n: number }
    expect(remaining.n).toBe(0)
    expect(versions.n).toBe(0)
  })

  it('refuses a draft past the cap', async () => {
    const conversation = await newConversation()
    for (let index = 0; index < MAX_ARTIFACTS_PER_CONVERSATION; index++) {
      await call('POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: `Draft ${index}`, content: 'Body' })
    }
    expect(await status('POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'One more', content: 'Body' })).toBe(409)
  })

  it('survives a backup round-trip', async () => {
    const conversation = await newConversation('With a draft')
    const made = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'A plan', content: 'Body' },
    )
    // The link is part of the draft, so it travels with it — a restored draft that forgot its note would
    // silently become a second copy of a document the reader already has.
    await call('PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}`, { noteId: '01hzzzzzzzzzzzzzzzzzzzzz02' })
    const payload = await call('GET', '/api/assistant/export') as Record<string, unknown>
    await call('DELETE', `/api/assistant/conversations/${conversation.id}`)
    const summary = await call<{ imported: { artifacts: number } }>('POST', '/api/assistant/import', payload)
    expect(summary.imported.artifacts).toBe(1)
    // Every column is NOT NULL, so a field the import forgets is bound as NULL and `INSERT OR IGNORE`
    // drops the whole row rather than complaining — the draft would simply not come back.
    const restored = await call<{ artifacts: AssistantArtifact[] }>('GET', `/api/assistant/conversations/${conversation.id}/artifacts`)
    expect(restored.artifacts.map((entry) => entry.id)).toEqual([made.artifact.id])
    expect(restored.artifacts[0]?.content).toBe('Body')
    expect(restored.artifacts[0]?.noteId).toBe('01hzzzzzzzzzzzzzzzzzzzzz02')
  })

  it('keeps drafts and their history out of a published conversation', async () => {
    const conversation = await newConversation('Published')
    const marker = 'PRIVATE-DRAFT-MARKER-4f9c'
    const made = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts`,
      { title: 'Secret plan', content: marker },
    )
    await call(
      'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}`,
      { content: `${marker} revised`, source: 'assistant', baseVersion: 1 },
    )
    const shared = await call<{ share: { slug: string } }>('POST', `/api/assistant/conversations/${conversation.id}/share`, {})
    const read = await call<unknown>('POST', `/api/public/conversation/${shared.share.slug}`, {})
    const payload = JSON.stringify(read)
    // The link publishes a transcript. A draft is the reader's working copy, and its history is every
    // working copy before it; neither was ever part of what a visitor was invited to read.
    expect(payload).not.toContain(marker)
    expect(payload).not.toContain('chat_artifact')
  })

  it('carries the history of a draft through a backup round-trip', async () => {
    const conversation = await newConversation('With history')
    const made = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts`, { title: 'A plan', content: 'First body' },
    )
    const second = await call<{ artifact: AssistantArtifact }>(
      'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}`,
      { content: 'Second body', source: 'assistant', baseVersion: 1 },
    )
    expect(second.artifact.version).toBe(2)
    const payload = await call('GET', '/api/assistant/export') as Record<string, unknown>
    await call('DELETE', `/api/assistant/conversations/${conversation.id}`)
    const summary = await call<{ imported: { artifacts: number, artifactVersions: number } }>('POST', '/api/assistant/import', payload)
    expect(summary.imported.artifacts).toBe(1)
    expect(summary.imported.artifactVersions).toBe(2)
    const restored = await call<{ artifacts: AssistantArtifact[] }>('GET', `/api/assistant/conversations/${conversation.id}/artifacts`)
    expect(restored.artifacts[0]?.version).toBe(2)
    expect(restored.artifacts[0]?.content).toBe('Second body')
    const versions = await call<{ versions: AssistantArtifactVersion[] }>(
      'GET', `/api/assistant/conversations/${conversation.id}/artifacts/${made.artifact.id}/versions`,
    )
    expect(versions.versions.map((entry) => entry.version)).toEqual([2, 1])
    expect(versions.versions.map((entry) => entry.source)).toEqual(['assistant', 'user'])
  })
})

describe('draft history', () => {
  const newConversation = async () =>
    (await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'History' })).conversation

  const makeDraft = async (conversationId: string, content = 'First body') =>
    (await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversationId}/artifacts`, { title: 'A plan', content },
    )).artifact

  const versionsOf = async (conversationId: string, artifactId: string) =>
    (await call<{ versions: AssistantArtifactVersion[] }>(
      'GET', `/api/assistant/conversations/${conversationId}/artifacts/${artifactId}/versions`,
    )).versions

  it('updates the head in place for a manual edit and appends for an assistant edit', async () => {
    const conversation = await newConversation()
    const draft = await makeDraft(conversation.id)
    expect(draft.version).toBe(1)
    const first = await versionsOf(conversation.id, draft.id)
    expect(first.map((entry) => entry.version)).toEqual([1])
    expect(first[0]?.source).toBe('user')
    // The list is a list: it does not carry the document body.
    expect(first[0]).not.toHaveProperty('content')

    // A reader typing is still the same version; a snapshot per keystroke would bury the history.
    const edited = await call<{ artifact: AssistantArtifact }>(
      'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${draft.id}`,
      { content: 'First body, edited', baseVersion: 1 },
    )
    expect(edited.artifact.version).toBe(1)
    expect((await versionsOf(conversation.id, draft.id)).map((entry) => entry.version)).toEqual([1])

    // An assistant write is a new version, and the one it replaced can still be read.
    const assistant = await call<{ artifact: AssistantArtifact }>(
      'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${draft.id}`,
      { content: 'Second body', source: 'assistant', baseVersion: 1 },
    )
    expect(assistant.artifact.version).toBe(2)
    const versions = await versionsOf(conversation.id, draft.id)
    expect(versions.map((entry) => entry.version)).toEqual([2, 1])
    expect(versions[0]?.source).toBe('assistant')
    const old = await call<{ version: AssistantArtifactVersion }>(
      'GET', `/api/assistant/conversations/${conversation.id}/artifacts/${draft.id}/versions/${versions[1]!.id}`,
    )
    expect(old.version.content).toBe('First body, edited')

    // A write based on the version it read is refused once a newer one exists.
    expect(await status(
      'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${draft.id}`,
      { content: 'Stale write', baseVersion: 1 },
    )).toBe(409)

    // Restoring appends: the way forward is not deleted to make the old text current again.
    const restored = await call<{ artifact: AssistantArtifact }>(
      'POST', `/api/assistant/conversations/${conversation.id}/artifacts/${draft.id}/versions/${versions[1]!.id}/restore`,
    )
    expect(restored.artifact.version).toBe(3)
    expect(restored.artifact.content).toBe('First body, edited')
    const after = await versionsOf(conversation.id, draft.id)
    expect(after.map((entry) => entry.version)).toEqual([3, 2, 1])
    expect(after[0]?.source).toBe('restore')
  })

  it('gives a draft that predates history a readable first version', async () => {
    const conversation = await newConversation()
    const draft = await makeDraft(conversation.id, 'Legacy body')
    // The shape a backup restored without the version table leaves behind.
    sqlite.prepare('DELETE FROM chat_artifact_versions WHERE artifact_id = ?').run(draft.id)
    const versions = await versionsOf(conversation.id, draft.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]?.id).toBeTruthy()
    const read = await call<{ version: AssistantArtifactVersion }>(
      'GET', `/api/assistant/conversations/${conversation.id}/artifacts/${draft.id}/versions/${versions[0]!.id}`,
    )
    expect(read.version.content).toBe('Legacy body')
  })

  it('keeps fifty versions and never prunes the head', async () => {
    const conversation = await newConversation()
    const draft = await makeDraft(conversation.id)
    let version = 1
    for (let index = 0; index < MAX_ARTIFACT_VERSIONS; index++) {
      const answer = await call<{ artifact: AssistantArtifact }>(
        'PATCH', `/api/assistant/conversations/${conversation.id}/artifacts/${draft.id}`,
        { content: `Body ${index + 2}`, source: 'assistant', baseVersion: version },
      )
      version = answer.artifact.version
    }
    const versions = await versionsOf(conversation.id, draft.id)
    expect(versions).toHaveLength(MAX_ARTIFACT_VERSIONS)
    expect(versions[0]?.version).toBe(version)
    expect(versions.at(-1)?.version).toBe(version - MAX_ARTIFACT_VERSIONS + 1)
  })

  it('does not let one conversation read another conversation\'s history', async () => {
    const conversation = await newConversation()
    const other = await newConversation()
    const draft = await makeDraft(conversation.id)
    expect(await status(
      'GET', `/api/assistant/conversations/${other.id}/artifacts/${draft.id}/versions`,
    )).toBe(404)
  })
})

describe('canvas tools in a turn', () => {
  const toolCallFrames = (name: string, args: Record<string, unknown>, id: string) => [
    openAiFrame({ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }),
    openAiFrame({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] }),
  ]

  it('creates a draft, then rewrites the open draft by default', async () => {
    await useExampleModel()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      // The first turn is three calls: the tool step, the answer, and the naming pass that titles the
      // new thread. The second turn has no naming pass, so its tool step is the fourth call.
      const frames = calls === 1
        ? toolCallFrames('create_artifact', { title: 'Plan', content: '# Plan\n\nFirst.' }, 'c-create')
        : calls === 4
          ? toolCallFrames('update_artifact', { content: '# Plan\n\nSecond.' }, 'c-update')
          : FINAL_FRAMES
      return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
    }))

    const first = await chatEvents({ message: 'write a plan' })
    await settleTurns()
    const created = first.find((event) => event.type === 'artifact')
    expect(created?.change).toBe('created')
    expect(created?.artifact?.title).toBe('Plan')
    expect(created?.artifact?.version).toBe(1)
    expect(created?.artifact?.content).toBe('# Plan\n\nFirst.')
    // The chip is streamed twice: running first, then the settled row that carries the draft id.
    const createdChip = first.filter((event) => event.type === 'tool' && event.tool?.name === 'create_artifact').at(-1)
    expect(createdChip?.tool?.artifactId).toBe(created?.artifact?.id)
    const conversationId = first.find((event) => event.type === 'start')?.conversationId

    const second = await chatEvents({
      conversationId,
      message: 'make the second line longer',
      activeArtifactId: created?.artifact?.id,
    })
    await settleTurns()
    const updated = second.find((event) => event.type === 'artifact')
    expect(updated?.change).toBe('updated')
    expect(updated?.artifact?.version).toBe(2)
    expect(updated?.artifact?.content).toBe('# Plan\n\nSecond.')
    const updatedChip = second.filter((event) => event.type === 'tool' && event.tool?.name === 'update_artifact').at(-1)
    expect(updatedChip?.tool?.artifactId).toBe(created?.artifact?.id)
    expect(second.some((event) => event.type === 'error')).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('realtime voice sessions', () => {
  async function useRealtimeModel(protocol: 'openai' | 'anthropic' = 'openai') {
    const { provider } = await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
      label: 'Voice',
      protocol,
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-realtime-test-1234',
      models: ['realtime-model'],
    })
    const { models } = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const model = models.find((entry) => entry.providerId === provider.id && entry.model === 'realtime-model')
    expect(model, 'the realtime model was not created').toBeTruthy()
    await call('PATCH', `/api/assistant/models/${model!.id}`, { purpose: 'realtime' })
    return { provider, model: { ...model!, purpose: 'realtime' as const } }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mints a short-lived secret and never returns the provider key', async () => {
    await useRealtimeModel()
    const seen: Array<{ url: string, auth: string | null, body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      })
      return new Response(JSON.stringify({ client_secret: { value: 'ek-test-secret', expires_at: 123 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    const result = await call<{ session: { clientSecret: string, model: string, baseUrl: string, transport: string, expiresAt: number | null } }>(
      'POST', '/api/assistant/realtime/session', {},
    )
    expect(result.session).toMatchObject({
      clientSecret: 'ek-test-secret',
      model: 'realtime-model',
      baseUrl: 'https://api.example.com',
      transport: 'calls',
      expiresAt: 123,
    })
    expect(JSON.stringify(result)).not.toContain('sk-realtime-test-1234')
    expect(seen[0]?.url).toBe('https://api.example.com/realtime/client_secrets')
    expect(seen[0]?.auth).toBe('Bearer sk-realtime-test-1234')
    expect(seen[0]?.body).toMatchObject({ session: { type: 'realtime', model: 'realtime-model' } })
  })

  it('falls back to the older sessions endpoint when client secrets are not there', async () => {
    await useRealtimeModel()
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      urls.push(String(input))
      return urls.length === 1
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify({ client_secret: { value: 'ek-legacy' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const result = await call<{ session: { clientSecret: string, transport: string } }>('POST', '/api/assistant/realtime/session', {})
    expect(result.session.clientSecret).toBe('ek-legacy')
    // The older door exchanges SDP at `realtime`, not `realtime/calls`; the browser is told which.
    expect(result.session.transport).toBe('legacy')
    expect(urls).toEqual([
      'https://api.example.com/realtime/client_secrets',
      'https://api.example.com/realtime/sessions',
    ])
  })

  it('refuses when no realtime model is configured', async () => {
    expect(await status('POST', '/api/assistant/realtime/session', {})).toBe(400)
  })

  it('refuses a provider that does not speak the OpenAI realtime protocol', async () => {
    await useRealtimeModel('anthropic')
    expect(await status('POST', '/api/assistant/realtime/session', {})).toBe(400)
  })

  it('does not echo the key when the provider refuses the session', async () => {
    await useRealtimeModel()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })))
    const response = await app.fetch(new Request('http://localhost/api/assistant/realtime/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), env, ctx)
    const text = await response.text()
    expect(response.status).toBe(400)
    expect(text).not.toContain('sk-realtime-test-1234')
    expect(text).toContain('refused the voice session')
    // A refused voice session is its own kind of failure: the panel can say what to check instead of
    // falling back to "the server had an internal error".
    expect(JSON.parse(text).error.code).toBe('realtime_refused')
  })

  it('names an unreachable provider rather than a generic server failure', async () => {
    await useRealtimeModel()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const response = await app.fetch(new Request('http://localhost/api/assistant/realtime/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), env, ctx)
    expect(response.status).toBe(502)
    const body = await response.json() as { error: { code: string, message: string } }
    expect(body.error.code).toBe('realtime_refused')
    expect(body.error.message).toContain('could not be reached')
  })
})

describe('ModelBest realtime relay sessions', () => {
  async function useModelBestRealtime() {
    const { provider } = await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
      label: 'ModelBest Voice',
      protocol: 'openai',
      baseUrl: 'https://api.modelbest.cn/v1',
      apiKey: 'sk-modelbest-test-1234',
      models: ['MiniCPM-o-4.5-Realtime'],
    })
    const { models } = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const model = models.find((entry) => entry.providerId === provider.id)!
    await call('PATCH', `/api/assistant/models/${model.id}`, { purpose: 'realtime' })
    return { ...model, purpose: 'realtime' as const }
  }

  it('describes a same-origin relay instead of minting a provider secret', async () => {
    const model = await useModelBestRealtime()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await call<{ session: { transport: string, model: string, relayPath: string, expiresAt: null } }>(
      'POST', '/api/assistant/realtime/session', {},
    )
    expect(result.session).toMatchObject({
      transport: 'modelbest',
      model: 'MiniCPM-o-4.5-Realtime',
      relayPath: `/api/assistant/realtime/relay?modelId=${model.id}`,
      expiresAt: null,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('sk-modelbest-test-1234')
  })

  it('builds the socket URL the SDK documents', () => {
    expect(isModelBestEndpoint('https://api.modelbest.cn/v1')).toBe(true)
    expect(isModelBestEndpoint('https://api.example.com/v1')).toBe(false)
    expect(modelBestSocketUrl('https://api.modelbest.cn', 'MiniCPM-o-4.5-Realtime'))
      .toBe('wss://api.modelbest.cn/v1/realtime?mode=audio&model=MiniCPM-o-4.5-Realtime')
    expect(modelBestSocketUrl('https://api.modelbest.cn/v1/', 'MiniCPM-o-4.5-Realtime'))
      .toBe('wss://api.modelbest.cn/v1/realtime?mode=audio&model=MiniCPM-o-4.5-Realtime')
  })

  it('refuses a relay request that is not an upgrade, or names no realtime model', async () => {
    expect(await status('GET', '/api/assistant/realtime/relay')).toBe(400)
    const response = await app.fetch(new Request(
      'http://localhost/api/assistant/realtime/relay?modelId=01hzzzzzzzzzzzzzzzzzzzzz00',
      { headers: { Upgrade: 'websocket' } },
    ), env, ctx)
    expect(response.status).toBe(400)
  })
})

describe('re-taking a turn', () => {
  /**
   * A thread with two answers, written straight into the store.
   *
   * These routes are about rows that already stand — a streamed turn would only make the fixture slower
   * — and the rollup is written too, because an edit has to take it back.
   */
  async function thread() {
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const conversation = await store.createConversation('Planning')
    const first = await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'FIRST ASK' })
    const firstAnswer = await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'FIRST ANSWER' })
    const second = await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'SECOND ASK' })
    const secondAnswer = await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'SECOND ANSWER' })
    await store.setSummary(conversation.id, 'A paragraph about the first turn.', firstAnswer.createdAt)
    return { store, conversation, first, firstAnswer, second, secondAnswer }
  }

  it('retypes the reader\'s own message and takes back what was written below it', async () => {
    const { store, conversation, first } = await thread()
    const result = await call<{ message: AssistantMessage, removed: number }>(
      'PATCH', `/api/assistant/conversations/${conversation.id}/messages/${first.id}`, { content: 'RETYPED' },
    )
    expect(result.message.content).toBe('RETYPED')
    // The answer written from the old words, and the turn after it, were answers to a question that no
    // longer exists; the thread is asked again from what is left.
    expect(result.removed).toBe(3)
    expect((await store.messages(conversation.id)).map((entry) => entry.content)).toEqual(['RETYPED'])
    // The rollup described the rows that are gone.
    expect((await store.getConversation(conversation.id))?.summary).toBeNull()
  })

  it('refuses to retype an answer, and refuses a message of another thread', async () => {
    const { conversation, firstAnswer } = await thread()
    expect(await status('PATCH', `/api/assistant/conversations/${conversation.id}/messages/${firstAnswer.id}`, { content: 'NOPE' })).toBe(400)
    const other = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Elsewhere' })
    expect(await status('PATCH', `/api/assistant/conversations/${other.conversation.id}/messages/${firstAnswer.id}`, { content: 'NOPE' })).toBe(404)
    expect(await status('DELETE', `/api/assistant/conversations/${other.conversation.id}/messages/${firstAnswer.id}`)).toBe(404)
  })

  it('takes the pair back when the reader deletes their own turn', async () => {
    const { conversation, first, firstAnswer, second, secondAnswer } = await thread()
    const result = await call<{ removed: string[], messages: AssistantMessage[] }>(
      'DELETE', `/api/assistant/conversations/${conversation.id}/messages/${first.id}`,
    )
    // A question with no answer under it is half a turn, so both rows go; the turn after them is the
    // reader's own and is left alone.
    expect(result.removed).toEqual([first.id, firstAnswer.id])
    expect(result.messages.map((entry) => entry.id)).toEqual([second.id, secondAnswer.id])
  })

  it('records a verdict on an answer, takes it back, and refuses anything else', async () => {    const { store, conversation, first, firstAnswer } = await thread()
    const rate = (body: unknown, messageId = firstAnswer.id) => call<{ message: AssistantMessage }>(
      'PATCH', `/api/assistant/conversations/${conversation.id}/messages/${messageId}/feedback`, body,
    )
    expect((await rate({ feedback: 'up' })).message.feedback).toBe('up')
    // The verdict survives a re-read, which is the whole point of storing it on the row: a chip held in
    // a component would be gone by the next morning.
    expect((await store.getMessage(firstAnswer.id))?.feedback).toBe('up')
    expect((await rate({ feedback: null })).message.feedback).toBeUndefined()
    expect(await status('PATCH', `/api/assistant/conversations/${conversation.id}/messages/${firstAnswer.id}/feedback`, { feedback: 'maybe' })).toBe(400)
    // The reader's own words are not an answer, and a message in another thread is not this one's.
    expect(await status('PATCH', `/api/assistant/conversations/${conversation.id}/messages/${first.id}/feedback`, { feedback: 'up' })).toBe(400)
    const other = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Elsewhere' })
    expect(await status('PATCH', `/api/assistant/conversations/${other.conversation.id}/messages/${firstAnswer.id}/feedback`, { feedback: 'up' })).toBe(404)
  })

  it('deletes exactly the turns a reader selected, and nothing beside them', async () => {
    const { store, conversation, first, firstAnswer, second, secondAnswer } = await thread()
    const result = await call<{ removed: string[], messages: AssistantMessage[] }>(
      'POST', `/api/assistant/conversations/${conversation.id}/messages/delete`,
      { ids: [firstAnswer.id, secondAnswer.id] },
    )
    // A selection is not a turn: deleting a single message takes its pair with it, and this must not —
    // the reader pointed at two rows and the two rows are what goes.
    expect(result.removed.sort()).toEqual([firstAnswer.id, secondAnswer.id].sort())
    expect(result.messages.map((entry) => entry.id)).toEqual([first.id, second.id])
    // The rollup described rows that are gone.
    expect((await store.getConversation(conversation.id))?.summary).toBeNull()
    expect(await status('POST', `/api/assistant/conversations/${conversation.id}/messages/delete`, { ids: [] })).toBe(400)
    const other = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Elsewhere' })
    expect(await status('POST', `/api/assistant/conversations/${other.conversation.id}/messages/delete`, { ids: [first.id] })).toBe(200)
  })

  it('publishes a conversation read-only, and never the thinking or the tool rows', async () => {
    const { store, conversation, first, firstAnswer } = await thread()
    // A turn that thought, searched and called a tool, so the published payload has something to *not*
    // carry: the reasoning is the model thinking aloud, and a tool result can quote a private note.
    await store.updateMessageContent(firstAnswer.id, 'The answer, per the search.')
    const shared = await call<{ share: { slug: string, url: string, hasPassword: boolean } }>(
      'POST', `/api/assistant/conversations/${conversation.id}/share`, {},
    )
    expect(shared.share.url).toContain(`/c/${shared.share.slug}`)
    expect(shared.share.hasPassword).toBe(false)

    const read = await call<{ title: string, messages: Array<{ role: string, content: string }> }>(
      'POST', `/api/public/conversation/${shared.share.slug}`, {},
    )
    // The whole thread, in order, with the edit the test made showing through — a link carries the
    // conversation as it stands, not a snapshot from when it was minted.
    expect(read.messages.map((message) => message.content))
      .toEqual([first.content, 'The answer, per the search.', 'SECOND ASK', 'SECOND ANSWER'])
    expect(read.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])

    // The row is written with reasoning and tool activity, and the read side must not echo either.
    const raw = JSON.stringify(read)
    expect(raw).not.toContain('reasoning')
    expect(raw).not.toContain('tools')
    expect(raw).not.toContain('attachments')
  })

  it('gates a published conversation behind its passcode, and behind nothing else', async () => {
    const { conversation } = await thread()
    const shared = await call<{ share: { slug: string } }>(
      'POST', `/api/assistant/conversations/${conversation.id}/share`, { password: 'open-sesame-please' },
    )
    expect(await status('POST', `/api/public/conversation/${shared.share.slug}`, {})).toBe(401)
    expect(await status('POST', `/api/public/conversation/${shared.share.slug}`, { password: 'wrong-passcode-here' })).toBe(401)
    expect(await status('POST', `/api/public/conversation/${shared.share.slug}`, { password: 'open-sesame-please' })).toBe(200)
  })

  it('rotates the link on request and revokes it outright', async () => {
    const { conversation } = await thread()
    const first = await call<{ share: { slug: string } }>('POST', `/api/assistant/conversations/${conversation.id}/share`, {})
    const rotated = await call<{ share: { slug: string } }>(
      'POST', `/api/assistant/conversations/${conversation.id}/share`, { rotate: true },
    )
    expect(rotated.share.slug).not.toBe(first.share.slug)
    // The old address is dead the moment a new one is minted, which is the only way to un-share a link
    // somebody already has a copy of.
    expect(await status('POST', `/api/public/conversation/${first.share.slug}`, {})).toBe(404)
    expect(await status('POST', `/api/public/conversation/${rotated.share.slug}`, {})).toBe(200)
    await call('DELETE', `/api/assistant/conversations/${conversation.id}/share`)
    expect(await status('POST', `/api/public/conversation/${rotated.share.slug}`, {})).toBe(404)
    const state = await call<{ share: unknown }>('GET', `/api/assistant/conversations/${conversation.id}/share`)
    expect(state.share).toBeNull()
  })

  it('refuses to publish a conversation that belongs to somebody else', async () => {
    const { conversation } = await thread()
    asUser(OTHER)
    expect(await status('POST', `/api/assistant/conversations/${conversation.id}/share`, {})).toBe(404)
    expect(await status('GET', `/api/assistant/conversations/${conversation.id}/share`)).toBe(404)
    asUser(USER)
  })

  it('keeps the pages a searched answer consulted, and drops a row that is not one', async () => {
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const conversation = await store.createConversation('Searched')
    const written = await store.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'It is 12 degrees.',
      sources: [
        { url: 'https://weather.example/today', title: 'Today', cited: '12 degrees' },
        // Shaped like a source, so only the store's own check can turn it away: the type says `string`,
        // and an answer that showed a chip leading nowhere would read as one that searched.
        { url: 'not a url', title: 'junk' },
      ],
    })
    const read = await store.getMessage(written.id)
    // A source is a link, so a row with no url is not one — and a stored answer that lost its links
    // would read as an answer that never searched.
    expect(read?.sources).toEqual([{ url: 'https://weather.example/today', title: 'Today', cited: '12 degrees' }])
    expect((await store.getMessage(written.id))?.sources).toHaveLength(1)
  })

  it('reports what was spent, split by model and kept per currency', async () => {
    await useExampleModel()
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const model = models.models[0]!
    await call('PATCH', `/api/assistant/models/${model.id}`, { inputPrice: 1, outputPrice: 2, priceCurrency: 'usd' })
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    await store.incrementUsage({ requests: 2, inputTokens: 1_000_000, outputTokens: 500_000, toolCalls: 3 }, undefined, model.label)
    const stats = await call<{
      total: { requests: number, inputTokens: number }
      models: Array<{ label: string, cost: number | null, currency: string }>
      spend: Array<{ currency: string, amount: number }>
      unpricedModels: number
    }>('GET', '/api/assistant/stats?range=7')
    expect(stats.total.requests).toBe(2)
    expect(stats.models[0]).toMatchObject({ label: model.label, currency: 'USD' })
    // 1M input at 1 + 0.5M output at 2, per million: the arithmetic the reader would otherwise do by hand.
    expect(stats.models[0]!.cost).toBeCloseTo(2)
    expect(stats.spend).toEqual([{ currency: 'USD', amount: 2 }])
    expect(stats.unpricedModels).toBe(0)
  })

  it('says a model is unpriced rather than counting it as free', async () => {
    await useExampleModel()
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    await store.incrementUsage({ requests: 1, inputTokens: 10 }, undefined, models.models[0]!.label)
    const stats = await call<{ models: Array<{ cost: number | null }>, spend: unknown[], unpricedModels: number }>('GET', '/api/assistant/stats?range=7')
    expect(stats.models[0]!.cost).toBeNull()
    expect(stats.unpricedModels).toBe(1)
    expect(stats.spend).toEqual([])
  })

  it('branches a conversation at a message, leaving the original whole', async () => {    const { conversation, first, firstAnswer, second, secondAnswer } = await thread()
    const result = await call<{ conversation: AssistantConversation, messages: AssistantMessage[] }>(
      'POST', `/api/assistant/conversations/${conversation.id}/fork`, { messageId: firstAnswer.id, title: 'Planning (branch)' },
    )
    expect(result.conversation.title).toBe('Planning (branch)')
    expect(result.conversation.id).not.toBe(conversation.id)
    // The branch remembers where it came from, which is what the tree is drawn from.
    expect(result.conversation.parentId).toBe(conversation.id)
    expect((await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${conversation.id}`)).conversation.parentId).toBeNull()
    // The copied thread is what led to that message, in order, with its own ids — a branch that shared
    // rows would be two conversations editing each other.
    expect(result.messages.map((entry) => entry.content)).toEqual([first.content, firstAnswer.content])
    expect(result.messages.map((entry) => entry.id)).not.toContain(first.id)
    const source = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversation.id}`)
    expect(source.messages.map((entry) => entry.id)).toEqual([first.id, firstAnswer.id, second.id, secondAnswer.id])
    // The original keeps its own name and its turn count; a branch is not a rename of anything.
    expect((await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${conversation.id}`)).conversation.title).toBe('Planning')
    expect(await status('POST', `/api/assistant/conversations/${conversation.id}/fork`, { messageId: 'not-a-message', title: 'x' })).toBe(404)

    // A second branch off the same thread is a sibling, and the tree says so from either side.
    const otherBranch = await call<{ conversation: AssistantConversation }>(
      'POST', `/api/assistant/conversations/${conversation.id}/fork`, { messageId: first.id, title: 'Planning (branch 2)' },
    )
    const branches = await call<{ parent: { id: string, title: string } | null, siblings: Array<{ id: string, title: string }> }>(
      'GET', `/api/assistant/conversations/${result.conversation.id}/branches`,
    )
    expect(branches.parent?.id).toBe(conversation.id)
    expect(branches.siblings.map((entry) => entry.id).sort()).toEqual([result.conversation.id, otherBranch.conversation.id].sort())
    // The root itself has no parent and no siblings: the threads forked off it are its children.
    const rootBranches = await call<{ parent: unknown, siblings: unknown[] }>(
      'GET', `/api/assistant/conversations/${conversation.id}/branches`,
    )
    expect(rootBranches.parent).toBeNull()
    expect(rootBranches.siblings).toEqual([])
  })
})

/**
 * Publishing some of a thread rather than all of it.
 *
 * The link is the same object either way — same slug rules, same passcode, same expiry — so what these
 * cases pin is the scope: what a visitor gets, that a narrowed link and the thread's own link are two
 * separate publications, and that neither one's revocation reaches the other.
 */
describe('sharing a selection', () => {
  /** Four turns in one thread, so a scope has something to leave out. */
  async function thread() {
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const conversation = await store.createConversation('Planning')
    const first = await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'FIRST ASK' })
    const firstAnswer = await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'FIRST ANSWER' })
    const second = await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'SECOND ASK' })
    const secondAnswer = await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'SECOND ANSWER' })
    return { store, conversation, first, firstAnswer, second, secondAnswer }
  }

  const read = async (slug: string) =>
    await call<{ messages: { role: string, content: string }[] }>('POST', `/api/public/conversation/${slug}`, {})

  it('publishes exactly the picked turns, in the thread\'s own order', async () => {
    const { conversation, first, firstAnswer } = await thread()
    // Named back to front on purpose: the reader ticked two boxes, not an order.
    const shared = await call<{ share: { slug: string } }>(
      'POST', `/api/assistant/conversations/${conversation.id}/share`,
      { messageIds: [firstAnswer.id, first.id] },
    )
    expect((await read(shared.share.slug)).messages.map((message) => message.content))
      .toEqual(['FIRST ASK', 'FIRST ANSWER'])
  })

  it('keeps the thread\'s own link and a narrowed one as two publications', async () => {
    const { conversation, second, secondAnswer } = await thread()
    const whole = await call<{ share: { slug: string } }>('POST', `/api/assistant/conversations/${conversation.id}/share`, {})
    const narrowed = await call<{ share: { slug: string } }>(
      'POST', `/api/assistant/conversations/${conversation.id}/share`,
      { messageIds: [second.id, secondAnswer.id] },
    )
    expect(narrowed.share.slug).not.toBe(whole.share.slug)
    // Narrowing must not rewrite the address the reader already sent somebody.
    expect((await read(whole.share.slug)).messages).toHaveLength(4)
    expect((await read(narrowed.share.slug)).messages.map((message) => message.content))
      .toEqual(['SECOND ASK', 'SECOND ANSWER'])
    // And the panel asks about the link it is showing, not the thread's own.
    expect((await call<{ share: { slug: string } }>('GET', `/api/assistant/conversations/${conversation.id}/share`)).share.slug)
      .toBe(whole.share.slug)
    expect((await call<{ share: { slug: string } }>(
      'GET', `/api/assistant/conversations/${conversation.id}/share?messageIds=${second.id},${secondAnswer.id}`,
    )).share.slug).toBe(narrowed.share.slug)
  })

  it('revokes one publication without taking the other down', async () => {
    const { conversation, first } = await thread()
    const whole = await call<{ share: { slug: string } }>('POST', `/api/assistant/conversations/${conversation.id}/share`, {})
    const narrowed = await call<{ share: { slug: string } }>(
      'POST', `/api/assistant/conversations/${conversation.id}/share`, { messageIds: [first.id] },
    )
    await call('DELETE', `/api/assistant/conversations/${conversation.id}/share?messageIds=${first.id}`)
    expect(await status('POST', `/api/public/conversation/${narrowed.share.slug}`, {})).toBe(404)
    expect(await status('POST', `/api/public/conversation/${whole.share.slug}`, {})).toBe(200)
  })

  it('refuses a turn that is not in this conversation', async () => {
    const { store, conversation, first } = await thread()
    const elsewhere = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Elsewhere' })
    const foreign = await store.addMessage({ conversationId: elsewhere.conversation.id, role: 'user', content: 'ELSEWHERE' })
    // Refused at the moment of sharing rather than minted into a link that reads as empty: a page with
    // nothing on it is harder to explain than a refusal while the reader is still looking at the ticks.
    expect(await status('POST', `/api/assistant/conversations/${conversation.id}/share`, { messageIds: [first.id, foreign.id] })).toBe(400)
    expect(await status('POST', `/api/assistant/conversations/${conversation.id}/share`, { messageIds: ['not-a-message'] })).toBe(400)
  })

  it('can still be taken down after the turns it named are gone', async () => {
    const { conversation, first, firstAnswer } = await thread()
    const shared = await call<{ share: { slug: string } }>(
      'POST', `/api/assistant/conversations/${conversation.id}/share`, { messageIds: [first.id, firstAnswer.id] },
    )
    await call('POST', `/api/assistant/conversations/${conversation.id}/messages/delete`, { ids: [first.id, firstAnswer.id] })
    // The link resolves to an empty transcript rather than vanishing: what it published is gone, not the
    // promise that it published something.
    expect((await read(shared.share.slug)).messages).toEqual([])
    // And the reader can still find it to take it down, which a check on the messages would have stopped.
    await call('DELETE', `/api/assistant/conversations/${conversation.id}/share?messageIds=${first.id},${firstAnswer.id}`)
    expect(await status('POST', `/api/public/conversation/${shared.share.slug}`, {})).toBe(404)
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

  it('keeps a routine claimed for the whole run, so an overlapping sweep cannot start it twice', async () => {
    const created = await call<{ automation: Automation }>('POST', '/api/assistant/automations', {
      name: 'Morning digest', kind: 'task_digest', message: '',
      schedule: { type: 'daily', time: '09:00' },
    })
    const due = Date.now() - 1000
    sqlite.prepare('UPDATE chat_automations SET next_run = ? WHERE id = ?').run(due, created.automation.id)

    const { AssistantStore, dueAutomations } = await import('../src/worker/assistant/store')
    const { AutomationService } = await import('../src/worker/assistant/automations')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const service = new AutomationService(store, await store.getSettings())
    const [claimed] = await dueAutomations(env.DB, Date.now(), 20)
    expect(claimed).toBeTruthy()

    let seenDuringRun = -1
    await service.fire(claimed!.automation, async () => {
      // A model call can outlive the minute sweep. This is that next sweep arriving mid-run.
      seenDuringRun = (await dueAutomations(env.DB, Date.now(), 20))
        .filter((entry) => entry.automation.id === created.automation.id).length
      return { status: 'success' as const, result: 'delivered' }
    })
    expect(seenDuringRun).toBe(0)

    // Re-arming is what releases the claim; the row is scheduled again and not left claimed.
    const row = sqlite.prepare('SELECT claimed_at, next_run FROM chat_automations WHERE id = ?').get(created.automation.id) as { claimed_at: number | null, next_run: number }
    expect(row.claimed_at).toBeNull()
    expect(row.next_run).toBeGreaterThan(Date.now())
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
      limits: { maxOutputTokens: 99_000_000, maxToolCalls: -4 },
    })
    expect(result.settings.limits.maxOutputTokens).toBe(MAX_TOKEN_CEILING)
    expect(result.settings.limits.maxToolCalls).toBe(0)
  })

  it('keeps a ceiling the model page can offer, and round-trips the three token limits', async () => {
    const result = await call<{ settings: AssistantSettings }>('PATCH', '/api/assistant/settings', {
      // 64K is on the model editor's own ladder: a range that stopped at 8192 could not answer for a
      // model the reader had set to it, and the input ceiling did not exist here at all.
      limits: { maxOutputTokens: 65_536, maxInputTokens: 524_288 },
    })
    expect(result.settings.limits.maxOutputTokens).toBe(65_536)
    expect(result.settings.limits.maxInputTokens).toBe(524_288)
  })

  it('round-trips every settings field the client can patch', async () => {
    const before = await call<{ settings: AssistantSettings }>('GET', '/api/assistant/settings')
    const flipped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(before.settings)) {
      // One boolean in that answer is not a setting at all: the server says whether the chosen search engine
      // is holding a key, and a client cannot tell it otherwise. `assistant-web-search-engines.test.ts`
      // asserts that forgery directly; here it is simply left out of the patchable list.
      if (key === 'webSearchKeyStored') continue
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

  it('keeps proving which key is stored after the provider is read back', async () => {
    const created = await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
      label: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-secret-value-123456',
    })
    // The create answer is not the screen: the row is read back on every later open, and it has to say
    // which key is held without the ciphertext ever being decrypted for a listing.
    expect(created.provider.keyHint).toBe('3456')
    const listed = await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')
    expect(listed.providers[0]).toMatchObject({ hasKey: true, keyHint: '3456' })

    // An edit that does not mention the key keeps both the key and its hint.
    const renamed = await call<{ provider: AssistantProvider }>('PATCH', `/api/assistant/providers/${created.provider.id}`, { label: 'Renamed' })
    expect(renamed.provider).toMatchObject({ hasKey: true, keyHint: '3456' })
    const afterRename = await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')
    expect(afterRename.providers[0]).toMatchObject({ hasKey: true, keyHint: '3456' })

    // A replacement recomputes the hint; clearing the key clears both facts.
    const rotated = await call<{ provider: AssistantProvider }>('PATCH', `/api/assistant/providers/${created.provider.id}`, { apiKey: 'sk-other-value-0000' })
    expect(rotated.provider).toMatchObject({ hasKey: true, keyHint: '0000' })
    const cleared = await call<{ provider: AssistantProvider }>('PATCH', `/api/assistant/providers/${created.provider.id}`, { apiKey: null })
    expect(cleared.provider).toMatchObject({ hasKey: false, keyHint: '' })
    const afterClear = await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')
    expect(afterClear.providers[0]).toMatchObject({ hasKey: false, keyHint: '' })
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

  it('records which of several keys was refused, so the screen can point at the broken one', async () => {
    const created = await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
      label: 'Ring',
      protocol: 'openai',
      baseUrl: 'https://api.example.com',
      models: ['example-model'],
    })
    const added = await call<{ key: { id: string } }>(
      'POST', `/api/assistant/providers/${created.provider.id}/keys`, { apiKey: 'sk-ring-key-1111', label: 'main' },
    )
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'bad key' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )))
    const events = await chatEvents({ message: 'hello' })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(events.some((event) => event.type === 'error')).toBe(true)
    // The refusal is written onto the key that was on the wire, not onto the provider: with a ring of
    // several, "which one is broken" is the question the settings screen has to answer.
    const keys = await call<{ keys: { id: string, errorCount: number, lastError: string | null }[] }>(
      'GET', `/api/assistant/providers/${created.provider.id}/keys`,
    )
    const refused = keys.keys.find((entry) => entry.id === added.key.id)
    expect(refused?.errorCount).toBe(1)
    expect(refused?.lastError).toContain('auth')
  })
})

describe('the vendor’s own model list', () => {
  async function addProvider(): Promise<AssistantProvider> {
    const created = await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
      label: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-route-secret-123456',
      models: ['placeholder'],
    })
    return created.provider
  }

  it('answers with the vendor ids and sends the stored key only to that vendor', async () => {
    const provider = await addProvider()
    const seen: { url: string, auth?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(url), auth: headers.authorization })
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat', owned_by: 'deepseek' }, { id: '   ' }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }))
    const listed = await call<{ ok: boolean, models: { id: string, label: string }[] }>('GET', `/api/assistant/providers/${provider.id}/vendor-models`)
    vi.unstubAllGlobals()
    expect(listed.ok).toBe(true)
    expect(listed.models.map((model) => model.id)).toEqual(['deepseek-chat'])
    expect(seen[0]?.url).toBe('https://api.deepseek.com/v1/models')
    expect(seen[0]?.auth).toBe('Bearer sk-route-secret-123456')
  })

  it('reports a vendor failure in the body rather than failing the screen', async () => {
    const provider = await addProvider()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })))
    const response = await app.fetch(new Request(`http://localhost/api/assistant/providers/${provider.id}/vendor-models`, {
      headers: { 'x-inkstone-client': '1' },
    }), env, ctx)
    const body = await response.json() as { ok: boolean, error: string, models: unknown[] }
    vi.unstubAllGlobals()
    expect(response.status, 'a dead vendor must not close the picker').toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('401')
    // The vendor's own words are never relayed: an upstream body can carry the key it was refused for.
    expect(body.error).not.toContain('Invalid API key')
    expect(body.models).toEqual([])
  })

  it('keeps another account’s provider out of reach', async () => {
    const provider = await addProvider()
    asUser(OTHER)
    expect(await status('GET', `/api/assistant/providers/${provider.id}/vendor-models`)).toBe(404)
    asUser(USER)
  })
})

describe('the same listing for a provider that has not been saved', () => {
  it('asks the vendor with the key from the body and stores neither value', async () => {
    const seen: { url: string, auth?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(url), auth: headers.authorization })
      return new Response(JSON.stringify({ data: [{ id: 'gemini-2.5-flash', owned_by: 'google' }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }))
    const listed = await call<{ ok: boolean, models: { id: string }[] }>('POST', '/api/assistant/providers/model-list', {
      protocol: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'sk-draft-secret-123456',
    })
    vi.unstubAllGlobals()
    expect(listed.ok).toBe(true)
    expect(listed.models.map((model) => model.id)).toEqual(['gemini-2.5-flash'])
    expect(seen[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(seen[0]?.auth).toBe('Bearer sk-draft-secret-123456')
    // The form is asking a question; nothing about it should survive the answer.
    const providers = await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')
    expect(providers.providers.map((provider) => provider.baseUrl)).not.toContain('https://generativelanguage.googleapis.com/v1beta')
  })

  it('refuses an address inside the network before any key leaves', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const state = await status('POST', '/api/assistant/providers/model-list', {
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'sk-draft-secret-123456',
    })
    vi.unstubAllGlobals()
    expect(state, 'a private target must be refused, not attempted').toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('per-protocol provider endpoints', () => {
  async function addGateway(): Promise<AssistantProvider> {
    const created = await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
      label: 'Gateway',
      protocol: 'openai',
      baseUrl: 'https://gw.test/v1',
      apiKey: 'sk-gateway-secret-1',
      models: ['gateway-large'],
    })
    return created.provider
  }

  it('saves each address, refuses one inside the network, and drops a name that is not a protocol', async () => {
    const provider = await addGateway()
    const patched = await call<{ provider: AssistantProvider }>('PATCH', `/api/assistant/providers/${provider.id}`, {
      endpoints: { anthropic: 'https://gw.test/anthropic/v1', gemini: '   ', nonsense: 'https://ok.test/v1' },
    })
    expect(patched.provider.endpoints).toEqual({ anthropic: 'https://gw.test/anthropic/v1' })
    expect(await status('PATCH', `/api/assistant/providers/${provider.id}`, { endpoints: { gemini: 'http://127.0.0.1:11434' } })).toBe(400)
    const listed = await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')
    expect(listed.providers[0]?.endpoints?.anthropic).toBe('https://gw.test/anthropic/v1')
    // An edit that never mentions the endpoints must not wipe them, exactly like the MCP token.
    const renamed = await call<{ provider: AssistantProvider }>('PATCH', `/api/assistant/providers/${provider.id}`, { label: 'Renamed' })
    expect(renamed.provider.endpoints?.anthropic, 'an unrelated edit cleared the extra addresses').toBe('https://gw.test/anthropic/v1')
  })

  it('keeps a protocol written by hand out of the model, and one the route accepts in it', async () => {
    const provider = await addGateway()
    const created = await call<{ model: AssistantModel }>('POST', '/api/assistant/models', {
      providerId: provider.id, model: 'gateway-anthropic-shaped', protocol: 'anthropic',
    })
    expect(created.model.protocol).toBe('anthropic')
    // The POST answers from the object it built, so only a re-read proves the column was written.
    const reread = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    expect(reread.models.find((entry) => entry.id === created.model.id)?.protocol).toBe('anthropic')
    sqlite.prepare('UPDATE chat_models SET protocol = ? WHERE id = ?').run('mistral', created.model.id)
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    expect(models.models.find((entry) => entry.id === created.model.id)?.protocol).toBeNull()
  })

  it('calls a model through the endpoint its own protocol names', async () => {
    const provider = await addGateway()
    await call('PATCH', `/api/assistant/providers/${provider.id}`, { endpoints: { anthropic: 'https://gw.test/anthropic' } })
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const updated = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${models.models[0]!.id}`, { protocol: 'anthropic' })
    expect(updated.model.protocol).toBe('anthropic')
    const urls: string[] = []
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      urls.push(String(url))
      bodies.push(String(init?.body ?? ''))
      return new Response(sse([`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`]), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events = await chatEvents({ message: 'hi' })
    await settleTurns()
    expect(events.some((event) => event.type === 'done')).toBe(true)
    // The provider's protocol is openai, so this address can only come from the model's own override.
    expect(urls).toEqual(['https://gw.test/anthropic/v1/messages'])
    // The same override decides what the web-search switch can ask for: only Anthropic has that tool.
    await chatEvents({ message: 'hi again', webSearch: true })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(bodies.at(-1)).toContain('web_search_20250305')
  })

  it('keeps a model following the provider when the protocol asked for is not one', async () => {
    await addGateway()
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const updated = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${models.models[0]!.id}`, { protocol: 'mistral' })
    expect(updated.model.protocol).toBeNull()
    const back = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${models.models[0]!.id}`, { protocol: 'gemini' })
    expect(back.model.protocol).toBe('gemini')
    const cleared = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${models.models[0]!.id}`, { protocol: null })
    expect(cleared.model.protocol).toBeNull()
  })

  it('says which address is unusable, and treats a half-typed scheme as no address', async () => {
    const provider = await addGateway()
    // A stray value in an optional field has to name itself: "bad request" is not a diagnosis.
    const response = await app.fetch(new Request(`http://localhost/api/assistant/providers/${provider.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-inkstone-client': '1' },
      body: JSON.stringify({ endpoints: { gemini: 'lgf5090' } }),
    }), env, ctx)
    const body = await response.json() as { error?: { message?: string } }
    expect(response.status).toBe(400)
    expect(body.error?.message).toMatch(/gemini/i)

    const seeded = await call<{ provider: AssistantProvider }>('PATCH', `/api/assistant/providers/${provider.id}`, {
      endpoints: { gemini: 'https://', anthropic: '  ' },
    })
    expect(seeded.provider.endpoints).toEqual({})
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
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    expect(await store.claimRun(created.conversation.id)).toBeTruthy()
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

  it('gives a claim back only to the run that took it', async () => {
    const { AssistantStore, RUN_LEASE_MS } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const conversation = await store.createConversation('Leased')
    const first = await store.claimRun(conversation.id)
    expect(first).toBeTruthy()
    // One claim at a time: the second request is refused instead of both starting a turn.
    expect(await store.claimRun(conversation.id)).toBeNull()

    // Once the lease has expired another run may take over. The old run finishing late must not delete
    // the newer claim — that would let a third turn start beside a live one.
    const second = await store.claimRun(conversation.id, Date.now() + RUN_LEASE_MS + 1)
    expect(second).toBeTruthy()
    await store.releaseRun(conversation.id, first!)
    expect(await store.isRunning(conversation.id)).toBe(true)
    await store.releaseRun(conversation.id, second!)
    expect(await store.isRunning(conversation.id)).toBe(false)
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
      // The naming pass that titles a brand-new conversation is a third call, made after the answer is
      // filed, to the same model on the same key.
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
    // The day totals now carry both the turn and the naming pass that followed it (the wire's canned
    // `FINAL_FRAMES` answers both calls, so each reports 20/6): two calls, 40 in, 12 out, one tool call.
    expect(usage.today.requests).toBe(3)
    expect(usage.today.inputTokens).toBe(40)
    expect(usage.today.outputTokens).toBe(12)
    expect(usage.today.toolCalls).toBe(1)
  })

  it('keeps the answer of a turn that asked for no tool', async () => {
    await useExampleModel()
    // A plain reply ends the turn on its own step, and that step's words used to be left behind by the
    // break that ends the loop: the row came back as "Done." or as an empty turn with a failure notice,
    // while the reader was watching the answer arrive.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    const events = await chatEvents({ message: 'what is on my list?' })
    await settleTurns()
    vi.unstubAllGlobals()
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: { role: string, content: string, status: string }[] }>(
      'GET', `/api/assistant/conversations/${conversationId}`,
    )
    expect(detail.messages[1]!.content).toContain('Nothing is on the list.')
    expect(detail.messages[1]!.status).toBe('complete')
  })
})

/**
 * The picture a turn draws.
 *
 * The whole path is what is pinned here, because each half of it can look finished while the reader still
 * sees nothing: the model has to ask for the picture, the worker has to call the reader's own image model
 * on its own wire, and the bytes have to end up on the answer. A picture that is generated and stored but
 * never attached is a chip in the transcript and no image, which is the failure this case exists to catch.
 */
describe('drawing a picture', () => {
  /** The model asks for an image, then answers once it has one. */
  const IMAGE_CALL_FRAMES = [
    openAiFrame({ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'image_generate', arguments: '{"prompt":"a cat on a keyboard"}' } }] } }] }),
    openAiFrame({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] }),
  ]

  /** A PNG header, which is all the signature check reads. */
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ])

  /** A second model on the example provider, marked by its purpose as the one that draws. */
  async function useImageModel(): Promise<void> {
    const provider = (await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')).providers[0]!
    const created = await call<{ model: AssistantModel }>('POST', '/api/assistant/models', {
      providerId: provider.id,
      model: 'gpt-image-1',
      label: 'Image',
    })
    await call('PATCH', `/api/assistant/models/${created.model.id}`, { purpose: 'image_generate' })
  }

  it('attaches what it drew to the answer, and serves it back', async () => {
    await useExampleModel()
    await useImageModel()
    const seen: string[] = []
    let chatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ b64_json: toBase64(PNG) }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      chatCalls++
      return new Response(sse(chatCalls === 1 ? IMAGE_CALL_FRAMES : FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))

    const events = await chatEvents({ message: 'draw me a cat' })
    await settleTurns()
    vi.unstubAllGlobals()

    // The image model is called on its own door, not the chat one.
    expect(seen).toContain('https://api.example.com/v1/images/generations')
    expect(events.some((event) => event.type === 'error')).toBe(false)

    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{
      messages: { role: string, attachments?: string[] }[],
      attachments: { id: string, kind: string, filename: string, mime: string }[],
    }>('GET', `/api/assistant/conversations/${conversationId}`)

    const answer = detail.messages.find((message) => message.role === 'assistant')!
    expect(answer.attachments).toHaveLength(1)
    const id = answer.attachments![0]!
    expect(detail.attachments.find((entry) => entry.id === id)).toMatchObject({
      kind: 'image', mime: 'image/png', filename: 'a cat on a keyboard.png',
    })

    // And it is served to the reader's own browser, which is what draws the `<img>` in the reply.
    const file = await app.fetch(new Request(`http://localhost/api/assistant/files/${id}`), env, ctx)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toContain('image/png')
  })

  it('refuses an image model that answers with a redirect', async () => {
    await useExampleModel()
    await useImageModel()
    const generation: Array<RequestInit | undefined> = []
    let chatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('/images/generations')) {
        generation.push(init)
        return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } })
      }
      chatCalls++
      return new Response(sse(chatCalls === 1 ? IMAGE_CALL_FRAMES : FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))

    const events = await chatEvents({ message: 'draw me a cat' })
    await settleTurns()
    vi.unstubAllGlobals()

    const failed = events.find((event) => event.type === 'tool' && event.tool?.status === 'error') as { tool: { error: string } } | undefined
    expect(failed?.tool.error).toContain('redirect')
    expect(generation).toHaveLength(1)
  })

  it('says which setting to fix when no image model is configured', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith('/images/generations')
      ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(sse(IMAGE_CALL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))

    const events = await chatEvents({ message: 'draw me a cat' })
    await settleTurns()
    vi.unstubAllGlobals()

    const failed = events.find((event) => event.type === 'tool' && event.tool?.status === 'error') as { tool: { error: string } } | undefined
    expect(failed?.tool.error).toContain('No image model is configured')
  })
})

/**
 * The program a turn runs.
 *
 * The path this pins is the one no unit test can see: the tool has to reach the model through the runner,
 * run for real inside the request, and come back as a chip the reader can open. A `code_execute` that is
 * wired up but never reaches the model looks exactly like a tool the model chose not to use, which is why
 * the schema the provider was sent is asserted as well as the result.
 *
 * The program is the real one the model wrote — `return 6 * 7` — and the interpreter is the real engine,
 * so what the chip shows is a number this deployment computed rather than a stub's answer.
 */
describe('running code', () => {
  const CODE_CALL_FRAMES = [
    openAiFrame({ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'code_execute', arguments: JSON.stringify({ code: 'console.log("working")\nreturn 6 * 7' }) } }] } }] }),
    openAiFrame({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] }),
  ]

  it('runs the model\'s own program and shows the reader the result', async () => {
    await useExampleModel()
    const bodies: string[] = []
    let chatCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      chatCalls++
      return new Response(sse(chatCalls === 1 ? CODE_CALL_FRAMES : FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))

    const events = await chatEvents({ message: 'what is 6 times 7?' })
    await settleTurns()
    vi.unstubAllGlobals()

    expect(events.some((event) => event.type === 'error')).toBe(false)
    // On the table for this turn: the tool reached the executor through the route.
    expect(bodies[0]).toContain('code_execute')

    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    const answer = detail.messages.find((message) => message.role === 'assistant')!
    const chip = answer.tools[0]!
    expect(chip.name).toBe('code_execute')
    expect(chip.status).toBe('success')
    // What the reader can open the chip to read, and what the model was handed back.
    expect(chip.result).toContain('42')
  })
})

/**
 * The thread the reader asked not to keep.
 *
 * The promise is a list of exclusions, so that is what is asserted: not in the everyday list, not in a
 * shortlist, not in the sidebar's counts, not in a backup, not shareable — and gone once its retention has
 * run out, with nothing it carried left behind. Each of those is a query somewhere, and the interesting
 * failure is the one clause that was forgotten rather than the feature that does not work at all.
 */
describe('temporary conversations', () => {
  /** One plain turn, which is what makes the conversation. */
  async function turn(ephemeral: boolean): Promise<string> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    const events = await chatEvents({ message: 'something private', ...(ephemeral ? { ephemeral: true } : {}) })
    await settleTurns()
    vi.unstubAllGlobals()
    return events.find((event) => event.type === 'start')!.conversationId!
  }

  it('is reachable by id and by nothing else', async () => {
    await useExampleModel()
    const id = await turn(true)

    // The reader is in it, so it opens — the row is stored, which is what keeps a reload from losing the
    // thought they were in the middle of.
    const detail = await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${id}`)
    expect(detail.conversation.ephemeral).toBe(true)

    const listed = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    expect(listed.conversations.map((entry) => entry.id)).not.toContain(id)
    // A shortlist is a listing too: starring it must not smuggle it back into view.
    await call('PATCH', `/api/assistant/conversations/${id}`, { starred: true })
    const starred = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?starred=1')
    expect(starred.conversations.map((entry) => entry.id)).not.toContain(id)
    // The numbers the sidebar draws come from the same rows, so they exclude it as well.
    expect((await call<{ unfiled: number }>('GET', '/api/assistant/folders')).unfiled).toBe(0)

    // A public link is the most kept a conversation can be.
    expect(await status('POST', `/api/assistant/conversations/${id}/share`, {})).toBe(404)
  })

  it('stays out of a backup, and so does everything it carried', async () => {
    await useExampleModel()
    const id = await turn(true)
    const payload = await call<{
      data: { conversations: { id: string }[], messages: { conversation_id: string }[] }
    }>('GET', '/api/assistant/export')
    expect(payload.data.conversations.map((entry) => entry.id)).not.toContain(id)
    expect(payload.data.messages.some((entry) => entry.conversation_id === id)).toBe(false)
  })

  it('is swept away once its retention has run out', async () => {
    await useExampleModel()
    const id = await turn(true)
    // Aged past the window, then the sweep the cron runs.
    sqlite.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(1, id)
    expect(await purgeExpiredEphemeralConversations(env.DB, env, Date.now())).toBe(1)
    expect(await status('GET', `/api/assistant/conversations/${id}`)).toBe(404)
    // Nothing it carried is left behind: a message or a draft outliving the thread is the exact trace the
    // feature exists not to leave.
    const messages = sqlite.prepare('SELECT count(*) AS n FROM chat_messages WHERE conversation_id = ?').get(id) as { n: number }
    expect(messages.n).toBe(0)
  })

  it('leaves a kept conversation alone, however old', async () => {
    await useExampleModel()
    const id = await turn(false)
    sqlite.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(1, id)
    expect(await purgeExpiredEphemeralConversations(env.DB, env, Date.now())).toBe(0)
    expect(await status('GET', `/api/assistant/conversations/${id}`)).toBe(200)
  })
})

/**
 * What a turn says when the model ran out of output room.
 *
 * The failure the reader reported: a thinking model spent the whole allowance on its trace, wrote no
 * answer, and the turn was filed with "check the model in Assistant settings" — advice that sends them to
 * look for a broken model when the model worked and the limit beside it was what cut the answer off.
 */
describe('a turn cut off at the output cap', () => {
  /** One provider call whose only frame states how it ended. */
  function capped(frames: string[]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })))
  }

  async function answerOf(events: ChatStreamEvent[]) {
    await settleTurns()
    vi.unstubAllGlobals()
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    return detail.messages[1]!
  }

  it('names the limit when thinking used the whole allowance', async () => {
    await useExampleModel()
    capped([
      openAiFrame({ choices: [{ index: 0, finish_reason: null, delta: { reasoning_content: 'weighing every option' } }] }),
      openAiFrame({ choices: [{ index: 0, finish_reason: 'length', delta: {} }] }),
    ])
    const answer = await answerOf(await chatEvents({ message: 'write me a long tutorial' }))
    expect(answer.status).toBe('error')
    // The trace is kept — it is all the turn produced, and it is what the reader watched arrive — but the
    // turn is not sold as an answer.
    expect(answer.reasoning).toBe('weighing every option')
    expect(answer.content).toBe('')
    expect(answer.error).toContain('never wrote an answer')
    expect(answer.error).toMatch(/\d+-token output allowance/)
    expect(answer.error).toContain('Max output tokens')
  })

  it('keeps the part that arrived and says where it stops', async () => {
    await useExampleModel()
    capped([openAiFrame({ choices: [{ index: 0, finish_reason: 'length', delta: { content: 'half an ans' } }] })])
    const answer = await answerOf(await chatEvents({ message: 'write me a long tutorial' }))
    expect(answer.status).toBe('error')
    expect(answer.content).toBe('half an ans')
    expect(answer.error).toContain('stops where it does')
    expect(answer.error).toContain('Max output tokens')
  })

  it('files a turn that thought and stopped as the trace, not as a settings problem', async () => {
    await useExampleModel()
    // No cap signal at all: the model simply stopped after its trace. The old wording blamed the model
    // and the key, which is the one thing that was working.
    capped([
      openAiFrame({ choices: [{ index: 0, finish_reason: null, delta: { reasoning_content: 'still thinking' } }] }),
      openAiFrame({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] }),
    ])
    const answer = await answerOf(await chatEvents({ message: 'write me a long tutorial' }))
    expect(answer.status).toBe('error')
    expect(answer.error).toContain('wrote only its thinking')
    expect(answer.error).not.toContain('check the model')
  })

  it('still reports an empty turn the plain way when nothing came back at all', async () => {
    await useExampleModel()
    capped([openAiFrame({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })])
    const answer = await answerOf(await chatEvents({ message: 'say something' }))
    expect(answer.status).toBe('error')
    expect(answer.content).toBe('')
    expect(answer.error).toContain('could not produce an answer')
  })
})

/**
 * Whose output number a turn spends.
 *
 * Two places hold one — the model's own field and the account-wide ceiling — and the turn took the lower
 * of the two, so a model the reader had set to 64000 still answered with the account's untouched 1024,
 * and was then reported as cut off at 1024. The number beside the model is the reader's answer; the
 * account's is what a model without one falls back to.
 */
describe('whose output number a turn spends', () => {
  async function firstModelId(): Promise<string> {
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    return models.models[0]!.id
  }

  /** One turn, with the body the provider was actually sent and the row it was filed as. */
  async function turn(frames: string[] = FINAL_FRAMES) {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events = await chatEvents({ message: 'write me a long tutorial' })
    await settleTurns()
    vi.unstubAllGlobals()
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    return { sent: bodies[0]!, answer: detail.messages[1]! }
  }

  const accountOutput = (tokens: number) => call('PATCH', '/api/assistant/settings', { limits: { maxOutputTokens: tokens } })

  it('sends the number set beside the model, not the account ceiling under it', async () => {
    await useExampleModel()
    const saved = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${await firstModelId()}`, { maxOutputTokens: 64_000 })
    expect(saved.model.maxOutputTokens).toBe(64_000)
    await accountOutput(2000)
    const { sent, answer } = await turn([openAiFrame({ choices: [{ index: 0, finish_reason: 'length', delta: { content: 'half an ans' } }] })])
    expect(sent.max_tokens).toBe(64_000)
    // And the notice names the number that really cut it, not whichever one the account happens to hold.
    expect(answer.error).toContain('64000-token output limit')
  })

  it('falls back to the account ceiling for a model that has none', async () => {
    await useExampleModel()
    const cleared = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${await firstModelId()}`, { maxOutputTokens: null })
    // Null is the reader emptying the field, so it must come back as unset rather than as the account's
    // current number frozen onto the row.
    expect(cleared.model.maxOutputTokens).toBe(null)
    await accountOutput(3000)
    const { sent } = await turn()
    expect(sent.max_tokens).toBe(3000)
  })

  it('stores the ceiling a model is created with instead of clamping it to 8192', async () => {
    await useExampleModel()
    const providers = await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')
    const created = await call<{ model: AssistantModel }>('POST', '/api/assistant/models', {
      providerId: providers.providers[0]!.id,
      model: 'deepseek-chat',
      maxOutputTokens: 64_000,
    })
    expect(created.model.maxOutputTokens).toBe(64_000)
    expect(created.model.maxInputTokens).toBe(null)
    expect(created.model.contextTokens).toBe(null)
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

/**
 * A stand-in for the Workers AI binding: deterministic, cheap, and shaped like the real answer.
 *
 * `AI.run` names its result type only at the call site, so the body builds the embedding list the
 * route reads and hands it back as that type. The texts come from the `{ text }` the route sends.
 */
function stubAi(model: string): { calls: string[][]; run: NonNullable<Env['AI']>['run'] } {
  const calls: string[][] = []
  return {
    calls,
    run: async <T>(requested: string, inputs: unknown): Promise<T> => {
      expect(requested).toBe(model)
      const { text } = inputs as { text: string[] }
      calls.push(text)
      return {
        data: text.map((line) => ({
          embedding: Array.from({ length: 8 }, (_, index) => {
            let hash = index + 1
            for (const character of line) hash = (hash * 31 + character.codePointAt(0)!) % 1024
            return hash / 1024
          }),
        })),
      } as T
    },
  }
}

describe('a stopped turn', () => {
  it('files the words that had already reached the reader', async () => {
    await useExampleModel()
    const { AssistantRunner } = await import('../src/worker/assistant/runner')
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const conversation = await store.createConversation('Stopped')
    expect(await store.claimRun(conversation.id)).toBeTruthy()
    const controller = new AbortController()
    // A model that has said part of the answer and then waits: the reader's stop is what ends it.
    const encoder = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'half an answer' } }] })}\n\n`))
          init?.signal?.addEventListener('abort', () => streamController.error(new Error('aborted')))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }))
    const runner = new AssistantRunner({ store, env, ftsEnabled: false, origin: 'http://localhost', settings: await store.getSettings() })
    const events: ChatStreamEvent[] = []
    for await (const event of runner.chat({ conversationId: conversation.id, message: 'say something', signal: controller.signal })) {
      events.push(event)
      if (event.type === 'text') {
        controller.abort()
        // What the stop button does: the lease is released, so the turn ends even where the platform
        // does not echo the dropped connection back into the isolate.
        await store.releaseRun(conversation.id)
      }
    }
    vi.unstubAllGlobals()

    const done = events.find((event) => event.type === 'done') as { finalMessage: AssistantMessage } | undefined
    expect(done?.finalMessage.status).toBe('cancelled')
    // The transcript is the row, not the event: a cancelled answer keeps the text the reader saw.
    const stored = (await store.messages(conversation.id)).find((entry) => entry.role === 'assistant')
    expect(stored?.status).toBe('cancelled')
    expect(stored?.content).toContain('half an answer')
  })
})

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

  it('narrows a tag filter to the whole subtree, the way the folder filter does', async () => {
    const TAG_WORKFLOW = oid('tw1')
    addTag(TAG_RED, 'work')
    addTag(TAG_BLUE, 'work/meeting')
    addTag(TAG_WORKFLOW, 'workflow')
    const parent = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Roadmap' })
    const child = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Standup' })
    const unrelated = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Groceries' })
    await call('POST', `/api/assistant/conversations/${parent.conversation.id}/tags`, { tagId: TAG_RED })
    await call('POST', `/api/assistant/conversations/${child.conversation.id}/tags`, { tagId: TAG_BLUE })
    await call('POST', `/api/assistant/conversations/${unrelated.conversation.id}/tags`, { tagId: TAG_WORKFLOW })

    // `work` now answers for `work/meeting` too, and a tag that merely starts with the same letters
    // stays out: the `/` boundary is what separates the two.
    const subtree = await call<{ conversations: AssistantConversation[] }>('GET', `/api/assistant/conversations?tag=${TAG_RED}`)
    expect(subtree.conversations.map((entry) => entry.id).sort()).toEqual(
      [child.conversation.id, parent.conversation.id].sort(),
    )
    const exact = await call<{ conversations: AssistantConversation[] }>('GET', `/api/assistant/conversations?tag=${TAG_BLUE}`)
    expect(exact.conversations.map((entry) => entry.id)).toEqual([child.conversation.id])
  })

  it('orders the chat tag list case-insensitively and reports which tags are pinned', async () => {
    addTag(TAG_RED, 'Zebra')
    addTag(TAG_BLUE, 'apple')
    sqlite.prepare('UPDATE tags SET is_pinned = 1 WHERE id = ?1 AND user_id = ?2').run(TAG_BLUE, USER)

    const tags = await call<{ tags: { id: string, name: string, isPinned?: boolean }[] }>('GET', '/api/assistant/tags')
    expect(tags.tags.map((tag) => tag.name)).toEqual(['apple', 'Zebra'])
    expect(tags.tags.find((tag) => tag.name === 'apple')?.isPinned).toBe(true)
    expect(tags.tags.find((tag) => tag.name === 'Zebra')?.isPinned).toBe(false)
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

describe('projects', () => {
  it('keeps the brief and knowledge a project is created with', async () => {
    addFolder(FOLDER_A, '项目')
    const created = await call<{ project: Project }>('POST', '/api/assistant/projects', {
      name: '调研',
      description: '关于 X 的调研',
      instructions: 'Always answer in Chinese.',
      noteScope: [FOLDER_A],
    })
    expect(created.project.instructions).toBe('Always answer in Chinese.')
    expect(created.project.noteScope).toEqual([FOLDER_A])
    expect(created.project.description).toBe('关于 X 的调研')

    // Both read paths spell the columns out by hand, so the list has to carry them too.
    const list = await call<{ projects: Project[] }>('GET', '/api/assistant/projects')
    const row = list.projects.find((entry) => entry.id === created.project.id)
    expect(row?.instructions).toBe('Always answer in Chinese.')
    expect(row?.noteScope).toEqual([FOLDER_A])
  })

  it('drops a knowledge entry that is not a folder id', async () => {
    const created = await call<{ project: Project }>('POST', '/api/assistant/projects', {
      name: 'No knowledge',
      noteScope: ['not-an-id', 42],
    })
    expect(created.project.noteScope).toEqual([])
  })

  /**
   * A brief emptied is a save, not a bad request.
   *
   * The project form sends the whole draft, and only the name is required of it, so a reader clearing the
   * standing brief used to have every field of their edit refused with it.
   */
  it('clears a project brief the reader empties', async () => {
    const created = await call<{ project: Project }>('POST', '/api/assistant/projects', {
      name: 'Briefed',
      instructions: 'Answer in Chinese.',
    })
    expect(created.project.instructions).toBe('Answer in Chinese.')
    const body = {
      name: 'Briefed',
      description: 'What it is about',
      instructions: '',
      noteScope: [],
      modelId: null,
    }
    const saved = await call<{ project: Project }>('PATCH', `/api/assistant/projects/${created.project.id}`, body)
    expect(saved.project.instructions).toBe('')
    expect(saved.project.description).toBe('What it is about')
    const list = await call<{ projects: Project[] }>('GET', '/api/assistant/projects')
    const row = list.projects.find((entry) => entry.id === created.project.id)!
    expect(row.instructions).toBe('')
    expect(row.description).toBe('What it is about')
  })

  it('moves a conversation into a project and back out', async () => {
    const project = await call<{ project: Project }>('POST', '/api/assistant/projects', { name: 'Filing' })
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Member' })
    const moved = await call<{ conversation: AssistantConversation }>('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { projectId: project.project.id })
    expect(moved.conversation.projectId).toBe(project.project.id)
    await call('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { projectId: null })
    const after = await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${created.conversation.id}`)
    // The read path omits the field rather than spelling null, so absence is the "left the project" answer.
    expect(after.conversation.projectId ?? null).toBeNull()
  })

  it('filters conversations by project and counts them per project', async () => {
    const project = await call<{ project: Project }>('POST', '/api/assistant/projects', { name: 'Counting' })
    const inside = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Inside' })
    const outside = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Outside' })
    await call('PATCH', `/api/assistant/conversations/${inside.conversation.id}`, { projectId: project.project.id })

    const filtered = await call<{ conversations: AssistantConversation[] }>('GET', `/api/assistant/conversations?project=${project.project.id}`)
    expect(filtered.conversations.map((entry) => entry.id)).toEqual([inside.conversation.id])
    const unfiled = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?project=none')
    expect(unfiled.conversations.map((entry) => entry.id)).toContain(outside.conversation.id)
    expect(unfiled.conversations.map((entry) => entry.id)).not.toContain(inside.conversation.id)

    const summary = await call<{ projects: { id: string, count: number }[], unfiled: number }>('GET', '/api/assistant/projects/summary')
    expect(summary.projects.find((row) => row.id === project.project.id)?.count).toBe(1)
    expect(summary.unfiled).toBeGreaterThanOrEqual(1)
  })
})

describe('archiving', () => {
  it('hides a put-away conversation from the everyday list and leaves the thread whole', async () => {
    const kept = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Kept' })
    const put = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Put away' })
    expect(put.conversation.archived, 'a new conversation starts in the list').toBe(false)
    await call('PATCH', `/api/assistant/conversations/${put.conversation.id}`, { archived: true })

    // `archived=0` is the everyday list; an unqualified read still returns everything, which is what the
    // backup and the assistant's own search rely on — put away is not gone.
    const everyday = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?archived=0')
    expect(everyday.conversations.map((entry) => entry.id)).toEqual([kept.conversation.id])
    const all = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    expect(all.conversations.map((entry) => entry.id).sort()).toEqual([kept.conversation.id, put.conversation.id].sort())
    const archived = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?archived=1')
    expect(archived.conversations.map((entry) => entry.id)).toEqual([put.conversation.id])

    // The thread still opens and still carries its flag: archiving is not deleting.
    const thread = await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${put.conversation.id}`)
    expect(thread.conversation.archived).toBe(true)

    await call('PATCH', `/api/assistant/conversations/${put.conversation.id}`, { archived: false })
    const back = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?archived=0')
    expect(back.conversations.map((entry) => entry.id).sort()).toEqual([kept.conversation.id, put.conversation.id].sort())
  })

  it('survives a backup round-trip', async () => {
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Put away and backed up' })
    const id = created.conversation.id
    await call('PATCH', `/api/assistant/conversations/${id}`, { archived: true })
    const payload = await call('GET', '/api/assistant/export') as Record<string, unknown>
    await call('DELETE', `/api/assistant/conversations/${id}`)
    await call('POST', '/api/assistant/import', payload)
    // A column the import does not name comes back as the column default, so the flag has to be in the
    // export's own list or an archived conversation would silently reappear in the everyday list.
    const restored = (await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?archived=1'))
      .conversations.find((entry) => entry.id === id)
    expect(restored?.archived).toBe(true)
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

  it('keeps the project a fact was filed under, and unfiles a project the backup did not bring', async () => {
    const project = await call<{ project: { id: string } }>('POST', '/api/assistant/projects', { name: 'Client A' })
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    // No route files a fact under a project — the reader's own additions belong to the account — so the
    // row is written the way a turn inside the project writes it.
    const filed = await store.insertMemory({
      content: 'The budget review is monthly', category: 'fact', source: 'assistant', projectId: project.project.id,
    })
    const payload = await call('GET', '/api/assistant/export') as { data: { projects: unknown[], memories: unknown[] } }

    // A restore that carries the project keeps the fact where it was filed. `project_id` is nullable, so a
    // forgotten column would not drop the row the way a NOT NULL one does — it would quietly promote every
    // project's facts to the account's own, which is the failure nobody would notice until they leaked.
    asUser(OTHER)
    await call('POST', '/api/assistant/import', payload)
    const restored = await call<{ memories: AssistantMemory[] }>('GET', '/api/assistant/memories')
    expect(restored.memories.find((memory) => memory.id === filed.id)?.projectId).toBe(project.project.id)

    // One that does not bring the project leaves the fact unfiled, rather than filing it under a project
    // that is not there: a fact under a missing project is a fact no turn can ever recall.
    asUser('0123456789abcdefghjkmnpqrv')
    await call('POST', '/api/assistant/import', { ...payload, data: { ...payload.data, projects: [] } })
    const orphaned = await call<{ memories: AssistantMemory[] }>('GET', '/api/assistant/memories')
    expect(orphaned.memories.find((memory) => memory.id === filed.id)?.projectId).toBeNull()
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

  it('carries a project brief, the threads filed under it, and what each answer came from', async () => {
    const folder = oid('bkf1')
    addFolder(folder, 'Client knowledge')
    const project = await call<{ project: Project }>('POST', '/api/assistant/projects', {
      name: 'Client A', description: 'the engagement', instructions: 'Answer in French.', noteScope: [folder],
    })
    const conversation = (await call<{ conversation: AssistantConversation }>(
      'POST', '/api/assistant/conversations', { title: 'Filed under A' },
    )).conversation
    await call('PATCH', `/api/assistant/conversations/${conversation.id}`, { projectId: project.project.id })
    // A message is only worth restoring with the pages it leaned on and the verdict it earned, so both
    // travel with it; a fork only means something with the thread it came from.
    const messageId = oid('bkm1')
    insert('chat_messages', {
      id: messageId, conversation_id: conversation.id, role: 'assistant', content: 'Bonjour',
      reasoning: '', tools: '[]', attachments: '[]', status: 'complete', source: 'chat',
      input_tokens: 3, output_tokens: 2, duration_ms: 10, model_label: 'example-model',
      sources: JSON.stringify([{ url: 'https://example.com/a', title: 'A' }]), feedback: 'up',
      created_at: Date.now(),
    })
    const fork = (await call<{ conversation: AssistantConversation }>(
      'POST', `/api/assistant/conversations/${conversation.id}/fork`, { messageId, title: 'Branch' },
    )).conversation
    const memory = (await call<{ memory: AssistantMemory }>('POST', '/api/assistant/memories', {
      content: 'The engagement is monthly', category: 'fact',
    })).memory
    const noteId = oid('bkn1')
    sqlite.prepare('UPDATE chat_memories SET note_id = ? WHERE id = ?').run(noteId, memory.id)

    const payload = await call<Record<string, unknown>>('GET', '/api/assistant/export')
    asUser(OTHER)
    await call('POST', '/api/assistant/import', payload)

    const projects = await call<{ projects: Project[] }>('GET', '/api/assistant/projects')
    const restored = projects.projects.find((entry) => entry.id === project.project.id)!
    expect(restored.instructions).toBe('Answer in French.')
    expect(restored.description).toBe('the engagement')
    // A knowledge scope names notebook folders, and those are not in this backup: a folder this account
    // does not have is dropped rather than left as a dangling id that reads nothing.
    expect(restored.noteScope).toEqual([])
    const threads = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    expect(threads.conversations.find((entry) => entry.id === conversation.id)?.projectId).toBe(project.project.id)
    expect(threads.conversations.find((entry) => entry.id === fork.id)?.parentId).toBe(conversation.id)
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversation.id}`)
    const restoredMessage = detail.messages.find((entry) => entry.id === messageId)!
    expect(restoredMessage.sources?.map((entry) => entry.url)).toEqual(['https://example.com/a'])
    expect(restoredMessage.feedback).toBe('up')
    const memories = await call<{ memories: AssistantMemory[] }>('GET', '/api/assistant/memories')
    expect(memories.memories.find((entry) => entry.id === memory.id)?.noteId).toBe(noteId)

    // Restored beside the folder it names, the same file keeps the scope: the validation drops what this
    // notebook cannot resolve, and a restore into the account that owns the folder resolves it.
    const keptNote = oid('bkn2')
    sqlite.prepare(
      `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, created_at, updated_at)
       VALUES (?, ?, 'Kept page', 'kept page', 'still in this notebook', '', 1, 1)`,
    ).run(keptNote, USER)
    for (const row of (payload.data as Record<string, unknown>).projects as Record<string, unknown>[]) {
      row.note_ids = JSON.stringify([keptNote, oid('bkn3')])
    }
    asUser(USER)
    await call('DELETE', `/api/assistant/projects/${project.project.id}`)
    await call('POST', '/api/assistant/import', payload)
    const back = await call<{ projects: Project[] }>('GET', '/api/assistant/projects')
    expect(back.projects.find((entry) => entry.id === project.project.id)?.noteScope).toEqual([folder])
    // Named pages follow the folders' rule — kept when this notebook has them, dropped when it does not —
    // and the project row rides along with the answer: the column is NOT NULL and is written by the same
    // insert, so a restore that never read the list loses the whole project, and with it every memory and
    // thread filed under the brief.
    expect(back.projects.find((entry) => entry.id === project.project.id)?.noteIds).toEqual([keptNote])
  })

  it('is idempotent and never writes a provider key into the file', async () => {
    await call('POST', '/api/assistant/providers', {
      label: 'Keyed', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-backup-secret-1234',
    })
    const conversation = (await call<{ conversation: AssistantConversation }>(
      'POST', '/api/assistant/conversations', { title: 'Twice' },
    )).conversation
    insert('chat_messages', {
      id: oid('bkt1'), conversation_id: conversation.id, role: 'user', content: 'hello',
      reasoning: '', tools: '[]', attachments: '[]', status: 'complete', source: 'chat',
      input_tokens: 1, output_tokens: 0, duration_ms: 0, model_label: '', created_at: Date.now(),
    })
    const payload = await call<Record<string, unknown>>('GET', '/api/assistant/export')
    // A backup is a file a reader can hand to somebody else: the ciphertext and the plaintext are both
    // configuration of this deployment, not content of the reader's.
    const file = JSON.stringify(payload)
    expect(file).not.toContain('sk-backup-secret-1234')
    expect(file).not.toContain('key_ciphertext')

    asUser(OTHER)
    const first = await call<{ imported: { messages: number } }>('POST', '/api/assistant/import', payload)
    const second = await call<{ imported: { messages: number } }>('POST', '/api/assistant/import', payload)
    expect(second.imported.messages).toBe(0)
    const count = (sqlite.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?').get(OTHER) as { n: number }).n
    expect(count).toBe(first.imported.messages)
    const threads = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    expect(threads.conversations.filter((entry) => entry.id === conversation.id)).toHaveLength(1)
  })

  it('never replaces a newer local edit with an older copy', async () => {
    const conversation = (await call<{ conversation: AssistantConversation }>(
      'POST', '/api/assistant/conversations', { title: 'Original' },
    )).conversation
    const task = (await call<{ task: Task }>('POST', '/api/assistant/tasks', { title: 'File it' })).task
    const payload = await call<Record<string, unknown>>('GET', '/api/assistant/export')
    await call('PATCH', `/api/assistant/conversations/${conversation.id}`, { title: 'Renamed here' })
    await call('PATCH', `/api/assistant/tasks/${task.id}`, { title: 'Renamed task' })

    // The same file re-imported over the copy it came from: it must merge, not roll back the newer edits.
    await call('POST', '/api/assistant/import', payload)
    const threads = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    expect(threads.conversations.find((entry) => entry.id === conversation.id)?.title).toBe('Renamed here')
    const tasks = await call<{ tasks: Task[] }>('GET', '/api/assistant/tasks')
    expect(tasks.tasks.find((entry) => entry.id === task.id)?.title).toBe('Renamed task')
  })

  it('settles a project name another account already holds instead of failing the file', async () => {
    const project = (await call<{ project: Project }>('POST', '/api/assistant/projects', { name: 'Client B' })).project
    const conversation = (await call<{ conversation: AssistantConversation }>(
      'POST', '/api/assistant/conversations', { title: 'Under B' },
    )).conversation
    await call('PATCH', `/api/assistant/conversations/${conversation.id}`, { projectId: project.id })
    const payload = await call<Record<string, unknown>>('GET', '/api/assistant/export')

    asUser(OTHER)
    await call('POST', '/api/assistant/projects', { name: 'Client B' })
    const result = await call<{ imported: { projects: number } }>('POST', '/api/assistant/import', payload)
    expect(result.imported.projects).toBe(1)
    const projects = await call<{ projects: Project[] }>('GET', '/api/assistant/projects')
    const restored = projects.projects.find((entry) => entry.id === project.id)!
    expect(restored.name).toBe('Client B (imported)')
    // The thread the file filed under that project still points at it, which a skipped project could not.
    const threads = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations')
    expect(threads.conversations.find((entry) => entry.id === conversation.id)?.projectId).toBe(project.id)
  })

  it('refuses a file from another app', async () => {
    expect(await status('POST', '/api/assistant/import', { format: 'not-inkstone', version: 1, data: {} })).toBe(400)
  })
})

async function uploadFile(
  name: string,
  content: string | Uint8Array,
  mime: string,
  extractedText?: string,
): Promise<{ attachment: { id: string, kind: string, key: string, filename: string, size: number } }> {
  const form = new FormData()
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  form.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), name)
  if (extractedText) form.append('text', extractedText)
  const response = await app.fetch(new Request('http://localhost/api/assistant/files', { method: 'POST', body: form }), env, ctx)
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
      env, ctx,
    )
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('text/markdown')
    expect(await served.text()).toContain('读者提到的重点')

    const removed = await call<{ deleted: boolean }>('DELETE', `/api/assistant/files/${uploaded.attachment.id}`)
    expect(removed.deleted).toBe(true)
    expect(chatR2.objects.has(uploaded.attachment.key)).toBe(false)
  })

  it('never renders an uploaded document against this origin', async () => {
    // The mime comes from the uploader, so a file claiming to be HTML must not come back as a page.
    const html = await uploadFile('page.html', '<img src=x onerror=alert(1)>', 'text/html')
    const served = await app.fetch(
      new Request(`http://localhost/api/assistant/files/${html.attachment.id}`),
      env, ctx,
    )
    expect(served.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')

    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
    const picture = await uploadFile('shot.png', png, 'image/png')
    const shown = await app.fetch(
      new Request(`http://localhost/api/assistant/files/${picture.attachment.id}`),
      env, ctx,
    )
    expect(shown.headers.get('content-disposition')).toMatch(/^inline;/)
    // The composer's own download link asks for it, and a picture has to be forced out too.
    const forced = await app.fetch(
      new Request(`http://localhost/api/assistant/files/${picture.attachment.id}?download=1`),
      env, ctx,
    )
    expect(forced.headers.get('content-disposition')).toMatch(/^attachment;/)
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
    // Every call is stubbed: what this test is about is the file travelling with the turn, and a turn left
    // to the real network spent ten seconds failing to reach a host that does not answer.
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events = await chatEvents({ message: '我附的文件里要买什么？', attachments: [uploaded.attachment.id] })
    await settleTurns()
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    const userTurn = detail.messages.find((entry) => entry.role === 'user')!
    expect(userTurn.attachments).toEqual([uploaded.attachment.id])
    // The stored row is what the reader typed; the file joins the model's view, not the transcript.
    expect(userTurn.content).toBe('我附的文件里要买什么？')
    expect(bodies.join('\n')).toContain('买咖啡豆和燕麦奶')
    // The body the model is fed carries the file, so a second turn can still be told what it said.
    bodies.length = 0
    await chatEvents({ conversationId, message: '再说一遍清单里的东西' })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(bodies.join('\n')).toContain('买咖啡豆和燕麦奶')
  })

  it('feeds a document the browser read into the model, and names one it could not', async () => {
    await useExampleModel()
    const read = await uploadFile('manual.pdf', new Uint8Array([37, 80, 68, 70]), 'application/pdf', '第一章 导言：燕麦奶比牛奶便宜')
    const blank = await uploadFile('scan.pdf', new Uint8Array([37, 80, 68, 70]), 'application/pdf')
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    await chatEvents({ message: '这两份文件讲了什么？', attachments: [read.attachment.id, blank.attachment.id] })
    await settleTurns()
    vi.unstubAllGlobals()
    const body = bodies.join('\n')
    expect(body).toContain('燕麦奶比牛奶便宜')
    expect(body).toContain('text read from the file')
    // The one the browser could not read is named rather than silently presented as empty.
    expect(body).toContain('not text; contents not read')
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
    // Stubbed: what is being read here is which ids survive the gate, and a turn left to the real network
    // would spend its time failing to reach a host rather than answering.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    const events = await chatEvents({ message: '附件呢？', attachments: ['nope', '../etc/passwd', '0123456789abcdefghjkmnpqrs'] })
    await settleTurns()
    vi.unstubAllGlobals()
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    // A shape that is not an id never becomes a row, and neither does an id the reader does not own.
    expect(detail.messages.find((entry) => entry.role === 'user')?.attachments ?? []).toEqual([])
  })

  it('carries the attachment ids through a backup round-trip', async () => {
    const uploaded = await uploadFile('keep.txt', '要留在备份里', 'text/plain')
    await useExampleModel()
    // Stubbed for the same reason as the turn above: the round trip is the subject here, not reachability.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    const events = await chatEvents({ message: '记住这个附件', attachments: [uploaded.attachment.id] })
    await settleTurns()
    vi.unstubAllGlobals()
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

describe('large image encoding', () => {
  it('base64s a big picture without exhausting the string builder', async () => {
    await useExampleModel()
    // 200 KB is 25 chunks of the encoder's step: enough to blow a one-shot String.fromCharCode(...),
    // which is the failure a reader would see as a turn that simply refuses to answer.
    const bytes = new Uint8Array(200_000).map((_, index) => index % 251)
    const uploaded = await uploadFile('big.png', bytes, 'image/png')
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events = await chatEvents({ message: '这张大图里是什么？', attachments: [uploaded.attachment.id] })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(bodies[0]).toContain('"type":"image_url"')
    expect((bodies[0].match(/data:image\/png;base64,/) ?? []).length).toBe(1)
    expect(bodies[0].length).toBeGreaterThan(uploaded.attachment.size)
  })
})

describe('upstream reachability', () => {
  it('says the model was unreachable rather than blaming the key when the request cannot leave', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const events = await chatEvents({ message: '在吗？' })
    await settleTurns()
    vi.unstubAllGlobals()
    const failure = events.find((event) => event.type === 'error')
    // The wire layer wraps a refused request as an unreachable provider; either way the reader is not
    // sent to retype a key that was never the problem.
    expect(failure?.message).toContain('fetch failed')
    expect(failure?.message).not.toContain('Check the model and key')
  })
})

describe('oversized search terms', () => {
  // SQLite compiles a LIKE pattern into a program and refuses one longer than 50 000 characters with
  // `LIKE or GLOB pattern too complex`. A chat body may be 64 KB, and a pasted log line or base64 blob
  // arrives as one unbroken run, so the refusal was reachable from the composer with no attachment.
  it('answers a term longer than SQLite can compile instead of failing the turn', async () => {
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    await store.insertMemory({ content: '读者喜欢用 ZEBRAZEBRA 前缀命名文件', category: 'preference', source: 'manual' })
    await store.insertMemory({ content: `${'A'.repeat(20_000)}`, category: 'preference', source: 'manual' })
    const huge = `ZEBRAZEBRA${'x'.repeat(70_000)}TAILMARKTAIL`
    expect(await store.searchMemories(huge, 8)).toEqual([])
    expect(await store.listMemories({ query: huge })).toEqual([])
    expect(await store.listConversations(huge)).toEqual([])
    expect(await store.listTasks({ query: huge })).toEqual([])
    // The ceiling is a truncation, not a switch: a long-but-ordinary query still matches what contains
    // it, and an ordinary one still recalls the memory, so the guard cannot silently disable search.
    expect((await store.searchMemories('A'.repeat(20_000), 8)).map((memory) => memory.content.length))
      .toEqual([20_000])
    expect((await store.searchMemories('ZEBRAZEBRA', 8)).map((memory) => memory.content))
      .toEqual(['读者喜欢用 ZEBRAZEBRA 前缀命名文件'])
  })
})

describe('turn pins from the composer', () => {
  it('tells the model which tools the reader asked for, and drops the ones that do not exist', async () => {
    await useExampleModel()
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events = await chatEvents({
      message: '找一下会议记录',
      tools: ['search_notes', 'delete_the_whole_vault', 'search_notes'],
      scopes: [
        { kind: 'tag', id: 'g'.repeat(26), name: 'TAGPIN-9x' },
        { kind: 'tag', id: 'not-an-id', name: 'FORGEPIN-7y' },
        { kind: 'nonsense', id: 'g'.repeat(26), name: 'FORGEPIN-7y' },
      ],
    })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(events.some((event) => event.type === 'done')).toBe(true)
    const prompt = bodies[0] ?? ''
    expect(prompt).toContain('search_notes')
    // A name the assistant cannot call is not something to tell the model about, and an id that is not
    // an id never reaches the scope either.
    expect(prompt).not.toContain('delete_the_whole_vault')
    // A marker that appears nowhere else: the tag name reaches the model only through this turn's scope line.
    expect(prompt).toContain('TAGPIN-9x')
    expect(prompt).not.toContain('FORGEPIN-7y')
  })
})

describe('model editor fields', () => {
  /** The route used to hand-copy its own list of accepted fields, so a new column silently never saved. */
  it('round-trips every field the editor can change', async () => {
    await useExampleModel()
    const listed = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/settings')
    const id = listed.models[0]!.id
    const cases: [string, Record<string, unknown>, string, unknown][] = [
      ['label', { label: 'DeepSeek Flash' }, 'label', 'DeepSeek Flash'],
      ['purpose', { purpose: 'image_generate' }, 'purpose', 'image_generate'],
      ['purpose rejected', { purpose: 'embedding' }, 'purpose', 'image_generate'],
      ['kind', { kind: 'rerank' }, 'kind', 'rerank'],
      ['supportsTools', { supportsTools: false }, 'supportsTools', false],
      ['maxInputTokens', { maxInputTokens: 128_000 }, 'maxInputTokens', 128_000],
      ['topP', { topP: 0.85 }, 'topP', 0.85],
      ['topP off', { topP: null }, 'topP', null],
      ['temperature off', { temperature: null }, 'temperature', null],
      ['customParams', { customParams: [{ name: 'reasoning_effort', type: 'number', value: '7' }] }, 'customParams', [{ name: 'reasoning_effort', type: 'number', value: '7' }]],
    ]
    for (const [name, patch, field, expected] of cases) {
      const echoed = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${id}`, patch)
      expect(echoed.model[field as keyof AssistantModel], `${name} (echo)`).toEqual(expected)
      const after = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/settings')
      const model = after.models.find((entry) => entry.id === id)!
      expect(model[field as keyof typeof model], name).toEqual(expected)
    }
  })

  /**
   * The save the editor really makes: one request carrying the whole draft.
   *
   * `AssistantModelTab` hands `updateModel` the draft object, so a field the reader never typed — the
   * currency of a model nobody has priced, which every new model has as `''` — used to refuse the request
   * and lose every other field with it. Saving one field at a time, as the case above does, cannot see it.
   */
  it('saves the whole draft the editor submits, currency and all', async () => {
    await useExampleModel()
    const listed = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/settings')
    const before = listed.models[0]!
    expect(before.priceCurrency).toBe('')
    const draft = {
      label: `${before.label} edited`,
      purpose: before.purpose,
      kind: before.kind,
      supportsTools: before.supportsTools,
      reasoning: before.reasoning,
      vision: before.vision,
      contextTokens: 1_048_576,
      maxInputTokens: 131_072,
      maxOutputTokens: 16_384,
      modalities: before.modalities,
      temperature: before.temperature,
      topP: before.topP,
      customParams: before.customParams,
      protocol: before.protocol,
      fallbackModelId: before.fallbackModelId,
      inputPrice: 0.25,
      outputPrice: 1,
      priceCurrency: '',
    }
    const saved = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${before.id}`, draft)
    expect(saved.model.priceCurrency).toBe('')
    const after = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/settings')
    const model = after.models.find((entry) => entry.id === before.id)!
    expect(model.label).toBe(`${before.label} edited`)
    expect(model.contextTokens).toBe(1_048_576)
    expect(model.maxInputTokens).toBe(131_072)
    expect(model.maxOutputTokens).toBe(16_384)
    expect(model.inputPrice).toBe(0.25)
    // A price without a currency stays without one: nothing here may invent a currency for it.
    expect(model.priceCurrency).toBe('')
    // A code is a code, however it was typed, and emptying the box again is an edit of its own.
    const priced = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${before.id}`, { priceCurrency: 'eur' })
    expect(priced.model.priceCurrency).toBe('EUR')
    const unpriced = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${before.id}`, { priceCurrency: '' })
    expect(unpriced.model.priceCurrency).toBe('')
    expect(await status('PATCH', `/api/assistant/models/${before.id}`, { priceCurrency: 7 })).toBe(400)
  })

  it('sends the reader\u2019s sampling and extra fields, and never lets a parameter take over the request', async () => {
    await useExampleModel()
    const listed = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/settings')
    const id = listed.models[0]!.id
    await call('PATCH', `/api/assistant/models/${id}`, {
      temperature: null,
      topP: 0.4,
      customParams: [
        { name: 'reasoning_effort', type: 'string', value: 'high' },
        { name: 'stream', type: 'boolean', value: 'false' },
        { name: 'messages', type: 'string', value: '[]' },
      ],
    })
    let sent = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      // Keep the first request only: the naming pass that follows a new conversation's answer is a second
      // call, and this test is about what the reader's sampling settings did to the turn's own request.
      if (!sent) sent = String(init?.body ?? '')
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events = await chatEvents({ message: 'hi' })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(events.some((event) => event.type === 'done')).toBe(true)
    expect(sent).toContain('"top_p":0.4')
    expect(sent).toContain('"reasoning_effort":"high"')
    expect(sent).not.toContain('"temperature"')
    // The reader's own parameter may not replace the request's skeleton.
    expect(JSON.parse(sent).stream).toBe(true)
    expect(Array.isArray(JSON.parse(sent).messages)).toBe(true)
  })

  it('stops offering tools to a model that cannot use them', async () => {
    await useExampleModel()
    const listed = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/settings')
    const id = listed.models[0]!.id
    await call('PATCH', `/api/assistant/models/${id}`, { supportsTools: false })
    let sent = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sent = String(init?.body ?? '')
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    await chatEvents({ message: 'hi' })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(sent).not.toContain('"tools"')
  })
})

describe('skill library', () => {
  it('creates, searches, edits and deletes the reader\u2019s own skills', async () => {
    const created = await call<{ skill: AssistantSkill }>('POST', '/api/assistant/skills', {
      title: '周报', content: '把这周做的事写成周报，按项目分段。', group: '写作', icon: '📝',
    })
    expect(created.skill.id).toBeTruthy()
    expect(created.skill.group).toBe('写作')
    expect(created.skill.icon).toBe('📝')

    const found = await call<{ skills: AssistantSkill[] }>('GET', '/api/assistant/skills?q=分段')
    expect(found.skills.map((entry) => entry.id)).toEqual([created.skill.id])

    const edited = await call<{ skill: AssistantSkill }>('PATCH', `/api/assistant/skills/${created.skill.id}`, { title: '每周周报', icon: '🗓️' })
    expect(edited.skill.title).toBe('每周周报')
    expect(edited.skill.content).toContain('分段')
    expect(edited.skill.icon).toBe('🗓️')

    expect((await call<{ deleted: boolean }>('DELETE', `/api/assistant/skills/${created.skill.id}`)).deleted).toBe(true)
    expect((await call<{ skills: AssistantSkill[] }>('GET', '/api/assistant/skills')).skills).toEqual([])
    expect((await call<{ deleted: boolean }>('DELETE', `/api/assistant/skills/${created.skill.id}`)).deleted).toBe(false)
  })

  it('refuses an empty skill and an over-long one is cut, not stored whole', async () => {
    expect(await status('POST', '/api/assistant/skills', { title: '  ', content: '  ' })).toBe(400)
    // Either half alone is enough: a paragraph with no name is still a skill the reader will want back.
    const contentOnly = await call<{ skill: AssistantSkill }>('POST', '/api/assistant/skills', { content: '只要正文，标题以后再说。' })
    expect(contentOnly.skill.content).toContain('只要正文')
    expect(contentOnly.skill.title.length).toBeGreaterThan(0)
    const titleOnly = await call<{ skill: AssistantSkill }>('POST', '/api/assistant/skills', { title: '只有标题' })
    expect(titleOnly.skill.title).toBe('只有标题')
    // A skill with no icon carries an empty one rather than a null the reader would have to guard against.
    expect(titleOnly.skill.icon).toBe('')
    const long = await call<{ skill: AssistantSkill }>('POST', '/api/assistant/skills', {
      title: 'x'.repeat(400), content: 'y'.repeat(10_000), icon: '🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀',
    })
    expect(long.skill.title.length).toBeLessThanOrEqual(MAX_SKILL_TITLE_CHARS)
    expect(long.skill.content.length).toBeLessThanOrEqual(MAX_SKILL_CONTENT_CHARS)
    expect(long.skill.icon.length).toBeLessThanOrEqual(MAX_SKILL_ICON_CHARS)
  })

  it('keeps one account\u2019s skills out of another\u2019s list', async () => {
    const mine = await call<{ skill: AssistantSkill }>('POST', '/api/assistant/skills', { title: '只属于我', content: '别读' })
    asUser('0123456789abcdefghjkmnpqrst')
    expect((await call<{ skills: AssistantSkill[] }>('GET', '/api/assistant/skills')).skills).toEqual([])
    expect(await status('PATCH', `/api/assistant/skills/${mine.skill.id}`, { title: '改掉' })).toBe(404)
    expect(await status('DELETE', `/api/assistant/skills/${mine.skill.id}`)).toBe(200)
    asUser(USER)
    expect((await call<{ skills: AssistantSkill[] }>('GET', '/api/assistant/skills')).skills.map((entry) => entry.id)).toEqual([mine.skill.id])
  })

  it('saves the arrangement a skill brings to the turn, and refuses what it cannot call', async () => {
    await useExampleModel()
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const created = await call<{ skill: AssistantSkill }>('POST', '/api/assistant/skills', {
      title: '周报',
      content: '按项目分段。',
      tools: ['search_notes', 'list_tasks', 'invent_a_tool', 'search_notes'],
      scopes: [
        { kind: 'folder', id: FOLDER_A, name: '工作' },
        { kind: 'tag', id: 'no such id', name: 'x' },
        { kind: 'note', id: FOLDER_B, name: '周记' },
      ],
      modelId: models.models[0]!.id,
    })
    // A tool the assistant cannot call and a scope with no real id are not things the reader asked for:
    // they name a reach the turn does not have, so both are dropped rather than saved to be trusted later.
    expect(created.skill.tools).toEqual(['search_notes', 'list_tasks'])
    // A note is a pin like the composer's own chips: the reader pointing at one page, which the runner
    // re-reads against this account before any tool sees it.
    expect(created.skill.scopes).toEqual([
      { kind: 'folder', id: FOLDER_A, name: '工作' },
      { kind: 'note', id: FOLDER_B, name: '周记' },
    ])
    expect(created.skill.modelId).toBe(models.models[0]!.id)
    expect((await call<{ skills: AssistantSkill[] }>('GET', '/api/assistant/skills')).skills[0]).toMatchObject({
      tools: ['search_notes', 'list_tasks'],
      scopes: [
        { kind: 'folder', id: FOLDER_A, name: '工作' },
        { kind: 'note', id: FOLDER_B, name: '周记' },
      ],
      modelId: models.models[0]!.id,
    })
    // Another account's model is refused at the save, not remembered as a preference to fail on later.
    expect(await status('POST', '/api/assistant/skills', { title: '借来的模型', modelId: OTHER })).toBe(400)
    const cleared = await call<{ skill: AssistantSkill }>('PATCH', `/api/assistant/skills/${created.skill.id}`, {
      modelId: null, tools: [], scopes: [],
    })
    expect(cleared.skill.modelId).toBeNull()
    expect(cleared.skill.tools).toEqual([])
    expect(cleared.skill.scopes).toEqual([])
    // A patch that names only the title leaves the three bindings where they were.
    const renamed = await call<{ skill: AssistantSkill }>('PATCH', `/api/assistant/skills/${created.skill.id}`, { title: '改个名' })
    expect(renamed.skill.modelId).toBeNull()
    expect(renamed.skill.tools).toEqual([])
  })

  it('holds a saved skill to the same ceilings as the turn it stands for', async () => {
    const tools = [...ASSISTANT_TOOL_BY_NAME.keys()]
    expect(tools.length).toBeGreaterThan(MAX_TURN_TOOLS)
    const created = await call<{ skill: AssistantSkill }>('POST', '/api/assistant/skills', {
      title: '全都想要',
      content: '把每个工具和每个文件夹都点上。',
      tools,
      scopes: Array.from({ length: MAX_TURN_SCOPES + 8 }, (_, index) => ({
        kind: 'folder' as const,
        id: oid(`s${index}`),
        name: `f${index}`,
      })),
    })
    expect(created.skill.tools).toHaveLength(MAX_TURN_TOOLS)
    expect(created.skill.scopes).toHaveLength(MAX_TURN_SCOPES)
  })

  it('writes the library out as a bundle another account can read back', async () => {
    await useExampleModel()
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const created = await call<{ skill: AssistantSkill }>('POST', '/api/assistant/skills', {
      title: '周报',
      content: '按项目分段。',
      group: '写作',
      icon: '📝',
      tools: ['search_notes', 'invent_a_tool'],
      scopes: [{ kind: 'folder', id: FOLDER_A, name: '工作' }],
      modelId: models.models[0]!.id,
    })
    const exported = await call<{ bundle: { version: number, skills: Record<string, unknown>[] } }>('GET', '/api/assistant/skills/export')
    expect(exported.bundle.version).toBe(1)
    expect(exported.bundle.skills).toEqual([{
      title: '周报',
      content: '按项目分段。',
      group: '写作',
      icon: '📝',
      // The uncallable tool was never stored, so the bundle cannot carry it either.
      tools: ['search_notes'],
      scopes: [{ kind: 'folder', id: FOLDER_A, name: '工作' }],
      modelId: models.models[0]!.id,
    }])
    // Nothing the server assigns travels: the importing account would be naming a row it does not have.
    expect(exported.bundle.skills[0]).not.toHaveProperty('id')
    expect(exported.bundle.skills[0]).not.toHaveProperty('updatedAt')

    // The same file, read into an account that has none of the models it names.
    asUser('0123456789abcdefghjkmnpqrst')
    expect(await call<{ imported: number, skipped: unknown[] }>('POST', '/api/assistant/skills/import', {
      skills: exported.bundle.skills,
    })).toEqual({ imported: 1, skipped: [] })
    const mine = await call<{ skills: AssistantSkill[] }>('GET', '/api/assistant/skills')
    expect(mine.skills).toHaveLength(1)
    // The words, the icon and the tools travel. The model does not: this account has never heard of it,
    // and a file that fails whole because of one binding it could not carry is a file nobody can use.
    expect(mine.skills[0]).toMatchObject({
      title: '周报', content: '按项目分段。', group: '写作', icon: '📝', tools: ['search_notes'], modelId: null,
    })
    expect(mine.skills[0]!.scopes).toEqual([{ kind: 'folder', id: FOLDER_A, name: '工作' }])
    // A skill that arrives is a new row, not the row it was written from.
    expect(mine.skills[0]!.id).not.toBe(created.skill.id)
  })

  it('keeps the readable entries of a bundle and says why the others were not', async () => {
    const result = await call<{ imported: number, skipped: { title: string, reason: string }[] }>(
      'POST', '/api/assistant/skills/import', {
        skills: [
          { title: '好的', content: '留着。' },
          'not an object',
          null,
          { title: '   ', content: '  ' },
          { title: 'x'.repeat(400), content: 'y'.repeat(10_000), icon: '🚀'.repeat(20), tools: ['search_notes', 'invent_a_tool'] },
        ],
      },
    )
    expect(result.imported).toBe(2)
    expect(result.skipped).toEqual([
      { title: '', reason: 'shape' },
      { title: '', reason: 'shape' },
      { title: '', reason: 'empty' },
    ])
    const mine = await call<{ skills: AssistantSkill[] }>('GET', '/api/assistant/skills')
    const long = mine.skills.find((entry) => entry.content.startsWith('y'))!
    expect(long.title.length).toBeLessThanOrEqual(MAX_SKILL_TITLE_CHARS)
    expect(long.content.length).toBeLessThanOrEqual(MAX_SKILL_CONTENT_CHARS)
    expect(long.icon.length).toBeLessThanOrEqual(MAX_SKILL_ICON_CHARS)
    // A tool the assistant cannot call is dropped on the way in, the same as it would be on a save.
    expect(long.tools).toEqual(['search_notes'])
  })

  it('reads a file with no list as nothing at all rather than as one empty skill', async () => {
    expect(await call<{ imported: number, skipped: unknown[] }>('POST', '/api/assistant/skills/import', {})).toEqual({ imported: 0, skipped: [] })
    expect(await call<{ imported: number, skipped: unknown[] }>('POST', '/api/assistant/skills/import', { skills: 'nope' })).toEqual({ imported: 0, skipped: [] })
    expect((await call<{ skills: AssistantSkill[] }>('GET', '/api/assistant/skills')).skills).toEqual([])
  })
})

describe('model input modalities', () => {

  it('names a recording the model was not marked to take, and stops doing so once it is', async () => {
    await useExampleModel()
    const models = await call<{ models: { id: string }[] }>('GET', '/api/assistant/models')
    const modelId = models.models[0]!.id
    const clip = await uploadFile('voice-note.mp3', new Uint8Array([255, 251, 240, 128]), 'audio/mpeg')
    const bodies: string[] = []
    const stub = () => vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))

    stub()
    const refusedTurn = bodies.length
    await chatEvents({ message: '这条录音里说了什么？', attachments: [clip.attachment.id] })
    await settleTurns()
    // Read the turn's own request, not the naming pass that follows it (bodies keeps both).
    const refused = bodies[refusedTurn] ?? ''
    expect(refused).toContain('not marked as able to take audio')

    await call('PATCH', `/api/assistant/models/${modelId}`, { modalities: ['audio'] })
    stub()
    const acceptedTurn = bodies.length
    await chatEvents({ message: '这条录音里说了什么？', attachments: [clip.attachment.id] })
    await settleTurns()
    vi.unstubAllGlobals()
    const accepted = bodies[acceptedTurn] ?? ''
    // The refusal is gone, and the recording is still not passed off as read: it is named as what it is.
    expect(accepted).not.toContain('not marked as able to take audio')
    expect(accepted).toContain('voice-note.mp3')
  })

  it('stores a context budget above the composer’s largest chip, and caps an absurd one', async () => {
    await useExampleModel()
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const modelId = models.models[0]!.id
    // Capping at the chip list silently rewrote a 1M model down to 262144, which the field then showed
    // as the number the reader had typed until the page was reloaded.
    const big = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${modelId}`, { contextTokens: 1_000_000 })
    expect(big.model.contextTokens).toBe(1_000_000)
    const listed = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    expect(listed.models.find((entry) => entry.id === modelId)?.contextTokens).toBe(1_000_000)
    const absurd = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${modelId}`, { contextTokens: 99_000_000 })
    expect(absurd.model.contextTokens).toBe(MAX_TOKEN_CEILING)
    const cleared = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${modelId}`, { contextTokens: null })
    expect(cleared.model.contextTokens).toBeNull()
  })
  it('round-trips modalities and drops an unknown one without resetting the rest', async () => {
    await useExampleModel()
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const modelId = models.models[0]!.id
    expect(models.models[0]?.modalities).toEqual([])
    const first = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${modelId}`, { modalities: ['audio', 'video'] })
    // `video` is an unknown value now, like `telepathy` below: the switch was deleted because no request
    // format carried it, so a row that still names it must lose it rather than keep a promise nobody honours.
    expect(first.model.modalities).toEqual(['audio'])
    const second = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${modelId}`, { modalities: ['telepathy', 'audio', 'audio'] })
    expect(second.model.modalities).toEqual(['audio'])
    const listed = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    expect(listed.models.find((entry) => entry.id === modelId)?.modalities).toEqual(['audio'])
    // An absent field leaves the choice alone, which is what makes the other controls patchable in isolation.
    const third = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${modelId}`, { label: 'Renamed' })
    expect(third.model.modalities).toEqual(['audio'])
  })
})

describe('answer versions', () => {

  /**
   * One turn per call that thinks first and then answers.
   *
   * The trace arrives the way a thinking model sends it — before the words, on its own frames — because
   * that ordering is what the fold depends on and what a naive reader of the stream would lose.
   */
  function thinking(text: string, trace: string) {
    return vi.fn(async () => new Response(sse([
      openAiFrame({ choices: [{ index: 0, finish_reason: null, delta: { reasoning_content: trace } }] }),
      openAiFrame({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: text } }] }),
    ]), { headers: { 'content-type': 'text/event-stream' } }))
  }

  /** One finished answer per call, distinguishable in the transcript and in the version rows. */
  function answering(text: string, elapsedMs = 6) {
    return vi.fn(async (_url: string, _init?: RequestInit) => {
      // A floor of real elapsed time, so "the turn recorded how long it took" is an assertion rather
      // than a comparison of two zeroes.
      await new Promise((resolve) => setTimeout(resolve, elapsedMs))
      return new Response(sse([
        openAiFrame({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: text } }] }),
        openAiFrame({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } }),
      ]), { headers: { 'content-type': 'text/event-stream' } })
    })
  }

  async function openThread(): Promise<string> {
    const events = await chatEvents({ message: 'VERSIONS-ASK' })
    await settleTurns()
    const started = events.find(event => event.type === 'start')
    const conversationId = started?.conversationId
    expect(conversationId).toBeTruthy()
    return conversationId as string
  }

  async function thread(conversationId: string) {
    const detail = await call<{ messages: Array<AssistantMessage & { versionCount?: number }> }>('GET', `/api/assistant/conversations/${conversationId}`)
    return detail.messages
  }

  it('files the answer a regeneration displaces instead of stacking a second bubble', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', answering('FIRST-ANSWER-1'))
    const conversationId = await openThread()
    vi.stubGlobal('fetch', answering('SECOND-ANSWER-2'))
    const events = await chatEvents({ conversationId, message: '', retry: true })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(events.some(event => event.type === 'done')).toBe(true)
    const rows = await thread(conversationId)
    // One reader line, one assistant line: the retry replaced the turn rather than appending to it.
    expect(rows.filter(row => row.role === 'user')).toHaveLength(1)
    expect(rows.filter(row => row.role === 'assistant')).toHaveLength(1)
    const answer = rows.at(-1)!
    expect(answer.content).toContain('SECOND-ANSWER-2')
    expect(answer.versionCount).toBe(1)
    // The turn recorded its own elapsed time, and the filed answer carries it out of the way.
    expect(answer.durationMs).toBeGreaterThanOrEqual(6)
    expect(answer.modelLabel).toBe('example-model')
    const versions = await call<{ versions: AssistantAnswerVersion[] }>('GET', `/api/assistant/conversations/${conversationId}/messages/${answer.id}/versions`)
    expect(versions.versions.map(version => version.content)).toEqual(['FIRST-ANSWER-1'])
    expect(versions.versions[0]?.usage).toEqual({ inputTokens: 30, outputTokens: 9 })
    expect(versions.versions[0]?.durationMs).toBeGreaterThanOrEqual(6)
  })

  it('swaps an earlier answer back, and the displaced one takes its slot', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', answering('FIRST-ANSWER-1'))
    const conversationId = await openThread()
    vi.stubGlobal('fetch', answering('SECOND-ANSWER-2'))
    await chatEvents({ conversationId, message: '', retry: true })
    await settleTurns()
    vi.unstubAllGlobals()
    const before = (await thread(conversationId)).at(-1)!
    const versions = await call<{ versions: AssistantAnswerVersion[] }>('GET', `/api/assistant/conversations/${conversationId}/messages/${before.id}/versions`)
    const first = versions.versions[0]!
    const after = await call<{ message: AssistantMessage }>('POST',
      `/api/assistant/conversations/${conversationId}/messages/${before.id}/versions/${first.id}/activate`)
    expect(after.message.content).toContain('FIRST-ANSWER-1')
    // A swap, not a copy: still one version, and it now holds what the reader just gave up.
    expect(after.message.versionCount).toBe(1)
    const swapped = await call<{ versions: AssistantAnswerVersion[] }>('GET', `/api/assistant/conversations/${conversationId}/messages/${before.id}/versions`)
    expect(swapped.versions.map(version => version.id)).toEqual([first.id])
    expect(swapped.versions[0]?.content).toContain('SECOND-ANSWER-2')
  })

  it('files the reasoning with the answer, and reads it back when the thread is reopened', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', thinking('FIRST-ANSWER-1', 'FIRST-TRACE-1'))
    const conversationId = await openThread()
    // Reopened the way the app reopens it: the transcript comes from the route, so this is the row and
    // not the live turn that had to carry the trace.
    const first = (await thread(conversationId)).at(-1)!
    expect(first.content).toContain('FIRST-ANSWER-1')
    expect(first.reasoning).toBe('FIRST-TRACE-1')

    vi.stubGlobal('fetch', thinking('SECOND-ANSWER-2', 'SECOND-TRACE-2'))
    await chatEvents({ conversationId, message: '', retry: true })
    await settleTurns()
    vi.unstubAllGlobals()
    const answer = (await thread(conversationId)).at(-1)!
    expect(answer.reasoning).toBe('SECOND-TRACE-2')

    // The displaced answer carries its own trace: reading an old answer must not show it the trace of the
    // answer that replaced it.
    const filed = await call<{ versions: AssistantAnswerVersion[] }>('GET', `/api/assistant/conversations/${conversationId}/messages/${answer.id}/versions`)
    expect(filed.versions.map((version) => version.reasoning)).toEqual(['FIRST-TRACE-1'])
    const swapped = await call<{ message: AssistantMessage }>('POST',
      `/api/assistant/conversations/${conversationId}/messages/${answer.id}/versions/${filed.versions[0]!.id}/activate`)
    expect(swapped.message.content).toContain('FIRST-ANSWER-1')
    expect(swapped.message.reasoning).toBe('FIRST-TRACE-1')
    const displaced = await call<{ versions: AssistantAnswerVersion[] }>('GET', `/api/assistant/conversations/${conversationId}/messages/${answer.id}/versions`)
    expect(displaced.versions[0]?.reasoning).toBe('SECOND-TRACE-2')
  })

  it('bounds what a long trace may put in a row, and keeps the beginning of it', async () => {
    await useExampleModel()
    // Ten times the cap: a thinking model is not stopped by a row, so the row has to stop it.
    const long = 'thought-'.repeat(MAX_REASONING_CHARS)
    vi.stubGlobal('fetch', thinking('ANSWER-AFTER-A-LONG-THOUGHT', long))
    const conversationId = await openThread()
    vi.unstubAllGlobals()
    const answer = (await thread(conversationId)).at(-1)!
    expect(answer.reasoning).toMatch(/^thought-thought-/)
    expect(answer.reasoning).toContain('more characters')
    expect(answer.reasoning!.length).toBeLessThan(MAX_REASONING_CHARS + 200)
  })

  it('does not file an answer that never said anything', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', answering('REAL-ANSWER-3'))
    const conversationId = await openThread()
    // A turn whose request cannot complete files an error row, and an error row has nothing to page back
    // to: filing it would push the reader's real answer out of the retained window.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('upstream refused to answer')
    }))
    await chatEvents({ conversationId, message: '', retry: true })
    await settleTurns()
    const failed = (await thread(conversationId)).at(-1)!
    expect(failed.status).toBe('error')
    vi.stubGlobal('fetch', answering('REAL-ANSWER-4'))
    await chatEvents({ conversationId, message: '', retry: true })
    await settleTurns()
    vi.unstubAllGlobals()
    const answer = (await thread(conversationId)).at(-1)!
    expect(answer.role).toBe('assistant')
    expect(answer.status).toBe('complete')
    const filed = await call<{ versions: AssistantAnswerVersion[] }>('GET', `/api/assistant/conversations/${conversationId}/messages/${answer.id}/versions`)
    // Only the one good answer was displaced; the failed turn contributed no version.
    expect(filed.versions.map(version => version.content)).toEqual(['REAL-ANSWER-3'])
    expect(answer.versionCount).toBe(1)
  })

  it('refuses to file an answer that is only whitespace', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', answering('BLANK-BEFORE-4'))
    const conversationId = await openThread()
    // The runner substitutes a sentence when a model says nothing, so a blank-but-complete row is only
    // reachable from restored or imported data. Written here, it is the case the guard exists for.
    sqlite.prepare(`UPDATE chat_messages SET content = '   ' WHERE user_id = '${USER}' AND role = 'assistant'`).run()
    vi.stubGlobal('fetch', answering('BLANK-AFTER-5'))
    await chatEvents({ conversationId, message: '', retry: true })
    await settleTurns()
    vi.unstubAllGlobals()
    const answer = (await thread(conversationId)).at(-1)!
    expect(answer.content).toContain('BLANK-AFTER-5')
    expect(answer.versionCount ?? 0).toBe(0)
  })

  it('keeps the last five displaced answers and drops the oldest', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', answering('V-ONE'))
    const conversationId = await openThread()
    for (const text of ['V-TWO', 'V-THREE', 'V-FOUR', 'V-FIVE', 'V-SIX', 'V-SEVEN']) {
      vi.stubGlobal('fetch', answering(text))
      await chatEvents({ conversationId, message: '', retry: true })
      await settleTurns()
    }
    vi.unstubAllGlobals()
    const answer = (await thread(conversationId)).at(-1)!
    expect(answer.content).toContain('V-SEVEN')
    const versions = await call<{ versions: AssistantAnswerVersion[] }>('GET', `/api/assistant/conversations/${conversationId}/messages/${answer.id}/versions`)
    expect(versions.versions).toHaveLength(MAX_ANSWER_VERSIONS)
    // Oldest first, and the first answer is the one that fell off the end of the window.
    expect(versions.versions.map(version => version.content)).toEqual(['V-TWO', 'V-THREE', 'V-FOUR', 'V-FIVE', 'V-SIX'])
    expect(versions.versions.map(version => version.content).join(' ')).not.toContain('V-ONE')
  })

  it('will not page one thread’s answers into another, not even for the same reader', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', answering('MINE-ONE'))
    const mine = await openThread()
    vi.stubGlobal('fetch', answering('MINE-TWO'))
    await chatEvents({ conversationId: mine, message: '', retry: true })
    await settleTurns()
    vi.stubGlobal('fetch', answering('OTHERS-ONE'))
    const other = await openThread()
    vi.unstubAllGlobals()
    const myAnswer = (await thread(mine)).at(-1)!
    const theirAnswer = (await thread(other)).at(-1)!
    // Same account, different thread: the message id is real but does not belong to this conversation.
    expect(await status('GET', `/api/assistant/conversations/${other}/messages/${myAnswer.id}/versions`)).toBe(404)
    const versions = await call<{ versions: AssistantAnswerVersion[] }>('GET', `/api/assistant/conversations/${mine}/messages/${myAnswer.id}/versions`)
    const foreign = versions.versions[0]!
    expect(await status('POST', `/api/assistant/conversations/${other}/messages/${theirAnswer.id}/versions/${foreign.id}/activate`)).toBe(404)
    // And the swap it should have made did not happen: the other thread still holds its own answer.
    expect((await thread(other)).at(-1)?.content).toContain('OTHERS-ONE')
  })

  it('deleting a conversation leaves no version rows behind', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', answering('DROP-ONE'))
    const conversationId = await openThread()
    vi.stubGlobal('fetch', answering('DROP-TWO'))
    await chatEvents({ conversationId, message: '', retry: true })
    await settleTurns()
    vi.unstubAllGlobals()
    const answer = (await thread(conversationId)).at(-1)!
    expect(await status('DELETE', `/api/assistant/conversations/${conversationId}`)).toBe(200)
    const left = sqlite.prepare('SELECT count(*) AS n FROM chat_answer_versions WHERE user_id = ? AND message_id = ?').all(USER, answer.id) as Array<{ n: number }>
    expect(left[0]?.n).toBe(0)
  })
})


describe('external MCP servers', () => {
  /** A third party that answers the handshake and offers a read, a write and a web tool. */
  function fakeMcpServer(calls: string[]) {
    return vi.fn(async (url: unknown, init?: RequestInit) => {
      // JSON-RPC puts the tool name and its arguments under `params`, which is what `mcp-client.ts:246`
      // sends; the top level only ever carries `method`, so reading a name from it saw `undefined`.
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        method?: string
        params?: { name?: string, arguments?: unknown }
      }
      calls.push(`${String(url)}:${body.method ?? '?'}:${body.params?.name ?? ''}:${JSON.stringify(body.params?.arguments ?? '')}`)
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {} } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-77' },
        })
      }
      if (body.method === 'tools/list') {
        return new Response(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [
            { name: 'resolve-library-id', description: 'Find a library id', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
            { name: 'drop_everything', description: 'Removes data', inputSchema: { type: 'object', properties: {} } },
            { name: 'web_lookup', description: 'Searches the live web', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
          ] },
        })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      if (body.method === 'tools/call') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: `ran ${body.params?.name} with ${JSON.stringify(body.params?.arguments)}` }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('', { status: 202 })
    })
  }

  /**
   * The same third party, speaking the older transport: a stream that names where to post and answers on it.
   *
   * Every call is recorded with the address it went to, because that is the whole difference between the two
   * types: one posts to the url the reader saved, the other opens it and posts where it is told.
   */
  function fakeSseServer() {
    const encoder = new TextEncoder()
    const calls: string[] = []
    let open: ReadableStreamDefaultController<Uint8Array> | null = null
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push(`${String(url)} ${method === 'GET' ? 'GET' : 'POST'}`)
      if (method === 'GET') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            open = controller
            controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'))
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number, method?: string }
      if (body.id !== undefined) {
        open?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'resolve-library-id', description: 'Find a library id', inputSchema: { type: 'object' } }] },
        })}\n\n`))
      }
      return new Response(null, { status: 202 })
    })
    return { calls, fetchImpl }
  }

  async function addServer(url = 'https://mcp.example.test/mcp') {
    return call<{ server: { id: string } }>('POST', '/api/assistant/mcp', {
      label: 'Example',
      url,
      headers: { Authorization: 'Bearer ctx7sk-secret-value-1234' },
    })
  }

  /**
   * The catalogue the settings screen reads: one entry per server, its tools, and which are switched off.
   *
   * Separate from the turn's own tool list, which is what the model is offered — a server switched off at
   * its own level is still listed here, because that is where its per-tool switches live.
   */
  async function catalog() {
    return call<{
      servers: { serverId: string, serverLabel: string, tools: AssistantMcpTool[] }[]
      problems: { serverId: string }[]
    }>('GET', '/api/assistant/mcp/tools')
  }

  /** The namespaced name a turn would be offered for one remote tool, from the catalogue above. */
  async function offeredName(fragment: string): Promise<string> {
    const { servers } = await catalog()
    return servers.flatMap((entry) => entry.tools).find((entry) => entry.name.includes(fragment))!.name
  }

  /**
   * A server with nothing said about it.
   *
   * The form requires a name and an address and sends the description box whether it was filled or not, so
   * an undescribed server used to be refused at the door — and every field of an edit that only meant to
   * clear the description went with it.
   */
  it('keeps a server whose description was left blank, on both paths', async () => {
    const created = await call<{ server: AssistantMcpServer }>('POST', '/api/assistant/mcp', {
      label: 'Undescribed',
      url: 'https://mcp.example.test/mcp',
      description: '',
      transport: 'streamableHttp',
      timeoutSeconds: 30,
    })
    expect(created.server.description).toBe('')
    const written = await call<{ server: AssistantMcpServer }>('PATCH', `/api/assistant/mcp/${created.server.id}`, { description: 'Reads the tracker' })
    expect(written.server.description).toBe('Reads the tracker')
    const cleared = await call<{ server: AssistantMcpServer }>('PATCH', `/api/assistant/mcp/${created.server.id}`, { description: '' })
    expect(cleared.server.description).toBe('')
    const listed = await call<{ servers: AssistantMcpServer[] }>('GET', '/api/assistant/mcp')
    const row = listed.servers.find((entry) => entry.id === created.server.id)!
    expect(row.description).toBe('')
    expect(row.label).toBe('Undescribed')
  })

  it('reaches a server through the type it was saved as, not through the default one', async () => {
    const legacy = fakeSseServer()
    vi.stubGlobal('fetch', legacy.fetchImpl)
    const created = await call<{ server: { id: string, transport: string } }>('POST', '/api/assistant/mcp', {
      label: 'Legacy',
      url: 'https://mcp.example.test/sse',
      transport: 'sse',
    })
    expect(created.server.transport).toBe('sse')
    const listed = await catalog()
    vi.unstubAllGlobals()
    // Nothing was skipped and the tool is there, which is only reachable through the stream: a server
    // called as Streamable HTTP would have had its POST answered with a 404 by this one.
    expect(listed.problems).toEqual([])
    expect(listed.servers[0]?.tools.map((tool) => tool.remoteName)).toEqual(['resolve-library-id'])
    expect(legacy.calls).toEqual([
      'https://mcp.example.test/sse GET',
      'https://mcp.example.test/messages POST',
      'https://mcp.example.test/messages POST',
      'https://mcp.example.test/messages POST',
    ])
  })

  it('stores a server, keeps its token out of every read, and lists its tools', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', fakeMcpServer(calls))
    const created = await addServer()
    expect(created.server.id).toBeTruthy()
    const listed = await call<{ servers: { label: string, url: string, hasKey: boolean, toolMode: string }[] }>('GET', '/api/assistant/mcp')
    expect(listed.servers).toHaveLength(1)
    expect(listed.servers[0]?.hasKey).toBe(true)
    expect(listed.servers[0]?.toolMode).toBe('ask')
    // The token must not appear anywhere a listing can carry it.
    expect(JSON.stringify(listed)).not.toContain('ctx7sk-secret-value-1234')
    const tools = await catalog()
    expect(tools.problems).toEqual([])
    expect(tools.servers).toHaveLength(1)
    expect(tools.servers[0]?.serverLabel).toBe('Example')
    expect(tools.servers[0]?.tools.map((entry) => entry.name)).toEqual([
      expect.stringMatching(/^mcp_[a-z0-9]+_resolve-library-id$/),
      expect.stringMatching(/^mcp_[a-z0-9]+_drop_everything$/),
      expect.stringMatching(/^mcp_[a-z0-9]+_web_lookup$/),
    ])
    // Nothing is answered for until the reader says so: every row runs under the server's own mode.
    expect(tools.servers[0]?.tools.every((entry) => entry.mode === 'ask')).toBe(true)
    expect(tools.servers[0]?.tools.map((entry) => entry.remoteName)).toEqual(['resolve-library-id', 'drop_everything', 'web_lookup'])
    // The handshake asked for the session and echoed it back on the next call.
    expect(calls.some((entry) => entry.includes(':initialize:'))).toBe(true)
    expect(calls.some((entry) => entry.includes(':tools/list:'))).toBe(true)
    vi.unstubAllGlobals()
  })

  it('refuses an address inside the network before anything is fetched', async () => {
    const fetches = vi.fn()
    vi.stubGlobal('fetch', fetches)
    expect(await status('POST', '/api/assistant/mcp', { label: 'Inside', url: 'http://169.254.169.254/latest/meta-data/' })).toBe(400)
    expect(await status('POST', '/api/assistant/mcp', { label: 'Plain', url: 'https://example.test/mcp' })).toBe(201)
    expect(await status('PATCH', '/api/assistant/mcp/' + (await call<{ servers: { id: string }[] }>('GET', '/api/assistant/mcp')).servers[0]!.id, { url: 'http://127.0.0.1:9/mcp' })).toBe(400)
    expect(fetches).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('refuses to follow a redirect out of a stored server', async () => {
    const seen: Array<RequestInit | undefined> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init)
      // The saved address was vetted; the redirect target is one this app never checked, so the
      // request must come back with the 3xx rather than quietly continue somewhere inside the network.
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    }))
    await call('POST', '/api/assistant/mcp', { label: 'Redirector', url: 'https://mcp.example.test/mcp' })
    const listed = await catalog()
    vi.unstubAllGlobals()
    expect(listed.servers).toEqual([])
    expect(listed.problems).toHaveLength(1)
    // Every request the client made asked fetch not to follow one.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((init) => init?.redirect === 'manual')).toBe(true)
  })

  it('asks the reader before an external tool runs, and runs the approved call with the shown arguments', async () => {
    await useExampleModel()
    const calls: string[] = []
    vi.stubGlobal('fetch', fakeMcpServer(calls))
    const created = await addServer()
    const resolveName = await offeredName('resolve-library-id')

    // The model asks for it; in `ask` mode nothing has run yet and a proposal is shown instead.
    const answerFrames = [
      `data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: resolveName, arguments: '{"query":"react-query"}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'I asked you first.' } }] })}\n\n`,
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('"model":"example-model"')) return new Response(sse(answerFrames), { headers: { 'content-type': 'text/event-stream' } })
      return fakeMcpServer(calls)(url, init)
    }))
    const events = await chatEvents({ message: '帮我查 react-query 的库 id', tools: [resolveName] })
    await settleTurns()
    const activity = events.filter((event) => event.type === 'tool').map((event) => event.tool)
    const proposed = activity.find((entry) => entry?.approval)
    expect(proposed?.approval?.status, 'no approval card was offered').toBe('pending')
    expect(calls.some((entry) => entry.includes(':tools/call:resolve-library-id'))).toBe(false)
    const actionId = proposed!.approval!.id
    const approved = await call<{ action: { status: string } }>('POST', `/api/assistant/actions/${actionId}/approve`)
    expect(approved.action.status).toBe('approved')
    // The replay carries the arguments the card showed: a remote call cannot be re-derived from a target id.
    const ran = calls.filter((entry) => entry.includes(':tools/call:resolve-library-id:'))
    expect(ran.length, 'the approved call never reached the server').toBe(1)
    expect(ran[0]).toContain('query')
    expect(ran[0]).toContain('react-query')
    const threadId = events.find((event) => event.type === 'start')!.conversationId!
    const after = await call<{ messages: { tools: { name: string, status: string, args?: string, result?: string }[] }[] }>('GET', `/api/assistant/conversations/${threadId}`)
    const settled = after.messages.flatMap((message) => message.tools).filter((entry) => entry.name.includes('resolve-library-id'))
    expect(settled.some((entry) => entry.status === 'success'), 'the chip still says pending').toBe(true)
    // The payloads survive the row as well as the stream: a thread reopened tomorrow has to be able to
    // answer what was asked and what came back, which is the whole point of keeping them.
    // The approved replay is its own entry: the proposal's answer is the card's notice, and the call's
    // own text lands on the run that happened.
    expect(settled.map((entry) => entry.args ?? '').join('\n'), 'the stored call lost its arguments').toContain('react-query')
    expect(settled.map((entry) => entry.result ?? '').join('\n'), 'the stored call lost its answer').toContain('ran resolve-library-id')
    vi.unstubAllGlobals()
    void created
  })

  it('runs an auto-mode server without a card, and never offers a disabled one', async () => {
    await useExampleModel()
    const calls: string[] = []
    vi.stubGlobal('fetch', fakeMcpServer(calls))
    const created = await addServer()
    await call('PATCH', `/api/assistant/mcp/${created.server.id}`, { toolMode: 'auto' })
    const resolveName = await offeredName('resolve-library-id')
    const answerFrames = [
      `data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: resolveName, arguments: '{"query":"svelte"}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: '查到了。' } }] })}\n\n`,
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('"model":"example-model"')) return new Response(sse(answerFrames), { headers: { 'content-type': 'text/event-stream' } })
      return fakeMcpServer(calls)(url, init)
    }))
    const events = await chatEvents({ message: '查 svelte' })
    await settleTurns()
    expect(calls.some((entry) => entry.includes(':tools/call:resolve-library-id'))).toBe(true)
    expect(events.filter((event) => event.type === 'tool').map((event) => event.tool).at(-1)?.approval).toBeUndefined()

    await call('PATCH', `/api/assistant/mcp/${created.server.id}`, { enabled: false })
    // The turn is offered nothing, while the settings catalogue still lists the server: that is where the
    // switches that turn it back on live.
    const listed = await catalog()
    expect(listed.servers).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('runs one stored call again, and refuses where the turn itself would have asked first', async () => {
    await useExampleModel()
    const calls: string[] = []
    const mcp = fakeMcpServer(calls)
    vi.stubGlobal('fetch', mcp)
    const created = await addServer()
    await call('PATCH', `/api/assistant/mcp/${created.server.id}`, { toolMode: 'auto' })
    const resolveName = await offeredName('resolve-library-id')
    const answerFrames = [
      `data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: resolveName, arguments: '{"query":"svelte"}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: '查到了。' } }] })}\n\n`,
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('"model":"example-model"')) return new Response(sse(answerFrames), { headers: { 'content-type': 'text/event-stream' } })
      return mcp(url, init)
    }))
    const events = await chatEvents({ message: '查 svelte' })
    await settleTurns()
    const conversationId = events.find((entry) => entry.type === 'start')!.conversationId!

    const thread = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    const answer = thread.messages.find((entry) => entry.role === 'assistant')!
    const called = answer.tools.find((entry) => entry.name.includes('resolve-library-id'))!
    expect(called.args, 'the stored call has nothing to replay').toContain('svelte')

    const before = calls.filter((entry) => entry.includes(':tools/call:resolve-library-id')).length
    const again = await call<{ ok: boolean, result: string }>('POST', '/api/assistant/mcp/replay', {
      conversationId: answer.conversationId,
      messageId: answer.id,
      toolId: called.id,
    })
    expect(again.ok).toBe(true)
    // The arguments are the ones on the row rather than anything the caller sent.
    expect(again.result).toContain('ran resolve-library-id')
    expect(again.result).toContain('svelte')
    expect(calls.filter((entry) => entry.includes(':tools/call:resolve-library-id')).length).toBe(before + 1)

    // A call that is not to a third party has nothing to run, and a server that asks each time would be
    // letting this route do what its own mode refuses.
    expect(await status('POST', '/api/assistant/mcp/replay', { conversationId: answer.conversationId, messageId: answer.id, toolId: 'nope' })).toBe(404)
    await call('PATCH', `/api/assistant/mcp/${created.server.id}`, { toolMode: 'ask' })
    expect(await status('POST', '/api/assistant/mcp/replay', { conversationId: answer.conversationId, messageId: answer.id, toolId: called.id })).toBe(409)
    await call('PATCH', `/api/assistant/mcp/${created.server.id}`, { enabled: false })
    expect(await status('POST', '/api/assistant/mcp/replay', { conversationId: answer.conversationId, messageId: answer.id, toolId: called.id })).toBe(409)
    vi.unstubAllGlobals()
  })

  it('answers for one tool without touching its neighbours, and leaves it out of the turn', async () => {
    await useExampleModel()
    const calls: string[] = []
    vi.stubGlobal('fetch', fakeMcpServer(calls))
    const created = await addServer()
    await call('PATCH', `/api/assistant/mcp/${created.server.id}`, { toolMode: 'auto', toolModes: { drop_everything: 'off' } })
    const resolveName = await offeredName('resolve-library-id')

    const listed = await catalog()
    const rows = listed.servers[0]!.tools
    // The server says run directly; one of its tools disagrees, and each row shows its own answer.
    expect(rows.find((entry) => entry.remoteName === 'drop_everything')?.mode).toBe('off')
    expect(rows.find((entry) => entry.remoteName === 'resolve-library-id')?.mode).toBe('auto')

    // The model is not offered the switched-off tool at all: a schema would let it name one that can
    // never run, and the turn would then have to refuse after the fact.
    const bodies: string[] = []
    const mcp = fakeMcpServer(calls)
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('"model":"example-model"')) {
        bodies.push(body)
        return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
      }
      return mcp(url, init)
    }))
    await chatEvents({ message: '查一下 react-query' })
    await settleTurns()
    vi.unstubAllGlobals()
    const offered = JSON.parse(bodies[0] ?? '{}') as { tools?: { function?: { name?: string } }[] }
    const names = (offered.tools ?? []).map((entry) => entry.function?.name ?? '')
    expect(names).toContain(resolveName)
    expect(names.some((name) => name.includes('drop_everything'))).toBe(false)
  })

  it('refuses a per-tool answer that is not a map of the three words', async () => {
    vi.stubGlobal('fetch', fakeMcpServer([]))
    const created = await addServer()
    expect(await status('PATCH', `/api/assistant/mcp/${created.server.id}`, { toolModes: 'drop_everything' })).toBe(400)
    expect(await status('PATCH', `/api/assistant/mcp/${created.server.id}`, { toolModes: ['drop_everything'] })).toBe(400)
    // An unknown mode and an empty name are dropped rather than stored, so nothing is ever filtered by
    // a word this app does not have.
    const patched = await call<{ server: AssistantMcpServer }>('PATCH', `/api/assistant/mcp/${created.server.id}`, {
      toolModes: { drop_everything: 'sometimes', '': 'off', web_lookup: 'auto' },
    })
    expect(patched.server.toolModes).toEqual({ web_lookup: 'auto' })
    vi.unstubAllGlobals()
  })

  it('keeps a stored header through an unrelated edit, and drops it only when told to', async () => {
    vi.stubGlobal('fetch', fakeMcpServer([]))
    const created = await addServer()
    const renamed = await call<{ server: { hasKey: boolean } }>('PATCH', `/api/assistant/mcp/${created.server.id}`, { label: 'Renamed' })
    expect(renamed.server.hasKey, 'an edit that did not touch the headers cleared them').toBe(true)
    const cleared = await call<{ server: { hasKey: boolean } }>('PATCH', `/api/assistant/mcp/${created.server.id}`, { headers: null })
    expect(cleared.server.hasKey).toBe(false)
    const retyped = await call<{ server: { hasKey: boolean } }>('PATCH', `/api/assistant/mcp/${created.server.id}`, { headers: { Authorization: 'Bearer another-secret-999' } })
    expect(retyped.server.hasKey).toBe(true)
    expect(JSON.stringify(retyped)).not.toContain('another-secret-999')
    vi.unstubAllGlobals()
  })

  it('stores what the form says about a server, and reads the header names back without the values', async () => {
    vi.stubGlobal('fetch', fakeMcpServer([]))
    const created = await call<{ server: AssistantMcpServer }>('POST', '/api/assistant/mcp', {
      label: 'Docs',
      url: 'https://mcp.example.test/mcp',
      description: 'Library documentation',
      transport: 'streamableHttp',
      timeoutSeconds: 90,
      headers: { Authorization: 'Bearer ctx7sk-secret-value-1234', 'X-Client': 'inkstone' },
    })
    expect(created.server.description).toBe('Library documentation')
    expect(created.server.timeoutSeconds).toBe(90)
    expect(created.server.transport).toBe('streamableHttp')
    const detail = await call<{ server: AssistantMcpServer, headerNames: string[] }>('GET', `/api/assistant/mcp/${created.server.id}`)
    expect(detail.headerNames.sort()).toEqual(['Authorization', 'X-Client'])
    expect(JSON.stringify(detail), 'a header value reached the client').not.toContain('ctx7sk-secret-value-1234')
    // A timeout past its own bounds is clamped rather than refused, the way every other limit here is.
    const slow = await call<{ server: AssistantMcpServer }>('PATCH', `/api/assistant/mcp/${created.server.id}`, { timeoutSeconds: 10_000 })
    expect(slow.server.timeoutSeconds).toBe(MAX_MCP_TIMEOUT_SECONDS)
    expect(await status('PATCH', `/api/assistant/mcp/${created.server.id}`, { headers: { 'Not A Name': 'x' } })).toBe(400)
    vi.unstubAllGlobals()
  })

  it('offers nothing from a server set to off, while it stays configured', async () => {
    vi.stubGlobal('fetch', fakeMcpServer([]))
    const created = await addServer()
    expect((await catalog()).servers[0]!.tools.length).toBeGreaterThan(0)
    const off = await call<{ server: { enabled: boolean, toolMode: string } }>('PATCH', `/api/assistant/mcp/${created.server.id}`, { toolMode: 'off' })
    expect(off.server.toolMode).toBe('off')
    expect(off.server.enabled, 'switching the mode off must not silently disable the row').toBe(true)
    vi.unstubAllGlobals()
  })

  it('keeps one account’s servers out of another’s', async () => {
    vi.stubGlobal('fetch', fakeMcpServer([]))
    const mine = await addServer()
    asUser('0123456789abcdefghjkmnpqrt')
    expect((await call<{ servers: unknown[] }>('GET', '/api/assistant/mcp')).servers).toEqual([])
    expect(await status('PATCH', `/api/assistant/mcp/${mine.server.id}`, { enabled: false })).toBe(404)
    expect(await status('DELETE', `/api/assistant/mcp/${mine.server.id}`)).toBe(404)
    asUser(USER)
    expect(await status('DELETE', `/api/assistant/mcp/${mine.server.id}`)).toBe(200)
    expect((await call<{ servers: unknown[] }>('GET', '/api/assistant/mcp')).servers).toEqual([])
    vi.unstubAllGlobals()
  })

  describe('the web-search switch on a turn', () => {
    /** The reader's server, with the one tool name a search turn can recognise on its own. */
    async function addSearchServer(): Promise<string> {
      vi.stubGlobal('fetch', fakeMcpServer([]))
      await addServer()
      const name = await offeredName('web_lookup')
      vi.unstubAllGlobals()
      return name
    }

    /** Records what the runner put on the wire, while the MCP handshake still gets answered. */
    function watchModelRequest(model: string, frames: readonly string[]): string[] {
      const bodies: string[] = []
      const mcp = fakeMcpServer([])
      vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
        const body = String(init?.body ?? '')
        if (body.includes(`"model":"${model}"`)) {
          bodies.push(body)
          return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
        }
        return mcp(url, init)
      }))
      return bodies
    }

    function systemOf(body: string | undefined): string {
      const parsed = JSON.parse(body ?? '{}') as { messages?: { role: string, content: string }[], system?: string }
      return String(parsed.messages?.find((entry) => entry.role === 'system')?.content ?? parsed.system ?? '')
    }

    it('names a remote search tool when the protocol has no vendor search', async () => {
      await useExampleModel()
      const searchName = await addSearchServer()
      const bodies = watchModelRequest('example-model', FINAL_FRAMES)
      const events = await chatEvents({ message: 'What is the weather in Shanghai today?', webSearch: true })
      await settleTurns()
      vi.unstubAllGlobals()
      expect(events.some((event) => event.type === 'done')).toBe(true)
      expect(systemOf(bodies[0])).toContain(searchName)
    })

    it('mentions nothing in the prompt when the switch is off, though the tool is still offered', async () => {
      await useExampleModel()
      const searchName = await addSearchServer()
      const bodies = watchModelRequest('example-model', FINAL_FRAMES)
      await chatEvents({ message: 'What is the weather in Shanghai today?' })
      await settleTurns()
      vi.unstubAllGlobals()
      expect(systemOf(bodies[0])).not.toContain(searchName)
      // The absence is only in the prompt line: the server's tool remains in the schema list, so a
      // green here cannot come from the whole server having vanished.
      expect(bodies[0] ?? '').toContain(searchName)
    })

    it('asks the vendor for its own search instead of pinning a remote tool', async () => {
      await useExampleModel()
      const searchName = await addSearchServer()
      const providers = await call<{ providers: { id: string }[] }>('GET', '/api/assistant/providers')
      await call('PATCH', `/api/assistant/providers/${providers.providers[0]!.id}`, { protocol: 'anthropic' })
      const bodies = watchModelRequest('example-model', [
        openAiFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Searching.' } }),
        openAiFrame({ type: 'message_stop' }),
      ])
      const events = await chatEvents({ message: 'What is the weather in Shanghai today?', webSearch: true })
      await settleTurns()
      vi.unstubAllGlobals()
      expect(events.some((event) => event.type === 'done')).toBe(true)
      const sent = bodies[0] ?? ''
      expect(sent).toContain('web_search_20250305')
      expect(systemOf(sent)).not.toContain(searchName)
    })

    it('treats anything but true as off', async () => {
      await useExampleModel()
      const searchName = await addSearchServer()
      const bodies = watchModelRequest('example-model', FINAL_FRAMES)
      await chatEvents({ message: 'What is the weather in Shanghai today?', webSearch: 'yes' })
      await settleTurns()
      vi.unstubAllGlobals()
      expect(systemOf(bodies[0])).not.toContain(searchName)
    })
  })
})

describe('usage attribution', () => {
  it('charges a turn to the provider key as well as the model', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    await chatEvents({ message: 'hello' })
    await settleTurns()
    vi.unstubAllGlobals()

    const stats = await call<{ keys: { providerLabel: string, requests: number, inputTokens: number, outputTokens: number }[] }>(
      'GET', '/api/assistant/stats?range=all',
    )
    const row = stats.keys.find((entry) => entry.providerLabel === 'Example')
    expect(row).toBeTruthy()
    expect(row!.requests).toBeGreaterThanOrEqual(1)
    // The day carries the turn and the naming pass that follows it — the wire answers both with 20/6.
    expect(row!.inputTokens).toBe(40)
    expect(row!.outputTokens).toBe(12)
  })

  it('prices the window day by day, split by model and by key from the same rows', async () => {
    await useExampleModel()
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    // A price makes the series a claim rather than a zero: the chart's bars are this arithmetic.
    await call('PATCH', `/api/assistant/models/${models.models[0]!.id}`, { inputPrice: 1, outputPrice: 2, priceCurrency: 'cny' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    await chatEvents({ message: 'hello' })
    await settleTurns()
    vi.unstubAllGlobals()

    const stats = await call<{
      series: Array<{
        day: string
        requests: number
        costs: { currency: string, amount: number }[]
        models: { id: string, label: string, costs: { currency: string, amount: number }[], unpriced: boolean }[]
        keys: { id: string, label: string, costs: { currency: string, amount: number }[] }[]
      }>
      models: { label: string, currency: string, cost: number | null }[]
    }>('GET', '/api/assistant/stats?range=all')

    // 40 tokens in at 1/M and 12 out at 2/M — the turn's 20/6 plus the naming pass's 20/6.
    const expected = (1 * 40 + 2 * 12) / 1_000_000
    expect(stats.series).toHaveLength(1)
    const day = stats.series[0]!
    expect(day.requests).toBeGreaterThanOrEqual(1)
    expect(day.costs).toEqual([{ currency: 'CNY', amount: expect.closeTo(expected, 12) }])
    // The same rows read both ways, so the two splits describe one day's money rather than two days'.
    expect(day.models.map((entry) => entry.label)).toEqual([stats.models[0]!.label])
    expect(day.models[0]!.costs[0]!.amount).toBeCloseTo(expected, 12)
    expect(day.keys).toHaveLength(1)
    expect(day.keys[0]!.label).toBe('Example')
    expect(day.keys[0]!.id.endsWith(':'), 'a provider with one key is its own slice, keyless').toBe(true)
    expect(day.keys[0]!.costs[0]!.amount).toBeCloseTo(expected, 12)
  })

  it('leaves an unpriced model out of the money without counting it as free', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    await chatEvents({ message: 'hello' })
    await settleTurns()
    vi.unstubAllGlobals()

    const stats = await call<{ series: { costs: unknown[], models: { unpriced: boolean, costs: unknown[] }[] }[] }>(
      'GET', '/api/assistant/stats?range=all',
    )
    // The day still happened — its tokens are there — but nothing priced it, so no bar is drawn for it.
    expect(stats.series[0]!.models[0]!.unpriced).toBe(true)
    expect(stats.series[0]!.models[0]!.costs).toEqual([])
    expect(stats.series[0]!.costs).toEqual([])
  })

  it('rebuilds the by-model split for usage recorded before the dimension existed', async () => {
    const { usageDay, dayBefore } = await import('../src/worker/assistant/store')
    const day = dayBefore(usageDay(), 2)
    const conversation = await call<{ conversation: AssistantConversation }>(
      'POST', '/api/assistant/conversations', { title: 'Before the split' },
    )
    // What the old build left behind: the day's counters, and the messages they were counted from. No
    // `chat_usage_daily_model` row exists for any of it, because the table had not been thought of yet.
    insert('chat_usage_daily', { day, requests: 2, input_tokens: 50, output_tokens: 10, tool_calls: 2 })
    const at = Date.parse(`${day}T12:00:00.000Z`)
    insert('chat_messages', {
      id: oid('m1'), conversation_id: conversation.conversation.id, role: 'assistant', content: 'one',
      reasoning: '', tools: JSON.stringify([{ id: 't1' }]), attachments: '[]', status: 'complete',
      source: 'chat', input_tokens: 30, output_tokens: 6, duration_ms: 1000,
      model_label: 'deepseek-chat', created_at: at,
    })
    insert('chat_messages', {
      id: oid('m2'), conversation_id: conversation.conversation.id, role: 'assistant', content: 'two',
      reasoning: '', tools: JSON.stringify([{ id: 't2' }]), attachments: '[]', status: 'complete',
      source: 'chat', input_tokens: 20, output_tokens: 4, duration_ms: 900,
      model_label: 'deepseek-chat', created_at: at + 1000,
    })

    const stats = await call<{
      total: { inputTokens: number }
      models: { label: string, requests: number, inputTokens: number, outputTokens: number, toolCalls: number, cost: number | null }[]
      modelOptions: string[]
      series: { day: string, models: { label: string, requests: number }[] }[]
      unpricedModels: number
    }>('GET', '/api/assistant/stats?range=all')

    // The day's totals were never lost; what was missing is the model behind them.
    expect(stats.total.inputTokens).toBe(50)
    expect(stats.models).toEqual([
      expect.objectContaining({ label: 'deepseek-chat', requests: 2, inputTokens: 50, outputTokens: 10, toolCalls: 2, cost: null }),
    ])
    // A model with no price is unpriced, not free: the total above still says nothing was billed for it.
    expect(stats.unpricedModels).toBe(1)
    expect(stats.modelOptions).toContain('deepseek-chat')
    expect(stats.series.find((entry) => entry.day === day)?.models.map((entry) => entry.label)).toEqual(['deepseek-chat'])

    // The filter the picker now offers answers from the same rebuilt row rather than from a key table
    // that never heard of this day.
    const filtered = await call<{ total: { inputTokens: number }, models: { label: string }[] }>(
      'GET', `/api/assistant/stats?range=all&model=${encodeURIComponent('deepseek-chat')}`,
    )
    expect(filtered.total.inputTokens).toBe(50)
    expect(filtered.models.map((entry) => entry.label)).toEqual(['deepseek-chat'])

    // Reading the screen again is not a second charge: the rebuild is inserted once and then read.
    const again = await call<{ models: { requests: number, inputTokens: number }[] }>('GET', '/api/assistant/stats?range=all')
    expect(again.models[0]).toMatchObject({ requests: 2, inputTokens: 50 })
  })

  it('answers the account totals from the whole history, which no range narrows', async () => {
    const { usageDay } = await import('../src/worker/assistant/store')
    await useExampleModel()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    await chatEvents({ message: 'hello' })
    await settleTurns()
    vi.unstubAllGlobals()

    const { overview } = await call<{
      overview: {
        totalTokens: number
        peakDay: string | null
        peakTokens: number
        longestTurnMs: number
        currentStreak: number
        longestStreak: number
        activity: { day: string, tokens: number }[]
      }
    }>('GET', '/api/assistant/stats/overview')

    // 40 tokens in and 12 out (the turn plus the naming pass), on the one day this account has ever been used.
    expect(overview.totalTokens).toBe(52)
    expect(overview.peakDay).toBe(usageDay())
    expect(overview.peakTokens).toBe(52)
    expect(overview.currentStreak).toBe(1)
    expect(overview.longestStreak).toBe(1)
    expect(overview.activity).toEqual([{ day: usageDay(), tokens: 52 }])
    // The turn is timed, so the longest one is a real number rather than a missing field.
    expect(overview.longestTurnMs).toBeGreaterThanOrEqual(0)
  })

  it('counts a streak over consecutive days, and lets a day not yet spent on pass', async () => {
    const { usageDay, dayBefore } = await import('../src/worker/assistant/store')
    const today = usageDay()
    // Today is deliberately left empty: a reader who opens the screen before their first question must not
    // watch their own streak read zero. The lone day a week back is a run of one, not of four.
    for (const day of [dayBefore(today, 1), dayBefore(today, 2), dayBefore(today, 3)]) {
      insert('chat_usage_daily', { day, requests: 1, input_tokens: 10, output_tokens: 5 })
    }
    insert('chat_usage_daily', { day: dayBefore(today, 6), requests: 1, input_tokens: 1, output_tokens: 1 })

    const { overview } = await call<{ overview: { currentStreak: number, longestStreak: number, totalTokens: number, activity: unknown[] } }>(
      'GET', '/api/assistant/stats/overview',
    )
    expect(overview.currentStreak).toBe(3)
    expect(overview.longestStreak).toBe(3)
    expect(overview.totalTokens).toBe(3 * 15 + 2)
    // Every day with usage, oldest first — the map's own data, which no range narrows.
    expect(overview.activity).toHaveLength(4)
  })

  it('narrows the window to one model or one key, and to nothing when neither matches', async () => {
    await useExampleModel()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    await chatEvents({ message: 'hello' })
    await settleTurns()
    vi.unstubAllGlobals()

    const all = await call<{ total: { inputTokens: number }, keys: { providerId: string, providerLabel: string }[], modelOptions: string[] }>(
      'GET', '/api/assistant/stats?range=all',
    )
    const entry = all.keys.find((candidate) => candidate.providerLabel === 'Example')!
    const modelLabel = all.modelOptions[0]!
    expect(entry).toBeTruthy()
    expect(modelLabel).toBeTruthy()

    const byKey = await call<{ total: { inputTokens: number }, models: { label: string }[] }>(
      'GET', `/api/assistant/stats?range=all&key=${entry.providerId}`,
    )
    expect(byKey.total.inputTokens).toBe(40)
    expect(byKey.models.map((model) => model.label)).toEqual([modelLabel])

    const byModel = await call<{ total: { inputTokens: number } }>(
      'GET', `/api/assistant/stats?range=all&model=${encodeURIComponent(modelLabel)}`,
    )
    expect(byModel.total.inputTokens).toBe(40)

    const none = await call<{ total: { inputTokens: number } }>('GET', '/api/assistant/stats?range=all&model=nope')
    expect(none.total.inputTokens).toBe(0)
  })
})

describe('note mentions', () => {
  it('resolves a [[wikilink]] into the note it names', async () => {
    await useExampleModel()
    insert('notes', {
      id: oid('na1'), folder_id: null, title: '购物清单', title_key: '购物清单', content: '咖啡豆和燕麦奶',
      excerpt: '', rev: 1, word_count: 5, char_count: 6, is_pinned: 0, is_starred: 0, is_archived: 0,
      position: 0, content_hash: 'h', created_at: 1, updated_at: 1, deleted_at: null,
    })
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    await chatEvents({ message: '看看 [[购物清单]] 里写了什么' })
    await settleTurns()
    vi.unstubAllGlobals()
    const body = bodies.join('\n')
    expect(body).toContain('咖啡豆和燕麦奶')
    expect(body).toContain('[mentioned notes]')
  })

  it('names a mention that matches no readable note instead of inventing it', async () => {
    await useExampleModel()
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    await chatEvents({ message: '看看 [[不存在的笔记]]' })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(bodies.join('\n')).toContain('no note with that title')
  })
})

describe('provider key rotation', () => {
  it('adds a key, never echoes its plaintext, and rotates between the two', async () => {
    await useExampleModel()
    const providers = await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')
    const providerId = providers.providers[0]!.id

    const added = await call<{ key: { id: string, hasKey: boolean, keyHint: string, enabled: boolean } }>(
      'POST', `/api/assistant/providers/${providerId}/keys`, { label: 'second', apiKey: 'sk-second-key-4321' },
    )
    expect(added.key.hasKey).toBe(true)
    expect(added.key.keyHint).toBe('4321')
    expect(JSON.stringify(added)).not.toContain('sk-second-key-4321')

    const listed = await call<{ keys: { id: string }[] }>('GET', `/api/assistant/providers/${providerId}/keys`)
    expect(listed.keys).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('sk-second-key-4321')

    const auths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      auths.push(new Headers(init?.headers as HeadersInit).get('authorization') ?? '')
      return new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    await chatEvents({ message: 'one' })
    await settleTurns()
    await chatEvents({ message: 'two' })
    await settleTurns()
    vi.unstubAllGlobals()
    // The provider's own key answers first; marking it used pushes the extra one ahead of it next turn.
    expect(auths.some((value) => value.includes('sk-test-value-9876'))).toBe(true)
    expect(auths.some((value) => value.includes('sk-second-key-4321'))).toBe(true)
  })

  it('switches a key off without losing it, and deletes it on request', async () => {
    await useExampleModel()
    const providers = await call<{ providers: AssistantProvider[] }>('GET', '/api/assistant/providers')
    const providerId = providers.providers[0]!.id
    const added = await call<{ key: { id: string } }>(
      'POST', `/api/assistant/providers/${providerId}/keys`, { label: 'parked', apiKey: 'sk-parked-9999' },
    )

    const off = await call<{ key: { enabled: boolean, hasKey: boolean } }>(
      'PATCH', `/api/assistant/providers/${providerId}/keys/${added.key.id}`, { enabled: false },
    )
    expect(off.key.enabled).toBe(false)
    expect(off.key.hasKey).toBe(true)

    // A key id from another provider reads as not found rather than being edited through this path.
    expect(await status('PATCH', `/api/assistant/providers/${providers.providers[0]!.id}/keys/${oid('zz1')}`, { enabled: true })).toBe(404)

    await call('DELETE', `/api/assistant/providers/${providerId}/keys/${added.key.id}`)
    const listed = await call<{ keys: unknown[] }>('GET', `/api/assistant/providers/${providerId}/keys`)
    expect(listed.keys).toHaveLength(0)
  })
})

/**
 * The model a turn is handed to when the chosen one cannot answer at all.
 *
 * A spare is the reader's answer to a vendor retiring a model, a service going down, or an account running
 * out of quota — the three failures that are facts about one model's door rather than about the question.
 * What it must not become is a second chance for a request the provider refused on its own terms, which the
 * spare would refuse just as flatly after the reader had waited for it.
 */
describe('the model a turn falls back to', () => {
  async function activeModelId(): Promise<string> {
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    return models.models[0]!.id
  }

  /** A second provider on its own host, so the stub can tell the two apart by address. */
  async function addSpare(): Promise<AssistantModel> {
    const created = await call<{ provider: AssistantProvider }>('POST', '/api/assistant/providers', {
      label: 'Spare',
      protocol: 'openai',
      baseUrl: 'https://spare.example.com',
      apiKey: 'sk-spare-1111',
      models: ['spare-model'],
    })
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    return models.models.find((entry) => entry.providerId === created.provider.id)!
  }

  it('saves a spare, and refuses the model itself or one that is not there', async () => {
    await useExampleModel()
    const primary = await activeModelId()
    const spare = await addSpare()
    const saved = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${primary}`, { fallbackModelId: spare.id })
    expect(saved.model.fallbackModelId).toBe(spare.id)
    // A chain of one that can never answer, and a name nothing can resolve: both are refused rather than
    // stored, because a spare that silently does nothing is worse than being told the pick was wrong.
    expect(await status('PATCH', `/api/assistant/models/${primary}`, { fallbackModelId: primary })).toBe(400)
    expect(await status('PATCH', `/api/assistant/models/${primary}`, { fallbackModelId: oid('zz9') })).toBe(400)
    const cleared = await call<{ model: AssistantModel }>('PATCH', `/api/assistant/models/${primary}`, { fallbackModelId: null })
    expect(cleared.model.fallbackModelId).toBe(null)
  })

  it('answers with the spare when the chosen model cannot answer at all', async () => {
    await useExampleModel()
    const primary = await activeModelId()
    const spare = await addSpare()
    await call('PATCH', `/api/assistant/models/${primary}`, { fallbackModelId: spare.id })

    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const host = new URL(String(url)).host
      hosts.push(host)
      // `retry-after: 0` keeps the retry budget real without making the test sit out the backoff.
      return host === 'api.example.com'
        ? new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
        : new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })
    }))
    const events = await chatEvents({ message: 'what is on my list?' })
    await settleTurns()
    vi.unstubAllGlobals()

    // The chosen model gets its retries first, and only then is the spare asked. The fifth call is the
    // naming pass: it follows the answer on the spare that actually served the turn, not the primary that could not.
    expect(hosts).toEqual(['api.example.com', 'api.example.com', 'api.example.com', 'spare.example.com', 'spare.example.com'])
    expect(events.some((event) => event.type === 'error')).toBe(false)
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversationId}`)
    expect(detail.messages[1]!.content).toContain('Nothing is on the list.')
    expect(detail.messages[1]!.status).toBe('complete')
    // The turn is filed against the model that answered it, not the one that could not.
    expect(detail.messages[1]!.modelLabel).toBe(spare.label)
  })

  it('does not hand a request the provider refused to the spare', async () => {
    await useExampleModel()
    const primary = await activeModelId()
    const spare = await addSpare()
    await call('PATCH', `/api/assistant/models/${primary}`, { fallbackModelId: spare.id })
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      hosts.push(new URL(String(url)).host)
      return new Response('{"error":"bad field"}', { status: 400 })
    }))
    const events = await chatEvents({ message: 'hello' })
    await settleTurns()
    vi.unstubAllGlobals()
    expect(hosts).toEqual(['api.example.com'])
    expect(events.some((event) => event.type === 'error')).toBe(true)
  })
})

describe('backup round trip', () => {
  it('carries the reasoning along with the message it belongs to', async () => {
    const { AssistantStore } = await import('../src/worker/assistant/store')
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const conversation = await store.createConversation('Traced')
    const written = await store.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'ANSWER',
      reasoning: 'A TRACE',
    })
    const exported = await store.exportTables()
    const row = (exported.messages ?? []).find((entry) => entry.id === written.id)!
    expect(row.reasoning).toBe('A TRACE')

    // A restore writes through the same column list, so a column left out of it is a trace the file
    // silently drops — and the account restoring is not the one that exported.
    const restored = new AssistantStore(env.DB as D1Database, OTHER, env)
    await restored.importRow('chat_messages', row)
    expect((await restored.messages(conversation.id)).at(-1)?.reasoning).toBe('A TRACE')
  })
})

/**
 * The thread a saved note came from.
 *
 * A note written by the model's own `create_note` tool files this row server-side, but a note written
 * from a reply is saved by the browser, so the client reports the origin afterwards. The row is what the
 * note's backlink panel joins on, and a conversation from somewhere else must be refused rather than
 * stored as a link with nothing at the end.
 */
describe('note origins', () => {
  it('records the thread a saved note came from, once per pair', async () => {
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Origins' })
    const noteId = '01hzzzzzzzzzzzzzzzzzzzzz01'

    expect(await call<{ ok: true }>('POST', '/api/assistant/note-writes', {
      noteId, conversationId: created.conversation.id,
    })).toEqual({ ok: true })
    // A thread that appends twice is still one origin: the panel lists threads, not edits.
    await call('POST', '/api/assistant/note-writes', { noteId, conversationId: created.conversation.id })
    const listed = await call<{ conversations: { id: string, title: string }[] }>(
      'GET', `/api/assistant/note-writes?noteId=${noteId}`,
    )
    expect(listed.conversations.map((entry) => entry.id)).toEqual([created.conversation.id])
    expect(listed.conversations[0]!.title).toBe('Origins')

    // Ids are checked before the row is written, and a conversation this account does not own is not found
    // rather than stored: it would be a link the panel could never resolve.
    expect(await status('POST', '/api/assistant/note-writes', { noteId: 'nope', conversationId: created.conversation.id })).toBe(404)
    expect(await status('POST', '/api/assistant/note-writes', {
      noteId, conversationId: '01hzzzzzzzzzzzzzzzzzzzzz02',
    })).toBe(404)

    // The row is account-scoped: another reader's panel does not learn that this note exists.
    asUser(OTHER)
    const foreign = await call<{ conversations: unknown[] }>('GET', `/api/assistant/note-writes?noteId=${noteId}`)
    expect(foreign.conversations).toHaveLength(0)
  })
})

/**
 * Long threads and long lists, read a page at a time.
 *
 * The rows are seeded straight into the database because the subject is the paging itself: a hundred
 * chat turns through the route would spend a minute proving what five hundred rows prove in a second.
 */
describe('paged lists and threads', () => {
  // Ids are the app's own shape — 26 base32 characters — because the routes validate them: a six-character
  // fixture would be refused before the paging it is meant to exercise was ever reached.
  const conversationId = (n: number) => `c${String(n).padStart(25, '0')}`
  const messageId = (n: number) => `m${String(n).padStart(25, '0')}`
  const noteId = (n: number) => `n${String(n).padStart(25, '0')}`

  function seedConversation(n: number, at: number, extra: { pinned?: number, noteId?: string | null } = {}): string {
    const id = conversationId(n)
    sqlite.prepare(
      `INSERT INTO chat_conversations (user_id, id, title, pinned, starred, archived, ephemeral, note_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
    ).run(USER, id, `Thread ${n}`, extra.pinned ?? 0, extra.noteId ?? null, at, at)
    return id
  }

  function seedMessage(n: number, conversation: string, role: 'user' | 'assistant', content: string, at: number): string {
    const id = messageId(n)
    sqlite.prepare(
      `INSERT INTO chat_messages (id, user_id, conversation_id, role, content, reasoning, tools, attachments, status, error, source,
        input_tokens, output_tokens, duration_ms, model_label, feedback, sources, created_at)
       VALUES (?, ?, ?, ?, ?, '', '[]', '[]', 'complete', NULL, 'chat', 0, 0, 0, '', '', '[]', ?)`,
    ).run(id, USER, conversation, role, content, at)
    return id
  }

  it('walks the whole list by cursor without repeating or skipping a row', async () => {
    // One pinned row among unpinned ones: the boundary between the two groups is where a keyset cursor
    // written against `updated_at` alone goes wrong.
    seedConversation(1, 1_000)
    seedConversation(2, 2_000, { pinned: 1 })
    seedConversation(3, 3_000)
    seedConversation(4, 4_000)
    seedConversation(5, 5_000)

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const query: string = `/api/assistant/conversations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const listed: { conversations: AssistantConversation[], nextCursor: string | null } = await call('GET', query)
      expect(listed.conversations.length).toBeLessThanOrEqual(2)
      seen.push(...listed.conversations.map((entry) => entry.id))
      cursor = listed.nextCursor
      if (!cursor) break
    }
    // Newest first, the pinned row ahead of it, and every row exactly once.
    expect(seen).toEqual([conversationId(2), conversationId(5), conversationId(4), conversationId(3), conversationId(1)])
    expect(new Set(seen).size).toBe(5)
    // A cursor the client made up is refused rather than silently read as the first page.
    expect(await status('GET', '/api/assistant/conversations?cursor=not-a-cursor')).toBe(400)
  })

  it('reads a long thread backwards, and opens it at a search hit', async () => {
    const conversation = seedConversation(9, 9_000)
    for (let n = 1; n <= 120; n++) {
      seedMessage(n, conversation, n % 2 === 1 ? 'user' : 'assistant', `turn ${n}`, 10_000 + n)
    }

    const newest = await call<{ messages: AssistantMessage[], hasMore: boolean, nextBefore: string | null }>(
      'GET', `/api/assistant/conversations/${conversation}?limit=50`,
    )
    expect(newest.messages).toHaveLength(50)
    expect(newest.messages[0]!.content).toBe('turn 71')
    expect(newest.messages.at(-1)!.content).toBe('turn 120')
    expect(newest.hasMore).toBe(true)

    const older = await call<{ messages: AssistantMessage[], hasMore: boolean, nextBefore: string | null }>(
      'GET', `/api/assistant/conversations/${conversation}?limit=50&before=${encodeURIComponent(newest.nextBefore!)}`,
    )
    expect(older.messages[0]!.content).toBe('turn 21')
    expect(older.messages.at(-1)!.content).toBe('turn 70')

    const first = await call<{ messages: AssistantMessage[], hasMore: boolean }>(
      'GET', `/api/assistant/conversations/${conversation}?limit=50&before=${encodeURIComponent(older.nextBefore!)}`,
    )
    expect(first.messages).toHaveLength(20)
    expect(first.messages[0]!.content).toBe('turn 1')
    expect(first.hasMore).toBe(false)

    // Opening at a hit: the window ends at that turn, and the reader is told there is more below.
    const atHit = await call<{ messages: AssistantMessage[], hasMore: boolean, hasNewer: boolean }>(
      'GET', `/api/assistant/conversations/${conversation}?limit=10&upto=${messageId(60)}`,
    )
    expect(atHit.messages.at(-1)!.content).toBe('turn 60')
    expect(atHit.hasMore).toBe(true)
    expect(atHit.hasNewer).toBe(true)
    // A message from another thread cannot be used to open this one somewhere it has no row.
    expect(await status('GET', `/api/assistant/conversations/${conversation}?upto=${messageId(999)}`)).toBe(404)
  })

  it('finds a word in a thread and says which turn and which words', async () => {
    const conversation = seedConversation(11, 11_000)
    seedMessage(1, conversation, 'user', 'a question about nothing in particular', 11_001)
    seedMessage(2, conversation, 'assistant', 'The lighthouse keeper kept a ledger of every ship.', 11_002)
    seedConversation(12, 12_000)

    const found = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?q=lighthouse')
    expect(found.conversations).toHaveLength(1)
    expect(found.conversations[0]!.id).toBe(conversation)
    expect(found.conversations[0]!.match?.messageId).toBe(messageId(2))
    expect(found.conversations[0]!.match?.snippet).toContain('lighthouse')
    // A thread that only matched on its title carries no turn to jump to.
    expect(found.conversations[0]!.match?.snippet).not.toContain('question')
  })

  it('finds a thread by the words of the note it came from', async () => {
    sqlite.prepare(
      `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, created_at, updated_at)
       VALUES (?, ?, 'Harbour notes', 'harbour notes', 'The tide table is pinned above the door.', '', 1, 1)`,
    ).run(noteId(1), USER)
    const conversation = seedConversation(13, 13_000, { noteId: noteId(1) })
    seedMessage(1, conversation, 'user', 'what did I write about the door?', 13_001)
    seedConversation(14, 14_000)

    const found = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?q=tide table')
    expect(found.conversations.map((entry) => entry.id)).toEqual([conversation])
    // The hit is in the note, not in a turn, so there is no message to jump to.
    expect(found.conversations[0]!.match ?? null).toBeNull()
  })

  it('remembers the note a thread was started from, once', async () => {
    sqlite.prepare(
      `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, created_at, updated_at)
       VALUES (?, ?, 'Origins', 'origins', '', '', 1, 1)`,
    ).run(noteId(2), USER)
    // A second real page, so "name another note" is refused for being write-once rather than for
    // pointing at something that never existed — the two failures the reader would not distinguish.
    sqlite.prepare(
      `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, created_at, updated_at)
       VALUES (?, ?, 'Relabel', 'relabel', '', '', 1, 1)`,
    ).run(noteId(1), USER)
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'From a note' })
    const patched = await call<{ conversation: AssistantConversation }>(
      'PATCH', `/api/assistant/conversations/${created.conversation.id}`, { noteId: noteId(2) },
    )
    expect(patched.conversation.noteId).toBe(noteId(2))
    // The first answer stands: naming a different note later does not relabel the thread. This is the
    // write-once rule, and it lives in the store's `AND note_id IS NULL`, not in this route.
    await call('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { noteId: noteId(1) })
    const still = await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${created.conversation.id}`)
    expect(still.conversation.noteId).toBe(noteId(2))
    // Clearing is a different act from relabelling, and the reader can ask for it: the chip beside the
    // thread's title offers exactly that. A named note that no longer answers must not leave the thread
    // claiming a label nobody can point at.
    await call('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { noteId: null })
    const reread = await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${created.conversation.id}`)
    expect(reread.conversation.noteId).toBeNull()
    // A note this account does not own cannot be named, and a malformed id is refused rather than
    // silently answering "done" having changed nothing.
    expect(await status('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { noteId: noteId(3) })).toBe(400)
    expect(await status('PATCH', `/api/assistant/conversations/${created.conversation.id}`, { noteId: 'not-an-id' })).toBe(400)
  })

  it('keeps the scope a turn was asked under, so a thread read later still says what it could see', async () => {
    await call('PATCH', '/api/assistant/settings', { offlineMode: true })
    const events = await chatEvents({
      message: 'what is in this note?',
      scopes: [{ kind: 'note', id: noteId(4), name: 'A scoped note' }],
    })
    const conversationId = events.find((event) => event.type === 'start')!.conversationId!
    const detail = await call<{ messages: { role: string, scopes?: unknown }[] }>(
      'GET', `/api/assistant/conversations/${conversationId}`,
    )
    const asked = detail.messages.find((message) => message.role === 'user')
    expect(asked?.scopes).toEqual([{ kind: 'note', id: noteId(4), name: 'A scoped note' }])
  })

  it('takes the files of a deleted conversation with it', async () => {
    const uploaded = await uploadFile('gone.txt', 'to be deleted', 'text/plain')
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Files' })
    seedMessage(1, created.conversation.id, 'user', 'look at this', 20_001)
    sqlite.prepare(`UPDATE chat_messages SET attachments = ? WHERE user_id = ? AND id = ?`)
      .run(JSON.stringify([uploaded.attachment.id]), USER, messageId(1))

    await call('DELETE', `/api/assistant/conversations/${created.conversation.id}`)
    const left = sqlite.prepare(`SELECT count(*) AS n FROM chat_attachments WHERE user_id = ? AND id = ?`)
      .get(USER, uploaded.attachment.id) as { n: number }
    expect(left.n).toBe(0)
  })
  it('continues an answer from where it stopped, without asking again', async () => {
    await useExampleModel()
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Half done' })
    seedMessage(1, created.conversation.id, 'user', 'Tell me about the harbour.', 30_001)
    seedMessage(2, created.conversation.id, 'assistant', 'The harbour was built in', 30_002)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    await chatEvents({ conversationId: created.conversation.id, continue: true })
    await settleTurns()
    vi.unstubAllGlobals()

    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${created.conversation.id}`)
    // One assistant row, carrying both halves: the words the reader already saw and the words that
    // finished them. A continue that added a second row would read as two answers to one question.
    expect(detail.messages).toHaveLength(2)
    expect(detail.messages[1]!.id).toBe(messageId(2))
    expect(detail.messages[1]!.content).toBe('The harbour was built inNothing is on the list.')
  })

  it('asks an answer in the middle of a thread again, and files the one it replaced', async () => {
    await useExampleModel()
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Middle' })
    const conversation = created.conversation.id
    seedMessage(1, conversation, 'user', 'First question.', 31_001)
    seedMessage(2, conversation, 'assistant', 'First answer.', 31_002)
    seedMessage(3, conversation, 'user', 'Second question.', 31_003)
    seedMessage(4, conversation, 'assistant', 'Second answer.', 31_004)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(FINAL_FRAMES), { headers: { 'content-type': 'text/event-stream' } })))
    await chatEvents({ conversationId: conversation, retry: true, messageId: messageId(2) })
    await settleTurns()
    vi.unstubAllGlobals()

    const detail = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversation}`)
    // The first turn survives, re-answered; everything written on top of it is gone.
    expect(detail.messages.map((entry) => entry.content)).toEqual(['First question.', 'Nothing is on the list.'])
    expect(detail.messages[1]!.id).toBe(messageId(2))
    const versions = await call<{ versions: AssistantAnswerVersion[] }>(
      'GET', `/api/assistant/conversations/${conversation}/messages/${messageId(2)}/versions`,
    )
    expect(versions.versions.map((entry) => entry.content)).toEqual(['First answer.'])
  })

  it('keeps the turns an edit truncates as a branch, when asked', async () => {
    const created = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Edited' })
    const conversation = created.conversation.id
    seedMessage(1, conversation, 'user', 'Original question.', 32_001)
    seedMessage(2, conversation, 'assistant', 'Original answer.', 32_002)
    seedMessage(3, conversation, 'user', 'Follow-up.', 32_003)
    seedMessage(4, conversation, 'assistant', 'Follow-up answer.', 32_004)

    const edited = await call<{ removed: number, branch: AssistantConversation | null }>(
      'PATCH', `/api/assistant/conversations/${conversation}/messages/${messageId(1)}`,
      { content: 'Retyped question.', keepBranch: true, branchTitle: 'Kept aside' },
    )
    expect(edited.removed).toBe(3)
    expect(edited.branch?.title).toBe('Kept aside')

    const original = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversation}`)
    expect(original.messages.map((entry) => entry.content)).toEqual(['Retyped question.'])
    // The branch is the whole thread as it stood: nothing the edit removed is only in the trash.
    const branch = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${edited.branch!.id}`)
    expect(branch.messages.map((entry) => entry.content)).toEqual([
      'Original question.', 'Original answer.', 'Follow-up.', 'Follow-up answer.',
    ])
  })

  it('carries the note a thread came from through a backup', async () => {
    const conversation = seedConversation(21, 40_000, { noteId: noteId(5) })
    seedMessage(1, conversation, 'user', 'about that note', 40_001)
    const payload = await call('GET', '/api/assistant/export')
    await call('DELETE', `/api/assistant/conversations/${conversation}`)
    await call('POST', '/api/assistant/import', payload)
    const restored = await call<{ conversation: AssistantConversation }>('GET', `/api/assistant/conversations/${conversation}`)
    // A column the import row does not name is written as null, so a restored thread would come back
    // with no origin and the chip that says where it came from would have nothing to say.
    expect(restored.conversation.noteId).toBe(noteId(5))
  })

})
