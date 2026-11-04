// @vitest-environment node
/**
 * The Memos tools: what the model may name, what the tools write, and what another account cannot touch.
 *
 * The store is the real one over SQLite: a dependency of the assistant is a dependency of the Memos app,
 * so a mock here would only prove that a mock answers. The rows below are written and read through
 * `MemosStore`, and every refusal is a refusal the Memos app itself would make.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import {
  ALL_TOOLS,
  ToolError,
  assertToolsMatchSpecs,
  validateArgs,
  type DestructiveTool,
  type ToolContext,
} from '../src/worker/assistant/tools'
import { MemosStore } from '../src/worker/memos/store'
import { createSpace } from '../src/worker/memos/spaces'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const ALICE = '0123456789abcdefghjkmnpqrs'
const BOB = 'ssssssssssssssssssssssssss'

let sqlite: DatabaseSync
let env: ReturnType<typeof testBindings>
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  db = env.DB as D1Database
})

function context(userId = ALICE): ToolContext {
  return {
    store: new AssistantStore(db, userId, env),
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'UTC',
    dayEnd: 0,
    mode: 'chat',
    conversationId: 'conversation-1',
  } as unknown as ToolContext
}

function immediate(name: string) {
  const definition = ALL_TOOLS.find((entry) => entry.name === name)
  if (!definition || !('run' in definition)) throw new Error(`missing immediate tool ${name}`)
  return definition
}

function destructive(name: string): DestructiveTool {
  const definition = ALL_TOOLS.find((entry) => entry.name === name)
  if (!definition || definition.permission !== 'destructive') throw new Error(`missing destructive tool ${name}`)
  return definition
}

async function runTool(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx = context(),
): Promise<Record<string, unknown>> {
  const definition = immediate(name)
  return await definition.run(validateArgs(definition.fields, rawArgs), ctx) as Record<string, unknown>
}

function store(userId = ALICE): MemosStore {
  return new MemosStore(db, userId)
}

async function seedMemo(
  userId: string,
  fields: { content: string, tags?: string[], spaceId?: string, createdAt?: number, visibility?: 'private' | 'protected' | 'public' },
) {
  return await store(userId).create({
    content: fields.content,
    createdAt: fields.createdAt,
    ...(fields.tags ? { content: `${fields.content} ${fields.tags.map((tag) => `#${tag}`).join(' ')}` } : {}),
    ...(fields.spaceId !== undefined ? { spaceId: fields.spaceId } : {}),
    ...(fields.visibility ? { visibility: fields.visibility } : {}),
  })
}

describe('the memos tools in the catalog', () => {
  it('is in the shared spec list with the same permissions', () => {
    expect(() => assertToolsMatchSpecs()).not.toThrow()
    const expected: Record<string, string> = {
      memo_list: 'read',
      memo_search: 'read',
      memo_read: 'read',
      memo_create: 'write',
      memo_comment: 'destructive',
      memo_delete: 'destructive',
    }
    for (const [name, permission] of Object.entries(expected)) {
      const definition = ALL_TOOLS.find((entry) => entry.name === name)
      expect(definition?.permission).toBe(permission)
    }
  })

  it('validates declarations through the same FieldSpec the provider sees', () => {
    const deleteTool = ALL_TOOLS.find((entry) => entry.name === 'memo_delete')!
    const args = validateArgs(deleteTool.fields, {
      ids: Array.from({ length: 11 }, (_, index) => `memo-${index}`),
    })
    // The declaration itself caps the batch: a model that names eleven memos is handed ten, and the
    // approval card then says how many of them it will delete.
    expect(args.ids).toHaveLength(10)
    expect(() => validateArgs(ALL_TOOLS.find((entry) => entry.name === 'memo_create')!.fields, { content: '' }))
      .toThrow()
  })
})

describe('recording a memo', () => {
  it('writes a real row and echoes its id, body, tags, and where it landed', async () => {
    const space = await createSpace(db, ALICE, { title: '工作' })
    const result = await runTool('memo_create', {
      content: '今天和设计对齐首页改版',
      tags: ['设计', '#首页'],
      space: '工作',
      visibility: 'protected',
    })
    const created = result.created as Record<string, unknown>
    expect(created.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    expect(created.url).toBe(`/memos/m/${created.id}`)
    expect(created.tags).toEqual(expect.arrayContaining(['设计', '首页']))
    expect(created.visibility).toBe('protected')
    expect(created.space_id).toBe(space.id)

    const memo = await store().get(String(created.id))
    expect(memo?.content).toContain('今天和设计对齐首页改版')
    expect(memo?.content).toContain('#设计')
    expect(memo?.tags).toEqual(expect.arrayContaining(['设计', '首页']))
    expect(memo?.spaceId).toBe(space.id)
    expect(memo?.visibility).toBe('protected')
  })

  it('refuses a space the reader does not own', async () => {
    const bobsSpace = await createSpace(db, BOB, { title: '私有' })
    await expect(runTool('memo_create', { content: '写一条', space: bobsSpace.id }, context(BOB)))
      .resolves.toBeTruthy()
    await expect(runTool('memo_create', { content: '写一条', space: bobsSpace.id }, context(ALICE)))
      .rejects.toBeInstanceOf(ToolError)
  })

  it('refuses an empty body and a tag that the memo parser would drop', async () => {
    await expect(runTool('memo_create', { content: '   ' })).rejects.toBeInstanceOf(ToolError)
    await expect(runTool('memo_create', { content: '写一条', tags: ['not a tag'] }))
      .rejects.toBeInstanceOf(ToolError)
  })
})

describe('finding memos', () => {
  it('filters by space, tag, and a created-day range', async () => {
    const work = await createSpace(db, ALICE, { title: '工作' })
    const home = await createSpace(db, ALICE, { title: '生活' })
    await seedMemo(ALICE, { content: '上周提到上线', tags: ['上线'], spaceId: work.id, createdAt: Date.UTC(2026, 9, 27) / 1000 })
    await seedMemo(ALICE, { content: '首页设计评审', tags: ['设计'], spaceId: work.id, createdAt: Date.UTC(2026, 10, 2) / 1000 })
    await seedMemo(ALICE, { content: '买菜', tags: ['生活'], spaceId: home.id, createdAt: Date.UTC(2026, 10, 2) / 1000 })
    await seedMemo(ALICE, { content: '没有归类', createdAt: Date.UTC(2026, 10, 3) / 1000 })

    const bySpace = await runTool('memo_list', { space: '工作' })
    expect(bySpace.count).toBe(2)

    const byTag = await runTool('memo_list', { tag: '上线' })
    expect(byTag.count).toBe(1)
    expect((byTag.memos as Array<Record<string, unknown>>)[0]!.content).toContain('上周提到上线')

    const byDay = await runTool('memo_list', { since: '2026-11-01', until: '2026-11-02' })
    expect(byDay.count).toBe(2)

    const unfiled = await runTool('memo_list', { space: null })
    expect(unfiled.count).toBe(1)
    expect((unfiled.memos as Array<Record<string, unknown>>)[0]!.content).toContain('没有归类')
  })

  it('searches bodies case-insensitively and narrows with the same filters', async () => {
    const work = await createSpace(db, ALICE, { title: '工作' })
    await seedMemo(ALICE, { content: '上周提到上线计划', tags: ['上线'], spaceId: work.id, createdAt: Date.UTC(2026, 9, 27) / 1000 })
    await seedMemo(ALICE, { content: '他说"发布"要等评审', spaceId: work.id, createdAt: Date.UTC(2026, 10, 2) / 1000 })
    await seedMemo(ALICE, { content: '无关的一条' })

    const hit = await runTool('memo_search', { query: '上线' })
    expect(hit.count).toBe(1)
    expect((hit.memos as Array<Record<string, unknown>>)[0]!.tags).toContain('上线')

    const quotedHit = await runTool('memo_search', { query: '"发布"' })
    expect(quotedHit.count).toBe(1)

    const narrowed = await runTool('memo_search', { query: '评审', space: '工作', tag: '设计' })
    expect(narrowed.count).toBe(0)

    const otherAccount = await runTool('memo_search', { query: '上线' }, context(BOB))
    expect(otherAccount.count).toBe(0)
  })

  it('reads one memo in full and lists its comments', async () => {
    const memo = await seedMemo(ALICE, { content: '首页改版讨论' })
    const parent = await destructive('memo_comment').prepare({ memo: memo.id, content: '同意，周五评审' }, context())
    expect(parent.targetId).toBe(memo.id)
    expect(parent.targetLabel).toContain('首页改版讨论')
    expect((await store().listComments(memo.id))?.items).toHaveLength(0)

    const committed = await destructive('memo_comment').commit(parent.targetId, context(), { content: '同意，周五评审' })
    expect(committed).toMatchObject({ comment: { content: '同意，周五评审' } })

    const read = await runTool('memo_read', { id: memo.id })
    expect(read.full_content).toBe('首页改版讨论')
    expect(read.comments).toHaveLength(1)
    expect((read.comments as Array<Record<string, unknown>>)[0]!.content).toBe('同意，周五评审')
  })
})

describe('deleting memos through approval', () => {
  it('names the batch and deletes nothing until commit', async () => {
    const first = await seedMemo(ALICE, { content: '第一条要删' })
    const second = await seedMemo(ALICE, { content: '第二条要删' })
    const third = await seedMemo(ALICE, { content: '第三条要删' })

    const prepared = await destructive('memo_delete').prepare({ ids: [first.id, second.id, third.id] }, context())
    expect(prepared.targetLabel).toBe('3 memos: "第一条要删", "第二条要删", "第三条要删"')
    // Nothing has changed while the card waits.
    expect(await store().get(first.id)).not.toBeNull()
    expect(await store().get(second.id)).not.toBeNull()
    expect(await store().get(third.id)).not.toBeNull()

    const result = await destructive('memo_delete').commit(prepared.targetId, context(), {})
    expect(result).toEqual({ deleted: 3, ids: [first.id, second.id, third.id] })
    expect(await store().get(first.id)).toBeNull()
    expect(await store().get(second.id)).toBeNull()
    expect(await store().get(third.id)).toBeNull()
  })

  it('selects the batch by the same words and filters a search uses', async () => {
    const work = await createSpace(db, ALICE, { title: '工作' })
    const doomed = await seedMemo(ALICE, { content: '过期草稿：上线备忘', spaceId: work.id })
    await seedMemo(ALICE, { content: '保留：上线计划', spaceId: work.id })

    const prepared = await destructive('memo_delete').prepare({ query: '过期草稿', space: '工作' }, context())
    expect(prepared.targetId).toBe(doomed.id)
    expect(prepared.targetLabel).toContain('1 memo')

    await destructive('memo_delete').commit(prepared.targetId, context(), {})
    expect(await store().get(doomed.id)).toBeNull()
    expect((await runTool('memo_list', { space: '工作' })).count).toBe(1)
  })

  it('refuses a batch larger than the approval cap, and a selection that matches nothing', async () => {
    const ids: string[] = []
    for (let index = 0; index < 11; index++) ids.push((await seedMemo(ALICE, { content: `批量 ${index}` })).id)
    await expect(destructive('memo_delete').prepare({ ids }, context()))
      .rejects.toThrow(/at most 10 memos/)
    await expect(destructive('memo_delete').prepare({ query: '不存在的词' }, context()))
      .rejects.toBeInstanceOf(ToolError)
  })
})

describe('the permission boundary', () => {
  it('cannot read, comment on, or delete another account\'s memo', async () => {
    const bobsMemo = await seedMemo(BOB, { content: 'BOB 的备忘' })

    await expect(runTool('memo_read', { id: bobsMemo.id }, context(ALICE))).rejects.toBeInstanceOf(ToolError)
    await expect(destructive('memo_comment').prepare({ memo: bobsMemo.id, content: '越权评论' }, context(ALICE)))
      .rejects.toBeInstanceOf(ToolError)
    await expect(destructive('memo_delete').prepare({ ids: [bobsMemo.id] }, context(ALICE)))
      .rejects.toBeInstanceOf(ToolError)
    // BOB's own account still sees it.
    expect((await runTool('memo_read', { id: bobsMemo.id }, context(BOB))).full_content).toBe('BOB 的备忘')
  })

  it('cannot list another account\'s space, even by its id', async () => {
    const bobsSpace = await createSpace(db, BOB, { title: 'BOB 空间' })
    await seedMemo(BOB, { content: 'BOB 空间里的一条', spaceId: bobsSpace.id })

    await expect(runTool('memo_list', { space: bobsSpace.id }, context(ALICE)))
      .rejects.toBeInstanceOf(ToolError)
    await expect(runTool('memo_list', { space: 'BOB 空间' }, context(ALICE)))
      .rejects.toBeInstanceOf(ToolError)
    expect((await runTool('memo_list', { space: bobsSpace.id }, context(BOB))).count).toBe(1)
  })

  it('never hands a sealed body or its ciphertext to the model', async () => {
    const sealed = await store(ALICE).create({
      content: 'TOP SECRET words that must not travel',
      encrypted: true,
      contentCipher: 'memoenc:v1:AAAA:BBBB:CCCC',
      tags: ['private'],
    })
    const read = await runTool('memo_read', { id: sealed.id })
    expect(JSON.stringify(read)).not.toContain('TOP SECRET')
    expect(JSON.stringify(read)).not.toContain('memoenc:')
    expect(String(read.full_content)).toContain('encrypted')

    const listed = await runTool('memo_list', {})
    expect(JSON.stringify(listed)).not.toContain('TOP SECRET')
    expect(JSON.stringify(listed)).not.toContain('memoenc:')

    const searched = await runTool('memo_search', { query: 'SECRET' })
    expect(searched.count).toBe(0)
  })
})
