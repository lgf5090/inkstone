// @vitest-environment node
/**
 * The tools that let the model work on a draft.
 *
 * The store is the real one: the value of these tools is that a call becomes a version, so a fake that
 * only echoed the content would pass while the history stayed empty. The cases pin the two defaults the
 * model relies on — "the draft I have open" and "read before you write" — and the exact-match rule that
 * keeps a find-and-replace from landing on the wrong paragraph.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation } from '../src/shared/assistant'
import { initializeDatabase } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

let sqlite: DatabaseSync
let store: AssistantStore
let env: Env
let conversation: AssistantConversation

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'UTC',
    dayEnd: 1_700_000_000_000,
    mode: 'chat',
    conversationId: conversation.id,
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    writeContext: {} as ToolContext['writeContext'],
    ...over,
  }
}

function executor(ctx: ToolContext = context()): ToolExecutor {
  return new ToolExecutor(ctx, { maxToolCalls: 20 })
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  env = testBindings(makeD1(sqlite))
  await initializeDatabase(env)
  store = new AssistantStore(env.DB, USER, env)
  conversation = await store.createConversation('Draft bench')
})

describe('artifact tools', () => {
  it('creates a draft and returns a receipt rather than the document', async () => {
    const result = await executor().execute('create_artifact', {
      title: 'A plan',
      content: '# A plan\n\nFirst step.',
    }, 'call-create') as { artifact: { id: string, title: string, version: number, chars: number, created: boolean } }
    expect(result.artifact).toMatchObject({ title: 'A plan', version: 1, created: true })
    expect(result.artifact.chars).toBe('# A plan\n\nFirst step.'.length)
    expect(result).not.toHaveProperty('content')
    const drafts = await store.listArtifacts(conversation.id)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.id).toBe(result.artifact.id)
  })

  it('reads the open draft, and a slice of a long one', async () => {
    const draft = await store.createArtifact({ conversationId: conversation.id, title: 'Long', content: 'abcdefghij' })
    const read = await executor(context({ artifactContext: { id: draft.id } }))
      .execute('read_artifact', { offset: 2, limit: 3 }, 'call-read') as { artifact: { content: string, truncated: boolean, chars: number } }
    expect(read.artifact.content).toBe('cde')
    expect(read.artifact.chars).toBe(10)
    expect(read.artifact.truncated).toBe(true)
  })

  it('updates by exact replacement and appends a version', async () => {
    const draft = await store.createArtifact({ conversationId: conversation.id, title: 'Plan', content: 'One\nTwo\nThree' })
    const result = await executor(context({ artifactContext: { id: draft.id } }))
      .execute('update_artifact', { find: 'Two', replace: 'Second' }, 'call-update') as { artifact: { version: number }, changed: boolean }
    expect(result.changed).toBe(true)
    expect(result.artifact.version).toBe(2)
    const updated = await store.getArtifact(draft.id)
    expect(updated?.content).toBe('One\nSecond\nThree')
    const versions = await store.listArtifactVersions(draft.id)
    expect(versions.map((entry) => entry.version)).toEqual([2, 1])
    expect(versions[0]?.source).toBe('assistant')
  })

  it('refuses a replacement whose text is missing or appears twice', async () => {
    const draft = await store.createArtifact({ conversationId: conversation.id, title: 'Plan', content: 'One\nTwo\nTwo' })
    const ctx = context({ artifactContext: { id: draft.id } })
    await expect(executor(ctx).execute('update_artifact', { find: 'Three', replace: 'X' }, 'call-missing'))
      .rejects.toThrow('was not found')
    await expect(executor(ctx).execute('update_artifact', { find: 'Two', replace: 'X' }, 'call-twice'))
      .rejects.toThrow('more than once')
    expect((await store.getArtifact(draft.id))?.version).toBe(1)
  })

  it('requires a draft when none is open and no id is named', async () => {
    await expect(executor().execute('read_artifact', {}, 'call-none')).rejects.toThrow('No draft is open')
  })

  it('does not read across conversations', async () => {
    const other = await store.createConversation('Other')
    const foreign = await store.createArtifact({ conversationId: other.id, title: 'Mine', content: 'Body' })
    await expect(executor().execute('read_artifact', { id: foreign.id }, 'call-foreign'))
      .rejects.toThrow('No such draft')
  })

  it('does not create past the conversation cap', async () => {
    const ctx = context()
    for (let index = 0; index < 50; index++) {
      await store.createArtifact({ conversationId: conversation.id, title: `Draft ${index}`, content: 'Body' })
    }
    await expect(executor(ctx).execute('create_artifact', { content: 'Body' }, 'call-full'))
      .rejects.toThrow('already holds 50 drafts')
  })
})
