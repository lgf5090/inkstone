// @vitest-environment node
/**
 * What the chat tools do to the reader's tasks, against a real store.
 *
 * The store is real rather than mocked because the contract under test is a compound one: a task that
 * says it has a list, tags and steps is only true if the three tables agree. A spy would let a tool
 * "succeed" while the row it wrote carried none of it.
 *
 * The one thing deliberately not exercised is the model: every case calls the executor exactly as the
 * runner would, with the arguments a model would send, and reads the payload the model would see.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import { MAX_TASKS_FROM_NOTE, ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'user-alice'
const OTHER = 'user-bob'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOTE = '01hzzzzzzzzzzzzzzzzzzzzz20'
const OTHER_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz21'

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

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    store,
    env,
    ftsEnabled: false,
    origin: 'https://notes.test',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'Asia/Shanghai',
    dayEnd: Date.now() + DAY,
    mode: 'chat',
    conversationId: 'c1',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    ...over,
  }
}

function executor(over: Partial<ToolContext> = {}): ToolExecutor {
  return new ToolExecutor(context(over), { maxToolCalls: 20 })
}

/** A note body straight into the table, because the tool reads the row and nothing above it. */
function insertNote(id: string, content: string, user = USER, title = 'Weekly plan'): void {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
  ).run(id, user, title, title.toLowerCase(), content)
}

/** The end of a bare day in the account's zone (Asia/Shanghai in these fixtures), in UTC ms. */
function endOfShanghaiDay(day: string): number {
  return Date.parse(`${day}T15:59:00.000Z`)
}

describe('create_task', () => {
  it('files the list, the tags and the steps the model named', async () => {
    const list = await store.createTaskList({ name: 'Work' })
    const tools = executor()

    const created = await tools.execute('create_task', {
      title: 'File the return',
      list: 'work',
      tags: ['Tax', 'urgent'],
      steps: ['Collect receipts', 'Fill the form'],
      starred: true,
      repeat: 'weekly',
    }, 'call-1') as { created: Record<string, unknown> }

    expect(created.created).toMatchObject({ title: 'File the return', starred: true, repeat: 'weekly', steps: '0/2' })
    expect(created.created.list_id).toBe(list.id)
    expect(created.created.tags).toEqual(['Tax', 'urgent'])

    const tasks = await store.listTasks({ view: 'all' })
    expect(tasks).toHaveLength(1)
    expect((await store.listSteps(tasks[0]!.id)).map((step) => step.text)).toEqual(['Collect receipts', 'Fill the form'])
  })

  it('refuses a list that does not exist rather than silently filing it in the inbox', async () => {
    await expect(executor().execute('create_task', { title: 'One', list: 'Nowhere' }, 'call-1'))
      .rejects.toThrow(/No list matches/)
    expect(await store.listTasks({ view: 'all' })).toHaveLength(0)
  })

  it('keeps the conversation the task was created in', async () => {
    const created = await executor().execute('create_task', { title: 'From chat' }, 'call-1') as { created: Record<string, unknown> }
    expect(created.created.conversation_id).toBe('c1')
  })
})

describe('reusing lists and tags', () => {
  it('creates a list once and returns the same one by name afterwards', async () => {
    const tools = executor()
    const first = await tools.execute('create_task_list', { name: 'Reading' }, 'call-1') as { list: { id: string } }
    const again = await new ToolExecutor(context(), { maxToolCalls: 20 })
      .execute('create_task_list', { name: 'reading' }, 'call-2') as { list: { id: string } }

    expect(again.list.id).toBe(first.list.id)
    expect(await store.listTaskLists()).toHaveLength(1)
  })

  it('attaches an existing tag instead of making a second one with the same name', async () => {
    const tools = executor()
    await tools.execute('create_task', { title: 'One', tags: ['ops'] }, 'call-1')
    await tools.execute('create_task', { title: 'Two', tags: ['OPS'] }, 'call-2')

    const tags = await store.listTaskTags()
    expect(tags).toHaveLength(1)
    expect(tags[0]!.openCount).toBe(2)
  })
})

describe('get_task', () => {
  it('reads back the steps so the model can name the one it means', async () => {
    const created = await executor().execute('create_task', {
      title: 'Ship it', steps: ['Write the copy', 'Send the mail'],
    }, 'call-1') as { created: { id: string } }

    const read = await executor().execute('get_task', { task: created.created.id }, 'call-2') as {
      task: Record<string, unknown>
      steps: { text: string, done: boolean }[]
    }

    expect(read.task.id).toBe(created.created.id)
    expect(read.steps).toEqual([
      { text: 'Write the copy', done: false },
      { text: 'Send the mail', done: false },
    ])
  })
})

describe('add_task_step and check_task_step', () => {
  it('appends a step and ticks it by text', async () => {
    const created = await executor().execute('create_task', { title: 'Ship it' }, 'call-1') as { created: { id: string } }
    const id = created.created.id
    const tools = executor()

    expect(await tools.execute('add_task_step', { task: id, text: 'Write the copy' }, 'call-2'))
      .toEqual({ added: 'Write the copy', steps: 1 })
    expect(await tools.execute('check_task_step', { task: id, step: 'copy' }, 'call-3'))
      .toEqual({ step: 'Write the copy', done: true })

    const task = await store.getTask(id)
    expect(task).toMatchObject({ stepTotal: 1, stepDone: 1 })
  })

  it('refuses an ambiguous step instead of ticking the wrong one', async () => {
    const created = await executor().execute('create_task', {
      title: 'Ship it', steps: ['Write the copy', 'Write the mail'],
    }, 'call-1') as { created: { id: string } }

    await expect(executor().execute('check_task_step', { task: created.created.id, step: 'Write' }, 'call-2'))
      .rejects.toThrow(/Several steps match/)
  })
})

describe('completing a repeating task', () => {
  it('keeps the finished row and files the next occurrence with its steps unchecked', async () => {
    const due = Date.parse('2026-10-20T01:00:00Z')
    const created = await executor().execute('create_task', {
      title: 'Weekly report',
      due: '2026-10-20',
      repeat: 'weekly',
      tags: ['ops'],
      steps: ['Draft', 'Send'],
    }, 'call-1') as { created: { id: string } }
    await store.updateTask(created.created.id, { dueAt: due })
    const tools = executor()

    const result = await tools.execute('complete_task', { task: created.created.id }, 'call-2') as {
      completed: Record<string, unknown>
      next?: Record<string, unknown>
    }

    expect(result.completed.status).toBe('done')
    expect(result.next).toBeDefined()
    const next = await store.getTask(String(result.next!.id))
    expect(next).toMatchObject({ status: 'todo', repeat: { freq: 'weekly', interval: 1 }, stepTotal: 2, stepDone: 0 })
    expect(next!.dueAt).toBe(due + 7 * DAY)
    expect(next!.tags.map((tag) => tag.name)).toEqual(['ops'])
    // The finished row stays, so "I did send that last week" survives the next occurrence.
    expect((await store.getTask(created.created.id))?.status).toBe('done')
  })
})

describe('update_task', () => {
  it('replaces the tags it was given and leaves the rest alone', async () => {
    const created = await executor().execute('create_task', {
      title: 'One', tags: ['old'], starred: true,
    }, 'call-1') as { created: { id: string } }

    const updated = await executor().execute('update_task', {
      task: created.created.id, tags: ['new'], priority: 'urgent',
    }, 'call-2') as { updated: Record<string, unknown> }

    expect(updated.updated).toMatchObject({ priority: 'urgent', starred: true, tags: ['new'] })
  })

  it('moves a task back to the inbox when the list is cleared', async () => {
    await store.createTaskList({ name: 'Work' })
    const created = await executor().execute('create_task', { title: 'One', list: 'Work' }, 'call-1') as { created: { id: string } }

    const updated = await executor().execute('update_task', { task: created.created.id, list: null }, 'call-2') as {
      updated: Record<string, unknown>
    }

    expect(updated.updated.list_id).toBeNull()
    expect((await store.getTask(created.created.id))?.listId).toBeNull()
  })
})

describe('delete_task', () => {
  it('proposes the deletion and changes nothing until the reader approves', async () => {
    const created = await executor().execute('create_task', { title: 'Throw me away' }, 'call-1') as { created: { id: string } }

    const proposed = await executor().execute('delete_task', { task: created.created.id }, 'call-2') as {
      status: string
    }

    expect(proposed.status).toBe('awaiting_reader_approval')
    expect(await store.getTask(created.created.id)).not.toBeNull()
  })
})

describe('list_tasks', () => {
  it('answers with the counts so "how many are left" needs no second call', async () => {
    await executor().execute('create_task', { title: 'Today one', due: '2020-01-01' }, 'call-1')

    const listed = await executor().execute('list_tasks', { view: 'open' }, 'call-2') as {
      count: number
      counts: Record<string, number>
    }

    expect(listed.count).toBe(1)
    expect(listed.counts.overdue).toBe(1)
    expect(listed.counts.open).toBe(1)
  })

  it('narrows by list and by tag', async () => {
    await store.createTaskList({ name: 'Work' })
    const tools = executor()
    await tools.execute('create_task', { title: 'In work', list: 'Work', tags: ['ops'] }, 'call-1')
    await tools.execute('create_task', { title: 'Inbox', tags: ['home'] }, 'call-2')

    const byList = await tools.execute('list_tasks', { view: 'open', list: 'Work' }, 'call-3') as { tasks: { title: string }[] }
    const byTag = await tools.execute('list_tasks', { view: 'open', tag: 'home' }, 'call-4') as { tasks: { title: string }[] }

    expect(byList.tasks.map((task) => task.title)).toEqual(['In work'])
    expect(byTag.tasks.map((task) => task.title)).toEqual(['Inbox'])
  })

  it('does not show another account\'s tasks', async () => {
    await store.createTask({ title: 'Mine' })
    const otherStore = new AssistantStore(env.DB as D1Database, OTHER, env)
    const theirs = new ToolExecutor(context({ store: otherStore }), { maxToolCalls: 5 })

    const listed = await theirs.execute('list_tasks', { view: 'open' }, 'call-1') as { count: number }
    expect(listed.count).toBe(0)
  })
})

describe('decompose_task', () => {
  it('answers with a draft and leaves the task exactly as it was', async () => {
    const created = await executor().execute('create_task', { title: 'Plan the launch' }, 'call-1') as {
      created: { id: string }
    }
    const before = await store.getTask(created.created.id)

    const draft = await executor().execute('decompose_task', {
      task: created.created.id,
      steps: ['Pick a date', 'Write the copy'],
      by: '2026-04-01',
    }, 'call-2') as Record<string, unknown>

    expect(draft).toMatchObject({
      draft: true,
      task: { id: created.created.id, title: 'Plan the launch', steps: 0 },
      steps: ['Pick a date', 'Write the copy'],
      due_at: endOfShanghaiDay('2026-04-01'),
    })
    expect(String(draft.note)).toMatch(/Nothing was saved/)
    // The whole point of a draft: no step rows, and no edit to the task it was drafted for.
    expect(await store.listSteps(created.created.id)).toEqual([])
    expect((await store.getTask(created.created.id))?.updatedAt).toBe(before?.updatedAt)
  })

  it('refuses an empty breakdown rather than answering with nothing to accept', async () => {
    const created = await executor().execute('create_task', { title: 'One' }, 'call-1') as { created: { id: string } }

    await expect(executor().execute('decompose_task', { task: created.created.id, steps: [] }, 'call-2'))
      .rejects.toThrow(/at least one step/)
  })

  it('checks the steps against the same declaration the model was given', async () => {
    const created = await executor().execute('create_task', { title: 'One' }, 'call-1') as { created: { id: string } }

    await expect(executor().execute('decompose_task', { task: created.created.id, steps: 'not a list' }, 'call-2'))
      .rejects.toThrow(/"steps" must be a list/)
  })

  it('names an unknown task instead of drafting for nothing', async () => {
    await expect(executor().execute('decompose_task', { task: 'no such task', steps: ['a'] }, 'call-1'))
      .rejects.toThrow(/No single task matches/)
  })
})

describe('create_tasks_from_note', () => {
  it('turns the open boxes into tasks, with the day each line carries', async () => {
    insertNote(NOTE, [
      '# Plan',
      '- [ ] Buy milk [due:: 2026-03-01]',
      '- [x] Call mom',
      '* [ ] Ship it 📅 2026-01-15',
      '- a plain bullet',
      '```',
      '- [ ] inside code',
      '```',
    ].join('\n'))

    const result = await executor().execute('create_tasks_from_note', { note: NOTE }, 'call-1') as {
      created: number
      skipped: number
      ignored?: number
      tasks: { id: string, title: string }[]
    }

    expect(result.created).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.ignored).toBe(1)
    expect(result.tasks.map((task) => task.title)).toEqual(['Buy milk', 'Ship it'])

    const tasks = await store.listTasks({ view: 'all', status: 'all' })
    expect(tasks).toHaveLength(2)
    expect(tasks.every((task) => task.noteId === NOTE)).toBe(true)
    const byTitle = new Map(tasks.map((task) => [task.title, task]))
    expect(byTitle.get('Buy milk')?.dueAt).toBe(endOfShanghaiDay('2026-03-01'))
    expect(byTitle.get('Ship it')?.dueAt).toBe(endOfShanghaiDay('2026-01-15'))
  })

  it('adds nothing on a second sweep of the same note', async () => {
    insertNote(NOTE, '- [ ] Buy milk\n- [ ] Ship it')

    const first = await executor().execute('create_tasks_from_note', { note: NOTE }, 'call-1') as { created: number }
    const second = await executor().execute('create_tasks_from_note', { note: NOTE }, 'call-2') as {
      created: number
      skipped: number
    }

    expect(first.created).toBe(2)
    expect(second).toMatchObject({ created: 0, skipped: 2 })
    expect(await store.listTasks({ view: 'all', status: 'all' })).toHaveLength(2)
  })

  it('treats the same words written twice as one task', async () => {
    insertNote(NOTE, '- [ ] Buy milk\n- [ ] buy   milk')

    const result = await executor().execute('create_tasks_from_note', { note: NOTE }, 'call-1') as {
      created: number
      skipped: number
    }

    expect(result).toMatchObject({ created: 1, skipped: 1 })
    expect(await store.listTasks({ view: 'all', status: 'all' })).toHaveLength(1)
  })

  it('files a ticked box as a completed task when asked for everything', async () => {
    insertNote(NOTE, '- [x] Already done')

    const result = await executor().execute('create_tasks_from_note', { note: NOTE, filter: 'all' }, 'call-1') as {
      created: number
      tasks: { id: string }[]
    }

    expect(result.created).toBe(1)
    const task = await store.getTask(result.tasks[0]!.id)
    expect(task).toMatchObject({ title: 'Already done', status: 'done', noteId: NOTE })
    expect(task?.completedAt).not.toBeNull()
  })

  it('caps one sweep and leaves the rest for the next call', async () => {
    insertNote(NOTE, Array.from({ length: MAX_TASKS_FROM_NOTE + 5 }, (_, index) => `- [ ] Task ${index + 1}`).join('\n'))

    const first = await executor().execute('create_tasks_from_note', { note: NOTE }, 'call-1') as {
      created: number
      remaining?: number
    }
    const second = await executor().execute('create_tasks_from_note', { note: NOTE }, 'call-2') as {
      created: number
      remaining?: number
    }

    expect(first).toMatchObject({ created: MAX_TASKS_FROM_NOTE, remaining: 5 })
    expect(second.created).toBe(5)
    expect(second.remaining).toBeUndefined()
    expect(await store.listTasks({ view: 'all', status: 'all' })).toHaveLength(MAX_TASKS_FROM_NOTE + 5)
  })

  it('refuses a filter it does not know instead of guessing', async () => {
    insertNote(NOTE, '- [ ] One')

    await expect(executor().execute('create_tasks_from_note', { note: NOTE, filter: 'done' }, 'call-1'))
      .rejects.toThrow(/"filter" must be one of open, all/)
  })

  it('answers 404 for another account\'s note and writes nothing', async () => {
    insertNote(OTHER_NOTE, '- [ ] Their task', OTHER)

    await expect(executor().execute('create_tasks_from_note', { note: OTHER_NOTE }, 'call-1'))
      .rejects.toMatchObject({ status: 404 })
    expect(await store.listTasks({ view: 'all', status: 'all' })).toHaveLength(0)
  })
})
