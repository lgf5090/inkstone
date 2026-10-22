import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../src/worker/email/mailbox-store'
import { makeSqlExec } from '../doubles/do-sqlite'

let sqlite: DatabaseSync
let store: MailboxStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  const sql = makeSqlExec(sqlite)
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
})

function message(id: string, overrides: Partial<Parameters<MailboxStore['createEmail']>[1]> = {}) {
  return {
    id,
    subject: overrides.subject ?? 'Subject',
    sender: overrides.sender ?? 'sender@example.com',
    recipient: overrides.recipient ?? 'me@example.com',
    date: overrides.date ?? Date.now(),
    body: overrides.body ?? '<p>Hello</p>',
    ...overrides,
  }
}

describe('mailbox store', () => {
  it('seeds system folders and creates custom folders', () => {
    const folders = store.getFolders()
    expect(folders.map((folder) => folder.id)).toEqual(['inbox', 'sent', 'draft', 'archive', 'trash', 'spam'])
    const custom = store.createFolder('Projects')
    expect(custom?.name).toBe('Projects')
    expect(store.createFolder('projects')).toBeNull()
    expect(store.updateFolder(custom!.id, { name: 'Work' })?.name).toBe('Work')
  })

  it('creates, lists, reads and searches messages', () => {
    expect(store.createEmail('inbox', message('m1', { subject: 'Invoice 42', hasAttachment: true }))).toBe(true)
    expect(store.createEmail('inbox', message('m2', { subject: 'Hello', body: 'plain' }))).toBe(true)
    expect(store.countEmails({ folder: 'inbox' })).toBe(2)
    expect(store.getEmail('m1')?.subject).toBe('Invoice 42')
    expect(store.searchEmails({ query: 'Invoice' }).map((row) => row.id)).toEqual(['m1'])
    expect(store.searchEmails({ hasAttachment: true }).map((row) => row.id)).toEqual(['m1'])
    expect(store.searchEmails({ query: '%' })).toEqual([])
  })

  it('marks threads read and aggregates them', () => {
    store.createEmail('inbox', message('m1', { threadId: 't1', date: 1 }))
    store.createEmail('inbox', message('m2', { threadId: 't1', date: 2 }))
    const threads = store.getThreadedEmails({ folder: 'inbox' })
    expect(threads).toHaveLength(1)
    expect(Number(threads[0]!.thread_count)).toBe(2)
    store.markThreadRead('t1')
    expect(store.getThreadEmails('t1').every((row) => row.read === 1)).toBe(true)
  })

  it('soft-deletes, restores and purges trash', () => {
    store.createEmail('inbox', message('m1'))
    expect(store.trashEmail('m1')).toBe('inbox')
    expect(store.getEmail('m1')).toBeNull()
    expect(store.listTrash()).toHaveLength(1)
    expect(store.restoreEmail('m1')).toBe(true)
    expect(store.getEmail('m1')?.folder_id).toBe('inbox')
    store.trashEmail('m1')
    expect(store.emptyTrash()).toEqual(['m1'])
    expect(store.countTrash()).toBe(0)
  })

  it('keeps trashed messages out of lists and restores them to the inbox', () => {
    store.createEmail('inbox', message('m1', { body: 'x'.repeat(400), date: 2_000 }))
    store.createEmail('inbox', message('m2', { date: 1_000 }))
    const listed = store.getEmails({ folder: 'inbox' })
    expect(listed.map((row) => row.id)).toEqual(['m1', 'm2'])
    expect((listed[0] as typeof listed[number] & { snippet?: string }).snippet).toHaveLength(300)
    expect(store.trashEmail('m2')).toBe('inbox')
    expect(store.getEmails({ folder: 'inbox' }).map((row) => row.id)).toEqual(['m1'])
    expect(store.countEmails({ folder: 'inbox' })).toBe(1)
    expect(store.listTrash().map((row) => row.id)).toEqual(['m2'])
    expect(store.restoreEmail('m1')).toBe(false)
    expect(store.restoreEmail('m2')).toBe(true)
    expect(store.getEmail('m2')?.folder_id).toBe('inbox')
  })

  it('deletes a custom folder by moving its messages or deleting them', () => {
    const moved = store.createFolder('Projects')!
    store.createEmail(moved.id, message('m1'))
    const deleted = store.createFolder('Temporary')!
    store.createEmail(deleted.id, message('m2'))
    store.createEmail('inbox', message('m3'))

    expect(store.deleteFolder('inbox')).toBeNull()
    expect(store.deleteFolder(moved.id)).toEqual({ deletedMessageIds: [] })
    expect(store.getEmail('m1')?.folder_id).toBe('inbox')
    expect(store.getFolders().some((folder) => folder.id === moved.id)).toBe(false)

    expect(store.deleteFolder(deleted.id, true)).toEqual({ deletedMessageIds: ['m2'] })
    expect(store.getEmail('m2')).toBeNull()
    expect(store.getEmail('m3')).not.toBeNull()
  })

  it('refuses to move a message that is not there and clears its deleted marker on a move', () => {
    store.createEmail('inbox', message('m1'))
    expect(store.moveEmail('missing', 'archive')).toBe(false)
    expect(store.moveEmail('m1', 'missing')).toBe(false)
    expect(store.moveEmail('m1', 'archive')).toBe(true)
    expect(store.getEmail('m1')?.folder_id).toBe('archive')
    expect(store.deleteEmail('m1')).toBe(true)
    expect(store.deleteEmail('m1')).toBe(false)
  })

  it('claims inbound messages and operations idempotently', () => {
    const now = Date.now()
    expect(store.claimInbound('key', now)).toBe(true)
    expect(store.claimInbound('key', now + 1000)).toBe(false)
    store.completeInbound('key')
    expect(store.claimInbound('key', now + 2000)).toBe(false)
    expect(store.claimOperation('op', 'hash', 'm1').status).toBe('claimed')
    expect(store.claimOperation('op', 'hash', 'm2')).toEqual({ status: 'duplicate', messageId: 'm1' })
    expect(store.claimOperation('op', 'other', 'm3').status).toBe('conflict')
  })

  it('enforces the send rate limit', () => {
    for (let index = 0; index < 20; index++) {
      store.createEmail('sent', message(`s${index}`, { date: Date.now() }))
    }
    expect(store.checkSendRateLimit()).toContain('20 emails per hour')
  })
})
