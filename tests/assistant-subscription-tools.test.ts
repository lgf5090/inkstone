import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { ToolExecutor, type ToolContext } from '../src/worker/assistant/tools'
import type { NoteScope } from '../src/worker/assistant/note-scope'
import type { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { SubscriptionsStore, storeContext } from '../src/worker/subscriptions/store'
import { writeNotifyLog } from '../src/worker/subscriptions/logs'
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
  return { store: new SubscriptionsStore(env.DB, userId), context: storeContext({ timezone: 'Asia/Shanghai', paymentHistoryLimit: 100, locale: 'zh-CN', notificationHours: [], showLunar: false, baseCurrency: 'CNY', budgetMonthly: null, budgetYearly: null, rateOverrides: {}, inboundTokenHint: '' }, NOW) }
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

  /**
   * The fields the row carries but the tools used to be unable to name.
   *
   * `update_subscription` read `startDate` without declaring it, so every attempt to move a plan's start
   * was accepted, echoed back as success, and thrown away by the argument filter. A model cannot be blamed
   * for reporting a change it was told had happened, which is why this asserts the stored row rather than
   * the call's shape.
   */
  it('carries the flags the reader named into the stored row', async () => {
    const created = await run('create_subscription', {
      name: 'Nintendo',
      expiryDate: '2027-01-08',
      amount: 0,
      startDate: '2026-10-01',
      useLunar: true,
      autoRenew: false,
      isActive: false,
      trialEndsAt: '2026-10-08',
    }) as { created: { id: string; useLunar: boolean; autoRenew: boolean; isActive: boolean; startDate: string | null; trialEndsAt: string | null } }
    expect(created.created).toMatchObject({ useLunar: true, autoRenew: false, isActive: false, startDate: '2026-10-01', trialEndsAt: '2026-10-08' })

    const { store: subStore, context } = store()
    const saved = (await subStore.list(context)).find((item) => item.name === 'Nintendo')
    expect(saved, 'a switched-off plan stays off').toMatchObject({ useLunar: true, autoRenew: false, isActive: false })
    expect(saved?.startDate?.slice(0, 10)).toBe('2026-10-01')

    const moved = await run('update_subscription', { ref: 'Nintendo', startDate: '2026-11-11', useLunar: false }) as { updated: { startDate: string | null, useLunar: boolean } }
    expect(moved.updated).toMatchObject({ startDate: '2026-11-11', useLunar: false })
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

  /**
   * The toolbar's four orderings, because the same list asked for in a conversation has to come back in
   * the same order. `cost` is the one that cannot be faked: a $60-a-month plan is the dearest thing here
   * and the smallest number, so an ordering that read the digits would file it last and disagree with the
   * screen the reader is looking at.
   */
  it('orders a conversation list the way the toolbar does, converting money before comparing it', async () => {
    await seedSubscription({ name: 'Adobe', amount: 150, currency: 'CNY' })
    await seedSubscription({ name: 'Figma', amount: 60, currency: 'USD' })
    await seedSubscription({ name: 'Office', amount: 360, currency: 'CNY', periodUnit: 'year' })

    const names = async (sort: string) => ((await run('list_subscriptions', { sort })) as {
      subscriptions: Array<{ name: string }>
    }).subscriptions.map((item) => item.name)

    // ¥419 a month, then ¥150, then the annual plan's ¥30.
    expect(await names('cost')).toEqual(['Figma', 'Adobe', 'Office'])
    // One charge: the dollar plan, then the ¥360 year, then the ¥150 month.
    expect(await names('amount')).toEqual(['Figma', 'Office', 'Adobe'])
    expect(await names('name')).toEqual(['Adobe', 'Figma', 'Office'])
    // A word the toolbar does not offer is refused with the list of what it does, not quietly read as
    // "expiry": a model that guesses can correct itself, and one that is agreed with cannot.
    await expect(run('list_subscriptions', { sort: 'nonsense' })).rejects.toThrow(/expiry, cost, name, amount/)
  })

  it('names what is in the trash when a restore misses, rather than reporting an empty one', async () => {
    const created = await seedSubscription({ amount: 60 })
    const { store: subStore, context: ctx } = store()
    await subStore.trash(created.item.id, ctx)

    await expect(run('restore_subscription', { ref: 'Spotify' })).rejects.toThrow(/Netflix/)
  })
})

describe('the money history and the deliveries', () => {
  /**
   * "Did the app tell me?" is a question the reader asks out loud, and until now a conversation could not
   * answer it: the schedule and the delivery attempts were on screen in the app and nowhere in the tool
   * surface. An empty log has to read differently from "nothing was due", or the model reports a quiet
   * month as a working one.
   */
  it('reports what was delivered, and says an empty log is not an empty month', async () => {
    const created = await seedSubscription()
    const quiet = await run('subscription_logs', {}) as { total: number, note?: string, sweeps: unknown[] }
    expect(quiet.total).toBe(0)
    expect(quiet.note).toMatch(/No delivery has been attempted yet/)

    await writeNotifyLog(env.DB, ALICE, {
      subscriptionId: created.item.id, ruleId: 'r1', channel: 'bark', status: 'failed',
      title: 't', body: 'b', error: 'HTTP 500', detail: 'upstream said no',
    })
    const answer = await run('subscription_logs', { ref: 'netflix' }) as {
      total: number, deliveries: Array<{ subscription: string, channel: string, status: string, error: string | null, detail: string | null }>
    }
    expect(answer.total).toBe(1)
    expect(answer.deliveries[0]).toMatchObject({ subscription: 'Netflix', channel: 'bark', status: 'failed', error: 'HTTP 500' })
    expect(answer.deliveries[0]!.detail, 'the reason a reader can act on survives').toBe('upstream said no')
  })

  it('corrects a receipt without inventing a second one', async () => {
    const created = await seedSubscription({ amount: 60 })
    const read = await run('get_subscription', { ref: 'Netflix' }) as { payments: Array<{ id: string, amount: number }> }
    expect(read.payments).toHaveLength(1)

    const edited = await run('edit_subscription_payment', { ref: 'Netflix', payment: read.payments[0]!.id, amount: 88 }) as { payments: number }
    expect(edited.payments, 'a correction replaces the record rather than adding one').toBe(1)
    const after = await run('get_subscription', { ref: 'Netflix' }) as { payments: Array<{ amount: number }> }
    expect(after.payments[0]!.amount).toBe(88)

    await expect(run('edit_subscription_payment', { ref: 'Netflix', payment: 'nope', amount: 1 }))
      .rejects.toThrow(/nope/)
    await expect(run('edit_subscription_payment', { ref: 'Netflix', payment: read.payments[0]!.id }))
      .rejects.toThrow(/at least one part/)
  })

  it('erases one receipt only after approval, and leaves the subscription standing', async () => {
    const created = await seedSubscription({ amount: 60 })
    const read = await run('get_subscription', { ref: 'Netflix' }) as { payments: Array<{ id: string }> }
    const executor = new ToolExecutor(
      { ...context(ALICE), conversationId: 'conv-1', settings: { ...DEFAULT_ASSISTANT_SETTINGS, toolModes: { read: 'auto', write: 'auto', destructive: 'auto' } } },
      { maxToolCalls: 8 },
    )
    const prepared = await executor.execute('delete_subscription_payment', { ref: 'Netflix', payment: read.payments[0]!.id }, 'call-erase') as { deleted: boolean, payments: number }
    expect(prepared).toMatchObject({ deleted: true, payments: 0 })

    const { store: subStore, context: ctx } = store()
    const detail = await subStore.get(created.item.id, ctx)
    expect(detail?.payments).toHaveLength(0)
    expect(detail?.item.name, 'the subscription itself is untouched').toBe('Netflix')
  })

  /**
   * "How much has this one actually cost me" is asked about one plan, and the receipts behind it are older
   * than the payment list the detail carries. The count is therefore made from every receipt, and the tool
   * surface has to answer with the same numbers the panel draws — otherwise the reader hears one figure on
   * screen and another in the thread.
   */
  it('counts what a plan cost by year, on screen and in the answer', async () => {
    const created = await seedSubscription({ amount: 60 })
    const { store: subStore, context: ctx } = store()
    await subStore.renew(created.item.id, { paymentDate: '2025-12-20', amount: 60 }, ctx)

    const detail = await subStore.get(created.item.id, ctx)
    expect(detail?.yearlySpend).toEqual([
      { year: 2026, currency: 'CNY', amount: 60, receipts: 1 },
      { year: 2025, currency: 'CNY', amount: 60, receipts: 1 },
    ])

    const answer = await run('get_subscription', { ref: 'Netflix' }) as {
      yearlySpend: Array<{ year: number, currency: string, amount: number, receipts: number }>
    }
    expect(answer.yearlySpend).toEqual(detail?.yearlySpend)
  })
})

describe('the account behind the rows', () => {
  /**
   * The two things a conversation could previously not ask about at all: which names the reader already
   * uses, and how the app is configured. Both are on screen in the app itself, so a model that could not
   * read them had to either refuse the question or invent an answer.
   *
   * One call answers both registries: measured against a live model, a `kind` argument it had to guess was
   * sent empty first, refused, and asked again — so the registry is read whole.
   */
  it('reads both label registries in one call, and says when one is empty', async () => {
    const empty = await run('list_subscription_labels', {}) as {
      types: { total: number, labels: Array<{ name: string }>, note?: string }
      categories: { total: number, labels: Array<{ name: string }>, note?: string }
    }
    expect(empty.types.total, 'nothing was registered yet').toBe(0)
    expect(empty.types.note).toMatch(/built-in suggestions/)

    await seedSubscription()
    const filled = await run('list_subscription_labels', {}) as typeof empty
    expect(filled.types.labels.map((label) => label.name)).toContain('流媒体')
    expect(filled.types.note, 'a populated registry gets no empty-state note').toBeUndefined()
    expect(filled.categories.labels.map((label) => label.name)).toContain('娱乐')
  })

  it('sets the ceiling and the total currency, and refuses a zone that is not one', async () => {
    const saved = await run('set_subscription_settings', { budgetMonthly: 300, baseCurrency: 'USD' }) as { budgetMonthly: number, baseCurrency: string }
    expect(saved).toMatchObject({ budgetMonthly: 300, baseCurrency: 'USD' })
    const read = await run('get_subscription_settings', {}) as { budgetMonthly: number, budgetNote?: string }
    expect(read.budgetMonthly).toBe(300)

    const cleared = await run('set_subscription_settings', { clearBudget: true }) as { budgetMonthly: number | null, budgetNote?: string }
    expect(cleared.budgetMonthly, 'clearing is a real answer, not zero').toBeNull()
    expect(cleared.budgetNote).toMatch(/No monthly ceiling/)

    await expect(run('set_subscription_settings', { timezone: 'Shanghai' }))
      .rejects.toThrow(/Asia\/Shanghai/)
    await expect(run('set_subscription_settings', { notificationHours: '8,25' }))
      .rejects.toThrow(/0 to 23/)
    await expect(run('set_subscription_settings', {})).rejects.toThrow(/at least one setting/)
  })

  it('keeps the ceiling for the year apart from the one for the month', async () => {
    await run('set_subscription_settings', { budgetMonthly: 300 })
    const saved = await run('set_subscription_settings', { budgetYearly: 2400 }) as {
      budgetMonthly: number
      budgetYearly: number
      budgetYearlyNote?: string
    }
    expect(saved.budgetYearly).toBe(2400)
    expect(saved.budgetMonthly, 'naming the year does not give up the month').toBe(300)
    expect(saved.budgetYearlyNote, 'a ceiling that is set needs no sentence about it').toBeUndefined()

    const cleared = await run('set_subscription_settings', { clearYearlyBudget: true }) as {
      budgetMonthly: number
      budgetYearly: number | null
      budgetYearlyNote?: string
    }
    expect(cleared.budgetYearly).toBeNull()
    expect(cleared.budgetYearlyNote).toMatch(/No yearly ceiling/)
    expect(cleared.budgetMonthly).toBe(300)

    const summary = await run('subscription_summary', {}) as {
      yearlyBudget: { limit: number | null; over: boolean }
      budget: { limit: number | null }
    }
    expect(summary.yearlyBudget.limit, 'a cleared ceiling is said, not left blank').toBeNull()
    expect(summary.budget.limit).toBe(300)
  })

  /**
   * A rate the reader disagreed with was previously not something a conversation could fix: the number is
   * on the dashboard, and the only way to change it was the settings panel. Pinning one currency must not
   * lose the pins already set — "and use 7.2 for the dollar" is one sentence, not a request to restate the
   * account — and a currency the app does not convert has to be named back rather than dropped.
   */
  it('pins a rate, merges it with the ones already pinned, and unpins by name', async () => {
    const first = await run('set_subscription_settings', { rateOverrides: 'USD:7.2' }) as { rateOverrides: Record<string, number> }
    expect(first.rateOverrides).toEqual({ USD: 7.2 })

    const second = await run('set_subscription_settings', { rateOverrides: 'JPY:0.045' }) as { rateOverrides: Record<string, number> }
    expect(second.rateOverrides).toEqual({ USD: 7.2, JPY: 0.045 })

    const read = await run('get_subscription_settings', {}) as { rateOverrides: Record<string, number>, ratesNote?: string }
    expect(read.rateOverrides).toEqual({ USD: 7.2, JPY: 0.045 })
    expect(read.ratesNote, 'a pinned account is not told it follows the feed').toBeUndefined()

    const unpinned = await run('set_subscription_settings', { rateOverrides: 'USD:none' }) as { rateOverrides: Record<string, number> }
    expect(unpinned.rateOverrides).toEqual({ JPY: 0.045 })

    const cleared = await run('set_subscription_settings', { clearRates: true }) as { rateOverrides: Record<string, number>, ratesNote?: string }
    expect(cleared.rateOverrides).toEqual({})
    expect(cleared.ratesNote).toMatch(/daily exchange feed/)

    await expect(run('set_subscription_settings', { rateOverrides: '  ' }))
      .rejects.toThrow(/Name a currency/)

    // Refused rather than half-applied: the pin that was there is still the one the account carries.
    await run('set_subscription_settings', { rateOverrides: 'USD:7.2' })
    await expect(run('set_subscription_settings', { rateOverrides: 'XYZ:1' }))
      .rejects.toThrow(/is not a currency/)
    await expect(run('set_subscription_settings', { rateOverrides: 'CNY:1' }))
      .rejects.toThrow(/measured against/)
    await expect(run('set_subscription_settings', { rateOverrides: 'USD:seven' }))
      .rejects.toThrow(/USD:none/)
    expect((await run('get_subscription_settings', {})) as { rateOverrides: Record<string, number> })
      .toMatchObject({ rateOverrides: { USD: 7.2 } })
  })

  /**
   * The money summary is the call a model reaches for first when the question is about the account, and
   * until now it carried no word about the rates its own totals were converted with. Measured against a
   * live model on 2026-10-21: asked "is any rate pinned?" it called the summary, found nothing, and
   * answered that there were none — while the account carried USD 7.2.
   */
  it('states the pinned rates inside the money summary, not only in the settings tool', async () => {
    await run('set_subscription_settings', { rateOverrides: 'USD:7.2' })
    const pinned = await run('subscription_summary', {}) as { rates: { pinned: Record<string, number>, note: string } }
    expect(pinned.rates.pinned).toEqual({ USD: 7.2 })
    expect(pinned.rates.note).toMatch(/reader's own number/)

    await run('set_subscription_settings', { clearRates: true })
    const cleared = await run('subscription_summary', {}) as { rates: { pinned: Record<string, number>, note: string } }
    expect(cleared.rates.pinned).toEqual({})
    expect(cleared.rates.note).toMatch(/No rate is pinned/)
  })

  /**
   * A currency the day's table cannot price is in none of those totals, and the summary has to say so:
   * "this month cost ¥300" read to a model as the whole account when a plan it could not convert was
   * sitting right there. The stubbed feed above answers with nothing, so only the built-in nine codes can
   * be priced here — which is what makes SGD the case.
   */
  it('names the currencies left out of the money summary', async () => {
    await run('create_subscription', { name: 'LangAI', expiryDate: '2026-12-01', amount: 20, currency: 'SGD', periodValue: 1, periodUnit: 'month' })
    const summary = await run('subscription_summary', {}) as {
      rates: { source: string, at: string | null, unpriced: string[], basePriced: boolean, note: string }
    }
    expect(summary.rates.source).toBe('feed')
    expect(summary.rates.unpriced).toContain('SGD')
    expect(summary.rates.basePriced).toBe(true)
    expect(summary.rates.note).toMatch(/SGD had no rate/)
  })

  it('switches tracking off without touching the trash, and says so when nothing changed', async () => {
    await seedSubscription()
    const off = await run('set_subscription_active', { ref: 'Netflix', active: false }) as { updated: { isActive: boolean } }
    expect(off.updated.isActive).toBe(false)
    expect((await run('list_subscriptions', {})) as { total: number }).toBeTruthy()
    await expect(run('set_subscription_active', { ref: 'Netflix', active: false }))
      .rejects.toThrow(/already switched off/)
    const on = await run('set_subscription_active', { ref: 'Netflix', active: true }) as { updated: { isActive: boolean } }
    expect(on.updated.isActive).toBe(true)
  })
})

describe('several plans and the name registry', () => {
  it('changes the ones it can name and says which it could not', async () => {
    await seedSubscription({ name: 'Netflix' })
    await seedSubscription({ name: 'Figma', amount: 15 })
    const answer = await run('bulk_update_subscriptions', { refs: 'netflix, Figma, Ghost', action: 'deactivate' }) as {
      matched: number, changed: number, skipped: string[]
    }
    expect(answer).toMatchObject({ matched: 2, changed: 2 })
    expect(answer.skipped.join(' ')).toMatch(/Ghost/)
    expect(answer.skipped.join(' ')).toMatch(/no live plan/)

    const { store: subStore, context: ctx } = store()
    expect((await subStore.list(ctx)).filter((item) => item.isActive)).toHaveLength(0)
  })

  it('refuses the bulk verbs it cannot honour rather than doing half of them', async () => {
    await seedSubscription()
    await expect(run('bulk_update_subscriptions', { refs: 'Netflix', action: 'set_category' }))
      .rejects.toThrow(/needs a .category/)
    await expect(run('bulk_update_subscriptions', { refs: 'Netflix', action: 'trash' }))
      .rejects.toThrow(/must be one of/)
  })

  it('registers, renames and unregisters a name without editing any plan', async () => {
    await seedSubscription()
    const added = await run('add_subscription_label', { kind: 'type', name: '工具' }) as { label: { name: string }, total: number }
    expect(added.label.name).toBe('工具')

    const renamed = await run('rename_subscription_label', { kind: 'type', name: '工具', to: '软件' }) as { labels: string[] }
    expect(renamed.labels).toContain('软件')
    await expect(run('rename_subscription_label', { kind: 'type', name: '软件', to: '流媒体' }))
      .rejects.toThrow(/already exist|same/)

    const removed = await run('remove_subscription_label', { kind: 'type', name: '软件' }) as { removed: boolean, total: number }
    expect(removed.removed).toBe(true)
    const again = await run('remove_subscription_label', { kind: 'type', name: '软件' }) as { removed: boolean, note?: string }
    expect(again.removed).toBe(false)
    expect(again.note).toMatch(/Nothing registered/)

    const { store: subStore, context: ctx } = store()
    const held = await subStore.list(ctx)
    expect(held[0]!.customType, 'unregistering a name leaves the plans that carry it alone').toBe('流媒体')
  })
})

describe('erasing beyond recovery', () => {
  const autoExecutor = () => new ToolExecutor(
    { ...context(ALICE), conversationId: 'conv-erase', settings: { ...DEFAULT_ASSISTANT_SETTINGS, toolModes: { read: 'auto', write: 'auto', destructive: 'auto' } } },
    { maxToolCalls: 8 },
  )

  /**
   * The two verbs the app has no way back from, and the guard rail between them and a conversation.
   *
   * `purge_subscription` refuses a plan that is still live: the reader who says "delete Netflix" means the
   * trash, and an assistant that erased the receipts on the first request could not be blamed.
   */
  it('erases only what is already trashed, and says so when the name is a live plan', async () => {
    const created = await seedSubscription()
    await expect(autoExecutor().execute('purge_subscription', { ref: 'Netflix' }, 'call-live'))
      .rejects.toThrow(/trash is empty/)

    const { store: subStore, context: ctx } = store()
    await subStore.trash(created.item.id, ctx)
    const erased = await autoExecutor().execute('purge_subscription', { ref: 'Netflix' }, 'call-purge') as { purged: boolean }
    expect(erased.purged).toBe(true)
    expect(await subStore.list(ctx, 'trash')).toHaveLength(0)
    expect(await subStore.get(created.item.id, ctx)).toBeNull()
  })

  it('names how many plans are about to go, and reports the number that actually went', async () => {
    await expect(autoExecutor().execute('empty_subscription_trash', {}, 'call-empty'))
      .rejects.toThrow(/already empty/)

    const first = await seedSubscription({ name: 'Netflix' })
    const second = await seedSubscription({ name: 'Figma', amount: 15 })
    const { store: subStore, context: ctx } = store()
    await subStore.trash(first.item.id, ctx)
    await subStore.trash(second.item.id, ctx)
    const answer = await autoExecutor().execute('empty_subscription_trash', {}, 'call-empty-2') as { purged: number, note: string }
    expect(answer.purged).toBe(2)
    expect(await subStore.list(ctx, 'trash')).toHaveLength(0)
    expect(await subStore.trashCount()).toBe(0)
  })
})
