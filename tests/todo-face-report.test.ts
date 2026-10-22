// @vitest-environment node
/**
 * The store's face door says what it dropped.
 *
 * A task's icon and colour are judged by one accept set — `taskIconOrNull` and `taskColorOrNull` in
 * `shared/todos/model.ts` — but the two doors that use it fail differently: the HTTP route answers an
 * unusable value with a 400, while the store answers it with null so that one bad field cannot undo
 * the rest of the write (defect A17 of `reports/super-productivity-port-plan.md`, whose scope was
 * narrowed once both doors were measured against the same rule). A null is the same value a *clear*
 * writes, so a tool or agent that called the store directly could report "the icon is set" over a row
 * that carries none — a silent failure `AGENTS.md` rule 2 forbids.
 *
 * The cases below write through the store the way the MCP and assistant surfaces do, and pin that the
 * returned row names the field that did not land. A value that lands is answered without the field at
 * all: the report is about what is missing, and a write that lost nothing has nothing to report.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { MAX_TASK_ICON_CHARS } from '../src/shared/todos/model'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'user-alice'
/** An icon name one character past the ceiling the shared guard sets. */
const TOO_LONG_ICON = 'lucide:'.padEnd(MAX_TASK_ICON_CHARS + 1, 'x')
/** A colour outside the palette and not a hex the reader could have mixed. */
const NOT_A_COLOR = 'crimson'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

describe('a task face written through the store', () => {
  it('names the icon a create asked for and the row will not carry', async () => {
    const task = await store.createTask({ title: 'Weekly report', icon: TOO_LONG_ICON })

    expect(task.icon).toBeNull()
    expect(task.droppedFace?.map((entry) => entry.field)).toEqual(['icon'])
    expect(task.droppedFace?.[0]?.reason).toContain(String(MAX_TASK_ICON_CHARS))
  })

  it('names the colour an edit asked for and the row will not carry', async () => {
    const created = await store.createTask({ title: 'Weekly report' })

    const task = await store.updateTask(created.id, { color: NOT_A_COLOR })

    expect(task?.color).toBeNull()
    expect(task?.droppedFace?.map((entry) => entry.field)).toEqual(['color'])
  })

  it('names both fields when both were asked for unusably', async () => {
    const created = await store.createTask({ title: 'Weekly report', icon: 'Briefcase' })

    const task = await store.updateTask(created.id, { icon: TOO_LONG_ICON, color: NOT_A_COLOR })

    expect(task?.droppedFace?.map((entry) => entry.field).sort()).toEqual(['color', 'icon'])
    // The row keeps the face it had, rather than losing it to the half of the patch that landed.
    expect(task?.icon).toBe('Briefcase')
  })

  it('reports nothing when the face lands as asked', async () => {
    const task = await store.createTask({ title: 'Weekly report', icon: 'Briefcase', color: '#2563eb' })

    expect(task.icon).toBe('Briefcase')
    expect(task.color).toBe('#2563eb')
    expect(task.droppedFace).toBeUndefined()
  })

  it('treats clearing the face as the write it is, not as a loss', async () => {
    const created = await store.createTask({ title: 'Weekly report', icon: 'Briefcase', color: '#2563eb' })

    const task = await store.updateTask(created.id, { icon: null, color: null })

    expect(task?.icon).toBeNull()
    expect(task?.color).toBeNull()
    expect(task?.droppedFace).toBeUndefined()
  })
})
