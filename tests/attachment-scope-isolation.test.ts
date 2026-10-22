// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { filesRoutes } from '../src/worker/routes/files'
import { todoAttachmentRoutes } from '../src/worker/routes/todo-attachments'
import { attachmentHubRoutes } from '../src/worker/routes/attachments'
import { attachmentObjectKey } from '../src/worker/attachments/keys'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

/**
 * That a file belongs to the application that claims it, and that no application's sweep can
 * collect another's.
 *
 * The first case is a regression with a body count: task uploads have always been ordinary
 * `attachments` rows with a null `note_id`, and the notebook's "clean up unreferenced" decided
 * "unreferenced" by reading note bodies only. A task's file therefore looked spare to it and was
 * deleted, while the `todos_attachments` row survived and the task went on listing a file whose
 * bytes were gone — silently, with nothing queued and nothing thrown.
 */

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

function id(value: number): string {
  return String(value).padStart(26, '0')
}

const TASK = id(1)
const NOTE = id(2)
const OTHER_TASK = id(3)

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('/api/files/*', async (c, next) => {
    c.set('userId', mocks.userId)
    await next()
  })
  instance.route('/api/files', filesRoutes)
  instance.route('/api/todos', todoAttachmentRoutes)
  instance.route('/api/attachments', attachmentHubRoutes)
  return instance
}

function insertTask(userId: string, taskId: string): void {
  sqlite
    .prepare(
      `INSERT INTO todos_tasks (user_id, id, title, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(userId, taskId, 'A task with a file', 1, 1)
}

function insertNote(userId: string, noteId: string, content: string): void {
  sqlite
    .prepare(
      `INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev, word_count, char_count, is_pinned, is_starred, is_archived, position, created_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, 'A note', 'a note', ?, '', 1, 0, 0, 0, 0, 0, 0, 1, 1, NULL)`,
    )
    .run(noteId, userId, content)
}

function insertAttachmentRow(row: {
  id: string
  userId: string
  scope: string
  noteId: string | null
  filename: string
  objectKey: string | null
}): void {
  sqlite
    .prepare(
      `INSERT INTO attachments (id, user_id, scope, note_id, filename, mime, size, sha256, object_key, width, height, storage, created_at)
       VALUES (?, ?, ?, ?, ?, 'text/plain', 4, ?, ?, NULL, NULL, 'r2', 1000)`,
    )
    .run(row.id, row.userId, row.scope, row.noteId, row.filename, `${row.id}hash`, row.objectKey)
}

function fileCount(userId: string, scope?: string): number {
  return Number(
    (
      sqlite
        .prepare(
          scope
            ? `SELECT COUNT(*) AS n FROM attachments WHERE user_id = ? AND scope = ?`
            : `SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?`,
        )
        .get(...(scope ? [userId, scope] : [userId])) as { n: number }
    ).n,
  )
}

async function removedCount(response: Response): Promise<number> {
  return ((await response.json()) as { removed: number }).removed
}

async function post(path: string): Promise<Response> {
  return app().request(`http://localhost${path}`, { method: 'POST' }, env)
}

async function get(path: string): Promise<Response> {
  return app().request(`http://localhost${path}`, {}, env)
}

async function uploadTaskFile(taskId: string, filename: string): Promise<Response> {
  const form = new FormData()
  form.set('file', new File([new Uint8Array([1, 2, 3, 4])], filename, { type: 'text/plain' }))
  return app().request(`http://localhost/api/todos/${taskId}/attachments`, {
    method: 'POST',
    body: form,
  }, env)
}


beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
  insertTask(USER, TASK)
  insertTask(OTHER, OTHER_TASK)
  mocks.userId = USER
})

/**
 * The notebook's own sweep, which is where the task-file loss came from.
 *
 * Only the "leaves" case runs against `/api/files/prune`. The two cases that expect a deletion ask
 * the hub's sweep instead, because the older route cannot reach a delete under this harness at all:
 * `pruneUnreferenced` batches statements that bind more placeholders than they name (`?1, ?2, ?6`
 * with `?3` supplied but unreferenced), and the D1 double binds by name, so it throws before any row
 * is touched. Adding a column filter to those statements does not change their numbering, so this is
 * a pre-existing hole rather than one opened here — but it means the notebook's sweep has never been
 * tested actually deleting anything, which is worth its own issue.
 */
describe('the notebook’s unreferenced sweep', () => {
  it('leaves a file a task links, through the route the settings screen calls', async () => {
    const uploaded = await uploadTaskFile(TASK, 'report.txt')
    expect(uploaded.status).toBe(201)
    const { attachment } = (await uploaded.json()) as { attachment: { id: string } }
    const key = `todos/${USER}/${attachment.id}.txt`
    expect(bucket.objects.has(key)).toBe(true)

    const pruned = await post('/api/files/prune')
    expect(pruned.status).toBe(200)
    expect(await removedCount(pruned)).toBe(0)

    expect(fileCount(USER, 'todos')).toBe(1)
    expect(bucket.objects.has(key)).toBe(true)
  })

  it('still deletes a note file nothing references', async () => {
    insertAttachmentRow({
      id: id(40),
      userId: USER,
      scope: 'notes',
      noteId: null,
      filename: 'loose.txt',
      objectKey: `notes/${USER}/${id(40)}.txt`,
    })
    bucket.objects.set(`notes/${USER}/${id(40)}.txt`, new Uint8Array([1, 2, 3, 4]))

    const pruned = await post('/api/attachments/notes/files/prune')
    expect(await removedCount(pruned)).toBe(1)
    expect(fileCount(USER, 'notes')).toBe(0)
  })

  it('keeps a note file the body of a note names', async () => {
    insertAttachmentRow({
      id: id(41),
      userId: USER,
      scope: 'notes',
      noteId: NOTE,
      filename: 'kept.txt',
      objectKey: `notes/${USER}/${id(41)}.txt`,
    })
    insertNote(USER, NOTE, `Look: /api/files/${id(41)}`)

    const pruned = await post('/api/attachments/notes/files/prune')
    expect(await removedCount(pruned)).toBe(0)
    expect(fileCount(USER, 'notes')).toBe(1)
  })
})

describe('the hub’s sweep, per scope', () => {
  it('refuses to delete a row another application claims', async () => {
    insertAttachmentRow({
      id: id(50),
      userId: USER,
      scope: 'todos',
      noteId: null,
      filename: 'task-only.txt',
      objectKey: `todos/${USER}/${id(50)}.txt`,
    })
    insertAttachmentRow({
      id: id(51),
      userId: USER,
      scope: 'notes',
      noteId: null,
      filename: 'spare.txt',
      objectKey: `notes/${USER}/${id(51)}.txt`,
    })

    const notes = await post('/api/attachments/notes/files/prune')
    expect(notes.status).toBe(200)
    expect(await removedCount(notes)).toBe(1)
    expect(fileCount(USER, 'todos')).toBe(1)
    expect(fileCount(USER, 'notes')).toBe(0)
  })

  it('will not read or delete a scope through another scope’s path', async () => {
    insertAttachmentRow({
      id: id(52),
      userId: USER,
      scope: 'todos',
      noteId: null,
      filename: 'elsewhere.txt',
      objectKey: `todos/${USER}/${id(52)}.txt`,
    })

    const listed = await get('/api/attachments/notes/files')
    const { files } = (await listed.json()) as { files: Array<{ id: string }> }
    expect(files.map((file) => file.id)).not.toContain(id(52))

    const deleted = await app().request(`http://localhost/api/attachments/notes/files/${id(52)}`, {
      method: 'DELETE',
    }, env)
    expect(deleted.status).toBe(404)
    expect(fileCount(USER, 'todos')).toBe(1)
  })

  it('answers an unknown scope with a 404 rather than a table name', async () => {
    const response = await get('/api/attachments/secrets/files')
    expect(response.status).toBe(404)
  })
})

describe('object keys', () => {
  it('writes a new file under its scope prefix', async () => {
    const uploaded = await uploadTaskFile(TASK, 'prefixed.txt')
    const { attachment } = (await uploaded.json()) as { attachment: { id: string } }
    expect(bucket.objects.has(`todos/${USER}/${attachment.id}.txt`)).toBe(true)
  })

  it('still resolves a row written before the hub, which has no persisted key', () => {
    expect(
      attachmentObjectKey({
        id: id(60),
        user_id: USER,
        mime: 'text/plain',
        filename: 'old.txt',
        object_key: null,
      }),
    ).toBe(`${USER}/${id(60)}.txt`)
    expect(
      attachmentObjectKey({
        id: id(61),
        user_id: USER,
        mime: 'text/plain',
        filename: 'new.txt',
        object_key: `notes/${USER}/${id(61)}.txt`,
      }),
    ).toBe(`notes/${USER}/${id(61)}.txt`)
  })
})
