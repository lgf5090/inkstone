// @vitest-environment node
/**
 * Where a remembered fact lives, and therefore who can recall it.
 *
 * A project is a context — a client, an engagement, a piece of work — and what is true inside one is not
 * automatically true in the next. So a fact is filed where it was learned, and a turn recalls the account's
 * own facts plus its project's, never a third project's. Three things follow and are pinned here: the read
 * is narrowed, the write is filed, and the two comparisons that decide whether a new fact duplicates or
 * contradicts an old one happen inside one scope. Without the last of those, one client's fact would
 * silently retire another's — a data-loss bug wearing the costume of deduplication.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantMemory, type Project } from '../src/shared/assistant'
import { initializeDatabase } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { MemoryHistoryService } from '../src/worker/assistant/memory-service'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-1'

let env: Env
let store: AssistantStore
let clientA: Project
let clientB: Project

beforeEach(async () => {
  const sqlite = new DatabaseSync(':memory:')
  const db = makeD1(sqlite)
  await initializeDatabase({ DB: db } as never)
  env = { DB: db } as unknown as Env
  store = new AssistantStore(env.DB, USER, env)
  clientA = await store.createProject({ name: 'Client A', description: '' })
  clientB = await store.createProject({ name: 'Client B', description: '' })
})

/** A fact written straight into the store, filed where the test says it was learned. */
function fileFact(content: string, projectId: string | null, category: AssistantMemory['category'] = 'fact') {
  return store.insertMemory({ content, category, source: 'assistant', projectId })
}

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    store,
    env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'Asia/Shanghai',
    dayEnd: 1_700_000_000_000,
    mode: 'chat',
    conversationId: 'c1',
    memoryHistory: new MemoryHistoryService(store, {}, true),
    memoryScope: { projectId: clientA.id },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    ...over,
  }
}

const run = (name: string, args: Record<string, unknown> = {}, over: Partial<ToolContext> = {}) =>
  new ToolExecutor(context(over), { maxToolCalls: 8 }).execute(name, args, 'call-1')

describe('what a turn inside a project may recall', () => {
  it('sees the account\'s facts and its own project\'s, never another project\'s', async () => {
    await fileFact('The budget is 40k', null)
    await fileFact('The budget review is monthly', clientA.id)
    await fileFact('The budget owner is Dana', clientB.id)

    const inA = await store.searchMemories('budget', 8, 'current', { projectId: clientA.id })
    expect(inA.map((memory) => memory.content).sort()).toEqual(['The budget is 40k', 'The budget review is monthly'])

    const listed = await store.listMemories({ scope: { projectId: clientA.id } })
    expect(listed.map((memory) => memory.content).sort()).toEqual(['The budget is 40k', 'The budget review is monthly'])
  })

  it('gives a turn outside every project the account\'s facts alone', async () => {
    await fileFact('The budget is 40k', null)
    await fileFact('The budget review is monthly', clientA.id)

    // Narrower than "no filter", which is the whole reason the scope is a value rather than an optional
    // argument: a conversation that belongs to no project must not be the widest reader in the app.
    const outside = await store.searchMemories('budget', 8, 'current', { projectId: null })
    expect(outside.map((memory) => memory.content)).toEqual(['The budget is 40k'])
    expect(await store.listMemories({ scope: { projectId: null } })).toHaveLength(1)
  })

  it('leaves the management screen reading everything', async () => {
    await fileFact('The budget is 40k', null)
    await fileFact('The budget review is monthly', clientA.id)
    await fileFact('The budget owner is Dana', clientB.id)

    // No scope means no filter, and the only caller that gets to say that is the memory page: a reader
    // looking at what the assistant knows is not inside any one project.
    expect(await store.listMemories({})).toHaveLength(3)
    expect(await store.listMemories({ scope: { projectId: clientB.id } })).toHaveLength(2)
  })
})

describe('a fact is filed where it was learned', () => {
  it('files a remembered fact under the turn\'s project', async () => {
    const remembered = await run('remember', { content: 'The client prefers Tuesday calls' }) as { remembered: { id: string } }
    expect((await store.getMemory(remembered.remembered.id))?.projectId).toBe(clientA.id)

    const outside = await run('remember', { content: 'The reader prefers morning calls' }, { memoryScope: { projectId: null } }) as { remembered: { id: string } }
    expect((await store.getMemory(outside.remembered.id))?.projectId).toBeNull()
  })

  it('treats the same sentence in two projects as two facts', async () => {
    const inA = await fileFact('The budget is 40k', clientA.id)
    // A duplicate is a question about one scope. "The budget is 40k" said about one client is not a
    // reason to drop the other client's, so the second is a new fact rather than a refresh.
    expect(await store.findDuplicateMemory('The budget is 40k', { projectId: clientB.id })).toBeNull()
    expect((await store.findDuplicateMemory('the budget is 40k', { projectId: clientA.id }))?.id).toBe(inA.id)
  })

  it('keeps a correction in the scope of what it corrects', async () => {
    const original = await fileFact('The budget is 40k', clientA.id)
    const corrected = await new MemoryHistoryService(store, {}, true).update(original.id, { content: 'The budget is 45k' })
    // Replacing a project's fact with an account-wide one would be a promotion nobody asked for.
    expect(corrected.memory.projectId).toBe(clientA.id)
  })

  it('detects a conflict inside its own scope, and not across scopes', async () => {
    const history = new MemoryHistoryService(store, {}, true)
    const london = await history.create({ content: 'Lives in London', category: 'place', source: 'assistant', projectId: clientA.id })
    // Same topic, other client: a comparison here would retire a fact about a different engagement.
    const inB = await history.create({ content: 'Lives in London near the park', category: 'place', source: 'assistant', projectId: clientB.id })
    expect(inB.superseded).toHaveLength(0)
    expect((await store.getMemory(london.memory.id))?.status).toBe('active')
    expect((await store.getMemory(inB.memory.id))?.status).toBe('active')

    // And in its own scope the rules still run: the same refinement retires the older statement.
    const refined = await history.create({ content: 'Lives in London near the river', category: 'place', source: 'assistant', projectId: clientA.id })
    expect(refined.superseded.map((memory) => memory.id)).toEqual([london.memory.id])
  })
})

describe('the tools see what recall sees', () => {
  it('refuses to correct a memory from another project', async () => {
    const foreign = await fileFact('The budget owner is Dana', clientB.id)
    // An id is a stable string that travels through conversations, so "I know its name" must not be a
    // permission — otherwise a turn could edit what it is not allowed to read.
    await expect(run('update_memory', { id: foreign.id, content: 'The budget owner is nobody' }))
      .rejects.toThrow('Memory not found.')
    expect((await store.getMemory(foreign.id))?.content).toBe('The budget owner is Dana')
  })

  it('refuses to forget one', async () => {
    const foreign = await fileFact('The budget owner is Dana', clientB.id)
    await expect(run('forget_memory', { id: foreign.id })).rejects.toThrow('Memory not found.')
    expect(await store.getMemory(foreign.id)).not.toBeNull()
  })

  it('lets a turn touch the account\'s own memories from inside a project', async () => {
    const shared = await fileFact('The budget is 40k', null)
    // Account-wide facts are in every turn's scope; only a project's own are fenced off from other projects.
    const corrected = await run('update_memory', { id: shared.id, content: 'The budget is 42k' }) as { updated: { content: string } }
    expect(corrected.updated.content).toBe('The budget is 42k')
  })

  it('does not leak another project\'s facts through the generic search', async () => {
    await fileFact('The budget review is monthly', clientA.id)
    await fileFact('The budget owner is Dana', clientB.id)

    const found = await run('search', { query: 'budget' }) as { memories: { content: string }[] }
    // `search` reads memories too, so it asks the same question recall does. Without the scope it would be
    // the one door in the app a turn could walk through to another project's facts.
    expect(found.memories.map((memory) => memory.content)).toEqual(['The budget review is monthly'])
  })
})

describe('a project\'s facts leave with it', () => {
  it('deletes the facts filed under a deleted project and keeps the rest', async () => {
    const own = await fileFact('The budget review is monthly', clientA.id)
    const shared = await fileFact('The budget is 40k', null)
    const other = await fileFact('The budget owner is Dana', clientB.id)

    await store.deleteProject(clientA.id)

    // Keeping them would either resurrect one client's facts as the account's own — surfacing them in
    // every other conversation — or strand them under a project no turn can name again.
    expect(await store.getMemory(own.id)).toBeNull()
    expect(await store.getMemory(shared.id)).not.toBeNull()
    expect(await store.getMemory(other.id)).not.toBeNull()
  })
})
