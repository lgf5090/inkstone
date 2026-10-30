// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS } from '../src/worker/development/api-tester/schema'
import {
  createWorkspace,
  deleteWorkspace,
  ensureDefaultWorkspace,
  getStateRow,
  insertHistory,
  listHistoryRows,
  listWorkspaces,
  saveState,
  updateWorkspace,
} from '../src/worker/development/api-tester/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_APITESTER_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

describe('API Tester workspace store', () => {
  it('creates one default workspace per user and isolates users', async () => {
    const first = await ensureDefaultWorkspace(db, USER)
    const second = await ensureDefaultWorkspace(db, USER)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]?.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    expect(await listWorkspaces(db, OTHER)).toEqual([])
  })

  it('creates, renames and colors workspaces, then refuses to delete the last one', async () => {
    await ensureDefaultWorkspace(db, USER)
    const created = await createWorkspace(db, USER, { name: 'Staging', color: 'emerald' })
    expect(created.workspaces).toHaveLength(2)
    const list = await updateWorkspace(db, USER, created.workspace.id, { name: 'QA', color: 'red' })
    expect(list.find((workspace) => workspace.id === created.workspace.id)).toMatchObject({ name: 'QA', color: 'red' })
    const after = await deleteWorkspace(db, USER, created.workspace.id)
    expect(after).toHaveLength(1)
    await expect(deleteWorkspace(db, USER, after[0]!.id)).rejects.toMatchObject({ status: 400 })
  })

  it('inserts and updates state with revision protection', async () => {
    const [workspace] = await ensureDefaultWorkspace(db, USER)
    await saveState(db, USER, workspace!.id, 'cipher-1', 0)
    expect((await getStateRow(db, USER, workspace!.id))?.rev).toBe(1)
    const next = await saveState(db, USER, workspace!.id, 'cipher-2', 1)
    expect(next.rev).toBe(2)
    await expect(saveState(db, USER, workspace!.id, 'stale', 1)).rejects.toMatchObject({ status: 409 })
  })

  it('never re-files a history row into another workspace', async () => {
    const [first] = await ensureDefaultWorkspace(db, USER)
    const second = await createWorkspace(db, USER, { name: 'Other' })
    await insertHistory(db, USER, first!.id, { id: 'h-shared', ts: 10, ciphertext: 'first-copy' })

    await insertHistory(db, USER, second.workspace.id, { id: 'h-shared', ts: 20, ciphertext: 'second-copy' })

    const rows = await listHistoryRows(db, USER, first!.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ts: 10, data: 'first-copy' })
    expect(await listHistoryRows(db, USER, second.workspace.id)).toEqual([])
  })

  it('trims history to the newest 100 entries', async () => {
    const [workspace] = await ensureDefaultWorkspace(db, USER)
    for (let index = 0; index < 105; index++) {
      await insertHistory(db, USER, workspace!.id, { id: `h${String(index).padStart(25, '0')}`, ts: index, ciphertext: `c${index}` })
    }
    const rows = await listHistoryRows(db, USER, workspace!.id)
    expect(rows).toHaveLength(100)
    expect(rows[0]?.ts).toBe(104)
    expect(rows[99]?.ts).toBe(5)
  })
})
