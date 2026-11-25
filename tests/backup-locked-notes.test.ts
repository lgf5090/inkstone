// @vitest-environment node
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTE_LOCK_KDF_MIN_ITERATIONS,
  NoteLockSession,
  openNote,
  sealNote,
} from '../src/shared/crypto'
import {
  MARKDOWN_BACKUP_FORMAT,
  parseMarkdownBackupManifest,
  type MarkdownBackupManifest,
} from '../src/shared/backup-format'
import type { ImportResult } from '../src/shared/types'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { sha256Hex } from '../src/worker/lib/encoding'
import { persistAttachmentWithinQuota } from '../src/worker/attachments/storage'
import { buildSnapshot } from '../src/worker/backup/snapshot'
import { transferRoutes } from '../src/worker/routes/transfer'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const USER = 'user-locked-backup'
const OTHER = 'user-other-backup'
const NOTE_ID = 'a'.repeat(26)
const ATTACHMENT_ID = 'b'.repeat(26)
const ATTACHMENT_ID_2 = 'e'.repeat(26)
const PLAIN_NOTE_ID = 'c'.repeat(26)
const PLAIN_ATTACHMENT_ID = 'd'.repeat(26)
const STAMP = '20261126-010203-001'
const FAST = { iterations: NOTE_LOCK_KDF_MIN_ITERATIONS }
const PASSWORD = 'backup password'
const LEGACY_LOCKED_TITLE = 'memoenc:v1:MDEyMzQ1Njc4OWFiY2RlZg:AAECAwQFBgcICQoL:FMTWLJk0wmu0Cy1AXOh8hiCoNyjz2nFQrxkhwQ'

class NodeDigestStream {
  private readonly hash = createHash('sha256')
  private finish!: (digest: ArrayBuffer) => void
  private closed = false
  readonly digest = new Promise<ArrayBuffer>((resolve) => { this.finish = resolve })

  constructor(algorithm: string) {
    if (algorithm !== 'SHA-256') throw new TypeError(`Unsupported test digest: ${algorithm}`)
  }

  getWriter() {
    return {
      write: async (chunk: Uint8Array) => { this.hash.update(chunk) },
      close: async () => {
        if (this.closed) return
        this.closed = true
        this.finish(Uint8Array.from(this.hash.digest()).buffer)
      },
      abort: async () => { this.closed = true },
    }
  }
}

beforeAll(() => {
  vi.stubGlobal('crypto', Object.assign(globalThis.crypto, { DigestStream: NodeDigestStream }))
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const mocks = vi.hoisted(() => ({ userId: '' }))
vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))
vi.mock('../src/worker/lib/lease', () => ({
  acquireLease: vi.fn(async () => Object.assign(async () => {}, { renew: async () => true })),
}))

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('*', async (c, next) => {
  c.set('database', { ftsEnabled: false })
  await next()
})
app.route('/transfer', transferRoutes)

let source: DatabaseSync
let target: DatabaseSync
let sourceEnv: Env
let targetEnv: Env
let sourceBucket: TestR2Bucket
let targetBucket: TestR2Bucket

function database(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  for (const id of [USER, OTHER]) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, '', '', 'member', '{}', 1, 1)`,
    ).run(id, id, id)
  }
  return sqlite
}

function row<T = Record<string, unknown>>(sqlite: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return sqlite.prepare(sql).get(...(params as never[])) as T | undefined
}

function rows<T = Record<string, unknown>>(sqlite: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return sqlite.prepare(sql).all(...(params as never[])) as T[]
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function seedSource() {
  const session = await NoteLockSession.create(PASSWORD, FAST)
  const sealed = await sealNote(session, NOTE_ID, {
    title: 'Locked title',
    content: 'Locked body with 中文 and /api/files/not-readable',
  })
  const plaintext = new Uint8Array([0, 255, 1, 2, 3, 128])
  const encryptedBytes = await session.sealNoteAttachment(NOTE_ID, ATTACHMENT_ID, plaintext)
  source.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, is_encrypted, position, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, '', 1, 0, 0, 0, 0, 0, 1, 1, ?, 1000, 2000)`,
  ).run(NOTE_ID, USER, sealed.title, sealed.content, await sha256Hex(new TextEncoder().encode(sealed.content)))
  await persistAttachmentWithinQuota(sourceEnv, {
    id: ATTACHMENT_ID,
    userId: USER,
    scope: 'notes',
    noteId: NOTE_ID,
    filename: 'secret.bin',
    reportedMime: 'application/octet-stream',
    bytes: encryptedBytes,
    createdAt: 1000,
    encryption: 'note-lock-v1',
    plaintextSize: plaintext.byteLength,
  })
  expect(row<{ sha256: string }>(source, 'SELECT sha256 FROM attachments WHERE id = ?', ATTACHMENT_ID)?.sha256)
    .toBe(sha(encryptedBytes))
  const plaintext2 = new Uint8Array([9, 8, 7])
  const encryptedBytes2 = await session.sealNoteAttachment(NOTE_ID, ATTACHMENT_ID_2, plaintext2)
  await persistAttachmentWithinQuota(sourceEnv, {
    id: ATTACHMENT_ID_2,
    userId: USER,
    scope: 'notes',
    noteId: NOTE_ID,
    filename: 'second.bin',
    reportedMime: 'application/octet-stream',
    bytes: encryptedBytes2,
    createdAt: 1001,
    encryption: 'note-lock-v1',
    plaintextSize: plaintext2.byteLength,
  })

  const plainBytes = new TextEncoder().encode('ordinary attachment bytes')
  source.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, is_encrypted, position, content_hash, created_at, updated_at)
     VALUES (?, ?, 'Plain title', 'plain title', ?, '', 1, 3, 24, 0, 0, 0, 0, 1, ?, 1000, 2000)`,
  ).run(
    PLAIN_NOTE_ID,
    USER,
    `Plain body /api/files/${PLAIN_ATTACHMENT_ID}`,
    await sha256Hex(new TextEncoder().encode(`Plain body /api/files/${PLAIN_ATTACHMENT_ID}`)),
  )
  await persistAttachmentWithinQuota(sourceEnv, {
    id: PLAIN_ATTACHMENT_ID,
    userId: USER,
    scope: 'notes',
    noteId: PLAIN_NOTE_ID,
    filename: 'plain.txt',
    reportedMime: 'text/plain',
    bytes: plainBytes,
    createdAt: 1000,
  })
  return { session, sealed, plaintext, encryptedBytes, plaintext2, encryptedBytes2, plainBytes }
}

async function snapshot() {
  const built = await buildSnapshot(sourceEnv, USER, { includeAuxiliary: false, snapshot: STAMP })
  const manifestBody = new Uint8Array(await new Response(await built.manifestFile.open()).arrayBuffer())
  const rawManifest = JSON.parse(new TextDecoder().decode(manifestBody)) as MarkdownBackupManifest
  const manifest = parseMarkdownBackupManifest(rawManifest)!
  const files = await Promise.all([...built.payloadFiles, built.completeFile].map(async (file) => ({
    path: file.path,
    body: new Uint8Array(await new Response(await file.open()).arrayBuffer()),
    contentType: file.contentType,
  })))
  files.push({ path: built.manifestFile.path, body: manifestBody, contentType: built.manifestFile.contentType })
  return { built, files, rawManifest, manifest }
}

interface BackupMaterializedFile {
  path: string
  body: Uint8Array
  contentType: string
}

function backupForm(
  files: readonly BackupMaterializedFile[],
  manifest: MarkdownBackupManifest,
  conflict?: string,
): FormData {
  const paths = new Set([
    ...manifest.notes.map((entry) => entry.path),
    ...manifest.attachments.map((entry) => entry.path),
  ])
  const form = new FormData()
  if (conflict) form.set('conflict', conflict)
  form.set('backupManifest', JSON.stringify(manifest))
  form.set('backupPaths', JSON.stringify([...paths]))
  for (const entry of files) {
    if (paths.has(entry.path)) form.append('file', new File([entry.body as BlobPart], entry.path))
  }
  return form
}

async function importBackup(form: FormData, userId = USER, env = targetEnv): Promise<Response> {
  mocks.userId = userId
  const tasks: Promise<unknown>[] = []
  const ctx: ExecutionContext = {
    waitUntil: (task) => { tasks.push(task) },
    passThroughOnException: () => {},
    props: {},
  }
  const response = await app.request('/transfer/import', { method: 'POST', body: form as BodyInit }, env, ctx)
  await Promise.all(tasks)
  return response
}

beforeEach(() => {
  source = database()
  target = database()
  sourceBucket = testR2Bucket()
  targetBucket = testR2Bucket()
  sourceEnv = testBindings(makeD1(source), { FILES: sourceBucket })
  targetEnv = testBindings(makeD1(target), { FILES: targetBucket })
  mocks.userId = USER
})

describe('locked notes in Markdown backups', () => {
  it('snapshots and restores ciphertext plus IKA1 bytes with their original AAD ids', async () => {
    const seeded = await seedSource()
    const { files, rawManifest, manifest } = await snapshot()
    const lockedNote = manifest.notes.find((note) => note.id === NOTE_ID)!
    const encryptedAttachment = manifest.attachments.find((attachment) => attachment.id === ATTACHMENT_ID)!
    const encryptedAttachment2 = manifest.attachments.find((attachment) => attachment.id === ATTACHMENT_ID_2)!
    const lockedFile = files.find((file) => file.path === lockedNote.path)!
    const attachmentFile = files.find((file) => file.path === encryptedAttachment.path)!
    const attachmentFile2 = files.find((file) => file.path === encryptedAttachment2.path)!

    expect(lockedNote).toMatchObject({ isEncrypted: true, title: seeded.sealed.title })
    expect(new TextDecoder().decode(lockedFile.body)).toBe(seeded.sealed.content)
    expect(encryptedAttachment).toMatchObject({
      id: ATTACHMENT_ID,
      noteId: NOTE_ID,
      encryption: 'note-lock-v1',
      plaintextSize: seeded.plaintext.byteLength,
      size: seeded.encryptedBytes.byteLength,
      mime: 'application/octet-stream',
    })
    expect(attachmentFile.contentType).toBe('application/octet-stream')
    expect(attachmentFile.body).toEqual(seeded.encryptedBytes)
    expect(encryptedAttachment2).toMatchObject({
      id: ATTACHMENT_ID_2,
      noteId: NOTE_ID,
      encryption: 'note-lock-v1',
      plaintextSize: seeded.plaintext2.byteLength,
    })
    expect(attachmentFile2.body).toEqual(seeded.encryptedBytes2)
    expect(manifest.notes.find((note) => note.id === PLAIN_NOTE_ID)?.isEncrypted).toBe(false)

    const response = await importBackup(backupForm(files, rawManifest))
    expect(response.status, await response.clone().text()).toBe(200)
    const result = await response.json() as ImportResult
    expect(result).toMatchObject({ createdNotes: 2, createdAttachments: 3, skippedNotes: 0, skippedAttachments: 0 })

    const restoredNote = row<{ title: string; content: string; is_encrypted: number; excerpt: string; word_count: number }>(
      target,
      'SELECT title, content, is_encrypted, excerpt, word_count FROM notes WHERE id = ? AND user_id = ?',
      NOTE_ID,
      USER,
    )!
    expect(restoredNote).toMatchObject({ is_encrypted: 1, excerpt: '', word_count: 0 })
    const session = await NoteLockSession.fromEnvelope(PASSWORD, restoredNote.title)
    await expect(openNote(session, NOTE_ID, restoredNote)).resolves.toEqual({
      title: 'Locked title',
      content: 'Locked body with 中文 and /api/files/not-readable',
    })

    const restoredAttachment = row<{
      id: string; note_id: string; encryption: string; plaintext_size: number; object_key: string; sha256: string
    }>(
      target,
      `SELECT id, note_id, encryption, plaintext_size, object_key, sha256 FROM attachments
       WHERE id = ? AND user_id = ?`,
      ATTACHMENT_ID,
      USER,
    )!
    expect(restoredAttachment).toMatchObject({
      id: ATTACHMENT_ID,
      note_id: NOTE_ID,
      encryption: 'note-lock-v1',
      plaintext_size: seeded.plaintext.byteLength,
      sha256: sha(seeded.encryptedBytes),
    })
    expect(targetBucket.objects.get(restoredAttachment.object_key)).toEqual(seeded.encryptedBytes)
    await expect(session.openNoteAttachment(NOTE_ID, ATTACHMENT_ID, seeded.encryptedBytes))
      .resolves.toEqual(seeded.plaintext)
    const restoredAttachment2 = row<{ note_id: string; encryption: string; plaintext_size: number; object_key: string }>(
      target,
      `SELECT note_id, encryption, plaintext_size, object_key FROM attachments
       WHERE id = ? AND user_id = ?`,
      ATTACHMENT_ID_2,
      USER,
    )!
    expect(restoredAttachment2).toMatchObject({
      note_id: NOTE_ID,
      encryption: 'note-lock-v1',
      plaintext_size: seeded.plaintext2.byteLength,
    })
    expect(targetBucket.objects.get(restoredAttachment2.object_key)).toEqual(seeded.encryptedBytes2)
    await expect(session.openNoteAttachment(NOTE_ID, ATTACHMENT_ID_2, seeded.encryptedBytes2))
      .resolves.toEqual(seeded.plaintext2)
    expect(row(target, 'SELECT 1 AS found FROM ai_index_queue WHERE note_id = ?', NOTE_ID)).toBeUndefined()

    const plainNote = row<{ content: string; is_encrypted: number }>(
      target,
      'SELECT content, is_encrypted FROM notes WHERE id = ?',
      PLAIN_NOTE_ID,
    )!
    expect(plainNote.is_encrypted).toBe(0)
    const plainId = /\/api\/files\/([0-9a-hjkmnp-tv-z]{26})/.exec(plainNote.content)?.[1]
    expect(plainId).toBeTruthy()
    expect(plainId).not.toBe(PLAIN_ATTACHMENT_ID)
    const plainAttachment = row<{ object_key: string }>(target, 'SELECT object_key FROM attachments WHERE id = ?', plainId)!
    expect(targetBucket.objects.get(plainAttachment.object_key)).toEqual(seeded.plainBytes)

    const repeated = await importBackup(backupForm(files, rawManifest))
    expect(repeated.status).toBe(200)
    await expect(repeated.json()).resolves.toMatchObject({
      createdNotes: 0,
      createdAttachments: 0,
      skippedNotes: 2,
      skippedAttachments: 3,
    })
  })

  it('refuses cross-account id reuse before writing anything', async () => {
    await seedSource()
    const { files, rawManifest } = await snapshot()
    const beforeObjects = sourceBucket.objects.size

    const response = await importBackup(backupForm(files, rawManifest), OTHER, sourceEnv)

    expect(response.status).toBe(400)
    expect((await response.json() as { error: { message: string } }).error.message).toMatch(/another account/)
    expect(rows(source, 'SELECT id FROM notes WHERE user_id = ?', OTHER)).toEqual([])
    expect(rows(source, 'SELECT id FROM attachments WHERE user_id = ?', OTHER)).toEqual([])
    expect(sourceBucket.objects.size).toBe(beforeObjects)
  })

  it('rejects ciphertext-shaped metadata whose note body is not a matching envelope', async () => {
    await seedSource()
    const { files, rawManifest } = await snapshot()
    const note = rawManifest.notes.find((entry) => entry.id === NOTE_ID)!
    const body = new TextEncoder().encode('plaintext is not an envelope')
    const changedFiles = files.map((file) => file.path === note.path ? { ...file, body } : file)
    rawManifest.notes = rawManifest.notes.map((entry) => entry.id === NOTE_ID
      ? { ...entry, bytes: body.byteLength, sha256: sha(body) }
      : entry)

    const response = await importBackup(backupForm(changedFiles, rawManifest))

    expect(response.status).toBe(400)
    expect(rows(target, 'SELECT id FROM notes')).toEqual([])
    expect(rows(target, 'SELECT id FROM attachments')).toEqual([])
  })

  it('refuses duplicate mode for an existing locked note instead of breaking its AAD', async () => {
    await seedSource()
    const { files, rawManifest } = await snapshot()
    expect((await importBackup(backupForm(files, rawManifest))).status).toBe(200)

    const response = await importBackup(backupForm(files, rawManifest, 'duplicate'))

    expect(response.status).toBe(400)
    expect(rows(target, 'SELECT id FROM notes WHERE user_id = ?', USER)).toHaveLength(2)
    expect(rows(target, 'SELECT id FROM attachments WHERE user_id = ?', USER)).toHaveLength(3)
  })
})

function encryptedManifest(): MarkdownBackupManifest {
  const hash = 'a'.repeat(64)
  return {
    format: MARKDOWN_BACKUP_FORMAT,
    version: 4,
    appVersion: '0.8.0',
    createdAt: new Date(1).toISOString(),
    snapshot: STAMP,
    notes: [{
      id: NOTE_ID,
      path: 'notes/locked.md',
      title: LEGACY_LOCKED_TITLE,
      folder: [],
      attachmentHashes: [hash],
      state: 'notes',
      archived: false,
      bytes: 10,
      sha256: 'b'.repeat(64),
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      isEncrypted: true,
    }],
    attachments: [{
      path: `attachments/${hash}--secret.bin`,
      filename: 'secret.bin',
      mime: 'application/octet-stream',
      size: 35,
      sha256: hash,
      createdAt: 1,
      id: ATTACHMENT_ID,
      noteId: NOTE_ID,
      encryption: 'note-lock-v1',
      plaintextSize: 3,
    }],
  }
}

describe('strict locked-backup manifest parsing', () => {
  it('accepts old ordinary entries as unencrypted and validates complete encrypted metadata', () => {
    expect(parseMarkdownBackupManifest(encryptedManifest())?.notes[0]?.isEncrypted).toBe(true)
    const old = encryptedManifest()
    old.notes[0] = { ...old.notes[0]!, title: 'Ordinary', isEncrypted: undefined, attachmentHashes: [] }
    old.attachments = [{
      path: old.attachments[0]!.path,
      filename: 'plain.txt',
      mime: 'text/plain',
      size: 3,
      sha256: old.attachments[0]!.sha256,
      createdAt: 1,
    }]
    expect(parseMarkdownBackupManifest(old)?.notes[0]?.isEncrypted).toBe(false)
    expect(parseMarkdownBackupManifest({ ...old, version: 3 })).not.toBeNull()
  })

  it('rejects partial encryption metadata, bad ids, wrong owners and bad plaintext lengths', () => {
    const invalid: unknown[] = []
    for (const key of ['id', 'noteId', 'encryption', 'plaintextSize'] as const) {
      const manifest = encryptedManifest()
      delete manifest.attachments[0]![key]
      invalid.push(manifest)
    }
    for (const patch of [
      { id: 'bad' },
      { noteId: 'd'.repeat(26) },
      { plaintextSize: 2 },
      { encryption: 'none' },
    ]) {
      const manifest = encryptedManifest()
      Object.assign(manifest.attachments[0]!, patch)
      invalid.push(manifest)
    }
    const ordinaryDisguise = encryptedManifest()
    delete ordinaryDisguise.attachments[0]!.encryption
    delete ordinaryDisguise.attachments[0]!.noteId
    delete ordinaryDisguise.attachments[0]!.plaintextSize
    invalid.push(ordinaryDisguise)

    const wrongNote = encryptedManifest()
    wrongNote.notes[0] = { ...wrongNote.notes[0]!, title: 'Plain', isEncrypted: false }
    invalid.push(wrongNote)
    const unreferenced = encryptedManifest()
    unreferenced.notes[0]!.attachmentHashes = []
    invalid.push(unreferenced)
    const invalidTitle = encryptedManifest()
    invalidTitle.notes[0]!.title = 'not an envelope'
    invalid.push(invalidTitle)
    const invalidFlag = encryptedManifest()
    Object.assign(invalidFlag.notes[0]!, { isEncrypted: 'true' })
    invalid.push(invalidFlag)

    const duplicateId = encryptedManifest()
    const secondHash = 'c'.repeat(64)
    duplicateId.notes[0]!.attachmentHashes.push(secondHash)
    duplicateId.attachments.push({
      ...duplicateId.attachments[0]!,
      path: `attachments/${secondHash}--secret.bin`,
      sha256: secondHash,
    })
    invalid.push(duplicateId)

    for (const manifest of invalid) expect(parseMarkdownBackupManifest(manifest)).toBeNull()
  })
})
