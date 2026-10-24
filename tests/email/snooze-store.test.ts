// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_SNOOZE_MAX_MS } from '../../src/shared/email/model'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../src/worker/email/mailbox-store'
import { makeSqlExec } from '../doubles/do-sqlite'

let sqlite: DatabaseSync
let store: MailboxStore

const MINUTE_MS = 60 * 1000

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

describe('email snooze store', () => {
  it('hides snoozed messages from lists, counts, search, threads and folder unread counts', () => {
    store.createEmail('inbox', message('m1', { subject: 'Invoice', read: true }))
    store.createEmail('inbox', message('m2', { subject: 'Invoice later', read: false }))

    const until = Date.now() + 60 * MINUTE_MS
    expect(store.snoozeEmail('m1', until)?.snoozed_until).toBe(until)

    expect(store.getEmails({ folder: 'inbox' }).map((row) => row.id)).toEqual(['m2'])
    expect(store.countEmails({ folder: 'inbox' })).toBe(1)
    expect(store.getEmail('m1')?.id).toBe('m1')
    expect(store.searchEmails({ query: 'Invoice' }).map((row) => row.id)).toEqual(['m2'])
    expect(store.countSearchResults({ query: 'Invoice' })).toBe(1)
    expect(store.getFolders().find((folder) => folder.id === 'inbox')?.unread_count).toBe(1)

    const stats = store.mailboxStats()
    expect(stats.total).toBe(1)
    expect(stats.unread).toBe(1)
    expect(stats.folders.find((folder) => folder.folderId === 'inbox')).toMatchObject({ total: 1, unread: 1 })
  })

  it('keeps snoozed siblings out of threaded listings and counts', () => {
    store.createEmail('inbox', message('t1a', { threadId: 't1', date: 1_000 }))
    store.createEmail('inbox', message('t1b', { threadId: 't1', date: 2_000 }))

    expect(store.snoozeEmail('t1b', Date.now() + 60 * MINUTE_MS)).not.toBeNull()

    const rows = store.getThreadedEmails({ folder: 'inbox' })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.thread_count)).toBe(1)
    expect(store.countThreadedEmails('inbox')).toBe(1)
    expect(store.countEmails({ folder: 'inbox', threadId: 't1' })).toBe(1)
    expect(store.getThreadEmails('t1').map((row) => row.id)).toEqual(['t1a', 't1b'])
  })

  it('wakes due messages as unread and leaves future snoozes hidden', () => {
    const now = Date.now()
    store.createEmail('inbox', message('m1', { read: true }))
    store.createEmail('inbox', message('m2', { read: true }))
    expect(store.snoozeEmail('m1', now + MINUTE_MS)).not.toBeNull()
    expect(store.snoozeEmail('m2', now + 60 * MINUTE_MS)).not.toBeNull()

    expect(store.wakeSnoozed(now + 2 * MINUTE_MS)).toEqual(['m1'])
    expect(store.getEmail('m1')).toMatchObject({ snoozed_until: null, read: 0 })
    expect(store.getEmail('m2')?.snoozed_until).toBe(now + 60 * MINUTE_MS)
    expect(store.getEmails({ folder: 'inbox' }).map((row) => row.id)).toContain('m1')
    expect(store.getEmails({ folder: 'inbox' }).map((row) => row.id)).not.toContain('m2')
    expect(store.getFolders().find((folder) => folder.id === 'inbox')?.unread_count).toBe(1)
    expect(store.wakeSnoozed(now + 2 * MINUTE_MS)).toEqual([])
  })

  it('wakes at most the requested batch of due messages', () => {
    const until = Date.now() + MINUTE_MS
    for (const id of ['m1', 'm2', 'm3']) {
      store.createEmail('inbox', message(id, { date: Date.now() + Number(id.slice(1)) }))
      expect(store.snoozeEmail(id, until)).not.toBeNull()
    }

    expect(store.wakeSnoozed(until + 1, 2)).toHaveLength(2)
    expect(store.wakeSnoozed(until + 1, 2)).toEqual(['m3'])
    expect(store.wakeSnoozed(until + 1, 2)).toEqual([])
  })

  it('rejects invalid times and folders that cannot be snoozed', () => {
    const now = Date.now()
    const until = now + 60 * MINUTE_MS
    store.createEmail('inbox', message('inbox'))
    store.createEmail('draft', message('draft'))
    store.createEmail('sent', message('sent'))
    store.createEmail('spam', message('spam'))
    store.createEmail('trash', message('trash'))
    const custom = store.createFolder('Later')!
    store.createEmail(custom.id, message('custom'))

    expect(store.snoozeEmail('inbox', now - 1)).toBeNull()
    expect(store.snoozeEmail('inbox', now + EMAIL_SNOOZE_MAX_MS + MINUTE_MS)).toBeNull()
    expect(store.snoozeEmail('inbox', until)?.snoozed_until).toBe(until)
    expect(store.snoozeEmail('draft', until)).toBeNull()
    expect(store.snoozeEmail('sent', until)).toBeNull()
    expect(store.snoozeEmail('spam', until)).toBeNull()
    expect(store.snoozeEmail('trash', until)).toBeNull()
    expect(store.snoozeEmail('custom', until)?.snoozed_until).toBe(until)
    expect(store.snoozeEmail('missing', until)).toBeNull()
  })

  it('clears a pending snooze when the message is trashed', () => {
    const until = Date.now() + 60 * MINUTE_MS
    store.createEmail('inbox', message('m1'))
    expect(store.snoozeEmail('m1', until)).not.toBeNull()

    expect(store.trashEmail('m1')).toBe('inbox')
    const trashed = store.listTrash()
    expect(trashed.map((row) => row.id)).toEqual(['m1'])
    expect(trashed[0]!.snoozed_until).toBeNull()
    expect(store.wakeSnoozed(until + 1)).toEqual([])
  })
})
