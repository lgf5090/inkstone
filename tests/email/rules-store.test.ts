import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMAIL_INBOUND_MAX_BYTES } from '../../src/shared/email/model'
import {
  EMAIL_FILTER_MAX_RULES,
  parseEmailFilterInput,
  parseEmailFilterPatch,
  type EmailFilterInput,
} from '../../src/shared/email/rules'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore, type InboundRuleInput } from '../../src/worker/email/mailbox-store'
import { makeSqlExec } from '../doubles/do-sqlite'

let sqlite: DatabaseSync
let store: MailboxStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  const sql = makeSqlExec(sqlite)
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
})

function inbound(patch: Partial<InboundRuleInput> = {}): InboundRuleInput {
  return {
    sender: 'Alice <alice@example.com>',
    senderAddress: 'alice@example.com',
    recipient: 'me@example.com',
    cc: null,
    bcc: null,
    subject: 'Weekly digest',
    hasAttachment: false,
    size: 2048,
    ...patch,
  }
}

function createFilter(patch: Partial<EmailFilterInput> = {}) {
  const filter = store.createFilter({
    name: 'Digest',
    enabled: true,
    conditions: [{ field: 'subjectContains', value: 'digest' }],
    actions: [{ type: 'markRead' }],
    ...patch,
  })
  if (!filter) throw new Error('filter was not created')
  return filter
}

describe('email filter contracts', () => {
  it('accepts a full filter and rejects every shape outside the limits', () => {
    expect(parseEmailFilterInput({
      name: '  Invoices  ',
      enabled: false,
      conditions: [
        { field: 'fromContains', value: 'billing' },
        { field: 'toContains', value: 'me' },
        { field: 'subjectContains', value: 'invoice' },
        { field: 'hasAttachment', value: true },
        { field: 'minBytes', value: 1024 },
      ],
      actions: [
        { type: 'moveTo', folder: 'archive' },
        { type: 'addTag', tag: ' finance/invoices ' },
        { type: 'markRead' },
        { type: 'star' },
        { type: 'trash' },
      ],
    })).toEqual({
      name: 'Invoices',
      enabled: false,
      conditions: [
        { field: 'fromContains', value: 'billing' },
        { field: 'toContains', value: 'me' },
        { field: 'subjectContains', value: 'invoice' },
        { field: 'hasAttachment', value: true },
        { field: 'minBytes', value: 1024 },
      ],
      actions: [
        { type: 'moveTo', folder: 'archive' },
        { type: 'addTag', tag: 'finance/invoices' },
        { type: 'markRead' },
        { type: 'star' },
        { type: 'trash' },
      ],
    })

    const base = {
      name: 'Rule',
      conditions: [{ field: 'subjectContains', value: 'x' }],
      actions: [{ type: 'markRead' }],
    }
    const sixConditions = Array.from({ length: 6 }, () => ({ field: 'subjectContains', value: 'x' }))
    const invalid = [
      {},
      { ...base, name: '' },
      { ...base, name: 'x'.repeat(81) },
      { ...base, enabled: 'yes' },
      { ...base, conditions: [] },
      { ...base, conditions: sixConditions },
      { ...base, conditions: [{ field: 'bodyContains', value: 'x' }] },
      { ...base, conditions: [{ field: 'minBytes', value: -1 }] },
      { ...base, conditions: [{ field: 'minBytes', value: 1.5 }] },
      { ...base, conditions: [{ field: 'minBytes', value: EMAIL_INBOUND_MAX_BYTES + 1 }] },
      { ...base, actions: [] },
      { ...base, actions: [{ type: 'forwardTo', address: 'x@example.com' }] },
      { ...base, actions: [{ type: 'addTag', tag: 'bad\\tag' }] },
      { ...base, actions: [{ type: 'moveTo', folder: ' ' }] },
    ]
    for (const value of invalid) expect(parseEmailFilterInput(value)).toBeNull()
    expect(parseEmailFilterPatch({})).toBeNull()
    expect(parseEmailFilterPatch({ enabled: false })).toEqual({ enabled: false })
  })
})

describe('email filter storage', () => {
  it('creates, orders, updates and deletes filters', () => {
    const first = createFilter({ name: 'First' })
    const second = createFilter({ name: 'Second', enabled: false })
    expect(store.listFilters().map((filter) => filter.name)).toEqual(['First', 'Second'])
    expect(second.sortOrder).toBe(1)

    expect(store.updateFilter(first.id, { name: 'Renamed', enabled: false })).toMatchObject({
      name: 'Renamed',
      enabled: false,
    })
    expect(store.getFilter(second.id)?.enabled).toBe(false)
    expect(store.updateFilter('missing', { name: 'Nope' })).toBeNull()

    expect(store.deleteFilter(second.id)).toBe(true)
    expect(store.deleteFilter(second.id)).toBe(false)
    expect(store.listFilters().map((filter) => filter.id)).toEqual([first.id])
  })

  it('caps the rule count', () => {
    for (let index = 0; index < EMAIL_FILTER_MAX_RULES; index += 1) {
      expect(createFilter({ name: `Rule ${index}` })).toBeTruthy()
    }
    expect(store.createFilter({
      name: 'One too many',
      enabled: true,
      conditions: [{ field: 'subjectContains', value: 'x' }],
      actions: [{ type: 'markRead' }],
    })).toBeNull()
  })
})

describe('email filter matching', () => {
  it('matches a sender substring case-insensitively', () => {
    createFilter({ conditions: [{ field: 'fromContains', value: 'ALICE@EXAMPLE.COM' }], actions: [{ type: 'star' }] })
    expect(store.evaluateInboundRules(inbound()).starred).toBe(true)
    expect(store.evaluateInboundRules(inbound({ sender: 'Bob <bob@example.com>' })).starred).toBe(false)
  })

  it('matches a recipient substring across to, cc and bcc', () => {
    createFilter({ conditions: [{ field: 'toContains', value: 'team@example.com' }], actions: [{ type: 'star' }] })
    expect(store.evaluateInboundRules(inbound({ cc: 'Team <team@example.com>' })).starred).toBe(true)
    expect(store.evaluateInboundRules(inbound({ bcc: 'team@example.com' })).starred).toBe(true)
    expect(store.evaluateInboundRules(inbound({ recipient: 'other@example.com' })).starred).toBe(false)
  })

  it('matches a subject substring and requires the attachment flag exactly', () => {
    createFilter({
      conditions: [
        { field: 'subjectContains', value: 'DIGEST' },
        { field: 'hasAttachment', value: false },
      ],
      actions: [{ type: 'star' }],
    })
    expect(store.evaluateInboundRules(inbound()).starred).toBe(true)
    expect(store.evaluateInboundRules(inbound({ hasAttachment: true })).starred).toBe(false)
  })

  it('matches the raw size floor', () => {
    createFilter({ conditions: [{ field: 'minBytes', value: 4096 }], actions: [{ type: 'star' }] })
    expect(store.evaluateInboundRules(inbound({ size: 4096 })).starred).toBe(true)
    expect(store.evaluateInboundRules(inbound({ size: 4095 })).starred).toBe(false)
  })

  it('ignores disabled filters', () => {
    createFilter({ enabled: false, actions: [{ type: 'star' }] })
    expect(store.evaluateInboundRules(inbound()).starred).toBe(false)
  })
})

describe('email filter actions', () => {
  it('resolves a move target by id or unique name', () => {
    const folder = store.createFolder('Receipts')!
    createFilter({ conditions: [{ field: 'subjectContains', value: 'digest' }], actions: [{ type: 'moveTo', folder: 'receipts' }] })
    expect(store.evaluateInboundRules(inbound()).folderId).toBe(folder.id)
    store.updateFilter(store.listFilters()[0]!.id, {
      conditions: [{ field: 'subjectContains', value: 'digest' }],
      actions: [{ type: 'moveTo', folder: folder.id }],
    })
    expect(store.evaluateInboundRules(inbound()).folderId).toBe(folder.id)
  })

  it('lets a later matching filter override the folder and accumulates flags', () => {
    const folder = store.createFolder('Receipts')!
    const first = createFilter({
      name: 'First',
      actions: [{ type: 'moveTo', folder: 'archive' }, { type: 'markRead' }],
    })
    createFilter({
      name: 'Second',
      actions: [{ type: 'moveTo', folder: folder.id }, { type: 'star' }, { type: 'trash' }],
    })
    expect(store.evaluateInboundRules(inbound())).toMatchObject({
      folderId: folder.id,
      read: true,
      starred: true,
      trash: true,
    })
    store.updateFilter(first.id, { enabled: false })
    expect(store.evaluateInboundRules(inbound()).folderId).toBe(folder.id)
  })

  it('skips a move to a folder that no longer exists and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filter = createFilter({
      conditions: [{ field: 'subjectContains', value: 'digest' }],
      actions: [{ type: 'moveTo', folder: 'Deleted folder' }, { type: 'star' }],
    })
    expect(store.evaluateInboundRules(inbound())).toMatchObject({ folderId: 'inbox', starred: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('move target'), filter.id, 'Deleted folder')
  })

  it('treats a move to the trash as a soft delete', () => {
    createFilter({ actions: [{ type: 'moveTo', folder: 'trash' }] })
    expect(store.evaluateInboundRules(inbound())).toMatchObject({ folderId: 'trash', trash: true })
  })

  it('collects unique tag paths and creates missing tags on attach', () => {
    store.createEmail('inbox', {
      id: 'm1',
      subject: 'Digest',
      sender: 'alice@example.com',
      recipient: 'me@example.com',
      date: Date.now(),
      body: 'Body',
    })
    const plan = store.evaluateInboundRules(inbound())
    expect(plan.tagPaths).toEqual([])

    createFilter({ name: 'Tag one', actions: [{ type: 'addTag', tag: 'work/digest' }] })
    createFilter({ name: 'Tag two', actions: [{ type: 'addTag', tag: 'Work/Digest' }] })
    expect(store.evaluateInboundRules(inbound()).tagPaths).toEqual(['work/digest'])

    expect(store.attachTagPaths('m1', ['work/digest', 'work/other'])).toEqual(['work/digest', 'work/other'])
    const tags = store.listTags()
    expect(tags.map((tag) => tag.name)).toEqual(expect.arrayContaining(['work/digest', 'work/other']))
    expect(tags.every((tag) => tag.color === null)).toBe(true)
    const attached = sqlite.prepare(
      `SELECT COUNT(*) AS total FROM email_message_tags WHERE message_id = 'm1'`,
    ).get() as { total: number }
    expect(Number(attached.total)).toBe(2)
    expect(store.attachTagPaths('m1', ['bad\\tag'])).toEqual([])
  })
})

describe('blocked senders', () => {
  it('adds, lists, checks and removes normalized addresses', () => {
    expect(store.addBlockedSender('Alice@Example.com')?.email_normalized).toBe('alice@example.com')
    expect(store.addBlockedSender('alice@example.com')?.email_normalized).toBe('alice@example.com')
    expect(store.isBlockedSender('ALICE@EXAMPLE.COM')).toBe(true)
    expect(store.listBlockedSenders()).toHaveLength(1)
    expect(store.removeBlockedSender('Alice@example.com')).toBe(true)
    expect(store.removeBlockedSender('alice@example.com')).toBe(false)
    expect(store.isBlockedSender('alice@example.com')).toBe(false)
  })

  it('routes a blocked sender to spam, read, ahead of any matching filter', () => {
    store.addBlockedSender('alice@example.com')
    createFilter({
      actions: [
        { type: 'moveTo', folder: 'archive' },
        { type: 'star' },
        { type: 'addTag', tag: 'ignored' },
        { type: 'trash' },
      ],
    })
    expect(store.evaluateInboundRules(inbound())).toEqual({
      blocked: true,
      folderId: 'spam',
      read: true,
      starred: false,
      trash: false,
      tagPaths: [],
    })
  })
})
