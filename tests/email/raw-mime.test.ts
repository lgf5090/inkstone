// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMAIL_INBOUND_MAX_BYTES } from '../../src/shared/email/model'
import { createEmailAccount } from '../../src/worker/email/account-store'
import {
  deleteEmailRawMimeForMessage,
  deleteEmailRawMimesForAccount,
  deleteEmailRawMimesForMessages,
  getEmailRawMimeMetadata,
  readEmailRawMime,
  saveEmailRawMime,
} from '../../src/worker/email/raw-mime'
import { drainAttachmentCleanup } from '../../src/worker/attachments/cleanup'
import { newId } from '../../src/worker/lib/id'
import type { Env } from '../../src/worker/env'
import { testBindings, testR2Bucket, type TestR2Bucket } from '../doubles/bindings'
import { seedUser, testDatabase, type TestDatabase } from '../fixtures/email/harness'

const OWNER = 'owner-user'
const OTHER = 'other-user'
const NOW = 1_700_000_000_000

let database: TestDatabase
let bucket: TestR2Bucket
let env: Env
let accountId: string
let otherAccountId: string

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function save(messageId: string, bytes = new TextEncoder().encode('Subject: original\r\n\r\nbody')) {
  return saveEmailRawMime(env, { userId: OWNER, accountId, messageId, receivedAt: NOW, bytes })
}

beforeEach(async () => {
  database = testDatabase()
  seedUser(database.sqlite, OWNER, 'owner')
  seedUser(database.sqlite, OTHER, 'owner')
  bucket = testR2Bucket()
  env = testBindings(database.db, { FILES: bucket })
  accountId = (await createEmailAccount(database.db, {
    userId: OWNER, address: 'owner@example.com', displayName: 'Owner',
  })).id
  otherAccountId = (await createEmailAccount(database.db, {
    userId: OWNER, address: 'other@example.com', displayName: 'Other',
  })).id
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('email raw MIME storage', () => {
  it('stores and reads the exact bytes with owner and account scoping', async () => {
    const messageId = newId()
    const bytes = new Uint8Array([0x53, 0x75, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x3a, 0x20, 0x78, 0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0xff])
    const row = await save(messageId, bytes)

    expect(row).toMatchObject({
      message_id: messageId,
      user_id: OWNER,
      account_id: accountId,
      size: bytes.byteLength,
      sha256: hash(bytes),
      created_at: NOW,
    })
    expect(row.object_key).toMatch(/^mail\/raw\/[0-9a-z]{26}\.eml$/)
    expect(bucket.objects.get(row.object_key)).toEqual(bytes)
    expect(await readEmailRawMime(env, row)).toEqual(bytes)
    expect(await getEmailRawMimeMetadata(database.db, OTHER, accountId, messageId)).toBeNull()
    expect(await getEmailRawMimeMetadata(database.db, OWNER, otherAccountId, messageId)).toBeNull()
  })

  it('throws instead of degrading when storage is missing or a write fails', async () => {
    const messageId = newId()
    const unbound = testBindings(database.db)
    await expect(saveEmailRawMime(unbound, {
      userId: OWNER, accountId, messageId, receivedAt: NOW, bytes: new Uint8Array([1]),
    })).rejects.toThrow('storage is not configured')

    vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('R2 unavailable'))
    await expect(save(messageId)).rejects.toThrow('R2 unavailable')
    expect(await getEmailRawMimeMetadata(database.db, OWNER, accountId, messageId)).toBeNull()

    await expect(save(newId(), new Uint8Array(EMAIL_INBOUND_MAX_BYTES + 1)))
      .rejects.toThrow('exceeds')
  })

  it('detects changed object size and checksum', async () => {
    const row = await save(newId())
    bucket.objects.set(row.object_key, new Uint8Array(row.size + 1))
    await expect(readEmailRawMime(env, row)).rejects.toThrow('size changed')
    bucket.objects.set(row.object_key, new Uint8Array(row.size).fill(1))
    await expect(readEmailRawMime(env, row)).rejects.toThrow('checksum failed')
  })

  it('deletes message objects and metadata without crossing accounts', async () => {
    const first = await save(newId())
    const second = await save(newId())
    const foreign = await saveEmailRawMime(env, {
      userId: OWNER, accountId: otherAccountId, messageId: newId(), receivedAt: NOW, bytes: new Uint8Array([2]),
    })

    expect(await deleteEmailRawMimeForMessage(env, OWNER, otherAccountId, first.message_id))
      .toEqual({ messages: 0, cleanupPending: false })
    expect(bucket.objects.has(first.object_key)).toBe(true)
    expect(await deleteEmailRawMimesForMessages(env, OWNER, [first.message_id, second.message_id]))
      .toEqual({ messages: 2, cleanupPending: false })
    expect(bucket.objects.has(first.object_key)).toBe(false)
    expect(bucket.objects.has(second.object_key)).toBe(false)
    expect(bucket.objects.has(foreign.object_key)).toBe(true)
    expect(await getEmailRawMimeMetadata(database.db, OWNER, accountId, first.message_id)).toBeNull()
  })

  it('queues failed R2 cleanup and drains it through the existing queue', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const row = await save(newId())
    vi.spyOn(bucket, 'delete').mockRejectedValueOnce(new Error('R2 unavailable'))

    expect(await deleteEmailRawMimesForMessages(env, OWNER, [row.message_id]))
      .toEqual({ messages: 1, cleanupPending: true })
    expect(await getEmailRawMimeMetadata(database.db, OWNER, accountId, row.message_id)).toBeNull()
    expect(bucket.objects.has(row.object_key)).toBe(true)
    expect(await drainAttachmentCleanup(env, OWNER)).toEqual({ processed: 1, pending: false })
    expect(bucket.objects.has(row.object_key)).toBe(false)
  })

  it('cleans every raw object and row for an account', async () => {
    const first = await save(newId())
    const second = await save(newId())
    const foreign = await saveEmailRawMime(env, {
      userId: OWNER, accountId: otherAccountId, messageId: newId(), receivedAt: NOW, bytes: new Uint8Array([3]),
    })

    expect(await deleteEmailRawMimesForAccount(env, OWNER, accountId))
      .toEqual({ messages: 2, cleanupPending: false })
    expect(bucket.objects.has(first.object_key)).toBe(false)
    expect(bucket.objects.has(second.object_key)).toBe(false)
    expect(bucket.objects.has(foreign.object_key)).toBe(true)
    expect(await getEmailRawMimeMetadata(database.db, OWNER, accountId, first.message_id)).toBeNull()
  })
})
