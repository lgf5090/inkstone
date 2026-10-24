// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_FOLLOW_UP_MAX_MS } from '../../src/shared/email/model'
import { emailSearchParams, parseEmailSearchQuery } from '../../src/shared/email/search'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../src/worker/email/mailbox-store'
import { makeSqlExec } from '../doubles/do-sqlite'

let sqlite: DatabaseSync
let store: MailboxStore

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  const sql = makeSqlExec(sqlite)
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
})

function seed(
  id: string,
  overrides: { threadId?: string; folder?: string; read?: boolean; focused?: boolean; sender?: string } = {},
): void {
  expect(store.createEmail(overrides.folder ?? 'inbox', {
    id,
    subject: `Subject ${id}`,
    sender: overrides.sender ?? 'sender@example.com',
    recipient: 'me@example.com',
    date: Date.now(),
    body: '<p>Hello</p>',
    read: overrides.read ?? true,
    threadId: overrides.threadId,
    focused: overrides.focused,
  })).toBe(true)
}

describe('email search flag operators', () => {
  it('reads is:important, is:muted, is:followup, is:focused and is:other', () => {
    expect(parseEmailSearchQuery('is:important budget')).toEqual({ query: 'budget', important: true })
    expect(parseEmailSearchQuery('IS:MUTED')).toEqual({ query: '', muted: true })
    expect(parseEmailSearchQuery('is:followup')).toEqual({ query: '', followUp: true })
    expect(parseEmailSearchQuery('is:focused')).toEqual({ query: '', focused: true })
    expect(parseEmailSearchQuery('is:other')).toEqual({ query: '', focused: false })
  })

  it('serializes the flag filters as query parameters', () => {
    expect(emailSearchParams({ query: '', important: true })).toEqual({ is_important: 'true' })
    expect(emailSearchParams({ query: '', muted: false })).toEqual({ is_muted: 'false' })
    expect(emailSearchParams({ query: '', followUp: true })).toEqual({ is_followup: 'true' })
    expect(emailSearchParams({ query: '', focused: false })).toEqual({ is_focused: 'false' })
  })
})

describe('email message flags', () => {
  it('updates important and muted and keeps the rows listed by default', () => {
    seed('a')
    seed('b')
    expect(store.updateEmail('a', { important: true })?.important).toBe(1)
    expect(store.updateEmail('b', { muted: true })?.muted).toBe(1)

    expect(store.getEmails({ folder: 'inbox' }).map((row) => row.id).sort()).toEqual(['a', 'b'])
    expect(store.getEmails({ folder: 'inbox', important: true }).map((row) => row.id)).toEqual(['a'])
    expect(store.getEmails({ folder: 'inbox', muted: true }).map((row) => row.id)).toEqual(['b'])
    expect(store.countEmails({ folder: 'inbox', important: true })).toBe(1)
    expect(store.countEmails({ folder: 'inbox', muted: false })).toBe(1)
    expect(store.searchEmails({ important: true }).map((row) => row.id)).toEqual(['a'])
    expect(store.searchEmails({ muted: true }).map((row) => row.id)).toEqual(['b'])
    expect(store.searchEmails({ followUp: false }).map((row) => row.id).sort()).toEqual(['a', 'b'])
    expect(store.countSearchResults({ important: true })).toBe(1)
    expect(store.searchEmails({ important: false }).map((row) => row.id)).toEqual(['b'])
  })

  it('returns the row unchanged when a patch carries no flags', () => {
    seed('a')
    expect(store.updateEmail('a', {})?.id).toBe('a')
    expect(store.updateEmail('missing', { important: true })).toBeNull()
  })
})

describe('email focused inbox storage', () => {
  it('defaults new messages to focused and filters lists, counts and search', () => {
    seed('focused')
    seed('other', { focused: false })

    expect(store.getEmail('focused')?.focused).toBe(1)
    expect(store.getEmail('other')?.focused).toBe(0)
    expect(store.getEmails({ folder: 'inbox' }).map((row) => row.id).sort()).toEqual(['focused', 'other'])
    expect(store.getEmails({ folder: 'inbox', focused: false }).map((row) => row.id)).toEqual(['other'])
    expect(store.getEmails({ folder: 'inbox', focused: true }).map((row) => row.id)).toEqual(['focused'])
    expect(store.countEmails({ folder: 'inbox', focused: false })).toBe(1)
    expect(store.countEmails({ folder: 'inbox' })).toBe(2)
    expect(store.searchEmails({ focused: false }).map((row) => row.id)).toEqual(['other'])
    expect(store.searchEmails({ focused: true }).map((row) => row.id)).toEqual(['focused'])
    expect(store.countSearchResults({ focused: false })).toBe(1)

    const threaded = store.getThreadedEmails({ folder: 'inbox' })
    expect(threaded.map((row) => [row.id, row.focused]).sort()).toEqual([['focused', 1], ['other', 0]])
  })

  it('recognizes existing threads and prior senders', () => {
    expect(store.hasThread('t1')).toBe(false)
    expect(store.hasSenderHistory('alice@example.com')).toBe(false)
    seed('reply', { threadId: 't1', sender: 'Alice <alice@example.com>' })
    expect(store.hasThread('t1')).toBe(true)
    expect(store.hasSenderHistory('ALICE@example.com')).toBe(true)
    expect(store.hasSenderHistory('bob@example.com')).toBe(false)
    expect(store.hasSenderHistory('')).toBe(false)
  })
})

describe('email follow-up', () => {
  it('marks a scheduled message important and clears the reminder', () => {
    seed('a')
    const at = Date.now() + 2 * DAY_MS
    expect(store.setFollowUp('a', at)).toMatchObject({ follow_up_at: at, important: 1 })
    expect(store.setFollowUp('a', null)).toMatchObject({ follow_up_at: null, important: 1 })
  })

  it('rejects past times, times beyond a year and missing rows', () => {
    seed('a')
    const now = Date.now()
    expect(store.setFollowUp('a', now - MINUTE_MS)).toBeNull()
    expect(store.setFollowUp('a', now + EMAIL_FOLLOW_UP_MAX_MS + DAY_MS)).toBeNull()
    expect(store.setFollowUp('missing', now + DAY_MS)).toBeNull()
    expect(store.getEmail('a')?.follow_up_at).toBeNull()
  })

  it('wakes only due reminders and makes them unread and important', () => {
    const now = Date.now()
    seed('due-first', { read: true })
    seed('due-second', { read: true })
    seed('future', { read: true })
    seed('trashed', { read: true })
    store.setFollowUp('due-first', now + MINUTE_MS)
    store.setFollowUp('due-second', now + 3 * MINUTE_MS)
    store.setFollowUp('future', now + DAY_MS)
    store.setFollowUp('trashed', now + MINUTE_MS)
    store.trashEmail('trashed')

    expect(store.wakeFollowUps(now + 4 * MINUTE_MS)).toEqual(['due-first', 'due-second'])
    expect(store.getEmail('due-first')).toMatchObject({ follow_up_at: null, important: 1, read: 0 })
    expect(store.getEmail('due-second')).toMatchObject({ follow_up_at: null, important: 1, read: 0 })
    expect(store.getEmail('future')?.follow_up_at).toBe(now + DAY_MS)
    expect(store.listTrash()[0]?.follow_up_at).toBe(now + MINUTE_MS)
    expect(store.wakeFollowUps(now + 4 * MINUTE_MS)).toEqual([])

    store.setFollowUp('due-first', now + 10 * MINUTE_MS)
    store.setFollowUp('due-second', now + 20 * MINUTE_MS)
    expect(store.wakeFollowUps(now + 30 * MINUTE_MS, 1)).toEqual(['due-first'])
    expect(store.getEmail('due-second')?.follow_up_at).toBe(now + 20 * MINUTE_MS)
  })
})

describe('thread mute', () => {
  it('mutes and unmutes every row in the thread, including trashed and snoozed rows', () => {
    seed('m1', { threadId: 't1' })
    seed('m2', { threadId: 't1' })
    seed('m3', { threadId: 't2' })
    seed('m4')
    const snoozedUntil = Date.now() + 60 * MINUTE_MS
    expect(store.snoozeEmail('m1', snoozedUntil)).not.toBeNull()
    store.trashEmail('m2')

    expect(store.muteThread('t1', true)).toBe(2)
    expect(store.listTrash().find((row) => row.id === 'm2')?.muted).toBe(1)
    expect(sqlite.prepare(`SELECT muted, snoozed_until FROM email_messages WHERE id = 'm1'`).get())
      .toEqual({ muted: 1, snoozed_until: snoozedUntil })
    expect(sqlite.prepare(`SELECT muted FROM email_messages WHERE id = 'm3'`).get()).toEqual({ muted: 0 })
    expect(sqlite.prepare(`SELECT muted FROM email_messages WHERE id = 'm4'`).get()).toEqual({ muted: 0 })

    expect(store.muteThread('t1', false)).toBe(2)
    expect(store.searchEmails({ muted: true })).toEqual([])
    expect(store.muteThread('missing', true)).toBe(0)
  })
})
