import { describe, expect, it } from 'vitest'
import type { Env } from '../env'
import { AssistantStore, purgeExpiredTodoTrash } from './store'

/**
 * A D1 stand-in with the one limit that matters here: at most 100 bound parameters per statement.
 *
 * The fake throws the way the platform does — at `bind`, before any row is read — so a statement that
 * outgrew the budget fails the read even when its SQL would otherwise be fine. Every statement the
 * store prepares is recorded, which is what lets the tests assert both that nothing threw and that
 * the ids were actually asked about in pieces.
 */
const BIND_LIMIT = 100

interface Recorded {
  sql: string
  values: unknown[]
}

function fakeD1(rows: (sql: string, values: unknown[]) => unknown[]): { db: Env['DB'], statements: Recorded[] } {
  const statements: Recorded[] = []
  const db = {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          if (values.length > BIND_LIMIT) {
            throw new Error(`D1_ERROR: too many SQL variables: ${values.length} > ${BIND_LIMIT}`)
          }
          statement.values = values
          return statement
        },
        async all() {
          statements.push({ sql, values: statement.values })
          return { results: rows(sql, statement.values), success: true, meta: {} }
        },
        async first() {
          statements.push({ sql, values: statement.values })
          return rows(sql, statement.values)[0] ?? null
        },
        async run() {
          statements.push({ sql, values: statement.values })
          return { success: true, meta: { changes: 1 } }
        },
      }
      return statement
    },
    async batch(list: Array<{ values: unknown[] }>) {
      for (const statement of list) statements.push({ sql: '', values: statement.values })
      return []
    },
  }
  return { db: db as unknown as Env['DB'], statements }
}

function taskRow(id: string, index: number): Record<string, unknown> {
  return {
    id,
    title: `task ${index}`,
    description: null,
    status: index % 3 === 0 ? 'done' : 'todo',
    priority: 'medium',
    position: index,
    due_at: null,
    start_at: null,
    project_id: null,
    list_id: null,
    starred: 0,
    repeat_rule: null,
    reminder_times: null,
    planned_for: null,
    note_id: null,
    conversation_id: null,
    created_at: 1,
    updated_at: 1,
    completed_at: index % 3 === 0 ? 2 : null,
    rev: 1,
    deleted_at: null,
  }
}

/** A page of tasks far past the statement's bind budget, the shape the listing actually hands over. */
const TASK_IDS = Array.from({ length: 150 }, (_, index) => `task-${String(index).padStart(3, '0')}`)

describe('a listing wider than one statement', () => {
  it('reads every task of a 150-row page', async () => {
    const { db, statements } = fakeD1((sql) =>
      sql.includes('FROM todos_tasks') ? TASK_IDS.map(taskRow) : [])
    const store = new AssistantStore(db, 'user', {} as Env)

    const tasks = await store.listTasks({ view: 'all' })

    expect(tasks).toHaveLength(150)
    expect(tasks[0]!.id).toBe('task-000')
    // The page is asked about in pieces: one statement per 90-id chunk, never one per id.
    const detailReads = statements.filter((entry) => entry.sql.includes('todos_steps') || entry.sql.includes('todos_tag_links'))
    expect(detailReads.length).toBeGreaterThan(1)
    for (const entry of statements) expect(entry.values.length).toBeLessThanOrEqual(BIND_LIMIT)
  })

  it('still stitches steps and tags onto the tasks that have them', async () => {
    const { db } = fakeD1((sql, values) => {
      if (sql.includes('FROM todos_tasks')) return TASK_IDS.map(taskRow)
      if (sql.includes('FROM todos_steps')) {
        return [
          { task_id: 'task-000', total: 3, done: 1 },
          { task_id: 'task-149', total: 2, done: 2 },
        ]
      }
      if (sql.includes('FROM todos_tag_links')) {
        // A real table answers per chunk: only the chunk naming task-001 sees its link.
        return values.includes('task-001')
          ? [{ task_id: 'task-001', id: 'tag-1', name: '重要', color: '#f00', created_at: 1, updated_at: 1 }]
          : []
      }
      return []
    })
    const store = new AssistantStore(db, 'user', {} as Env)

    const tasks = await store.listTasks({ view: 'all' })
    const byId = new Map(tasks.map((task) => [task.id, task]))

    expect(byId.get('task-000')).toMatchObject({ stepTotal: 3, stepDone: 1 })
    expect(byId.get('task-149')).toMatchObject({ stepTotal: 2, stepDone: 2 })
    expect(byId.get('task-001')!.tags).toEqual([
      { id: 'tag-1', name: '重要', color: '#f00', createdAt: 1, updatedAt: 1, openCount: 0 },
    ])
    expect(byId.get('task-002')!.tags).toEqual([])
  })

  it('answers an empty listing without a detail read', async () => {
    const { db, statements } = fakeD1(() => [])
    const store = new AssistantStore(db, 'user', {} as Env)

    expect(await store.listTasks({ view: 'all' })).toEqual([])
    // Only the page itself is asked about; no chunk of steps or tags runs for zero rows.
    expect(statements).toHaveLength(1)
  })

  it('reads conversation tags for a 150-id page', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `conv-${index}`)
    const { db } = fakeD1((sql, values) =>
      sql.includes('chat_conversation_tags')
        ? values.includes('conv-0')
          ? [{ conversation_id: 'conv-0', tag_id: 'tag-1', name: '工作', color: null }]
          : []
        : [])
    const store = new AssistantStore(db, 'user', {} as Env)

    const tags = await store.tagsForConversations(ids)

    expect(tags.get('conv-0')).toEqual([{ id: 'tag-1', name: '工作', color: null }])
    expect(tags.size).toBe(1)
  })
})

describe('the trash sweep past the bind budget', () => {
  it('purges 200 expired tasks without one oversized statement', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({ user_id: 'user', id: `gone-${index}` }))
    const { db, statements } = fakeD1((sql) => (sql.includes('FROM todos_tasks') ? rows : []))

    const removed = await purgeExpiredTodoTrash(db, Date.now())

    expect(removed).toBe(200)
    // Ten statements per 90-id chunk: eight child tables — steps, tag links, reminders, both ends of the
    // dependency links, the attachment rows, the time ledger and the task's history — the promotion of the
    // children of a purged task, and the tasks themselves. The dependency pair and that promotion arrived
    // after this pin was first written, which is why a count like this is worth reading rather than
    // trusting: a child table left out of the sweep is an orphan no reader reaches, and this test is the
    // only place that notices the list grew.
    // (The sweep's own SELECT is recorded too, so count the batch statements only.)
    const batches = statements.filter((entry) => entry.sql === '')
    expect(batches).toHaveLength(30)
    for (const entry of statements) expect(entry.values.length).toBeLessThanOrEqual(BIND_LIMIT)
  })
})
