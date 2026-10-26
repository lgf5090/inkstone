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
import { localDate } from '../src/shared/assistant-time'
import { addDays, loadTodoStats } from '../src/worker/todos/stats'
import {
  MAX_PLAN_TODAY_SUGGESTIONS,
  MAX_TASKS_FROM_NOTE,
  ToolExecutor,
  runApprovedAction,
  type ToolContext,
} from '../src/worker/assistant/tools'
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

/** Presses the card the executor proposed, through the same door the reader's approval uses. */
async function approve(tools: ToolExecutor, callId: string): Promise<void> {
  const action = tools.approvalFor(callId)
  if (!action) throw new Error(`no approval was proposed for ${callId}`)
  await runApprovedAction(store, context(), action.id)
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

describe('update_task_list and delete_task_list', () => {
  it('renames, recolours and re-icons one list', async () => {
    const list = await store.createTaskList({ name: 'Work' })

    const result = await executor().execute('update_task_list', {
      list: 'work', name: 'Job', color: '#2563eb', icon: 'Briefcase',
    }, 'call-1') as { updated: Record<string, unknown> }

    expect(result.updated).toMatchObject({ id: list.id, name: 'Job', color: '#2563eb', icon: 'Briefcase' })
    expect(await store.getTaskList(list.id)).toMatchObject({ name: 'Job', color: '#2563eb', icon: 'Briefcase' })
  })

  it('refuses a colour outside the palette and a list that does not exist', async () => {
    await store.createTaskList({ name: 'Work' })

    await expect(executor().execute('update_task_list', { list: 'Work', color: 'red' }, 'call-1'))
      .rejects.toThrow(/not one of the palette/)
    await expect(executor().execute('update_task_list', { list: 'Nowhere', name: 'X' }, 'call-2'))
      .rejects.toThrow(/No list matches/)
  })

  it('proposes the list deletion, then moves its tasks to the inbox on approval', async () => {
    const list = await store.createTaskList({ name: 'Work' })
    const task = await store.createTask({ title: 'One', listId: list.id })
    const tools = executor()

    const proposed = await tools.execute('delete_task_list', { list: 'Work' }, 'call-1') as { status: string }
    expect(proposed.status).toBe('awaiting_reader_approval')
    expect(await store.getTaskList(list.id)).not.toBeNull()

    await approve(tools, 'call-1')

    expect(await store.getTaskList(list.id)).toBeNull()
    expect((await store.getTask(task.id))?.listId).toBeNull()
  })
})

describe('the task tag tools', () => {
  it('renames a tag everywhere it is used', async () => {
    const task = await store.createTask({ title: 'One', tags: ['ops'] })

    const result = await executor().execute('rename_task_tag', { tag: 'ops', name: 'platform' }, 'call-1') as {
      updated: Record<string, unknown>
    }

    expect(result.updated).toMatchObject({ name: 'platform' })
    expect((await store.getTask(task.id))?.tags.map((tag) => tag.name)).toEqual(['platform'])
  })

  it('refuses to rename a tag onto a name another tag already has', async () => {
    await store.createTask({ title: 'One', tags: ['ops', 'home'] })

    await expect(executor().execute('rename_task_tag', { tag: 'ops', name: 'home' }, 'call-1'))
      .rejects.toThrow(/already exists/)
    expect((await store.findTaskTagByName('ops'))?.name).toBe('ops')
  })

  it('proposes deleting a tag and removes its links on approval', async () => {
    const task = await store.createTask({ title: 'One', tags: ['ops'] })
    const tools = executor()

    const proposed = await tools.execute('delete_task_tag', { tag: 'ops' }, 'call-1') as { status: string }
    expect(proposed.status).toBe('awaiting_reader_approval')
    expect(await store.findTaskTagByName('ops')).not.toBeNull()

    await approve(tools, 'call-1')

    expect(await store.findTaskTagByName('ops')).toBeNull()
    expect((await store.getTask(task.id))?.tags).toEqual([])
  })
})

describe('delete_task_step', () => {
  it('proposes the step it matched, then deletes it on approval', async () => {
    const created = await executor().execute('create_task', {
      title: 'Ship it', steps: ['Write the copy', 'Send the mail'],
    }, 'call-1') as { created: { id: string } }
    const tools = executor()

    const proposed = await tools.execute('delete_task_step', {
      task: created.created.id, step: 'Write the copy',
    }, 'call-2') as { status: string }
    expect(proposed.status).toBe('awaiting_reader_approval')
    expect((await store.listSteps(created.created.id)).map((step) => step.text)).toEqual(['Write the copy', 'Send the mail'])

    await approve(tools, 'call-2')

    expect((await store.listSteps(created.created.id)).map((step) => step.text)).toEqual(['Send the mail'])
  })

  it('refuses an ambiguous step rather than deleting the wrong one', async () => {
    const created = await executor().execute('create_task', {
      title: 'Ship it', steps: ['Write the copy', 'Write the mail'],
    }, 'call-1') as { created: { id: string } }

    await expect(executor().execute('delete_task_step', { task: created.created.id, step: 'Write' }, 'call-2'))
      .rejects.toThrow(/Several steps match/)
  })
})

describe('snooze_task', () => {
  it('adds a reminder the chosen distance from now', async () => {
    const task = await store.createTask({ title: 'Call back' })
    const before = Date.now()

    const result = await executor().execute('snooze_task', { task: task.id, minutes: 60 }, 'call-1') as {
      remind_at: number
      snoozed: Record<string, unknown>
    }

    expect(result.remind_at).toBeGreaterThanOrEqual(before + HOUR)
    expect(result.snoozed.id).toBe(task.id)
    const reread = await store.getTask(task.id)
    expect(reread?.reminders).toEqual([result.remind_at])
  })

  it('refuses a finished task and a duration the menu does not offer', async () => {
    const done = await store.createTask({ title: 'Finished' })
    await store.completeTask(done.id, 'Asia/Shanghai')
    const open = await store.createTask({ title: 'Open' })

    await expect(executor().execute('snooze_task', { task: done.id, minutes: 60 }, 'call-1'))
      .rejects.toThrow(/finished task/)
    await expect(executor().execute('snooze_task', { task: open.id, minutes: 30 }, 'call-2'))
      .rejects.toThrow(/A snooze must be/)
  })
})

describe('delete_completed_tasks', () => {
  it('proposes one batch, then deletes only the rows that were completed', async () => {
    const first = await store.createTask({ title: 'Done one' })
    const second = await store.createTask({ title: 'Done two' })
    const open = await store.createTask({ title: 'Still open' })
    await store.completeTask(first.id, 'Asia/Shanghai')
    await store.completeTask(second.id, 'Asia/Shanghai')
    const tools = executor()

    const proposed = await tools.execute('delete_completed_tasks', {}, 'call-1') as { status: string }
    expect(proposed.status).toBe('awaiting_reader_approval')
    expect(await store.getTask(first.id)).not.toBeNull()

    await approve(tools, 'call-1')

    expect(await store.getTask(first.id)).toBeNull()
    expect(await store.getTask(second.id)).toBeNull()
    expect(await store.getTask(open.id)).not.toBeNull()
  })

  it('refuses when there is nothing completed to clear', async () => {
    await store.createTask({ title: 'Still open' })

    await expect(executor().execute('delete_completed_tasks', {}, 'call-1'))
      .rejects.toThrow(/no completed tasks/)
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

/** The account-zone day the tool plans into, read the way the tool reads it. */
function today(): string {
  return localDate(Date.now(), 'Asia/Shanghai')
}

describe('plan_today', () => {
  it('drafts the open candidates and writes no plan', async () => {
    const day = today()
    const overdue = await store.createTask({ title: 'Pay rent', dueAt: Date.now() - DAY })
    const starred = await store.createTask({ title: 'Book flights', dueAt: Date.now() + 2 * DAY, starred: true })
    const unscheduled = await store.createTask({ title: 'Read the report' })
    const picked = await store.createTask({ title: 'Already picked' })
    await store.planTask(picked.id, day)
    const ahead = await store.createTask({ title: 'Planned ahead', dueAt: Date.now() + 3 * DAY })
    await store.planTask(ahead.id, addDays(day, 1))
    const done = await store.createTask({ title: 'Finished' })
    await store.completeTask(done.id, 'Asia/Shanghai')
    const deleted = await store.createTask({ title: 'Gone' })
    await store.deleteTask(deleted.id)

    const result = await executor().execute('plan_today', {}, 'call-1') as {
      draft: boolean
      suggestions: { id: string, title: string, reason: string }[]
    }

    expect(result.draft).toBe(true)
    // Completed, deleted, picked-for-today and planned-for-tomorrow rows are all absent: the first two
    // are not work, the last two are already on the screen.
    expect(result.suggestions.map((entry) => entry.title)).toEqual(['Pay rent', 'Book flights', 'Read the report'])
    expect(result.suggestions.map((entry) => entry.reason)).toEqual(['overdue', 'starred_due', 'unscheduled'])
    expect(result.suggestions.map((entry) => entry.id)).toEqual([overdue.id, starred.id, unscheduled.id])
    // The whole point of a draft: nothing was planned by the call.
    for (const entry of result.suggestions) expect((await store.getTask(entry.id))?.plannedFor).toBeNull()
    expect((await store.getTask(picked.id))?.plannedFor).toBe(day)
    expect((await store.getTask(ahead.id))?.plannedFor).toBe(addDays(day, 1))
  })

  it('caps the answer with the named ceiling whatever the model asks for', async () => {
    for (let index = 0; index < MAX_PLAN_TODAY_SUGGESTIONS + 3; index++) {
      await store.createTask({ title: `Task ${index + 1}` })
    }

    const result = await executor().execute('plan_today', { limit: 999 }, 'call-1') as {
      suggestions: unknown[]
    }

    expect(result.suggestions).toHaveLength(MAX_PLAN_TODAY_SUGGESTIONS)
  })

  it('honours a smaller limit and refuses one that is not a number', async () => {
    await store.createTask({ title: 'One' })
    await store.createTask({ title: 'Two' })
    await store.createTask({ title: 'Three' })

    const two = await executor().execute('plan_today', { limit: 2 }, 'call-1') as {
      suggestions: unknown[]
    }
    expect(two.suggestions).toHaveLength(2)

    await expect(executor().execute('plan_today', { limit: 'lots' }, 'call-2'))
      .rejects.toThrow(/"limit" must be a number/)
  })

  it('never offers another account\'s tasks', async () => {
    await new AssistantStore(env.DB as D1Database, OTHER, env).createTask({ title: 'Their task' })

    const result = await executor().execute('plan_today', {}, 'call-1') as {
      suggestions: unknown[]
    }

    expect(result.suggestions).toEqual([])
  })
})

describe('task_stats', () => {
  it('reports the same numbers the statistics aggregate reads for the range', async () => {
    const day = today()
    const done = await store.createTask({
      title: 'Shipped it',
      dueAt: Date.parse('2020-01-01T00:00:00Z'),
    }, 'Asia/Shanghai')
    await store.completeTask(done.id, 'Asia/Shanghai')
    await store.createTask({ title: 'Still open' }, 'Asia/Shanghai')
    // The second rate has to reach a review turn too, or the assistant can only ever report what the
    // reader finished and never what they gave up.
    const abandoned = await store.createTask({ title: 'Not going to do it' }, 'Asia/Shanghai')
    await store.updateTask(abandoned.id, { status: 'cancelled' }, 'Asia/Shanghai')

    const result = await executor().execute('task_stats', {}, 'call-1') as {
      range: Record<string, unknown>
      summary: Record<string, number>
      by_list: unknown[]
    }
    const from = addDays(day, -6)
    const expected = await loadTodoStats(env.DB as D1Database, USER, {
      from,
      to: day,
      bucket: 'day',
      timezone: 'Asia/Shanghai',
      now: Date.now(),
    })

    expect(result.range).toMatchObject({ from, to: day, bucket: 'day', timezone: 'Asia/Shanghai' })
    expect(result.summary).toMatchObject({
      completed: expected.summary.completed,
      created: expected.summary.created,
      open: expected.summary.open,
      completionRate: expected.summary.completionRate,
      abandoned: expected.summary.abandoned,
      abandonedRate: expected.summary.abandonedRate,
      onTime: expected.summary.onTime,
      onTimeDue: expected.summary.onTimeDue,
      onTimeRate: expected.summary.onTimeRate,
      currentStreak: expected.summary.currentStreak,
      longestStreak: expected.summary.longestStreak,
    })
    expect(result.summary.completed).toBe(1)
    expect(result.summary.abandoned).toBe(1)
    // The abandoned row is in neither half of the completion rate, and it is in both halves of the
    // other one — the pairing a review turn must not be able to get wrong from the tool alone.
    expect(result.summary.completionRate).toBeCloseTo(expected.summary.completionRate, 10)
    expect(expected.summary.completionRate).toBeCloseTo(1 / 2, 10)
    expect(expected.summary.abandonedRate).toBeCloseTo(1 / 3, 10)
    expect(result.by_list).toEqual(expected.distributions.byList)
  })

  it('reads an explicit range exactly as asked', async () => {
    const day = today()
    const from = addDays(day, -2)

    const result = await executor().execute('task_stats', { from, to: day }, 'call-1') as {
      range: Record<string, unknown>
    }

    expect(result.range).toMatchObject({ from, to: day })
  })

  it('refuses a range that is not a pair of calendar days', async () => {
    await expect(executor().execute('task_stats', { from: '2026-02-30' }, 'call-1'))
      .rejects.toThrow(/calendar days/)
    await expect(executor().execute('task_stats', { from: '2026-10-10', to: '2026-10-01' }, 'call-2'))
      .rejects.toThrow(/must not be after/)
  })

  it('answers a scheduled review turn, which is how a weekly review runs', async () => {
    const scheduled = new ToolExecutor(context({ mode: 'scheduled' }), { maxToolCalls: 4 })

    const result = await scheduled.execute('task_stats', {}, 'call-1') as {
      summary: { completed: number }
    }

    expect(result.summary.completed).toBe(0)
  })
})

describe('planning and repeat details', () => {
  it('plans a task for a day and clears the plan with null', async () => {
    const task = await store.createTask({ title: 'Plan me' })
    const tools = executor()

    await tools.execute('plan_task', { task: task.id, day: today() }, 'call-1')
    expect((await store.getTask(task.id))?.plannedFor).toBe(today())

    await tools.execute('plan_task', { task: task.id, day: null }, 'call-2')
    expect((await store.getTask(task.id))?.plannedFor).toBeNull()
  })

  it('creates a task with a start, a My Day plan and named weekdays', async () => {
    const created = await executor().execute('create_task', {
      title: 'Every other Monday and Wednesday',
      start: '2026-10-20T09:00',
      planned: today(),
      repeat: 'weekly',
      repeatInterval: 2,
      repeatDays: '3,1,3',
    }, 'call-1') as { created: { id: string } }

    const task = await store.getTask(created.created.id)
    expect(task?.plannedFor).toBe(today())
    expect(task?.startAt).not.toBeNull()
    expect(task?.repeat).toEqual({ freq: 'weekly', interval: 2, weekdays: [1, 3] })
  })

  it('updates the plan and a monthly last-day rhythm together', async () => {
    const task = await store.createTask({ title: 'Month end' })

    await executor().execute('update_task', {
      task: task.id,
      planned: today(),
      start: '2026-10-20T09:00',
      repeat: 'monthly',
      repeatMonthly: 'lastDay',
    }, 'call-1')

    const updated = await store.getTask(task.id)
    expect(updated?.plannedFor).toBe(today())
    expect(updated?.startAt).not.toBeNull()
    expect(updated?.repeat).toEqual({ freq: 'monthly', interval: 1, monthlyMode: 'lastDay' })
  })

  it('sets a monthly rhythm that lands on an nth weekday', async () => {
    const created = await executor().execute('create_task', {
      title: 'Third Friday',
      due: '2026-10-16T09:00',
      repeat: 'monthly',
      repeatMonthly: 'nthWeekday',
    }, 'call-1') as { created: { id: string } }

    const task = await store.getTask(created.created.id)
    // The mode is the rule's only extra word: which Friday it is comes from the due date it names.
    expect(task?.repeat).toEqual({ freq: 'monthly', interval: 1, monthlyMode: 'nthWeekday' })
  })

  // The chat has no words for a series ceiling, a pause or a day let go of, so a model asked to change
  // the rhythm names only the rhythm — and the rule it writes replaces the row's whole JSON. Without
  // the carry-over below, "make that fortnightly" would quietly un-cap a series the reader bounded.
  it('changes the rhythm without deleting the series the row already runs', async () => {
    const task = await store.createTask({
      title: 'Stand-up',
      repeat: { freq: 'weekly', interval: 1, weekdays: [1, 3], count: 12, produced: 4, untilAt: Date.parse('2026-12-31T00:00:00Z') },
    })

    await executor().execute('update_task', { task: task.id, repeat: 'weekly', repeatInterval: 2 }, 'call-1')

    expect((await store.getTask(task.id))?.repeat).toEqual({
      freq: 'weekly',
      interval: 2,
      weekdays: [1, 3],
      count: 12,
      produced: 4,
      untilAt: Date.parse('2026-12-31T00:00:00Z'),
    })
  })

  it('stops the series when the chat is asked to stop repeating', async () => {
    const task = await store.createTask({ title: 'Stand-up', repeat: { freq: 'daily', interval: 1, count: 5 } })

    await executor().execute('update_task', { task: task.id, repeat: 'none' }, 'call-1')

    expect((await store.getTask(task.id))?.repeat).toBeNull()
  })

  it('refuses weekdays on a rhythm that is not weekly', async () => {
    await expect(executor().execute('create_task', {
      title: 'Bad rhythm',
      repeat: 'daily',
      repeatDays: '1,2',
    }, 'call-1')).rejects.toThrow(/only narrow a weekly/)
  })
})

describe('moving, trash and alarms', () => {
  it('moves a task before another and into a list', async () => {
    const list = await store.createTaskList({ name: 'Work' })
    const first = await store.createTask({ title: 'First', listId: list.id })
    await store.createTask({ title: 'Second', listId: list.id })
    const third = await store.createTask({ title: 'Third', listId: list.id })

    await executor().execute('move_task', { task: third.id, before: first.id }, 'call-1')
    const moved = await store.listTasks({ view: 'all', listId: list.id })
    expect(moved.slice(0, 2).map((task) => task.id)).toEqual([third.id, first.id])

    await executor().execute('move_task', { task: first.id, list: null }, 'call-2')
    expect((await store.getTask(first.id))?.listId).toBeNull()
  })

  it('lists the trash by id and restores the row', async () => {
    const task = await store.createTask({ title: 'Bring me back' })
    await store.deleteTask(task.id)

    const trash = await executor().execute('list_trash', {}, 'call-1') as { total: number, tasks: { id: string }[] }
    expect(trash.total).toBe(1)
    expect(trash.tasks[0]?.id).toBe(task.id)

    await executor().execute('restore_task', { id: task.id }, 'call-2')
    expect(await store.getTask(task.id)).not.toBeNull()
  })

  it('creates and replaces several absolute reminders', async () => {
    const created = await executor().execute('create_task', {
      title: 'Two alarms',
      due: '2026-10-22T15:00',
      reminders: ['2026-10-22T14:30', '2026-10-22T14:00'],
    }, 'call-1') as { created: { id: string } }
    const task = await store.getTask(created.created.id)
    expect(task?.reminders).toHaveLength(2)
    expect(task!.reminders![0]).toBeLessThan(task!.reminders![1]!)

    await executor().execute('update_task', {
      task: task!.id,
      reminders: ['2026-10-22T14:15'],
    }, 'call-2')
    expect((await store.getTask(task!.id))?.reminders).toHaveLength(1)
  })

  it('archives a list and puts it back', async () => {
    const list = await store.createTaskList({ name: 'Someday' })
    await executor().execute('update_task_list', { list: list.id, archived: true }, 'call-1')
    expect((await store.listTaskLists({ archived: true })).find((entry) => entry.id === list.id)?.archivedAt).not.toBeNull()
    await executor().execute('update_task_list', { list: list.id, archived: false }, 'call-2')
    expect((await store.listTaskLists()).find((entry) => entry.id === list.id)?.archivedAt).toBeNull()
  })
})

describe('the tree and the waits, from a chat', () => {
  it('files a child under a parent named in words, and says both back', async () => {
    const parent = await store.createTask({ title: 'Write the report' })

    const created = await executor().execute('create_task', {
      title: 'Send it out', parent: 'Write the report', waitsOn: [parent.id],
    }, 'call-1') as { created: Record<string, unknown> }

    expect(created.created.parent_id).toBe(parent.id)
    expect(created.created.waits_on).toEqual([parent.id])
    const stored = await store.getTask(String(created.created.id))
    expect(stored?.parentId).toBe(parent.id)
    expect(stored?.dependsOn.map((entry) => entry.id)).toEqual([parent.id])
  })

  it('refuses a task waiting on itself with the store’s own sentence, and writes nothing', async () => {
    const created = await executor().execute('create_task', { title: 'Solo' }, 'call-1') as { created: { id: string } }

    await expect(executor().execute('update_task', { task: created.created.id, waitsOn: [created.created.id] }, 'call-2'))
      .rejects.toThrow(/itself/)
    expect((await store.getTask(created.created.id))?.dependsOn).toEqual([])
  })

  it('refuses nesting a parent inside its own child', async () => {
    const parent = await store.createTask({ title: 'Upper row' })
    const child = await executor().execute('create_task', { title: 'Lower row', parent: parent.id }, 'call-1') as { created: { id: string } }

    await expect(executor().execute('update_task', { task: parent.id, parent: child.created.id }, 'call-2'))
      .rejects.toThrow(/by a route/)
    expect((await store.getTask(parent.id))?.parentId).toBeNull()
  })

  it('puts a row back at the top and empties its wait set when asked to', async () => {
    const parent = await store.createTask({ title: 'Upper' })
    const blocker = await store.createTask({ title: 'Blocker' })
    const created = await executor().execute('create_task', {
      title: 'Lower', parent: parent.id, waitsOn: [blocker.id],
    }, 'call-1') as { created: { id: string } }

    await executor().execute('update_task', { task: created.created.id, parent: null, waitsOn: [] }, 'call-2')

    const stored = await store.getTask(created.created.id)
    expect(stored?.parentId).toBeNull()
    expect(stored?.dependsOn).toEqual([])
    // The blocker's own copy of the edge is gone too, not merely hidden.
    expect((await store.getTask(blocker.id))?.blocks).toEqual([])
  })

  it('refuses a title that matches no task rather than dropping the field', async () => {
    await expect(executor().execute('create_task', { title: 'One', waitsOn: ['Nothing named this'] }, 'call-1'))
      .rejects.toThrow(/No single task matches/)
    expect(await store.listTasks({ view: 'all' })).toHaveLength(0)
  })

  it('shows what waits on a row, so a chat can answer "what is this blocking"', async () => {
    const blocker = await store.createTask({ title: 'Blocking row' })
    await executor().execute('create_task', { title: 'Waiting row', waitsOn: [blocker.id] }, 'call-1')

    const listed = await executor().execute('list_tasks', { view: 'open' }, 'call-2') as { tasks: Record<string, unknown>[] }
    const shown = listed.tasks.find((entry) => entry.id === blocker.id)
    expect(shown?.blocking).toEqual([expect.any(String)])
  })
})
