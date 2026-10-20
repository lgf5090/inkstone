import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { NoteScope } from '../src/worker/assistant/note-scope'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { SubscriptionsStore, storeContext } from '../src/worker/subscriptions/store'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The subscription tools, run the way the model runs them.
 *
 * `assistant-rules.test.ts` already proves every one of these names is registered, permissioned and
 * labelled in both languages. That is the cheap half. This file drives the executor against a real
 * database, because the failures that matter here are invisible to a registry test: a tool that answers
 * `{}` for a reader who asked a good question, a name that matches two subscriptions and silently picks
 * one, a delete that erases instead of trashing, or a store built without the session's account and
 * therefore reading somebody else's money.
 */

const ALICE = 'user-alice'
const BOB = 'user-bob'
const DAY = 86_400_000
const NOW = Date.parse('2026-05-24T04:00:00Z')

let sqlite: DatabaseSync
let env: Env
const openScope: NoteScope = { restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }

function context(userId: string): ToolContext {
  return {
    store: { userId } as unknown as AssistantStore,
    env,
    ftsEnabled: false,
    origin: 'https://inkstone.test',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'Asia/Shanghai',
    dayEnd: NOW,
    mode: 'chat',
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => openScope,
  }
}

function run(name: string, args: Record<string, unknown> = {}, userId = ALICE): Promise<unknown> {
  return new ToolExecutor(context(userId), { maxToolCalls: 8 }).execute(name, args, `call-${name}`)
}

/** Straight through the store, so a tool is tested against data the app itself would have written. */
async function seedSubscription(overrides: Record<string, unknown> = {}, userId = ALICE) {
  const store = new SubscriptionsStore(env.DB, userId)
  return store.create({
    name: 'Netflix',
    customType: '流媒体',
    category: '娱乐',
    amount: 60,
    currency: 'CNY',
    expiryDate: new Date(Date.now() + 5 * DAY).toISOString(),
    periodValue: 1,
    periodUnit: 'month',
    ...overrides,
  }, { timezone: 'Asia/Shanghai', paymentLimit: 100, now: NOW })
}

function store(userId = ALICE) {
  return { store: new SubscriptionsStore(env.DB, userId), context: storeContext({ timezone: 'Asia/Shanghai', paymentHistoryLimit: 100, locale: 'zh-CN', notificationHours: [], showLunar: false, baseCurrency: 'CNY', budgetMonthly: null, inboundTokenHint: '' }, NOW) }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = { DB: makeD1(sqlite) } as unknown as Env
  // The summary tool reaches the rate feed through the overview. Left alone it spends the whole ten
  // second timeout falling back to the built-in table, so the test answers from a stub instead.
  vi.stubGlobal('fetch', async () => Response.json({ rates: {} }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reading from a conversation', () => {
  it('lists what is due, and says when it paginated', async () => {
    await seedSubscription()
    await seedSubscription({ name: 'Adobe', category: '工作', expiryDate: new Date(NOW + 60 * DAY).toISOString() })
    const answer = await run('list_subscriptions', { status: 'soon' }) as { total: number; subscriptions: Array<{ name: string }> }
    expect(answer.total).toBe(1)
    expect(answer.subscriptions[0].name).toBe('Netflix')
  })

  it('summarises the money in the account’s own total currency', async () => {
    await seedSubscription()
    const answer = await run('subscription_summary') as { totalCurrency: string; active: { total: number }; yearly: { amount: number } }
    expect(answer.totalCurrency).toBe('CNY')
    expect(answer.active.total).toBe(1)
    expect(answer.yearly.amount).toBe(60)
  })

  it('finds a subscription by the name the reader used', async () => {
    const created = await seedSubscription()
    const answer = await run('get_subscription', { ref: 'netflix' }) as { subscription: { id: string }; reminders: unknown[] }
    expect(answer.subscription.id).toBe(created.item.id)
    // Four preset reminders, because the reader never asked for any — the app gave them.
    expect(answer.reminders).toHaveLength(4)
  })

  it('refuses to guess between two subscriptions that share a word', async () => {
    await seedSubscription({ name: 'Netflix 标准' })
    await seedSubscription({ name: 'Netflix 高级' })
    await expect(run('get_subscription', { ref: 'Netflix' })).rejects.toThrow(/matches 2 subscriptions/)
  })

  it('cannot reach another account’s money', async () => {
    const created = await seedSubscription()
    await expect(run('get_subscription', { ref: created.item.id }, BOB)).rejects.toThrow(/No subscription matches/)
    const asBob = await run('list_subscriptions', {}, BOB) as { total: number }
    expect(asBob.total).toBe(0)
  })
})

describe('writing from a conversation', () => {
  it('creates with the shorthand reminders the reader described', async () => {
    const answer = await run('create_subscription', {
      name: 'Figma',
      expiryDate: '2026-09-01',
      amount: 15,
      currency: 'USD',
      type: '软件订阅',
      reminders: '14d,3d,on,after:24',
    }) as { created: { id: string; name: string; currency: string } }
    expect(answer.created).toMatchObject({ name: 'Figma', currency: 'USD' })

    const { store: subStore, context } = store()
    const detail = await subStore.get(answer.created.id ?? '', context)
    const first = await subStore.list(context)
    const saved = first.find((item) => item.name === 'Figma')
    expect(saved).toBeTruthy()
    const rules = (await subStore.get(saved!.id, context))!.rules
    expect(rules.map((rule) => `${rule.type}:${rule.value}${rule.unit}`).sort()).toEqual([
      'after_expiry:0days', 'before_expiry:14days', 'before_expiry:3days', 'on_expiry:0days',
    ].sort())
    expect(detail).toBeTruthy()
  })

  it('rejects a reminder it cannot express rather than dropping it quietly', async () => {
    await seedSubscription()
    await expect(run('set_subscription_reminders', { ref: 'Netflix', reminders: '7 days' }))
      .rejects.toThrow(/is not a reminder/)
  })

  it('can switch every reminder off', async () => {
    await seedSubscription()
    const answer = await run('set_subscription_reminders', { ref: 'Netflix', reminders: '' }) as { reminders: unknown[] }
    expect(answer.reminders).toHaveLength(0)
  })

  it('renews by writing a receipt and moving the date, not by moving the date', async () => {
    const created = await seedSubscription()
    const answer = await run('renew_subscription', { ref: 'Netflix', periods: 2 }) as {
      renewed: { expiryDate: string; paymentCount: number }
    }
    const before = Date.parse(created.item.expiryDate)
    expect(Date.parse(`${answer.renewed.expiryDate}T00:00:00Z`)).toBeGreaterThan(before)
    // The opening receipt plus the renewal: a reader reconciling a statement needs both to be there.
    expect(answer.renewed.paymentCount).toBe(2)
  })

  it('gives a label a face, and refuses one the app does not draw', async () => {
    const styled = await run('set_subscription_style', { kind: 'type', name: '流媒体', icon: 'lucide:Tv', color: '#e11d48' }) as {
      label: { icon: string; color: string }
    }
    expect(styled.label).toEqual({ name: '流媒体', icon: 'lucide:Tv', color: '#e11d48' })
    await expect(run('set_subscription_style', { kind: 'type', name: '流媒体', icon: 'lucide:Bogus' }))
      .rejects.toThrow(/is not an icon the app offers/)
  })
})

describe('deleting from a conversation', () => {
  /**
   * The destructive verb is the trash, not the erasure, and this pins that in both directions: the row
   * and its receipts survive an approved delete, and `restore_subscription` puts it back.
   */
  it('trashes on approval and keeps the history restorable', async () => {
    const created = await seedSubscription({ amount: 60 })
    const executor = new ToolExecutor(
      { ...context(ALICE), conversationId: 'conv-1', settings: { ...DEFAULT_ASSISTANT_SETTINGS, toolModes: { read: 'auto', write: 'auto', destructive: 'auto' } } },
      { maxToolCalls: 8 },
    )
    const prepared = await executor.execute('delete_subscription', { ref: 'Netflix' }, 'call-delete')
    expect(prepared).toMatchObject({ trashed: true })

    const { store: subStore, context: ctx } = store()
    expect(await subStore.list(ctx)).toHaveLength(0)
    const trashed = await subStore.list(ctx, 'trash')
    expect(trashed).toHaveLength(1)
    const detail = await subStore.get(created.item.id, ctx)
    expect(detail?.payments).toHaveLength(1)

    const restored = await run('restore_subscription', { ref: 'Netflix' }) as { restored: { id: string } }
    expect(restored.restored.id).toBe(created.item.id)
    expect(await subStore.list(ctx)).toHaveLength(1)
  })

  /**
   * What a model can see of the trash.
   *
   * A live test asked for a restore and was told, confidently, that nothing had been deleted — because
   * `list_subscriptions` had no word for the trash and the closest-sounding filter (`disabled`) is a
   * different thing entirely. The reader can see the count in the rail; the assistant could not.
   */
  it('shows the trash to a conversation only when it asks for it by name', async () => {
    const created = await seedSubscription({ amount: 60 })
    const { store: subStore, context: ctx } = store()
    await subStore.trash(created.item.id, ctx)

    const live = await run('list_subscriptions', {}) as { subscriptions: Array<{ name: string }> }
    expect(live.subscriptions.map((item) => item.name), 'the default list excludes the trash').not.toContain('Netflix')

    const trashed = await run('list_subscriptions', { status: 'trash' }) as { subscriptions: Array<{ name: string }> }
    expect(trashed.subscriptions.map((item) => item.name)).toContain('Netflix')
  })

  it('names what is in the trash when a restore misses, rather than reporting an empty one', async () => {
    const created = await seedSubscription({ amount: 60 })
    const { store: subStore, context: ctx } = store()
    await subStore.trash(created.item.id, ctx)

    await expect(run('restore_subscription', { ref: 'Spotify' })).rejects.toThrow(/Netflix/)
  })
})
