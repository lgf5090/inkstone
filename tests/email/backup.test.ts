// @vitest-environment node
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  backupCompleteBody,
  backupEmailAttachmentPath,
  backupEmailPath,
  MARKDOWN_BACKUP_FORMAT,
  MARKDOWN_BACKUP_VERSION,
  type MarkdownBackupManifest,
} from '../../src/shared/backup-format'
import {
  EMAIL_BACKUP_FORMAT,
  EMAIL_BACKUP_VERSION,
  parseEmailBackupBundle,
  type EmailBackupBundle,
} from '../../src/shared/email/backup'
import { mergeSettingsPatch } from '../../src/shared/constants'
import type { ImportResult } from '../../src/shared/types'
import { SCHEMA_STATEMENTS } from '../../src/worker/db/schema'
import { createEmailAccount } from '../../src/worker/email/account-store'
import { applyBackupEmail, readBackupEmail } from '../../src/worker/email/backup'
import { buildSnapshot, materializeSnapshot } from '../../src/worker/backup/snapshot'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../src/worker/email/mailbox-store'
import type { AppBindings, Env } from '../../src/worker/env'
import { errorResponse } from '../../src/worker/lib/errors'
import { newId } from '../../src/worker/lib/id'
import { emailRoutes } from '../../src/worker/routes/email'
import { transferRoutes } from '../../src/worker/routes/transfer'
import { restoreMarkdownBackupFolder } from '../../src/client/lib/backup-import'
import { makeD1 } from '../doubles/d1-sqlite'
import { makeSqlExec } from '../doubles/do-sqlite'
import { fakeEmailMailboxNamespace } from '../doubles/email-mailbox'
import { testBindings, testR2Bucket, type TestR2Bucket } from '../doubles/bindings'

const USER = 'user-owner'
const OTHER = 'user-other'
const STAMP = '20261023-120000-000'
const NOW = 1_700_000_000_000

let sqlite: DatabaseSync
let db: D1Database
let store: MailboxStore
let bucket: TestR2Bucket
let env: Env
let userId: string
let userRole: 'owner' | 'member'
let accountId: string

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readFile(file: { open: () => Promise<ReadableStream<Uint8Array>> }): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(await file.open()).arrayBuffer())
}

function seedMessage(id: string, overrides: {
  folder?: string
  subject?: string
  read?: boolean
  starred?: boolean
  focused?: boolean
  body?: string
  bodySource?: string | null
  date?: number
} = {}): void {
  expect(store.createEmail(overrides.folder ?? 'inbox', {
    id,
    subject: overrides.subject ?? 'Hello',
    sender: 'Alice <alice@example.com>',
    recipient: 'owner@example.com',
    date: overrides.date ?? NOW,
    body: overrides.body ?? '<p>Hello</p>',
    bodySource: overrides.bodySource ?? 'Hello',
    read: overrides.read ?? false,
    starred: overrides.starred ?? false,
    focused: overrides.focused,
  })).toBe(true)
}

function seedAttachment(input: {
  id?: string
  emailId: string
  filename?: string
  mime?: string
  bytes?: Uint8Array
  objectKey?: string
  missing?: boolean
  lock?: boolean
}): { id: string; objectKey: string; path: string; bytes: Uint8Array } {
  const id = input.id ?? newId()
  const filename = input.filename ?? 'report.pdf'
  const mime = input.mime ?? 'application/pdf'
  const bytes = input.bytes ?? new TextEncoder().encode('attachment bytes')
  const objectKey = input.objectKey ?? `mail/docs/${id}.pdf`
  sqlite.prepare(
    `INSERT INTO email_attachments (
       id, user_id, account_id, email_id, filename, mime, size, width, height,
       content_id, disposition, object_key, storage, folder_id, is_starred,
       is_pinned, tags, locked, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'attachment', ?, 'r2', NULL, 0, 0, '[]', ?, ?)`,
  ).run(
    id,
    userId,
    accountId,
    input.emailId,
    filename,
    mime,
    bytes.byteLength,
    objectKey,
    input.lock ? 1 : 0,
    NOW,
  )
  if (!input.missing) {
    bucket.put(objectKey, bytes, { httpMetadata: { contentType: mime }, customMetadata: { sha256: sha(bytes) } })
  }
  return { id, objectKey, path: backupEmailAttachmentPath(STAMP, accountId, input.emailId, id, filename), bytes }
}

function emailApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('/api/email/*', async (c, next) => {
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: 'owner',
        login: 'owner',
        name: 'Owner',
        avatarUrl: '',
        role: userRole,
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  instance.route('/api/email', emailRoutes)
  return instance
}

function transferApp(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('user', {
      id: userId,
      username: 'owner',
      login: 'owner',
      name: 'Owner',
      avatarUrl: '',
      role: userRole,
      createdAt: 0,
      settingsRaw: '{}',
    })
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/transfer', transferRoutes)
  return instance
}

async function readEmailBundle(result: Awaited<ReturnType<typeof readBackupEmail>>): Promise<EmailBackupBundle> {
  expect(result.file).not.toBeNull()
  const parsed = parseEmailBackupBundle(JSON.parse(new TextDecoder().decode(await readFile(result.file!))))
  expect(parsed).not.toBeNull()
  return parsed!
}

function manifestFor(emailBytes: Uint8Array, includesAttachments: boolean): MarkdownBackupManifest {
  return {
    format: MARKDOWN_BACKUP_FORMAT,
    version: MARKDOWN_BACKUP_VERSION,
    appVersion: 'test',
    createdAt: new Date(NOW).toISOString(),
    snapshot: STAMP,
    notes: [],
    attachments: [],
    email: {
      path: backupEmailPath(STAMP),
      bytes: emailBytes.byteLength,
      sha256: sha(emailBytes),
      includesAttachments,
    },
  }
}

function emptyImportResult(): ImportResult {
  return {
    createdNotes: 0,
    updatedNotes: 0,
    skippedNotes: 0,
    createdFolders: 0,
    createdAttachments: 0,
    skippedAttachments: 0,
    warnings: [],
  }
}

function fileOf(path: string, bytes: Uint8Array<ArrayBuffer>): File {
  const file = new File([bytes], path)
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, 'owner', 'h', 'owner', 'Owner', '', 'owner', '{}', 1, 1)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, 'other', 'h', 'other', 'Other', '', 'owner', '{}', 1, 1)`,
  ).run(OTHER)
  db = makeD1(sqlite)
  const sql = makeSqlExec(sqlite)
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
  bucket = testR2Bucket()
  userId = USER
  userRole = 'owner'
  env = testBindings(db, {
    FILES: bucket,
    EMAIL_MAILBOX: fakeEmailMailboxNamespace(store),
  })
})

async function setupAccount(): Promise<void> {
  accountId = (await createEmailAccount(db, {
    userId,
    address: 'owner@example.com',
    displayName: 'Owner',
  })).id
}

describe('email backup format and reads', () => {
  it('round-trips accounts, folders, messages and attachment metadata', async () => {
    await setupAccount()
    const work = store.createFolder('Work')!
    const messageId = newId()
    seedMessage(messageId, { folder: work.id, subject: 'Release', read: true, starred: true, focused: false })
    const attachment = seedAttachment({ emailId: messageId })

    const result = await readBackupEmail(env, userId, { includeAttachments: false, snapshot: STAMP })
    expect(result.file?.path).toBe(backupEmailPath(STAMP))
    expect(result.includesAttachments).toBe(false)
    expect(result.attachments).toEqual([])
    expect(result.messageCount).toBe(1)
    expect(result.attachmentCount).toBe(1)

    const bundle = await readEmailBundle(result)
    expect(bundle.format).toBe(EMAIL_BACKUP_FORMAT)
    expect(bundle.version).toBe(EMAIL_BACKUP_VERSION)
    expect(bundle.snapshot).toBe(STAMP)
    expect(bundle.includesAttachments).toBe(false)
    expect(bundle.accounts).toHaveLength(1)
    expect(bundle.accounts[0]!.folders.map((folder) => folder.name)).toContain('Work')
    const message = bundle.accounts[0]!.messages[0]!
    expect(message).toMatchObject({
      id: messageId,
      folderId: work.id,
      subject: 'Release',
      body: '<p>Hello</p>',
      bodySource: 'Hello',
      read: true,
      starred: true,
      focused: false,
    })
    expect(message.attachments[0]).toMatchObject({
      id: attachment.id,
      objectKey: attachment.objectKey,
    })
  })

  it('streams attachment bytes when asked and marks a missing object', async () => {
    await setupAccount()
    const messageId = newId()
    seedMessage(messageId)
    const present = seedAttachment({ emailId: messageId, filename: 'present.pdf' })
    const absent = seedAttachment({
      emailId: messageId,
      filename: 'absent.pdf',
      missing: true,
      objectKey: 'mail/docs/absent.pdf',
    })

    const result = await readBackupEmail(env, userId, { includeAttachments: true, snapshot: STAMP })
    expect(result.includesAttachments).toBe(true)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]!.path).toBe(present.path)
    expect(await readFile(result.attachments[0]!)).toEqual(present.bytes)

    const bundle = await readEmailBundle(result)
    const attachments = bundle.accounts[0]!.messages[0]!.attachments
    const presentMeta = attachments.find((entry) => entry.id === present.id)
    const absentMeta = attachments.find((entry) => entry.id === absent.id)
    expect(presentMeta?.sha256).toBe(sha(present.bytes))
    expect(presentMeta?.missing).toBeUndefined()
    expect(absentMeta?.missing).toBe(true)
  })

  it('refuses to include attachments past the account quota', async () => {
    await setupAccount()
    const messageId = newId()
    seedMessage(messageId)
    const rows = 411
    const size = 25 * 1024 * 1024
    const insert = sqlite.prepare(
      `INSERT INTO email_attachments (
         id, user_id, account_id, email_id, filename, mime, size, width, height,
         content_id, disposition, object_key, storage, folder_id, is_starred,
         is_pinned, tags, locked, created_at
       ) VALUES (?, ?, ?, ?, 'big.bin', 'application/octet-stream', ?, NULL, NULL, NULL, 'attachment', ?, 'r2', NULL, 0, 0, '[]', 1, ?)`,
    )
    for (let index = 0; index < rows; index++) {
      insert.run(`${String(index).padStart(26, '0')}`, userId, accountId, messageId, size, `mail/other/${index}.bin`, NOW)
    }
    await expect(readBackupEmail(env, userId, { includeAttachments: true, snapshot: STAMP }))
      .rejects.toMatchObject({ status: 413, code: 'email_export_too_large' })
  })
})

describe('backup snapshot integration', () => {
  it('adds the email archive to the snapshot and manifest', async () => {
    await setupAccount()
    seedMessage(newId(), { subject: 'Snapshot mail' })
    const snapshot = await buildSnapshot(env, USER)
    const email = snapshot.payloadFiles.find((file) => file.kind === 'email')
    expect(email).toBeDefined()
    const files = await materializeSnapshot(snapshot)
    const manifestFile = files.find((file) => file.path === 'manifest.json')
    const manifest = JSON.parse(new TextDecoder().decode(manifestFile!.body)) as MarkdownBackupManifest
    expect(manifest.email).toMatchObject({
      path: email!.path,
      bytes: email!.byteLength,
      includesAttachments: false,
    })
    const emailFile = files.find((file) => file.path === email!.path)
    const bundle = parseEmailBackupBundle(JSON.parse(new TextDecoder().decode(emailFile!.body)))
    expect(bundle?.accounts[0]?.messages[0]?.subject).toBe('Snapshot mail')
  })

  it('leaves email out when the setting is off', async () => {
    await setupAccount()
    seedMessage(newId())
    sqlite.prepare(`UPDATE users SET settings = ? WHERE id = ?`)
      .run(JSON.stringify({ emailBackup: { enabled: false } }), USER)
    const snapshot = await buildSnapshot(env, USER)
    expect(snapshot.payloadFiles.some((file) => file.kind === 'email')).toBe(false)
    const manifestFile = (await materializeSnapshot(snapshot)).find((file) => file.path === 'manifest.json')
    const manifest = JSON.parse(new TextDecoder().decode(manifestFile!.body)) as MarkdownBackupManifest
    expect(manifest.email).toBeUndefined()
  })
})

describe('email restore', () => {
  it('restores metadata and messages, then skips everything on a second run', async () => {
    await setupAccount()
    const work = store.createFolder('Work')!
    const messageId = newId()
    seedMessage(messageId, { folder: work.id, read: true, starred: true, focused: false })
    const trashedId = newId()
    seedMessage(trashedId, { subject: 'Trash' })
    expect(store.trashEmail(trashedId)).toBe('inbox')
    const attachment = seedAttachment({ emailId: messageId, missing: true, objectKey: 'mail/docs/missing.pdf' })

    const result = await readBackupEmail(env, userId, { includeAttachments: false, snapshot: STAMP })
    const bundle = await readEmailBundle(result)

    store.deleteAll()
    sqlite.prepare('DELETE FROM email_attachments WHERE user_id = ?').run(userId)
    sqlite.prepare('DELETE FROM email_accounts WHERE user_id = ?').run(userId)

    const first = await applyBackupEmail(env, userId, { bundle, attachments: new Map() })
    expect(first.createdAccounts).toBe(1)
    expect(first.createdMessages).toBe(2)
    expect(first.createdFolders).toBeGreaterThanOrEqual(1)
    expect(first.createdAttachments).toBe(1)
    expect(first.missingAttachments).toBe(0)
    expect(store.getEmail(messageId)).toMatchObject({ read: 1, starred: 1, focused: 0, folder_id: work.id })
    expect(store.listTrash().map((row) => row.id)).toEqual([trashedId])
    expect(sqlite.prepare(
      'SELECT object_key, locked FROM email_attachments WHERE user_id = ? AND id = ?',
    ).get(userId, attachment.id)).toEqual({ object_key: `mail/docs/${attachment.id}.pdf`, locked: 0 })

    const second = await applyBackupEmail(env, userId, { bundle, attachments: new Map() })
    expect(second.createdAccounts).toBe(0)
    expect(second.skippedAccounts).toBe(1)
    expect(second.createdMessages).toBe(0)
    expect(second.skippedMessages).toBe(2)
    expect(second.createdAttachments).toBe(0)
    expect(second.skippedAttachments).toBe(1)
    expect(store.listAllEmails()).toHaveLength(2)
  })

  it('restores into root folders when a nested folder shares the name', async () => {
    await setupAccount()
    const work = store.createFolder('Work')!
    const messageId = newId()
    seedMessage(messageId, { folder: work.id })
    const result = await readBackupEmail(env, userId, { includeAttachments: false, snapshot: STAMP })
    const bundle = await readEmailBundle(result)

    store.deleteAll()
    sqlite.prepare('DELETE FROM email_attachments WHERE user_id = ?').run(userId)
    sqlite.prepare('DELETE FROM email_accounts WHERE user_id = ?').run(userId)

    const other = store.createFolder('Other')!
    const nested = store.createFolder('Work', other.id)!
    await applyBackupEmail(env, userId, { bundle, attachments: new Map() })

    expect(store.getEmail(messageId)?.folder_id).toBe(work.id)
    expect(store.getEmail(messageId)?.folder_id).not.toBe(nested.id)
    expect(store.getFolders().find((folder) => folder.id === work.id)?.parent_id).toBeNull()
  })

  it('restores attachment bytes and reports missing files rather than claiming them', async () => {
    await setupAccount()
    const messageId = newId()
    seedMessage(messageId)
    const attachment = seedAttachment({ emailId: messageId })

    const withBytes = await readBackupEmail(env, userId, { includeAttachments: true, snapshot: STAMP })
    const bundle = await readEmailBundle(withBytes)
    bundle.accounts[0]!.messages[0]!.attachments[0]!.objectKey = 'mail/other/forged.pdf'
    const bytes = new Map([[attachment.path.toLowerCase(), await readFile(withBytes.attachments[0]!)]])
    store.deleteAll()
    sqlite.prepare('DELETE FROM email_attachments WHERE user_id = ?').run(userId)
    sqlite.prepare('DELETE FROM email_accounts WHERE user_id = ?').run(userId)
    bucket.objects.delete(attachment.objectKey)

    const restored = await applyBackupEmail(env, userId, { bundle, attachments: bytes })
    expect(restored.createdAttachments).toBe(1)
    expect(restored.missingAttachments).toBe(0)
    expect(restored.restoredAttachmentBytes).toBe(attachment.bytes.byteLength)
    expect(bucket.objects.get(attachment.objectKey)).toEqual(attachment.bytes)
    expect(bucket.objects.has('mail/other/forged.pdf')).toBe(false)

    sqlite.prepare('DELETE FROM email_attachments WHERE user_id = ?').run(userId)
    const missing = await applyBackupEmail(env, userId, { bundle, attachments: new Map() })
    expect(missing.createdAttachments).toBe(1)
    expect(missing.missingAttachments).toBe(1)
    expect(restored.restoredAttachmentBytes).toBe(attachment.bytes.byteLength)
  })

  it('rejects an attachment entry that the bundle does not declare', async () => {
    await setupAccount()
    const messageId = newId()
    seedMessage(messageId)
    const result = await readBackupEmail(env, userId, { includeAttachments: false, snapshot: STAMP })
    const bundle = await readEmailBundle(result)
    await expect(applyBackupEmail(env, userId, {
      bundle,
      attachments: new Map([['email-attachments/elsewhere/file.pdf', new Uint8Array([1])]]),
    })).rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })

  it('refuses to write an account owned by another user', async () => {
    accountId = (await createEmailAccount(db, {
      userId: OTHER,
      address: 'other@example.com',
      displayName: 'Other',
    })).id
    const bundle: EmailBackupBundle = {
      format: EMAIL_BACKUP_FORMAT,
      version: EMAIL_BACKUP_VERSION,
      exportedAt: new Date(NOW).toISOString(),
      snapshot: STAMP,
      includesAttachments: false,
      accounts: [{
        id: accountId,
        address: 'other@example.com',
        displayName: 'Other',
        settings: {},
        createdAt: NOW,
        updatedAt: NOW,
        folders: [{ id: 'inbox', name: 'Inbox', isDeletable: false, createdAt: NOW }],
        messages: [],
      }],
    }
    await expect(applyBackupEmail(env, userId, { bundle, attachments: new Map() }))
      .rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })
})

describe('email export route', () => {
  it('refuses to restore a mailbox for a member', async () => {
    await setupAccount()
    seedMessage(newId())
    const result = await readBackupEmail(env, userId, { includeAttachments: false, snapshot: STAMP })
    const bundle = await readEmailBundle(result)
    userRole = 'member'
    sqlite.prepare('UPDATE users SET role = ? WHERE id = ?').run('member', userId)
    await expect(applyBackupEmail(env, userId, { bundle, attachments: new Map() }))
      .rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('hides another account and rejects members', async () => {
    await setupAccount()
    userId = OTHER
    const other = await emailApp().request(`/api/email/accounts/${accountId}/export`, {}, env)
    expect(other.status).toBe(404)
    expect((await other.json() as { error: { code: string } }).error.code).toBe('email_account_not_found')

    userId = USER
    userRole = 'member'
    const member = await emailApp().request(`/api/email/accounts/${accountId}/export`, {}, env)
    expect(member.status).toBe(403)
  })
})

describe('transfer integration', () => {
  it('rejects a file that is not listed in the email bundle', async () => {
    await setupAccount()
    const messageId = newId()
    seedMessage(messageId)
    const result = await readBackupEmail(env, userId, { includeAttachments: false, snapshot: STAMP })
    const emailBytes = await readFile(result.file!)
    const manifest = manifestFor(emailBytes, false)
    const form = new FormData()
    form.append('backupManifest', JSON.stringify(manifest))
    form.append('backupPaths', JSON.stringify([manifest.email!.path, 'email-attachments/extra.bin']))
    form.append('file', new File([emailBytes], 'email.json'))
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'extra.bin'))
    const response = await transferApp().request('/transfer/import', { method: 'POST', body: form }, env)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: 'The file is not listed in the backup manifest: email-attachments/extra.bin' },
    })
  })
})

describe('client restore selection', () => {
  it('sends the email archive and declared attachment files in one batch', async () => {
    await setupAccount()
    const messageId = newId()
    seedMessage(messageId)
    const attachment = seedAttachment({ emailId: messageId })
    const result = await readBackupEmail(env, userId, { includeAttachments: true, snapshot: STAMP })
    const emailBytes = await readFile(result.file!)
    const manifest = manifestFor(emailBytes, true)
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
    const completeBytes = new TextEncoder().encode(backupCompleteBody(sha(manifestBytes)))
    const sends: Array<{ paths: string[]; manifest: MarkdownBackupManifest }> = []
    const files = [
      fileOf('manifest.json', manifestBytes),
      fileOf('COMPLETE', completeBytes),
      fileOf(manifest.email!.path, emailBytes),
      fileOf(attachment.path, await readFile(result.attachments[0]!)),
    ]
    const output = await restoreMarkdownBackupFolder(files, async (batch, sentManifest, paths) => {
      sends.push({ manifest: sentManifest, paths })
      expect(batch).toHaveLength(2)
      return emptyImportResult()
    })
    expect(output.warnings).toEqual([])
    expect(sends).toHaveLength(1)
    expect(sends[0]!.paths).toEqual([manifest.email!.path, attachment.path])
    expect(sends[0]!.manifest.email).toEqual(manifest.email)
  })

  it('rejects an email file whose bundle does not match the manifest', async () => {
    const manifest = manifestFor(new TextEncoder().encode('{}'), false)
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
    const completeBytes = new TextEncoder().encode(backupCompleteBody(sha(manifestBytes)))
    const emailBytes = new TextEncoder().encode(JSON.stringify({ format: 'other' }))
    const files = [
      fileOf('manifest.json', manifestBytes),
      fileOf('COMPLETE', completeBytes),
      fileOf(manifest.email!.path, emailBytes),
    ]
    await expect(restoreMarkdownBackupFolder(files, async () => emptyImportResult()))
      .rejects.toThrow()
  })
})

describe('settings persistence', () => {
  it('keeps a saved email backup group instead of dropping it', () => {
    const merged = mergeSettingsPatch({}, { emailBackup: { enabled: false, includeAttachments: true } })
    expect(merged.emailBackup).toEqual({ enabled: false, includeAttachments: true })
  })
})
