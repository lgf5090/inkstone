// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { filesRoutes } from '../src/worker/routes/files'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const USER = 'a'.repeat(26)
const OTHER = 'e'.repeat(26)
const PLAIN_NOTE = 'b'.repeat(26)
const LOCKED_NOTE = 'c'.repeat(26)
const OTHER_NOTE = 'f'.repeat(26)
const ATTACHMENT = 'd'.repeat(26)
const QUOTA_FILLER = '1'.repeat(26)
const mocks = vi.hoisted(() => ({ userId: 'a'.repeat(26) }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', mocks.userId)
    await next()
  })
  instance.route('/api/files', filesRoutes)
  return instance
}

function envelope(length = 40): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set([73, 75, 65, 49])
  return bytes
}

function filePart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function upload(
  noteId: string,
  encryption: string,
  bytes = envelope(),
  filename = 'secret.png',
  mime = 'image/png',
): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([filePart(bytes)], filename, { type: mime }))
  form.append('noteId', noteId)
  form.append('attachmentId', ATTACHMENT)
  form.append('encryption', encryption)
  if (encryption === 'note-lock-v1') form.append('plaintextSize', String(bytes.length - 32))
  return app().request('http://localhost/api/files', { method: 'POST', body: form }, env)
}

async function replace(
  id: string,
  encryption: string,
  bytes: Uint8Array,
  options: { plaintextSize?: number; omitPlaintextSize?: boolean; filename?: string; mime?: string; expectedSha256?: string } = {},
): Promise<Response> {
  const form = new FormData()
  form.append('file', new File(
    [filePart(bytes)],
    options.filename ?? 'replacement.txt',
    { type: options.mime ?? 'text/plain' },
  ))
  form.append('encryption', encryption)
  if (options.expectedSha256) form.append('expectedSha256', options.expectedSha256)
  if (encryption === 'note-lock-v1' && !options.omitPlaintextSize) {
    form.append('plaintextSize', String(options.plaintextSize ?? bytes.length - 32))
  }
  return app().request(`http://localhost/api/files/${id}`, { method: 'PUT', body: form }, env)
}

function insertNote(id: string, userId: string, encrypted: number): void {
  sqlite.prepare(`INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count,
    char_count, is_pinned, is_starred, is_archived, is_encrypted, position, content_hash, created_at, updated_at)
    VALUES (?, ?, 'Secret', 'secret', 'ciphertext', '', 1, 0, 0, 0, 0, 0, ?, 0, '', 1, 1)`).run(id, userId, encrypted)
}

interface StoredAttachmentRow {
  id: string
  user_id: string
  note_id: string
  filename: string
  mime: string
  size: number
  sha256: string
  object_key: string
  width: number | null
  height: number | null
  storage: string
  encryption: string
  plaintext_size: number | null
  created_at: number
}

function attachmentRow(id: string): StoredAttachmentRow | undefined {
  return sqlite.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as StoredAttachmentRow | undefined
}

function cleanupRows(): Array<{ object_key: string; user_id: string }> {
  return sqlite.prepare('SELECT object_key, user_id FROM attachment_cleanup ORDER BY object_key')
    .all() as Array<{ object_key: string; user_id: string }>
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
  insertNote(PLAIN_NOTE, USER, 0)
  insertNote(LOCKED_NOTE, USER, 1)
  insertNote(OTHER_NOTE, OTHER, 0)
  mocks.userId = USER
})

describe('locked-note attachment uploads', () => {
  it('rejects plaintext for locked notes and ciphertext for ordinary notes', async () => {
    expect((await upload(LOCKED_NOTE, 'none', new Uint8Array([1, 2, 3]))).status).toBe(400)
    expect((await upload(PLAIN_NOTE, 'note-lock-v1')).status).toBe(400)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM attachments').get()).toMatchObject({ count: 0 })
  })

  it('stores only the encrypted envelope and serves it as non-inline no-store data', async () => {
    const bytes = envelope()
    const response = await upload(LOCKED_NOTE, 'note-lock-v1', bytes)
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      id: ATTACHMENT,
      noteId: LOCKED_NOTE,
      mime: 'image/png',
      size: 40,
      plaintextSize: 8,
      encryption: 'note-lock-v1',
    })
    const row = sqlite.prepare(`SELECT encryption, plaintext_size, object_key FROM attachments WHERE id = ?`)
      .get(ATTACHMENT) as { encryption: string; plaintext_size: number; object_key: string }
    expect(row).toMatchObject({ encryption: 'note-lock-v1', plaintext_size: 8 })
    expect(row.object_key.endsWith('.enc')).toBe(true)
    expect(bucket.objects.get(row.object_key)).toEqual(bytes)

    const read = await app().request(`http://localhost/api/files/${ATTACHMENT}`, {}, env)
    expect(read.status).toBe(200)
    expect(read.headers.get('content-type')).toBe('application/octet-stream')
    expect(read.headers.get('cache-control')).toBe('private, no-store')
    expect(read.headers.get('x-inkstone-attachment-encryption')).toBe('note-lock-v1')
    expect(read.headers.get('content-disposition')).toContain('attachment;')
    expect(await read.bytes()).toEqual(bytes)
    const revalidated = await app().request(`http://localhost/api/files/${ATTACHMENT}`, {
      headers: { 'If-None-Match': read.headers.get('etag')! },
    }, env)
    expect(revalidated.status).toBe(200)
    expect(revalidated.headers.get('x-inkstone-attachment-encryption')).toBe('note-lock-v1')
  })

  it('rejects a duplicate encrypted id without overwriting the first object', async () => {
    const original = envelope()
    expect((await upload(LOCKED_NOTE, 'note-lock-v1', original)).status).toBe(201)
    const replacement = envelope()
    replacement[4] = 9
    expect((await upload(LOCKED_NOTE, 'note-lock-v1', replacement)).status).toBe(409)
    const row = attachmentRow(ATTACHMENT)!
    expect(bucket.objects.get(row.object_key)).toEqual(original)
    const read = await app().request(`http://localhost/api/files/${ATTACHMENT}`, {}, env)
    expect(await read.bytes()).toEqual(original)
  })

  it('rejects malformed encrypted framing', async () => {
    expect((await upload(LOCKED_NOTE, 'note-lock-v1', new Uint8Array(40))).status).toBe(400)
    expect((await upload(LOCKED_NOTE, 'note-lock-v1', new Uint8Array(31))).status).toBe(400)
  })

  it('counts an encrypted attachment through its owning note', async () => {
    expect((await upload(LOCKED_NOTE, 'note-lock-v1')).status).toBe(201)
    const { collectAttachmentReferences } = await import('../src/worker/attachments/references')
    const references = await collectAttachmentReferences(env.DB, USER, new Set([ATTACHMENT]))
    expect(references.get(ATTACHMENT)).toBe(1)
  })
})

describe('note attachment byte replacement', () => {
  it('rejects plaintext after locking and ciphertext after unlocking', async () => {
    const plaintext = new Uint8Array([1, 2, 3])
    const uploaded = await upload(PLAIN_NOTE, 'none', plaintext, 'old.txt', 'text/plain')
    expect(uploaded.status).toBe(201)
    const { id: plainId } = await uploaded.json() as { id: string }
    const plainBefore = attachmentRow(plainId)
    sqlite.prepare('UPDATE notes SET is_encrypted = 1 WHERE id = ?').run(PLAIN_NOTE)

    expect((await replace(plainId, 'none', new Uint8Array([4, 5, 6]))).status).toBe(400)
    expect(attachmentRow(plainId)).toEqual(plainBefore)

    expect((await upload(LOCKED_NOTE, 'note-lock-v1')).status).toBe(201)
    const encryptedBefore = attachmentRow(ATTACHMENT)
    sqlite.prepare('UPDATE notes SET is_encrypted = 0 WHERE id = ?').run(LOCKED_NOTE)

    expect((await replace(ATTACHMENT, 'note-lock-v1', envelope())).status).toBe(400)
    expect(attachmentRow(ATTACHMENT)).toEqual(encryptedBefore)
    expect(cleanupRows()).toEqual([])
  })

  it('encrypts in place, keeps the id, and queues the old object for cleanup', async () => {
    const plaintext = new Uint8Array([1, 2, 3])
    const uploaded = await upload(PLAIN_NOTE, 'none', plaintext, 'old.txt', 'text/plain')
    expect(uploaded.status).toBe(201)
    const { id } = await uploaded.json() as { id: string }
    const before = attachmentRow(id)!
    const firstRead = await app().request(`http://localhost/api/files/${id}`, {}, env)
    expect(firstRead.status).toBe(200)
    const oldEtag = firstRead.headers.get('etag')!
    sqlite.prepare('UPDATE notes SET is_encrypted = 1 WHERE id = ?').run(PLAIN_NOTE)

    const ciphertext = envelope()
    ciphertext[4] = 9
    const response = await replace(id, 'note-lock-v1', ciphertext)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id,
      noteId: PLAIN_NOTE,
      filename: 'replacement.txt',
      mime: 'text/plain',
      size: 40,
      width: null,
      height: null,
      encryption: 'note-lock-v1',
      plaintextSize: 8,
    })

    const after = attachmentRow(id)!
    expect(after).toMatchObject({
      id,
      user_id: USER,
      note_id: PLAIN_NOTE,
      filename: 'replacement.txt',
      mime: 'text/plain',
      size: 40,
      width: null,
      height: null,
      storage: 'r2',
      encryption: 'note-lock-v1',
      plaintext_size: 8,
      object_key: `notes/${USER}/${id}.enc`,
    })
    expect(after.created_at).toBe(before.created_at)
    expect(after.sha256).not.toBe(before.sha256)
    expect(bucket.objects.get(before.object_key)).toEqual(plaintext)
    expect(bucket.objects.get(after.object_key)).toEqual(ciphertext)
    expect(cleanupRows()).toEqual([{ object_key: `r2:${before.object_key}`, user_id: USER }])

    const read = await app().request(`http://localhost/api/files/${id}`, {
      headers: { 'If-None-Match': oldEtag },
    }, env)
    expect(read.status).toBe(200)
    expect(await read.bytes()).toEqual(ciphertext)
  })

  it('refuses a stale checksum before replacing bytes', async () => {
    const uploaded = await upload(PLAIN_NOTE, 'none', new Uint8Array([1, 2, 3]), 'old.txt', 'text/plain')
    const { id } = await uploaded.json() as { id: string }
    const before = attachmentRow(id)!
    const response = await replace(id, 'none', new Uint8Array([4, 5, 6]), { expectedSha256: '0'.repeat(64) })
    expect(response.status).toBe(409)
    expect(attachmentRow(id)).toEqual(before)
    expect(bucket.objects.get(before.object_key)).toEqual(new Uint8Array([1, 2, 3]))
    const current = attachmentRow(id)!
    expect((await replace(id, 'none', new Uint8Array([4, 5, 6]), { expectedSha256: current.sha256 })).status).toBe(200)
  })

  it('uses a fresh object key when replacing bytes in the same layout', async () => {
    const uploaded = await upload(PLAIN_NOTE, 'none', new Uint8Array([1, 2, 3]), 'old.txt', 'text/plain')
    expect(uploaded.status).toBe(201)
    const { id } = await uploaded.json() as { id: string }
    const before = attachmentRow(id)!
    const replacement = new Uint8Array([4, 5, 6, 7, 8])

    expect((await replace(id, 'none', replacement)).status).toBe(200)
    const after = attachmentRow(id)!
    expect(after.object_key).not.toBe(before.object_key)
    expect(after.object_key.startsWith(`notes/${USER}/${id}.`)).toBe(true)
    expect(bucket.objects.get(before.object_key)).toEqual(new Uint8Array([1, 2, 3]))
    expect(bucket.objects.get(after.object_key)).toEqual(replacement)
    expect(cleanupRows()).toEqual([{ object_key: `r2:${before.object_key}`, user_id: USER }])
  })

  it('does not reuse a plaintext key that is still queued for cleanup', async () => {
    const uploaded = await upload(PLAIN_NOTE, 'none', new Uint8Array([1, 2, 3]), 'old.txt', 'text/plain')
    expect(uploaded.status).toBe(201)
    const { id } = await uploaded.json() as { id: string }
    const plaintextKey = attachmentRow(id)!.object_key

    sqlite.prepare('UPDATE notes SET is_encrypted = 1 WHERE id = ?').run(PLAIN_NOTE)
    expect((await replace(id, 'note-lock-v1', envelope())).status).toBe(200)
    const encryptedKey = attachmentRow(id)!.object_key
    sqlite.prepare('UPDATE notes SET is_encrypted = 0 WHERE id = ?').run(PLAIN_NOTE)

    const plaintext = new Uint8Array([7, 8, 9])
    expect((await replace(id, 'none', plaintext)).status).toBe(200)
    const after = attachmentRow(id)!
    expect(after.object_key).not.toBe(plaintextKey)
    expect(after.object_key).not.toBe(encryptedKey)
    expect(bucket.objects.get(after.object_key)).toEqual(plaintext)

    const { drainAttachmentCleanup } = await import('../src/worker/attachments/cleanup')
    await drainAttachmentCleanup(env, USER)
    expect(bucket.objects.has(plaintextKey)).toBe(false)
    expect(bucket.objects.has(encryptedKey)).toBe(false)
    expect(bucket.objects.get(after.object_key)).toEqual(plaintext)
  })

  it('rejects bad encrypted framing without touching the existing row or object', async () => {
    expect((await upload(LOCKED_NOTE, 'note-lock-v1')).status).toBe(201)
    const before = attachmentRow(ATTACHMENT)
    const badMagic = envelope()
    badMagic[0] = 0

    expect((await replace(ATTACHMENT, 'note-lock-v1', badMagic)).status).toBe(400)
    expect((await replace(ATTACHMENT, 'note-lock-v1', envelope(39), { plaintextSize: 8 })).status).toBe(400)
    expect((await replace(ATTACHMENT, 'note-lock-v1', envelope(), { omitPlaintextSize: true })).status).toBe(400)
    expect(attachmentRow(ATTACHMENT)).toEqual(before)
    expect(bucket.objects.size).toBe(1)
    expect(cleanupRows()).toEqual([])
  })

  it('answers an owner with 409 instead of reading bytes when note and row encryption differ', async () => {
    const uploaded = await upload(PLAIN_NOTE, 'none', new Uint8Array([1, 2, 3]), 'old.txt', 'text/plain')
    expect(uploaded.status).toBe(201)
    const { id } = await uploaded.json() as { id: string }
    const before = attachmentRow(id)!
    sqlite.prepare('UPDATE notes SET is_encrypted = 1 WHERE id = ?').run(PLAIN_NOTE)
    const readObject = vi.spyOn(bucket, 'get')

    const response = await app().request(`http://localhost/api/files/${id}`, {
      headers: { 'If-None-Match': `"${before.sha256}"` },
    }, env)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'conflict' } })
    expect(readObject).not.toHaveBeenCalled()
  })

  it('refuses a replacement owned by another user', async () => {
    const objectKey = `notes/${OTHER}/${ATTACHMENT}.txt`
    sqlite.prepare(`INSERT INTO attachments (id, user_id, scope, note_id, filename, mime, size, sha256,
      object_key, width, height, storage, created_at)
      VALUES (?, ?, 'notes', ?, 'other.txt', 'text/plain', 3, 'otherhash', ?, NULL, NULL, 'r2', 1)`)
      .run(ATTACHMENT, OTHER, OTHER_NOTE, objectKey)
    bucket.objects.set(objectKey, new Uint8Array([1, 2, 3]))
    const before = attachmentRow(ATTACHMENT)

    expect((await replace(ATTACHMENT, 'none', new Uint8Array([4, 5, 6]))).status).toBe(404)
    expect(attachmentRow(ATTACHMENT)).toEqual(before)
    expect(bucket.objects.get(objectKey)).toEqual(new Uint8Array([1, 2, 3]))
    expect(cleanupRows()).toEqual([])
  })

  it('returns 503 when no object storage is bound', async () => {
    const uploaded = await upload(PLAIN_NOTE, 'none', new Uint8Array([1, 2, 3]), 'old.txt', 'text/plain')
    expect(uploaded.status).toBe(201)
    const { id } = await uploaded.json() as { id: string }
    const before = attachmentRow(id)
    env = testBindings(makeD1(sqlite))

    const response = await replace(id, 'none', new Uint8Array([4, 5, 6]))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'storage_unavailable' } })
    expect(attachmentRow(id)).toEqual(before)
  })

  it('charges the quota for new size minus the replaced size', async () => {
    const uploaded = await upload(PLAIN_NOTE, 'none', new Uint8Array([1, 2, 3]), 'old.txt', 'text/plain')
    expect(uploaded.status).toBe(201)
    const { id } = await uploaded.json() as { id: string }
    sqlite.prepare(`INSERT INTO attachments (id, user_id, scope, note_id, filename, mime, size, sha256,
      storage, created_at)
      VALUES (?, ?, 'todos', NULL, 'quota.bin', 'application/octet-stream', ?, 'fillerhash', 'r2', 1)`)
      .run(QUOTA_FILLER, USER, LIMITS.attachmentQuotaBytes - 13)
    const before = attachmentRow(id)

    expect((await replace(id, 'none', new Uint8Array(20))).status).toBe(413)
    expect(attachmentRow(id)).toEqual(before)
    expect((await replace(id, 'none', new Uint8Array(10))).status).toBe(200)
    expect(attachmentRow(id)?.size).toBe(10)
  })
})
