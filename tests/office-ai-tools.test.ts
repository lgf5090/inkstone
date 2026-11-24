// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { OFFICE_TOOLS } from '../src/worker/assistant/office-tools'
import type { ToolContext } from '../src/worker/assistant/tools'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { officeSnapshotKey } from '../src/shared/office/constants'
import type { Env } from '../src/worker/env'

const USER = '0123456789abcdefghjkmnpqrs'

let sqlite: DatabaseSync
let bucket: TestR2Bucket
let env: Env

function tool(name: string) {
  const definition = OFFICE_TOOLS.find((entry) => entry.name === name)
  if (!definition) throw new Error(`missing tool ${name}`)
  return definition
}

function context(): ToolContext {
  return {
    env,
    store: { userId: USER },
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: {},
    timezone: 'UTC',
    dayEnd: Date.now(),
    mode: 'chat',
  } as unknown as ToolContext
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
})

describe('office assistant tools', () => {
  it('creates a file, opens it, and lists it back', async () => {
    const create = tool('office_create_file')
    if (!('run' in create)) throw new Error('expected immediate tool')
    const created = await create.run({ type: 'docs', title: 'Launch plan' }, context()) as {
      result: { file: { id: string } }
      effect: { kind: string; fileId: string; fileType: string }
    }
    expect(created.effect).toEqual({ kind: 'office.open', fileId: created.result.file.id, fileType: 'docs' })

    const list = tool('office_list_files')
    if (!('run' in list)) throw new Error('expected immediate tool')
    const listed = await list.run({}, context()) as { files: Array<{ id: string; title: string }> }
    expect(listed.files).toHaveLength(1)
    expect(listed.files[0]!.title).toBe('Launch plan')
  })

  it('reads a stored snapshot with a bounded text view', async () => {
    const create = tool('office_create_file')
    if (!('run' in create)) throw new Error('expected immediate tool')
    const created = await create.run({ type: 'docs', title: 'Read me' }, context()) as {
      result: { file: { id: string } }
    }
    const id = created.result.file.id
    const key = officeSnapshotKey(USER, id, 1)
    await bucket.put(key, JSON.stringify({ body: { dataStream: 'Hello office' } }))
    sqlite.prepare(`UPDATE office_file SET snapshot_key = ?, rev = 1 WHERE user_id = ? AND id = ?`).run(key, USER, id)

    const read = tool('office_read_file')
    if (!('run' in read)) throw new Error('expected immediate tool')
    const result = await read.run({ id }, context()) as { text: string; truncated: boolean }
    expect(result.text).toContain('Hello office')
    expect(result.truncated).toBe(false)
  })

  it('updates metadata and moves a file to the trash through the approval pair', async () => {
    const create = tool('office_create_file')
    if (!('run' in create)) throw new Error('expected immediate tool')
    const created = await create.run({ type: 'sheets', title: 'Budget' }, context()) as {
      result: { file: { id: string } }
    }
    const id = created.result.file.id

    const update = tool('office_update_file')
    if (!('run' in update)) throw new Error('expected immediate tool')
    const updated = await update.run({ id, title: 'Budget 2027', isStarred: true }, context()) as {
      result: { file: { title: string; isStarred: boolean } }
      effect: { kind: string }
    }
    expect(updated.result.file.title).toBe('Budget 2027')
    expect(updated.result.file.isStarred).toBe(true)
    expect(updated.effect.kind).toBe('office.refresh')

    const remove = tool('office_delete_file')
    if (!('prepare' in remove)) throw new Error('expected destructive tool')
    const prepared = await remove.prepare({ id }, context())
    expect(prepared.targetLabel).toBe('Budget 2027')
    await remove.commit(prepared.targetId, context(), {})
    const trashed = sqlite.prepare(`SELECT deleted_at FROM office_file WHERE user_id = ? AND id = ?`).get(USER, id) as { deleted_at: number | null }
    expect(trashed.deleted_at).not.toBeNull()
  })

  it('validates and returns an office edit plan without mutating the file', async () => {
    const create = tool('office_create_file')
    if (!('run' in create)) throw new Error('expected immediate tool')
    const created = await create.run({ type: 'sheets', title: 'Data' }, context()) as {
      result: { file: { id: string } }
    }
    const id = created.result.file.id
    const propose = tool('office_propose_edit')
    if (!('run' in propose)) throw new Error('expected immediate tool')
    const result = await propose.run({
      fileId: id,
      type: 'sheets',
      summary: 'Fill the header',
      ops: [{ kind: 'sheets.set-values', range: 'A1', values: [['Name']] }],
    }, context()) as { effect: { kind: string; plan: { ops: unknown[] } } }
    expect(result.effect.kind).toBe('office.apply-plan')
    expect(result.effect.plan.ops).toHaveLength(1)
    const row = sqlite.prepare(`SELECT rev FROM office_file WHERE user_id = ? AND id = ?`).get(USER, id) as { rev: number }
    expect(row.rev).toBe(0)
  })

  it('describes a plan and drops it when a routine may not write', async () => {
    const create = tool('office_create_file')
    if (!('run' in create)) throw new Error('expected immediate tool')
    const created = await create.run({ type: 'sheets', title: 'Routine target' }, context()) as { result: { file: { id: string } } }

    const propose = tool('office_propose_edit')
    if (!('run' in propose)) throw new Error('expected immediate tool')
    const ctx = { ...context(), mode: 'scheduled' as const }
    const outcome = await propose.run({
      fileId: created.result.file.id,
      type: 'sheets',
      summary: 'Fill the morning row',
      ops: [{ kind: 'sheets.set-values', range: 'A1', values: [[7]] }],
    }, ctx) as { result: { applied: boolean, reason?: string }, effect?: unknown }

    expect(outcome.result.applied).toBe(false)
    expect(outcome.result.reason).toContain('unattended')
    expect(outcome.effect).toBeUndefined()
  })

  it('writes the file itself when the account allowed unattended writes', async () => {
    const create = tool('office_create_file')
    if (!('run' in create)) throw new Error('expected immediate tool')
    const created = await create.run({ type: 'sheets', title: 'Routine target' }, context()) as { result: { file: { id: string } } }
    await bucket.put(officeSnapshotKey(USER, created.result.file.id, 1), JSON.stringify({
      sheets: { s1: { name: 'Sheet1', cellData: {} } },
      sheetOrder: ['s1'],
    }))
    sqlite.prepare(`UPDATE office_file SET rev = 1, snapshot_key = ?3 WHERE user_id = ?1 AND id = ?2`)
      .run(USER, created.result.file.id, officeSnapshotKey(USER, created.result.file.id, 1))

    const propose = tool('office_propose_edit')
    if (!('run' in propose)) throw new Error('expected immediate tool')
    const ctx = { ...context(), mode: 'scheduled' as const, settings: { officeUnattendedApply: true } } as unknown as ToolContext
    const outcome = await propose.run({
      fileId: created.result.file.id,
      type: 'sheets',
      summary: 'Fill the morning row',
      ops: [{ kind: 'sheets.set-values', range: 'B2', values: [[7]] }],
    }, ctx) as { result: { applied: boolean, rev?: number }, effect?: unknown }

    expect(outcome.result.applied).toBe(true)
    expect(outcome.effect).toBeUndefined()
    const stored = await bucket.get(officeSnapshotKey(USER, created.result.file.id, outcome.result.rev!))
    expect(await stored!.text()).toContain('"v":7')
  })

  it('still hands the plan to the editor in a chat turn', async () => {
    const create = tool('office_create_file')
    if (!('run' in create)) throw new Error('expected immediate tool')
    const created = await create.run({ type: 'sheets', title: 'Chat target' }, context()) as { result: { file: { id: string } } }

    const propose = tool('office_propose_edit')
    if (!('run' in propose)) throw new Error('expected immediate tool')
    const outcome = await propose.run({
      fileId: created.result.file.id,
      type: 'sheets',
      summary: 'Fill the cell',
      ops: [{ kind: 'sheets.set-values', range: 'A1', values: [[1]] }],
    }, context()) as { effect?: { kind: string } }

    expect(outcome.effect?.kind).toBe('office.apply-plan')
  })
})
