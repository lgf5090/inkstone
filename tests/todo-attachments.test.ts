// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { todoAttachmentRoutes } from '../src/worker/routes/todo-attachments'
import { filesRoutes } from '../src/worker/routes/files'
import { LIMITS } from '../src/shared/constants'
import type { Attachment } from '../src/shared/types'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

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

/** A valid 26-character id from the alphabet `isValidId` accepts. */
function id(value: number): string {
  return String(value).padStart(26, '0')
}

const TASK = id(1)
const OTHER_TASK = id(2)
const SECOND_TASK = id(3)
const TRASHED_TASK = id(4)

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  // The download route is mounted too: a detached file must still be readable, which is the
  // difference between "unlinked" and "deleted".
  instance.use('/api/files/*', async (c, next) => {
    c.set('userId', mocks.userId)
    await next()
  })
  instance.route('/api/files', filesRoutes)
  instance.route('/api/todos', todoAttachmentRoutes)
  return instance
}

function insertTask(userId: string, taskId: string, deletedAt: number | null = null): void {
  sqlite.prepare(
    `INSERT INTO todos_tasks (user_id, id, title, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'A task', 1, 1, ?)`,
  ).run(userId, taskId, deletedAt)
}

function fileForm(file: File | null): FormData {
  const form = new FormData()
  if (file) form.append('file', file)
  return form
}

async function upload(taskId: string, file: File | null, userId = USER): Promise<Response> {
  mocks.userId = userId
  return await app().request(
    `/api/todos/${taskId}/attachments`,
    { method: 'POST', body: fileForm(file) },
    env,
  )
}

async function list(taskId: string, userId = USER): Promise<Response> {
  mocks.userId = userId
  return await app().request(`/api/todos/${taskId}/attachments`, { method: 'GET' }, env)
}

async function detach(taskId: string, attachmentId: string, userId = USER): Promise<Response> {
  mocks.userId = userId
  return await app().request(
    `/api/todos/${taskId}/attachments/${attachmentId}`,
    { method: 'DELETE' },
    env,
  )
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return (await json<{ error: { code: string; message: string } }>(response)).error
}

function count(sql: string, ...values: Array<string | number | null>): number {
  return Number((sqlite.prepare(sql).get(...values) as { n: number }).n)
}

function linkCount(userId: string, taskId?: string): number {
  return taskId
    ? count('SELECT COUNT(*) AS n FROM todos_attachments WHERE user_id = ? AND task_id = ?', userId, taskId)
    : count('SELECT COUNT(*) AS n FROM todos_attachments WHERE user_id = ?', userId)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
  insertTask(USER, TASK)
  insertTask(USER, SECOND_TASK)
  insertTask(USER, TRASHED_TASK, 2)
  insertTask(OTHER, OTHER_TASK)
})

describe('a task attachment', () => {
  it('is uploaded through the existing attach module, linked, and listed back', async () => {
    const body = new Uint8Array([104, 105])
    const response = await upload(TASK, new File([body], 'notes.txt', { type: 'text/plain' }))
    expect(response.status).toBe(201)

    const { attachment } = await json<{ attachment: Attachment }>(response)
    expect(attachment).toMatchObject({
      noteId: null,
      filename: 'notes.txt',
      mime: 'text/plain',
      size: 2,
      width: null,
      height: null,
      url: `/api/files/${attachment.id}`,
    })
    expect(linkCount(USER, TASK)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ? AND user_id = ?', attachment.id, USER)).toBe(1)
    expect(bucket.objects.has(`todos/${USER}/${attachment.id}.txt`)).toBe(true)

    const listed = await list(TASK)
    expect(listed.status).toBe(200)
    const { attachments } = await json<{ attachments: Attachment[] }>(listed)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toEqual(attachment)
  })

  it('normalizes an unknown type the way the files route always has, instead of inventing a refusal', async () => {
    const response = await upload(TASK, new File(['<p>hi</p>'], 'page.html', { type: 'text/html' }))
    expect(response.status).toBe(201)
    const { attachment } = await json<{ attachment: Attachment }>(response)
    expect(attachment.mime).toBe('application/octet-stream')
    expect(bucket.objects.has(`todos/${USER}/${attachment.id}.html`)).toBe(true)
  })

  it('refuses a form without a file field with the existing upload error', async () => {
    const response = await upload(TASK, null)
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatchObject({ code: 'bad_request', message: 'Missing file field' })
    expect(linkCount(USER)).toBe(0)
  })

  it('refuses a file over the existing 25 MB ceiling before anything is stored', async () => {
    const response = await upload(
      TASK,
      new File([new Uint8Array(LIMITS.attachmentMaxBytes + 1)], 'big.bin', { type: 'application/octet-stream' }),
    )
    expect(response.status).toBe(413)
    expect(await errorOf(response)).toMatchObject({
      code: 'payload_too_large',
      message: 'The file exceeds the 25 MB limit',
    })
    expect(linkCount(USER)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?', USER)).toBe(0)
    expect(bucket.objects.size).toBe(0)
  })

  it('answers 404 in every direction for another account, and stores nothing', async () => {
    const hidden = await upload(OTHER_TASK, new File(['secret'], 'secret.txt', { type: 'text/plain' }), USER)
    expect(hidden.status).toBe(404)
    expect(await errorOf(hidden)).toMatchObject({ code: 'not_found', message: 'Task not found' })
    expect(count('SELECT COUNT(*) AS n FROM attachments')).toBe(0)
    expect(bucket.objects.size).toBe(0)

    const listed = await list(OTHER_TASK, USER)
    expect(listed.status).toBe(404)
    expect(await errorOf(listed)).toMatchObject({ message: 'Task not found' })

    const removed = await detach(OTHER_TASK, id(99), USER)
    expect(removed.status).toBe(404)
    expect(await errorOf(removed)).toMatchObject({ message: 'Task not found' })
  })

  it('detaches only this task, leaving the file readable and the other task link alone', async () => {
    const response = await upload(TASK, new File(['kept'], 'kept.txt', { type: 'text/plain' }))
    const { attachment } = await json<{ attachment: Attachment }>(response)
    // A second task naming the same file is legal in the link table; deleting one link must not
    // touch the other, which is the rule a "link an existing file" entry will rely on.
    sqlite.prepare(
      'INSERT INTO todos_attachments (user_id, task_id, attachment_id, created_at) VALUES (?, ?, ?, 1)',
    ).run(USER, SECOND_TASK, attachment.id)

    const removed = await detach(TASK, attachment.id)
    expect(removed.status).toBe(200)
    expect(await json(removed)).toEqual({ deleted: true })
    expect(linkCount(USER, TASK)).toBe(0)
    expect(linkCount(USER, SECOND_TASK)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attachment.id)).toBe(1)

    const download = await app().request(`/api/files/${attachment.id}`, {}, env)
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new TextEncoder().encode('kept'))

    expect((await json<{ attachments: Attachment[] }>(await list(TASK))).attachments).toEqual([])
    expect((await json<{ attachments: Attachment[] }>(await list(SECOND_TASK))).attachments).toHaveLength(1)
    expect((await detach(TASK, attachment.id)).status).toBe(404)
  })

  it('keeps a trashed task out of the list without deleting its links or its file', async () => {
    const response = await upload(TASK, new File(['trash'], 'trash.txt', { type: 'text/plain' }))
    const { attachment } = await json<{ attachment: Attachment }>(response)
    sqlite.prepare('UPDATE todos_tasks SET deleted_at = 3 WHERE user_id = ? AND id = ?').run(USER, TASK)

    const listed = await list(TASK)
    expect(listed.status).toBe(404)
    expect(await errorOf(listed)).toMatchObject({ message: 'Task not found' })
    expect(linkCount(USER, TASK)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attachment.id)).toBe(1)

    // A trashed task is not an upload target either; the file count stays where it was.
    const uploadToTrash = await upload(TRASHED_TASK, new File(['x'], 'x.txt', { type: 'text/plain' }))
    expect(uploadToTrash.status).toBe(404)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?', USER)).toBe(1)
  })
})
