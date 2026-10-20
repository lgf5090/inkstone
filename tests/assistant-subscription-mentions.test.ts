// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  resolveSubscriptionMentions,
  subscriptionMentions,
} from '../src/worker/assistant/subscription-mentions'
import { noteMentions } from '../src/worker/assistant/note-mentions'
import { SubscriptionsStore } from '../src/worker/subscriptions/store'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * What a `[[sub:…]]` mention brings into a turn.
 *
 * The interesting cases are the ones where a resolver could quietly answer the wrong question: two
 * subscriptions sharing a name, a mention pointing at a row that has since been purged, and a target the
 * note resolver would otherwise claim and report as a deleted note.
 */

const USER = 'user-1'
const NOW = Date.parse('2026-05-24T04:00:00Z')
const DAY = 86_400_000

let db: D1Database
let store: SubscriptionsStore
const context = { timezone: 'Asia/Shanghai', paymentLimit: 100, now: NOW }

async function seed(name: string, overrides: Record<string, unknown> = {}) {
  return store.create({
    name,
    customType: '流媒体',
    category: '娱乐',
    amount: 60,
    currency: 'CNY',
    expiryDate: new Date(NOW + 5 * DAY).toISOString(),
    periodValue: 1,
    periodUnit: 'month',
    notes: 'shared with the family',
    ...overrides,
  }, context)
}

beforeEach(() => {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  store = new SubscriptionsStore(db, USER)
})

describe('parsing', () => {
  it('takes only the sub:-prefixed targets', () => {
    const mentions = subscriptionMentions('compare [[sub:Netflix]] with [[some note]] and [[sub:Adobe]]')
    expect(mentions).toEqual([
      { id: null, name: 'Netflix' },
      { id: null, name: 'Adobe' },
    ])
  })

  it('treats a 26-character target as an id', () => {
    const id = '01hz0000000000000000000000'
    expect(subscriptionMentions(`[[sub:${id}]]`)).toEqual([{ id, name: null }])
  })

  it('reads the same mention twice as one', () => {
    expect(subscriptionMentions('[[sub:Netflix]] then [[sub:Netflix]]')).toHaveLength(1)
  })

  /** The two resolvers must partition the space, or a subscription is reported as a deleted note. */
  it('leaves sub: targets for the other resolver and takes none of the notes', () => {
    const text = '[[01hz0000000000000000000000|A note]] and [[sub:Netflix]]'
    expect(noteMentions(text).map((mention) => mention.title)).toEqual(['A note'])
    expect(subscriptionMentions(text)).toHaveLength(1)
  })
})

describe('resolution', () => {
  it('brings the row, not the free-text note', async () => {
    await seed('Netflix')
    const block = await resolveSubscriptionMentions(db, USER, 'what is [[sub:Netflix]] costing me?', NOW)
    expect(block).toContain('[mentioned subscriptions]')
    expect(block).toContain('price: ¥60.00 / 1 month')
    expect(block).toContain('billing mode: cycle')
    expect(block).toContain('last receipts')
    // The notes column is where a reader may have written anything; a mention of a row is not a licence
    // to pull their prose into a turn.
    expect(block).not.toContain('shared with the family')
  })

  it('resolves by id without needing the name to be unique', async () => {
    const created = await seed('Netflix')
    const block = await resolveSubscriptionMentions(db, USER, `[[sub:${created.item.id}]]`, NOW)
    expect(block).toContain('name: Netflix')
  })

  it('names an ambiguous mention rather than picking one', async () => {
    await seed('Netflix')
    await seed('Netflix', { amount: 120 })
    const block = await resolveSubscriptionMentions(db, USER, '[[sub:Netflix]]', NOW)
    expect(block).toContain('2 subscriptions share that name')
    expect(block).not.toContain('price:')
  })

  it('says so when nothing matches', async () => {
    const block = await resolveSubscriptionMentions(db, USER, '[[sub:Nothing]]', NOW)
    expect(block).toContain('no subscription of that name')
  })

  it('carries nothing for a turn that mentioned none', async () => {
    await seed('Netflix')
    expect(await resolveSubscriptionMentions(db, USER, 'just a question', NOW)).toBe('')
  })

  it('cannot reach another account', async () => {
    await seed('Netflix')
    const block = await resolveSubscriptionMentions(db, 'user-2', '[[sub:Netflix]]', NOW)
    expect(block).toContain('no subscription of that name')
  })
})
