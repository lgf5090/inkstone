// @vitest-environment node
/**
 * An automation that writes a note.
 *
 * A schedule that can only leave a notification behind cannot answer "turn yesterday into a log page
 * every morning": the reader has to be in the chat to take the answer somewhere. This is the kind that
 * writes the page itself, so the two things it has to get right are what these tests are for:
 *
 *  - the note is written through the store the notes routes themselves use, so its tags, links, index
 *    queue rows and — load-bearing — its record in `changes` land with it. An automation that wrote the
 *    row with a bare `INSERT` would leave the reader a note the notebook has never heard of.
 *  - a target the account does not have is refused where it is set, not dropped where it runs: a schedule
 *    that quietly lost its folder would run forever and write nothing.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import type { AppBindings, Env } from '../src/worker/env'
import type { Automation, AutomationRun } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const { asked } = vi.hoisted(() => ({ asked: [] as string[] }))

vi.mock('../src/worker/assistant/runner', () => ({
  AssistantRunner: class {
    async runScheduledPrompt(prompt: string): Promise<string> {
      asked.push(prompt)
      return '# The log\n\nYesterday had three things in it.'
    }
  },
}))

vi.mock('../src/worker/assistant/model-config', () => ({
  loadModelAndProvider: async () => ({ model: { id: 'm-1', label: 'Example' }, provider: { id: 'p-1' } }),
}))

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const FOLDER = '0123456789abcdefghjkmnpflu'
const OTHER_FOLDER = '0123456789abcdefghjkmnoflu'
const NOTE = '0123456789abcdefghjkmn0ote'
const OTHER_NOTE = '0123456789abcdefghjkmnoote'

let sqlite: DatabaseSync
let app: Hono<AppBindings>
let env: Env
const ctx = { waitUntil: (_task: Promise<unknown>) => {} } as ExecutionContext

function buildApp(userId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
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

// node:sqlite's `get()` takes SQLInputValue, not unknown, so a helper typed `unknown[]` never compiles —
// the same accepted set as `tests/trash-purge-batch.test.ts` uses, so an unsupported bind fails here
// instead of at run time.
function row<T>(sql: string, ...binds: Array<string | number | bigint | null | Uint8Array>): T | undefined {
  return sqlite.prepare(sql).get(...binds) as T | undefined
}

function makeFolder(id: string, userId: string, name: string): void {
  sqlite.prepare(
    `INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at)
     VALUES (?1, ?2, NULL, ?3, 0, 1, 1)`,
  ).run(id, userId, name)
}

function makeNote(id: string, userId: string, title: string, content: string): void {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
     VALUES (?1, ?2, NULL, ?3, ?4, '', 3, 1, 3, 0, 0, 0, 1, 'hash', 1, 1)`,
  ).run(id, userId, title, content)
}

/** The daily routine the reader is trying to set up: every morning, into the Journal folder. */
async function createWrite(body: Record<string, unknown>): Promise<Automation> {
  return (await call<{ automation: Automation }>('POST', '/api/assistant/automations', {
    name: 'Morning log',
    kind: 'note_write',
    message: 'Write yesterday as a log entry',
    schedule: { type: 'daily', time: '07:00' },
    ...body,
  })).automation
}

/** Runs what is due, the way the cron tick does. */
async function sweep(): Promise<void> {
  const { runDueAssistantAutomations } = await import('../src/worker/assistant/scheduler')
  await runDueAssistantAutomations(env)
}

function arm(id: string): void {
  sqlite.prepare(`UPDATE chat_automations SET next_run = ? WHERE id = ?`).run(Date.now() - 1000, id)
}

function latestRun(automationId: string): { status: string, result: string | null, error: string | null, note_id: string | null } | undefined {
  return row<{ status: string, result: string | null, error: string | null, note_id: string | null }>(
    `SELECT status, result, error, note_id FROM chat_runs WHERE automation_id = ?1 ORDER BY started_at DESC`, automationId,
  )
}

function noteCount(userId: string): number {
  return row<{ n: number }>(`SELECT COUNT(*) AS n FROM notes WHERE user_id = ?1`, userId)?.n ?? 0
}

beforeEach(() => {
  asked.length = 0
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  makeFolder(FOLDER, USER, 'Journal')
  makeFolder(OTHER_FOLDER, OTHER, 'Their journal')
  makeNote(NOTE, USER, 'Today', '# Old\n\nWhat was there.')
  makeNote(OTHER_NOTE, OTHER, 'Their page', '# Theirs\n')
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  app = buildApp(USER)
})

describe('the target of a note-writing routine', () => {
  it('keeps the folder the reader picked, and answers with it', async () => {
    const automation = await createWrite({ folderId: FOLDER })
    expect(automation.kind).toBe('note_write')
    expect(automation.targetFolderId).toBe(FOLDER)
    expect(automation.targetNoteId).toBeNull()
    const listed = await call<{ automations: Automation[] }>('GET', '/api/assistant/automations')
    expect(listed.automations[0]?.targetFolderId).toBe(FOLDER)
  })

  it('refuses a folder that is not this account\'s, rather than dropping it', async () => {
    expect(await status('POST', '/api/assistant/automations', {
      name: 'Elsewhere', kind: 'note_write', message: 'x',
      schedule: { type: 'daily', time: '07:00' }, folderId: OTHER_FOLDER,
    })).toBe(400)
  })

  it('refuses a page that is not this account\'s, rather than dropping it', async () => {
    expect(await status('POST', '/api/assistant/automations', {
      name: 'Elsewhere', kind: 'note_write', message: 'x',
      schedule: { type: 'daily', time: '07:00' }, noteId: OTHER_NOTE,
    })).toBe(404)
  })

  it('refuses a routine that said neither where to write nor what to update', async () => {
    expect(await status('POST', '/api/assistant/automations', {
      name: 'Nowhere', kind: 'note_write', message: 'x', schedule: { type: 'daily', time: '07:00' },
    })).toBe(400)
  })

  it('refuses one that said both', async () => {
    expect(await status('POST', '/api/assistant/automations', {
      name: 'Confused', kind: 'note_write', message: 'x',
      schedule: { type: 'daily', time: '07:00' }, folderId: FOLDER, noteId: NOTE,
    })).toBe(400)
  })

  it('refuses a target on a kind that has nothing to write', async () => {
    expect(await status('POST', '/api/assistant/automations', {
      name: 'Reminder', kind: 'reminder', message: 'Stand up',
      schedule: { type: 'daily', time: '07:00' }, folderId: FOLDER,
    })).toBe(400)
  })

  it('moves the page it updates when the reader points it at another one', async () => {
    const automation = await createWrite({ noteId: NOTE })
    const moved = await call<{ automation: Automation }>('PATCH', `/api/assistant/automations/${automation.id}`, { noteId: OTHER_NOTE })
    expect(moved.automation.targetNoteId).toBe(NOTE)
    const same = await call<{ automation: Automation }>('PATCH', `/api/assistant/automations/${automation.id}`, { noteId: '0123456789abcdefghjkmnzzzz' })
    expect(same.automation.targetNoteId).toBe(NOTE)
  })
})

describe('a due note-writing routine', () => {
  it('files the answer as a note in the folder it was pointed at, and says which in the run', async () => {
    const automation = await createWrite({ folderId: FOLDER })
    arm(automation.id)
    await sweep()

    const note = row<{ id: string, folder_id: string, title: string, content: string, rev: number }>(
      `SELECT id, folder_id, title, content, rev FROM notes WHERE user_id = ?1 AND id <> ?2`, USER, NOTE,
    )
    expect(note, 'the run wrote no note').toBeTruthy()
    expect(note?.folder_id).toBe(FOLDER)
    expect(note?.title).toBe('Morning log')
    expect(note?.content).toContain('Yesterday had three things in it.')
    expect(asked).toEqual(['Write yesterday as a log entry'])

    // The notebook only learns of a note through the change record, which is what the cursor carries.
    const change = row<{ entity_id: string }>(
      `SELECT entity_id FROM changes WHERE user_id = ?1 AND entity = 'note'`, USER,
    )
    expect(change?.entity_id).toBe(note?.id)

    const run = latestRun(automation.id)
    expect(run?.status).toBe('success')
    expect(run?.note_id).toBe(note?.id)
    expect(run?.result).toContain('Morning log')

    const notifications = sqlite.prepare(`SELECT title, body FROM chat_notifications WHERE user_id = ?1`).all(USER) as { title: string, body: string }[]
    expect(notifications.length).toBeGreaterThan(0)
  })

  it('rewrites the page it was pointed at instead of making another one', async () => {
    const automation = await createWrite({ noteId: NOTE })
    arm(automation.id)
    await sweep()

    const after = row<{ content: string, rev: number, title: string }>(`SELECT content, rev, title FROM notes WHERE id = ?1`, NOTE)
    expect(after?.content).toContain('Yesterday had three things in it.')
    expect(after?.rev).toBe(4)
    expect(noteCount(USER)).toBe(1)
    expect(latestRun(automation.id)?.note_id).toBe(NOTE)
  })

  it('refuses before it spends a turn when the folder it writes into is gone', async () => {
    const automation = await createWrite({ folderId: FOLDER })
    sqlite.prepare(`UPDATE folders SET deleted_at = 1 WHERE id = ?1`).run(FOLDER)
    arm(automation.id)
    await sweep()

    const run = latestRun(automation.id)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('folder')
    expect(run?.note_id).toBeNull()
    expect(noteCount(USER)).toBe(1)
    expect(asked).toEqual([])
  })

  it('names the page it lost when the one it updates has been deleted', async () => {
    const automation = await createWrite({ noteId: NOTE })
    sqlite.prepare(`UPDATE notes SET deleted_at = 1 WHERE id = ?1`).run(NOTE)
    arm(automation.id)
    await sweep()

    const run = latestRun(automation.id)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('Today')
    expect(asked).toEqual([])
  })
})

describe('a backup of the note-writing routines', () => {
  it('carries the page or folder each one writes into through the round trip', async () => {
    const intoFolder = await createWrite({ folderId: FOLDER })
    const ontoPage = await createWrite({ noteId: NOTE, name: 'Standing page' })
    const payload = await call<Record<string, unknown>>('GET', '/api/assistant/export')
    sqlite.prepare(`DELETE FROM chat_automations`).run()
    await call('POST', '/api/assistant/import', payload)

    const restored = await call<{ automations: Automation[] }>('GET', '/api/assistant/automations')
    expect(restored.automations.find((entry) => entry.id === intoFolder.id)?.targetFolderId).toBe(FOLDER)
    expect(restored.automations.find((entry) => entry.id === ontoPage.id)?.targetNoteId).toBe(NOTE)
  })
})
