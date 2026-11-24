import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_BATCH_ACTIONS } from '../../src/shared/email/model'
import { applyMailboxMigrations, type SqlExec } from '../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../src/worker/email/mailbox-store'
import { makeSqlExec } from '../doubles/do-sqlite'

const PLATFORM_MAX_BIND_PARAMS = 100
const PLATFORM_MAX_LIKE_BYTES = 50
const MAX_IDS_PER_QUERY = 90

interface SqlCall {
  query: string
  bindings: unknown[]
  inTransaction: boolean
}

let sqlite: DatabaseSync
let sql: SqlExec
let store: MailboxStore
let sqlCalls: SqlCall[]
let transactionDepth: number
let transactionCalls: number
let updateCalls: number
let failUpdateCall: number | null

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlCalls = []
  transactionDepth = 0
  transactionCalls = 0
  updateCalls = 0
  failUpdateCall = null
  const base = makeSqlExec(sqlite)
  sql = {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T> {
      sqlCalls.push({ query, bindings, inTransaction: transactionDepth > 0 })
      if (bindings.length > PLATFORM_MAX_BIND_PARAMS) {
        throw new Error(`SQLite accepts at most ${PLATFORM_MAX_BIND_PARAMS} bind parameters`)
      }
      if (/\bLIKE\b/i.test(query)) {
        for (const binding of bindings) {
          if (typeof binding !== 'string' || !binding.startsWith('%') || !binding.endsWith('%')) continue
          if (new TextEncoder().encode(binding).byteLength > PLATFORM_MAX_LIKE_BYTES) {
            throw new Error(`SQLite LIKE patterns are limited to ${PLATFORM_MAX_LIKE_BYTES} UTF-8 bytes`)
          }
        }
      }
      if (/^\s*UPDATE email_messages\b/i.test(query) && ++updateCalls === failUpdateCall) {
        throw new Error('Injected update failure')
      }
      return base.exec<T>(query, ...bindings)
    },
  }
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
})

function resetSqlCalls(): void {
  sqlCalls = []
  transactionCalls = 0
  updateCalls = 0
}

function messageIds(): string[] {
  return Array.from({ length: 100 }, (_, index) => `m${String(index).padStart(3, '0')}`)
}

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

  it.each(['query', 'from', 'to', 'subject'] as const)(
    'returns no results when the %s LIKE pattern exceeds the UTF-8 byte limit',
    (field) => {
      const term = 'x'.repeat(PLATFORM_MAX_LIKE_BYTES - 1)
      store.createEmail('inbox', message('match', {
        subject: term,
        sender: term,
        recipient: term,
        cc: term,
        bcc: term,
      }))
      const options = { [field]: term }

      expect(store.searchEmails(options)).toEqual([])
      expect(store.countSearchResults(options)).toBe(0)
      expect(sqlCalls.some((call) => /\bLIKE\b/i.test(call.query))).toBe(false)
    },
  )

  it('counts wildcard escapes and multibyte characters toward the LIKE byte limit', () => {
    store.createEmail('inbox', message('ascii', { subject: 'x'.repeat(48) }))
    store.createEmail('inbox', message('unicode', { subject: 'é'.repeat(24) }))
    store.createEmail('inbox', message('escaped', { subject: '%'.repeat(24) }))

    for (const [id, term] of [
      ['ascii', 'x'.repeat(48)],
      ['unicode', 'é'.repeat(24)],
      ['escaped', '%'.repeat(24)],
    ] as const) {
      const escaped = term.replace(/[\\%_]/g, (char) => `\\${char}`)
      expect(new TextEncoder().encode(`%${escaped}%`).byteLength).toBe(PLATFORM_MAX_LIKE_BYTES)
      expect(store.searchEmails({ query: term }).map((row) => row.id)).toEqual([id])
      expect(store.countSearchResults({ query: term })).toBe(1)
    }

    expect(store.searchEmails({ query: 'é'.repeat(25) })).toEqual([])
    expect(store.countSearchResults({ query: 'é'.repeat(25) })).toBe(0)
    expect(store.searchEmails({ query: '%'.repeat(25) })).toEqual([])
    expect(store.countSearchResults({ query: '%'.repeat(25) })).toBe(0)
  })

  it('stores drafts as read and keeps them out of the unread count', () => {
    const draftId = store.saveDraft(null, message('d1', { read: false }))
    expect(draftId).toBe('d1')
    expect(store.getEmail('d1')?.read).toBe(1)
    const stats = store.mailboxStats()
    expect(stats.draft).toBe(1)
    expect(stats.unread).toBe(0)
    store.saveDraft('d1', message('d1', { read: false }))
    expect(store.getEmail('d1')?.read).toBe(1)
  })

  it('refuses to revive a sent or deleted draft through a late save', () => {
    const sentId = store.saveDraft(null, message('sent-draft'))!
    sqlite.prepare("UPDATE email_messages SET folder_id = 'sent' WHERE id = ?").run(sentId)
    expect(store.saveDraftChecked(sentId, message('sent-draft', { body: 'Late edit' }))).toEqual({ ok: false, reason: 'failed' })
    expect(store.getEmail(sentId)?.folder_id).toBe('sent')

    const deletedId = store.saveDraft(null, message('deleted-draft'))!
    store.trashEmail(deletedId)
    expect(store.saveDraftChecked(deletedId, message('deleted-draft', { body: 'Late edit' }))).toEqual({ ok: false, reason: 'failed' })
    expect(store.getEmail(deletedId)).toBeNull()
  })

  it('counts every listable message per folder, including read and trashed rows', () => {
    store.createEmail('inbox', message('read', { read: true }))
    store.createEmail('inbox', message('unread', { read: false }))
    store.createEmail('inbox', message('snoozed', { read: true }))
    store.saveDraft(null, message('draft', { read: false }))
    expect(store.snoozeEmail('snoozed', Date.now() + 60_000)).not.toBeNull()

    const folders = new Map(store.getFolders().map((folder) => [folder.id, folder]))
    expect(folders.get('inbox')).toMatchObject({ unread_count: 1, total_count: 2 })
    expect(folders.get('draft')).toMatchObject({ total_count: 1 })

    expect(store.trashEmail('read')).toBe('inbox')
    const trashed = new Map(store.getFolders().map((folder) => [folder.id, folder]))
    expect(trashed.get('inbox')).toMatchObject({ unread_count: 1, total_count: 1 })
    expect(trashed.get('trash')).toMatchObject({ total_count: 1 })
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

  it('applies batch flags, moves, archives, trashes and restores', () => {
    store.createEmail('inbox', message('m1'))
    store.createEmail('inbox', message('m2'))

    expect(store.batchUpdate(['m1', 'm2', 'm1'], 'read')).toEqual({ updated: 2 })
    expect(store.getEmail('m1')?.read).toBe(1)
    expect(store.getEmail('m2')?.read).toBe(1)

    expect(store.batchUpdate(['m1', 'm2'], 'unread')).toEqual({ updated: 2 })
    expect(store.getEmail('m1')?.read).toBe(0)
    expect(store.getEmail('m2')?.read).toBe(0)

    expect(store.batchUpdate(['m1', 'm2'], 'star')).toEqual({ updated: 2 })
    expect(store.getEmail('m1')?.starred).toBe(1)
    expect(store.batchUpdate(['m1', 'm2'], 'unstar')).toEqual({ updated: 2 })
    expect(store.getEmail('m2')?.starred).toBe(0)

    expect(store.batchUpdate(['m1', 'm2'], 'move', 'archive')).toEqual({ updated: 2 })
    expect(store.getEmail('m1')?.folder_id).toBe('archive')
    expect(store.batchUpdate(['m1', 'm2'], 'archive')).toEqual({ updated: 2 })
    expect(store.getEmail('m2')?.folder_id).toBe('archive')

    expect(store.batchUpdate(['m1', 'm2'], 'trash')).toEqual({ updated: 2 })
    expect(store.getEmail('m1')).toBeNull()
    expect(store.listTrash().map((row) => row.id).sort()).toEqual(['m1', 'm2'])
    expect(store.batchUpdate(['m1', 'm2'], 'trash')).toEqual({ updated: 0 })

    expect(store.batchUpdate(['m1', 'm2'], 'restore')).toEqual({ updated: 2 })
    expect(store.getEmail('m1')?.folder_id).toBe('inbox')
    expect(store.getEmail('m2')?.deleted_at).toBeNull()
    expect(store.batchUpdate(['m1', 'm2'], 'restore')).toEqual({ updated: 0 })

    expect(store.batchUpdate(['m1'], 'move', 'trash')).toEqual({ updated: 1 })
    expect(store.getEmail('m1')).toBeNull()
    expect(store.getEmail('m2')?.folder_id).toBe('inbox')
  })

  it.each(EMAIL_BATCH_ACTIONS)('chunks every %s query and update to at most 90 ids', (action) => {
    const ids = messageIds()
    for (const id of ids) store.createEmail('inbox', message(id))
    if (action === 'restore') {
      for (const id of ids) expect(store.trashEmail(id)).toBe('inbox')
    }
    resetSqlCalls()

    expect(store.batchUpdate(ids, action, action === 'move' ? 'archive' : undefined)).toEqual({ updated: 100 })

    const inQueries = sqlCalls.filter((call) => /\bIN\s*\(/.test(call.query))
    const selects = inQueries.filter((call) => /^\s*SELECT\b/i.test(call.query))
    const updates = inQueries.filter((call) => /^\s*UPDATE\b/i.test(call.query))
    expect(selects).toHaveLength(2)
    expect(updates).toHaveLength(2)
    for (const call of inQueries) {
      expect(call.bindings.filter((binding) => typeof binding === 'string' && /^m\d{3}$/.test(binding)).length)
        .toBeLessThanOrEqual(MAX_IDS_PER_QUERY)
    }
    expect(selects.map((call) => call.bindings.length)).toEqual([90, 10])
    expect(updates.map((call) => call.bindings.filter((binding) => typeof binding === 'string' && /^m\d{3}$/.test(binding)).length))
      .toEqual([90, 10])
  })

  it('runs all batch chunks in one transaction and rolls them back together', () => {
    const ids = messageIds()
    for (const id of ids) store.createEmail('inbox', message(id))
    store = new MailboxStore(sql, {
      transactionSync<T>(closure: () => T): T {
        transactionCalls += 1
        transactionDepth += 1
        sqlite.exec('BEGIN')
        try {
          const result = closure()
          sqlite.exec('COMMIT')
          return result
        } catch (error) {
          sqlite.exec('ROLLBACK')
          throw error
        } finally {
          transactionDepth -= 1
        }
      },
    })
    resetSqlCalls()

    expect(store.batchUpdate(ids, 'read')).toEqual({ updated: 100 })
    expect(transactionCalls).toBe(1)
    expect(sqlCalls.every((call) => call.inTransaction)).toBe(true)

    resetSqlCalls()
    failUpdateCall = 2
    expect(() => store.batchUpdate(ids, 'unread')).toThrow('Injected update failure')
    expect(transactionCalls).toBe(1)
    expect(sqlCalls.every((call) => call.inTransaction)).toBe(true)
    expect(ids.every((id) => store.getEmail(id)?.read === 1)).toBe(true)
  })

  it('skips missing rows and rejects empty, oversized or invalid batches', () => {
    store.createEmail('inbox', message('m1'))
    expect(store.batchUpdate(['m1', 'missing'], 'read')).toEqual({ updated: 1 })
    expect(store.batchUpdate([], 'read')).toEqual({ updated: 0 })
    expect(store.batchUpdate(['m1'], 'move', 'missing')).toEqual({ updated: 0 })
    const tooMany = Array.from({ length: 101 }, (_, index) => `m${index}`)
    expect(store.batchUpdate(tooMany, 'read')).toEqual({ updated: 0 })
    expect(store.getEmail('m1')?.read).toBe(1)
  })
})
