/**
 * Everything the subscription app writes, and the rules it writes by.
 *
 * The reference project kept this in three files: a repository that shuttled JSON through KV, a
 * business layer that knew when an expiry date should move, and handlers that glued the two together.
 * With a real database the repository has nothing left to do — the business layer *is* the data layer,
 * because "advance the expiry date and write the receipt that explains it" has to be one transaction
 * rather than two calls that can disagree.
 *
 * Two invariants run through every method here:
 *  - a row is only ever read or written under its own `user_id`, so a guessed id is a 404 rather than
 *    somebody else's subscription;
 *  - a payment record and the expiry date it bought are written together, because a receipt without
 *    its period (or a period without its receipt) is what makes a history untrustworthy.
 */
import type { LabelEntry, LabelKind, SubscriptionDetail, SubscriptionItem, SubscriptionInput, SubscriptionSettings, PaymentRecord, ReminderRule, ReminderRuleInput, RenewOptions } from '@shared/subscriptions/model'
import {
  BULK_LIMIT,
  defaultPresetRules,
  labelNamesOf,
  normalizeRule,
  roundMoney,
  LABEL_MAX,
  RULES_LIMIT,
  type BulkAction,
} from '@shared/subscriptions/model'
import { normalizeColor, normalizeIcon } from '@shared/subscriptions/identity'
import { addLunarPeriod, lunar2solar, solar2lunar } from '@shared/subscriptions/lunar'
import { addCalendarPeriodInTimezone, getTimezoneDateParts, getTimezoneMidnightTimestamp, getTimestampForTimezoneParts } from '@shared/subscriptions/time'
import { getNextFireTime, soonestFire } from '@shared/subscriptions/reminder-engine'
import { newId } from '../lib/id'

/** Statements per `batch` call when emptying the trash: four per row, kept well under D1's ceiling. */
const PURGE_CHUNK = 80

/** The account's own context, which every date calculation needs and no row carries. */
export interface StoreContext {
  timezone: string
  paymentLimit: number
  now?: number
}

interface ItemRow {
  user_id: string
  id: string
  name: string
  custom_type: string
  category: string
  amount: number | null
  currency: string
  start_date: number | null
  expiry_date: number
  period_value: number
  period_unit: string
  subscription_mode: string
  use_lunar: number
  is_active: number
  auto_renew: number
  notes: string
  last_payment_date: number | null
  trial_ends_at: number | null
  deleted_at: number | null
  created_at: number
  updated_at: number
}

interface PaymentRow {
  user_id: string
  id: string
  subscription_id: string
  paid_at: number
  amount: number
  currency: string
  kind: string
  note: string
  period_start: number | null
  period_end: number | null
  created_at: number
}

interface RuleRow {
  user_id: string
  id: string
  subscription_id: string
  kind: string
  value: number
  unit: string
  repeat_interval: number | null
  repeat_until: string
  acknowledged_at: number | null
  enabled: number
  created_at: number
}

const ITEM_COLUMNS = `user_id, id, name, custom_type, category, amount, currency, start_date, expiry_date,
  period_value, period_unit, subscription_mode, use_lunar, is_active, auto_renew, notes,
  last_payment_date, trial_ends_at, deleted_at, created_at, updated_at`

const PAYMENT_COLUMNS = `user_id, id, subscription_id, paid_at, amount, currency, kind, note,
  period_start, period_end, created_at`

const RULE_COLUMNS = `user_id, id, subscription_id, kind, value, unit, repeat_interval, repeat_until,
  acknowledged_at, enabled, created_at`

function toIso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString()
}

function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function toPayment(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    paidAt: new Date(row.paid_at).toISOString(),
    amount: roundMoney(row.amount),
    currency: row.currency as PaymentRecord['currency'],
    kind: row.kind as PaymentRecord['kind'],
    note: row.note,
    periodStart: toIso(row.period_start),
    periodEnd: toIso(row.period_end),
  }
}

function toRule(row: RuleRow): ReminderRule {
  return {
    id: row.id,
    type: row.kind as ReminderRule['type'],
    value: row.value,
    unit: row.unit as ReminderRule['unit'],
    repeatInterval: row.repeat_interval,
    repeatUntil: row.repeat_until as ReminderRule['repeatUntil'],
    acknowledgedAt: row.acknowledged_at === null ? null : new Date(row.acknowledged_at).toISOString(),
    isEnabled: row.enabled === 1,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export class SubscriptionsStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * One shelf of subscriptions.
   *
   * `live` is the default and the only thing the scheduler, the overview and the app's first paint ask
   * for, which is what keeps a trashed subscription from renewing itself or sending reminders while
   * nobody is looking at it.
   */
  async list(context: StoreContext, view: 'live' | 'trash' = 'live'): Promise<SubscriptionItem[]> {
    const now = context.now ?? Date.now()
    const shelf = view === 'trash' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'
    const order = view === 'trash' ? 'deleted_at DESC' : 'expiry_date'
    const [items, payments, rules] = await Promise.all([
      this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM sub_item WHERE user_id = ?1 AND ${shelf} ORDER BY ${order}`)
        .bind(this.userId).all<ItemRow>(),
      this.db.prepare(
        `SELECT subscription_id, COUNT(*) AS count, SUM(amount) AS total
           FROM sub_payment WHERE user_id = ?1 GROUP BY subscription_id`,
      ).bind(this.userId).all<{ subscription_id: string; count: number; total: number | null }>(),
      this.db.prepare(`SELECT ${RULE_COLUMNS} FROM sub_reminder_rule WHERE user_id = ?1`)
        .bind(this.userId).all<RuleRow>(),
    ])

    const paid = new Map(payments.results.map((row) => [row.subscription_id, row]))
    const bySubscription = new Map<string, ReminderRule[]>()
    for (const row of rules.results) {
      const list = bySubscription.get(row.subscription_id) ?? []
      list.push(toRule(row))
      bySubscription.set(row.subscription_id, list)
    }

    return items.results.map((row) => this.toItem(
      row,
      context,
      now,
      paid.get(row.id),
      bySubscription.get(row.id) ?? [],
    ))
  }

  async get(id: string, context: StoreContext): Promise<SubscriptionDetail | null> {
    const now = context.now ?? Date.now()
    const row = await this.itemRow(id)
    if (!row) return null
    const [payments, rules] = await Promise.all([this.paymentRows(id), this.ruleRows(id)])
    const mapped = rules.map(toRule)
    const paid = {
      count: payments.length,
      total: payments.reduce((sum, payment) => sum + payment.amount, 0),
    }
    const expiryIso = toIso(row.expiry_date)!
    const nowIso = new Date(now).toISOString()
    return {
      item: this.toItem(row, context, now, paid, mapped),
      payments: payments.map(toPayment),
      rules: mapped,
      nextReminder: soonestFire(mapped, expiryIso, nowIso),
      upcoming: mapped
        .map((rule) => ({ rule, at: getNextFireTime(rule, expiryIso, nowIso) }))
        .filter((entry): entry is { rule: ReminderRule; at: string } => entry.at !== null)
        .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
        .map((entry) => ({
          ruleId: entry.rule.id,
          type: entry.rule.type,
          value: entry.rule.value,
          unit: entry.rule.unit,
          nextFireTime: entry.at,
        })),
    }
  }

  async create(input: SubscriptionInput, context: StoreContext): Promise<SubscriptionDetail> {
    const now = context.now ?? Date.now()
    const id = newId()
    const expiry = this.resolveExpiry(input, context, now)
    const amount = input.amount === undefined || input.amount === null ? null : roundMoney(input.amount)
    const currency = input.currency ?? 'CNY'
    const startDate = toMs(input.startDate ?? null)
    const createdAt = now

    const statements = [
      this.db.prepare(
        `INSERT INTO sub_item (${ITEM_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, NULL, ?19, ?20)`,
      ).bind(
        this.userId,
        id,
        input.name,
        (input.customType ?? '').trim(),
        (input.category ?? '').trim(),
        amount,
        currency,
        startDate,
        expiry,
        Math.max(1, Math.trunc(input.periodValue ?? 1)),
        input.periodUnit ?? 'month',
        input.subscriptionMode ?? 'cycle',
        input.useLunar ? 1 : 0,
        input.isActive === false ? 0 : 1,
        input.autoRenew === false ? 0 : 1,
        input.notes ?? '',
        startDate ?? createdAt,
        toMs(input.trialEndsAt ?? null),
        createdAt,
        createdAt,
      ),
    ]

    if (amount !== null) {
      statements.push(this.db.prepare(
        `INSERT INTO sub_payment (${PAYMENT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        this.userId,
        newId(),
        id,
        startDate ?? createdAt,
        amount,
        currency,
        'initial',
        '',
        startDate ?? createdAt,
        expiry,
        createdAt,
      ))
    }

    const rules = input.reminderRules && input.reminderRules.length > 0
      ? input.reminderRules.slice(0, RULES_LIMIT).map((rule) => normalizeRule(rule, newId, now))
      : defaultPresetRules(newId, now)
    for (const rule of rules) statements.push(this.insertRuleStatement(id, rule))

    await this.db.batch(statements)
    await this.registerLabels('type', input.customType)
    await this.registerLabels('category', input.category)
    return (await this.get(id, context))!
  }

  async update(id: string, input: SubscriptionInput, context: StoreContext): Promise<SubscriptionDetail | null> {
    const now = context.now ?? Date.now()
    const existing = await this.itemRow(id)
    if (!existing) return null

    const expiry = this.resolveExpiry({
      ...input,
      periodValue: input.periodValue ?? existing.period_value,
      periodUnit: (input.periodUnit ?? existing.period_unit) as SubscriptionInput['periodUnit'],
      useLunar: input.useLunar ?? existing.use_lunar === 1,
    }, context, now)

    const amount = input.amount === undefined
      ? existing.amount
      : input.amount === null ? null : roundMoney(input.amount)
    const currency = input.currency ?? existing.currency
    const startDate = input.startDate === undefined ? existing.start_date : toMs(input.startDate)
    const category = input.category === undefined ? existing.category : input.category.trim()

    await this.db.prepare(
      `UPDATE sub_item SET name = ?3, custom_type = ?4, category = ?5, amount = ?6, currency = ?7,
         start_date = ?8, expiry_date = ?9, period_value = ?10, period_unit = ?11,
         subscription_mode = ?12, use_lunar = ?13, is_active = ?14, auto_renew = ?15, notes = ?16,
         last_payment_date = ?17, trial_ends_at = ?19, updated_at = ?18
       WHERE user_id = ?1 AND id = ?2`,
    ).bind(
      this.userId,
      id,
      input.name,
      (input.customType ?? existing.custom_type).trim(),
      category,
      amount,
      currency,
      startDate,
      expiry,
      Math.max(1, Math.trunc(input.periodValue ?? existing.period_value)),
      input.periodUnit ?? existing.period_unit,
      input.subscriptionMode ?? existing.subscription_mode,
      (input.useLunar ?? existing.use_lunar === 1) ? 1 : 0,
      (input.isActive ?? existing.is_active === 1) ? 1 : 0,
      (input.autoRenew ?? existing.auto_renew === 1) ? 1 : 0,
      input.notes ?? existing.notes,
      existing.last_payment_date,
      now,
      input.trialEndsAt === undefined
        ? existing.trial_ends_at
        : toMs(input.trialEndsAt),
    ).run()

    await this.syncInitialPayment(id, existing, amount, currency, startDate, expiry, now)
    // An absent `reminderRules` means "not what this edit is about"; an empty array means "no rules",
    // which is a thing a reader can genuinely decide and must be able to say.
    if (input.reminderRules) await this.replaceRules(id, input.reminderRules)
    await this.registerLabels('type', input.customType ?? existing.custom_type)
    await this.registerLabels('category', category)
    return this.get(id, context)
  }

  /**
   * Move a subscription to the trash.
   *
   * Only the row's own timestamp changes: the receipts and the rules stay, because they are the reason
   * the row is worth keeping. A trashed subscription is excluded from `list('live')`, so it stops
   * renewing, reminding and counting towards a total the moment it lands here — no other bookkeeping.
   */
  async trash(id: string, context: StoreContext): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE sub_item SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
    ).bind(this.userId, id, context.now ?? Date.now()).run()
    return (result.meta.changes ?? 0) > 0
  }

  async restore(id: string, context: StoreContext): Promise<SubscriptionDetail | null> {
    const result = await this.db.prepare(
      `UPDATE sub_item SET deleted_at = NULL, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NOT NULL`,
    ).bind(this.userId, id, context.now ?? Date.now()).run()
    if (!(result.meta.changes ?? 0)) return null
    return this.get(id, context)
  }

  /** Erase a subscription and everything under it. This is the one that cannot be undone. */
  async purge(id: string): Promise<boolean> {
    const existing = await this.itemRow(id)
    if (!existing) return false
    await this.db.batch([
      this.db.prepare(`DELETE FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM sub_reminder_rule WHERE user_id = ?1 AND subscription_id = ?2`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM sub_notify_log WHERE user_id = ?1 AND subscription_id = ?2`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM sub_item WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id),
    ])
    return true
  }

  /** Every trashed row, gone for good. Returns how many went. */
  async emptyTrash(): Promise<number> {
    const trashed = await this.db.prepare(
      `SELECT id FROM sub_item WHERE user_id = ?1 AND deleted_at IS NOT NULL`,
    ).bind(this.userId).all<{ id: string }>()
    const ids = trashed.results.map((row) => row.id)
    if (!ids.length) return 0
    const statements = ids.flatMap((id) => [
      this.db.prepare(`DELETE FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM sub_reminder_rule WHERE user_id = ?1 AND subscription_id = ?2`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM sub_notify_log WHERE user_id = ?1 AND subscription_id = ?2`).bind(this.userId, id),
      this.db.prepare(`DELETE FROM sub_item WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id),
    ])
    // D1 caps a batch well below a thousand statements, and four per row means a reader with 300
    // trashed subscriptions would have had it fail halfway through the emptying.
    for (let offset = 0; offset < statements.length; offset += PURGE_CHUNK) {
      await this.db.batch(statements.slice(offset, offset + PURGE_CHUNK))
    }
    return ids.length
  }

  /**
   * Apply one action to a named set of subscriptions.
   *
   * Ids that are not the account's, or no longer exist, are skipped rather than failing the whole call —
   * a reader who selected twelve and had one restored elsewhere should not have the other eleven refuse.
   * The count that comes back is what actually changed, so the toast can be true.
   */
  async bulk(ids: readonly string[], action: BulkAction, options: { category?: string } = {}): Promise<number> {
    const unique = [...new Set(ids)].filter(Boolean).slice(0, BULK_LIMIT)
    if (!unique.length) return 0
    if (action === 'trash') {
      let changed = 0
      for (const id of unique) {
        const result = await this.db.prepare(
          `UPDATE sub_item SET deleted_at = ?3, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
        ).bind(this.userId, id, Date.now()).run()
        changed += (result.meta.changes ?? 0) > 0 ? 1 : 0
      }
      return changed
    }
    const set = action === 'activate' ? 'is_active = 1'
      : action === 'deactivate' ? 'is_active = 0'
        : 'category = ?3'
    let changed = 0
    for (const id of unique) {
      const result = action === 'set_category'
        ? await this.db.prepare(`UPDATE sub_item SET ${set}, updated_at = ?4 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`)
          .bind(this.userId, id, (options.category ?? '').trim(), Date.now()).run()
        : await this.db.prepare(`UPDATE sub_item SET ${set}, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`)
          .bind(this.userId, id, Date.now()).run()
      changed += (result.meta.changes ?? 0) > 0 ? 1 : 0
    }
    if (action === 'set_category') await this.registerLabels('category', options.category ?? '')
    return changed
  }

  async trashCount(): Promise<number> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM sub_item WHERE user_id = ?1 AND deleted_at IS NOT NULL`,
    ).bind(this.userId).first<{ count: number }>()
    return row?.count ?? 0
  }

  async setActive(id: string, isActive: boolean, context: StoreContext): Promise<SubscriptionDetail | null> {
    const existing = await this.itemRow(id)
    if (!existing) return null
    await this.db.prepare(`UPDATE sub_item SET is_active = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`)
      .bind(this.userId, id, isActive ? 1 : 0, context.now ?? Date.now())
      .run()
    return this.get(id, context)
  }

  /**
   * Renew by hand: a new period, a receipt for it, and a start date that follows the chosen mode.
   *
   * `reset` means "this payment starts a fresh term from the day it was made", which is what a plan
   * bought mid-cycle means; `cycle` means "extend from where the current term ends", which is what a
   * reader paying early expects. Both are the reference project's own two modes.
   */
  async renew(id: string, options: RenewOptions, context: StoreContext): Promise<SubscriptionDetail | null> {
    const now = context.now ?? Date.now()
    const existing = await this.itemRow(id)
    if (!existing) return null

    const paymentAt = toMs(options.paymentDate) ?? now
    const multiplier = Math.min(120, Math.max(1, Math.trunc(options.periodMultiplier ?? 1)))
    const amount = options.amount === undefined
      ? existing.amount ?? 0
      : roundMoney(options.amount)
    const mode = existing.subscription_mode === 'reset' ? 'reset' : 'cycle'
    const currentExpiry = existing.expiry_date
    const startAt = mode === 'reset'
      ? paymentAt
      : currentExpiry > paymentAt ? currentExpiry : paymentAt

    let expiry: number
    if (existing.use_lunar === 1) {
      expiry = this.addLunarPeriods(startAt, existing.period_value * multiplier, existing.period_unit as 'day' | 'month' | 'year', context.timezone)
    } else {
      expiry = addCalendarPeriodInTimezone(
        startAt,
        existing.period_value * multiplier,
        existing.period_unit as 'day' | 'month' | 'year',
        context.timezone,
      ).getTime()
    }

    const paymentId = newId()
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO sub_payment (${PAYMENT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        this.userId,
        paymentId,
        id,
        paymentAt,
        amount,
        existing.currency,
        'manual',
        options.note ?? '',
        startAt,
        expiry,
        now,
      ),
      this.db.prepare(
        `UPDATE sub_item SET start_date = ?3, expiry_date = ?4, last_payment_date = ?5, updated_at = ?6
          WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, id, startAt, expiry, paymentAt, now),
      this.clearAcknowledgementsStatement(id),
    ])
    await this.trimPayments(id, context.paymentLimit)
    return this.get(id, context)
  }

  /**
   * Roll an expired subscription forward, writing the receipt that says so.
   *
   * This is what an auto-renewing plan does on the morning it lapses, and it runs before the reminder
   * rules are evaluated — a subscription that renewed itself is no longer overdue, and telling a reader
   * it expired when it did not would be the one notification they remember.
   *
   * `cycle` continues from the old expiry date, so a lapse of three days still leaves the next term
   * ending on the anniversary; `reset` starts today, which is what a plan that was dormant means. Both
   * are the reference project's two modes, and both loop rather than adding a single period: a
   * subscription untouched for a year is caught up in one pass.
   */
  async autoRenew(id: string, context: StoreContext): Promise<SubscriptionItem | null> {
    const now = context.now ?? Date.now()
    const existing = await this.itemRow(id)
    if (!existing || existing.auto_renew !== 1 || existing.expiry_date > now) return null

    const mode = existing.subscription_mode === 'reset' ? 'reset' : 'cycle'
    const unit = existing.period_unit as 'day' | 'month' | 'year'
    let expiry = existing.expiry_date
    let periods = 0
    const ceiling = existing.use_lunar === 1 ? 60 : 120

    while (expiry <= now && periods < ceiling) {
      if (mode === 'reset' && existing.use_lunar !== 1) expiry = now
      expiry = existing.use_lunar === 1
        ? this.addLunarPeriods(expiry, existing.period_value, unit, context.timezone)
        : addCalendarPeriodInTimezone(expiry, existing.period_value, unit, context.timezone).getTime()
      periods++
    }
    if (periods === 0) return null

    const startAt = mode === 'reset' ? now : existing.expiry_date
    const note = periods > 1 ? `${mode === 'reset' ? 'reset' : 'cycle'} x${periods}` : mode
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO sub_payment (${PAYMENT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        this.userId,
        newId(),
        id,
        now,
        existing.amount ?? 0,
        existing.currency,
        'auto',
        note,
        startAt,
        expiry,
        now,
      ),
      this.db.prepare(
        `UPDATE sub_item SET start_date = ?3, expiry_date = ?4, last_payment_date = ?5, updated_at = ?6
          WHERE user_id = ?1 AND id = ?2`,
      ).bind(this.userId, id, startAt, expiry, now, now),
      this.clearAcknowledgementsStatement(id),
    ])
    await this.trimPayments(id, context.paymentLimit)
    const detail = await this.get(id, context)
    return detail?.item ?? null
  }

  /** Every rule the account owns, grouped by subscription, for a sweep that must not query per item. */
  async allRules(): Promise<Map<string, ReminderRule[]>> {
    const { results } = await this.db.prepare(
      `SELECT ${RULE_COLUMNS} FROM sub_reminder_rule WHERE user_id = ?1 ORDER BY value DESC`,
    ).bind(this.userId).all<RuleRow>()
    const grouped = new Map<string, ReminderRule[]>()
    for (const row of results) {
      const list = grouped.get(row.subscription_id) ?? []
      list.push(toRule(row))
      grouped.set(row.subscription_id, list)
    }
    return grouped
  }

  async updatePayment(
    id: string,
    paymentId: string,
    patch: { date?: string; amount?: number; currency?: string; note?: string },
    context: StoreContext,
  ): Promise<SubscriptionDetail | null> {
    const existing = await this.itemRow(id)
    if (!existing) return null
    const payment = await this.db.prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`,
    ).bind(this.userId, id, paymentId).first<PaymentRow>()
    if (!payment) return null

    const paidAt = toMs(patch.date) ?? payment.paid_at
    await this.db.prepare(
      `UPDATE sub_payment SET paid_at = ?4, amount = ?5, currency = ?6, note = ?7
        WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`,
    ).bind(
      this.userId,
      id,
      paymentId,
      paidAt,
      patch.amount === undefined ? payment.amount : roundMoney(patch.amount),
      patch.currency ?? payment.currency,
      patch.note ?? payment.note,
    ).run()

    const latest = await this.db.prepare(
      `SELECT MAX(paid_at) AS latest FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2`,
    ).bind(this.userId, id).first<{ latest: number | null }>()
    await this.db.prepare(`UPDATE sub_item SET last_payment_date = ?3 WHERE user_id = ?1 AND id = ?2`)
      .bind(this.userId, id, latest?.latest ?? null)
      .run()
    return this.get(id, context)
  }

  /**
   * Remove a receipt, and put the expiry date back where that receipt had left it.
   *
   * A receipt is the only record of why the date moved, so deleting one without moving the date back
   * would leave a subscription whose history does not explain its own expiry — and a reader who
   * deleted the wrong row would have no way to notice.
   */
  async deletePayment(id: string, paymentId: string, context: StoreContext): Promise<SubscriptionDetail | null> {
    const existing = await this.itemRow(id)
    if (!existing) return null
    const payment = await this.db.prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`,
    ).bind(this.userId, id, paymentId).first<PaymentRow>()
    if (!payment) return null

    await this.db.prepare(`DELETE FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`)
      .bind(this.userId, id, paymentId)
      .run()

    const remaining = await this.paymentRows(id)
    let expiry = existing.expiry_date
    let lastPaid: number | null = existing.last_payment_date
    if (remaining.length > 0) {
      const byPeriodEnd = [...remaining].sort((left, right) => (right.period_end ?? 0) - (left.period_end ?? 0))
      if (byPeriodEnd[0]?.period_end) expiry = byPeriodEnd[0].period_end
      const byDate = [...remaining].sort((left, right) => right.paid_at - left.paid_at)
      lastPaid = byDate[0]?.paid_at ?? null
    } else {
      if (payment.period_start) expiry = payment.period_start
      lastPaid = existing.start_date ?? existing.created_at ?? expiry
    }

    await this.db.prepare(`UPDATE sub_item SET expiry_date = ?3, last_payment_date = ?4, updated_at = ?5 WHERE user_id = ?1 AND id = ?2`)
      .bind(this.userId, id, expiry, lastPaid, context.now ?? Date.now())
      .run()
    return this.get(id, context)
  }

  async replaceRules(id: string, rules: readonly ReminderRuleInput[]): Promise<ReminderRule[] | null> {
    const existing = await this.itemRow(id)
    if (!existing) return null
    const normalized = rules.slice(0, RULES_LIMIT).map((rule) => normalizeRule(rule, newId))
    await this.db.batch([
      this.db.prepare(`DELETE FROM sub_reminder_rule WHERE user_id = ?1 AND subscription_id = ?2`).bind(this.userId, id),
      ...normalized.map((rule) => this.insertRuleStatement(id, rule)),
    ])
    return normalized
  }

  async addRule(id: string, input: ReminderRuleInput): Promise<ReminderRule | null> {
    const existing = await this.itemRow(id)
    if (!existing) return null
    const current = await this.ruleRows(id)
    if (current.length >= RULES_LIMIT) return null
    const rule = normalizeRule(input, newId)
    await this.insertRuleStatement(id, rule).run()
    return rule
  }

  async updateRule(id: string, ruleId: string, patch: ReminderRuleInput): Promise<ReminderRule | null> {
    const current = await this.db.prepare(
      `SELECT ${RULE_COLUMNS} FROM sub_reminder_rule WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`,
    ).bind(this.userId, id, ruleId).first<RuleRow>()
    if (!current) return null
    const merged = normalizeRule({ ...toRule(current), ...patch, id: ruleId }, newId)
    await this.db.prepare(
      `UPDATE sub_reminder_rule SET kind = ?4, value = ?5, unit = ?6, repeat_interval = ?7,
         repeat_until = ?8, acknowledged_at = ?9, enabled = ?10
       WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`,
    ).bind(
      this.userId,
      id,
      ruleId,
      merged.type,
      merged.value,
      merged.unit,
      merged.repeatInterval,
      merged.repeatUntil,
      merged.acknowledgedAt ? Date.parse(merged.acknowledgedAt) : null,
      merged.isEnabled ? 1 : 0,
    ).run()
    return merged
  }

  /**
   * Mark a rule as seen, which is what makes `repeat_until: acknowledged` mean anything.
   *
   * Scoped to one rule rather than the subscription: a reader who has dealt with a lapse does not always
   * mean "and also stop the three-days-before rule I set for next term", and a blanket mute would have
   * to be un-muted by hand before the next cycle.
   */
  async acknowledgeRule(id: string, ruleId: string, context: StoreContext): Promise<ReminderRule | null> {
    const current = await this.db.prepare(
      `SELECT ${RULE_COLUMNS} FROM sub_reminder_rule WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`,
    ).bind(this.userId, id, ruleId).first<RuleRow>()
    if (!current) return null
    await this.db.prepare(`UPDATE sub_reminder_rule SET acknowledged_at = ?4 WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`)
      .bind(this.userId, id, ruleId, context.now ?? Date.now())
      .run()
    return { ...toRule(current), acknowledgedAt: new Date(context.now ?? Date.now()).toISOString() }
  }

  /** A new term means the reader has not seen this one's expiry, so a mute must not carry into it. */
  private clearAcknowledgementsStatement(subscriptionId: string): D1PreparedStatement {
    return this.db.prepare(`UPDATE sub_reminder_rule SET acknowledged_at = NULL WHERE user_id = ?1 AND subscription_id = ?2`)
      .bind(this.userId, subscriptionId)
  }

  async deleteRule(id: string, ruleId: string): Promise<boolean> {
    const result = await this.db.prepare(
      `DELETE FROM sub_reminder_rule WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`,
    ).bind(this.userId, id, ruleId).run()
    return (result.meta.changes ?? 0) > 0
  }

  /**
   * The registry behind one kind of label.
   *
   * Interpolated into SQL rather than bound, because the value is one of two literals derived from a
   * validated union — a table name cannot be a parameter — and a caller that slips past
   * `isLabelKind` is refused at the route before it reaches here.
   */
  private static labelTable(kind: LabelKind): 'sub_type' | 'sub_category' {
    return kind === 'type' ? 'sub_type' : 'sub_category'
  }

  async listLabels(kind: LabelKind): Promise<LabelEntry[]> {
    const { results } = await this.db.prepare(
      `SELECT name, icon, color FROM ${SubscriptionsStore.labelTable(kind)} WHERE user_id = ?1 ORDER BY name`,
    ).bind(this.userId).all<{ name: string; icon: string; color: string }>()
    return results.map((row) => ({ name: row.name, icon: row.icon, color: row.color }))
  }

  /**
   * Learn every label one raw field names, keeping any face the reader already gave them.
   *
   * This is where the reference project's bug is fixed: it stored the whole composite string, so
   * a two-tag value came back as one suggestion while the filter rail showed its two tags separately.
   * Splitting on write means the suggestion list and the rail are built from the same rows.
   *
   * `ON CONFLICT DO NOTHING` rather than a upsert that blanks `icon`/`color`: a label the reader
   * decorated must keep its face when another subscription starts using it.
   */
  async registerLabels(kind: LabelKind, raw: string | null | undefined): Promise<void> {
    const names = labelNamesOf(raw, kind)
    if (!names.length) return
    const table = SubscriptionsStore.labelTable(kind)
    const statements = names.map((name) => this.db.prepare(
      `INSERT INTO ${table} (user_id, name, icon, color, created_at) VALUES (?1, ?2, '', '', ?3)
       ON CONFLICT DO NOTHING`,
    ).bind(this.userId, name.slice(0, LABEL_MAX), Date.now()))
    await this.db.batch(statements)
  }

  /**
   * Rename a label and move every subscription that carried the old one.
   *
   * A rename that only touched the registry would leave twelve rows saying the old word while the rail
   * showed the new one — the face and the name would disagree, which is worse than no rename at all.
   *
   * Categories are composite strings, so their rewrite goes through TypeScript: split, substitute the
   * one token, rejoin. Types are a single label and go straight through SQL.
   */
  async renameLabel(kind: LabelKind, from: string, to: string): Promise<boolean> {
    const target = to.trim().slice(0, LABEL_MAX)
    const source = from.trim()
    if (!source || !target || source === target) return false
    const table = SubscriptionsStore.labelTable(kind)
    const clash = await this.db.prepare(
      `SELECT 1 AS hit FROM ${table} WHERE user_id = ?1 AND name = ?2`,
    ).bind(this.userId, target).first()
    if (clash) return false

    const statements = [
      this.db.prepare(`UPDATE ${table} SET name = ?2 WHERE user_id = ?1 AND name = ?3`).bind(this.userId, target, source),
    ]
    if (kind === 'type') {
      statements.push(this.db.prepare(
        `UPDATE sub_item SET custom_type = ?2, updated_at = ?3 WHERE user_id = ?1 AND custom_type = ?4`,
      ).bind(this.userId, target, Date.now(), source))
    } else {
      const { results } = await this.db.prepare(
        `SELECT id, category FROM sub_item WHERE user_id = ?1 AND category LIKE ?2`,
      ).bind(this.userId, `%${source}%`).all<{ id: string; category: string }>()
      const now = Date.now()
      for (const row of results) {
        const tokens = labelNamesOf(row.category, 'category')
        if (!tokens.includes(source)) continue
        const rebuilt = tokens.map((token) => token === source ? target : token).join('/')
        statements.push(this.db.prepare(
          `UPDATE sub_item SET category = ?2, updated_at = ?3 WHERE user_id = ?1 AND id = ?4`,
        ).bind(this.userId, rebuilt, now, row.id))
      }
    }
    await this.db.batch(statements)
    return true
  }

  /**
   * Set a label's face.
   *
   * Only the axes the caller names are written: a reader who changes a colour has not asked to lose the
   * icon they picked last week, and a picker that sent the *resolved* icon alongside it would quietly
   * promote a default into a choice — after which a preset change could never reach that label again.
   * An explicit null is still a clearing, which is what the "reset" swatch means.
   */
  async setLabelStyle(kind: LabelKind, name: string, style: { icon?: string | null; color?: string | null }): Promise<LabelEntry | null> {
    const label = name.trim().slice(0, LABEL_MAX)
    if (!label) return null
    const table = SubscriptionsStore.labelTable(kind)
    const existing = await this.db.prepare(`SELECT icon, color FROM ${table} WHERE user_id = ?1 AND name = ?2`)
      .bind(this.userId, label)
      .first<{ icon: string; color: string }>()
    const icon = 'icon' in style ? (normalizeIcon(style.icon) ?? '') : existing?.icon ?? ''
    const color = 'color' in style ? (normalizeColor(style.color) ?? '') : existing?.color ?? ''
    await this.db.prepare(
      `INSERT INTO ${table} (user_id, name, icon, color, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id, name) DO UPDATE SET icon = excluded.icon, color = excluded.color`,
    ).bind(this.userId, label, icon, color, Date.now()).run()
    return { name: label, icon, color }
  }

  /**
   * Forget a label.
   *
   * Only the registry row goes: the subscriptions that still carry the word keep it, because deleting a
   * suggestion is not the same act as editing twelve records, and a reader who changes their mind about
   * the second one can undo it while they cannot undo the first.
   */
  async removeLabel(kind: LabelKind, name: string): Promise<boolean> {
    const label = name.trim()
    if (!label) return false
    const result = await this.db.prepare(
      `DELETE FROM ${SubscriptionsStore.labelTable(kind)} WHERE user_id = ?1 AND name = ?2`,
    ).bind(this.userId, label).run()
    return (result.meta.changes ?? 0) > 0
  }

  /** Every payment the account has, newest first, for the dashboard's aggregates. */
  async allPayments(): Promise<Array<{ subscriptionId: string; paidAt: number; amount: number; currency: string; note: string }>> {
    const { results } = await this.db.prepare(
      `SELECT subscription_id, paid_at, amount, currency, note FROM sub_payment
        WHERE user_id = ?1 AND amount > 0 ORDER BY paid_at DESC`,
    ).bind(this.userId).all<{ subscription_id: string; paid_at: number; amount: number; currency: string; note: string }>()
    return results.map((row) => ({
      subscriptionId: row.subscription_id,
      paidAt: row.paid_at,
      amount: row.amount,
      currency: row.currency,
      note: row.note,
    }))
  }

  private async itemRow(id: string): Promise<ItemRow | null> {
    return this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM sub_item WHERE user_id = ?1 AND id = ?2`)
      .bind(this.userId, id)
      .first<ItemRow>()
  }

  private async paymentRows(id: string): Promise<PaymentRow[]> {
    const { results } = await this.db.prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2 ORDER BY paid_at DESC`,
    ).bind(this.userId, id).all<PaymentRow>()
    return results
  }

  private async ruleRows(id: string): Promise<RuleRow[]> {
    const { results } = await this.db.prepare(
      `SELECT ${RULE_COLUMNS} FROM sub_reminder_rule WHERE user_id = ?1 AND subscription_id = ?2 ORDER BY value DESC`,
    ).bind(this.userId, id).all<RuleRow>()
    return results
  }

  private insertRuleStatement(subscriptionId: string, rule: ReminderRule): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO sub_reminder_rule (${RULE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(
      this.userId,
      rule.id,
      subscriptionId,
      rule.type,
      rule.value,
      rule.unit,
      rule.repeatInterval,
      rule.repeatUntil,
      rule.acknowledgedAt ? Date.parse(rule.acknowledgedAt) : null,
      rule.isEnabled ? 1 : 0,
      Date.parse(rule.createdAt),
    )
  }

  private toItem(
    row: ItemRow,
    context: StoreContext,
    now: number,
    paid: { count: number; total: number | null } | undefined,
    rules: ReminderRule[],
  ): SubscriptionItem {
    const expiry = row.expiry_date
    const daysRemaining = Math.round(
      (getTimezoneMidnightTimestamp(expiry, context.timezone) - getTimezoneMidnightTimestamp(now, context.timezone)) / 86_400_000,
    )
    const next = rules.length > 0
      ? soonestFire(rules, new Date(expiry).toISOString(), new Date(now).toISOString())
      : null
    return {
      id: row.id,
      name: row.name,
      customType: row.custom_type,
      category: row.category,
      amount: row.amount === null ? null : roundMoney(row.amount),
      currency: row.currency as SubscriptionItem['currency'],
      startDate: toIso(row.start_date),
      expiryDate: new Date(expiry).toISOString(),
      periodValue: row.period_value,
      periodUnit: row.period_unit as SubscriptionItem['periodUnit'],
      subscriptionMode: row.subscription_mode as SubscriptionItem['subscriptionMode'],
      useLunar: row.use_lunar === 1,
      isActive: row.is_active === 1,
      autoRenew: row.auto_renew === 1,
      notes: row.notes,
      lastPaymentDate: toIso(row.last_payment_date),
      trialEndsAt: toIso(row.trial_ends_at),
      deletedAt: toIso(row.deleted_at),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      daysRemaining,
      hoursRemaining: Math.round((expiry - now) / 3_600_000),
      trialDaysRemaining: row.trial_ends_at === null
        ? null
        : Math.round(
          (getTimezoneMidnightTimestamp(row.trial_ends_at, context.timezone) - getTimezoneMidnightTimestamp(now, context.timezone)) / 86_400_000,
        ),
      nextReminderAt: next?.nextFireTime ?? null,
      paymentCount: paid?.count ?? 0,
      paidTotal: roundMoney(paid?.total ?? 0),
    }
  }

  /**
   * The expiry date a create or an update should store: the one asked for, or the first future one if
   * that date is already behind us.
   *
   * A reader adding a subscription that lapsed last week means "this is still running", so the date is
   * walked forward a period at a time rather than saved in the past — where it would immediately be
   * treated as overdue and, with auto-renew on, renew itself on the next tick anyway.
   */
  private resolveExpiry(input: SubscriptionInput, context: StoreContext, now: number): number {
    const requested = toMs(input.expiryDate)
    if (requested === null) throw new Error('invalid_expiry')
    const periodValue = Math.max(1, Math.trunc(input.periodValue ?? 1))
    const periodUnit = (input.periodUnit ?? 'month') as 'day' | 'month' | 'year'
    const today = getTimezoneMidnightTimestamp(now, context.timezone)
    let cursor = requested
    let guard = 0
    while (cursor < today && guard < 1200) {
      cursor = input.useLunar
        ? this.addLunarPeriods(cursor, periodValue, periodUnit, context.timezone)
        : addCalendarPeriodInTimezone(cursor, periodValue, periodUnit, context.timezone).getTime()
      guard++
    }
    return cursor
  }

  private addLunarPeriods(from: number, value: number, unit: 'day' | 'month' | 'year', timezone: string): number {
    const parts = getTimezoneDateParts(from, timezone)
    const lunar = solar2lunar(parts.year, parts.month, parts.day)
    if (!lunar) throw new Error('lunar_out_of_range')
    const next = addLunarPeriod(lunar, value, unit)
    const solar = lunar2solar(next)
    if (!solar) throw new Error('lunar_out_of_range')
    return getTimestampForTimezoneParts(solar, timezone)
  }

  /**
   * Keep the first receipt in step with the subscription's price.
   *
   * The initial receipt is what a reader's own history starts from, so a price they typed wrong should
   * be correctable — but only that one row: every later receipt records what was actually charged and
   * must not be rewritten by an edit to today's price.
   */
  private async syncInitialPayment(
    id: string,
    existing: ItemRow,
    amount: number | null,
    currency: string,
    startDate: number | null,
    expiry: number,
    now: number,
  ): Promise<void> {
    const initial = await this.db.prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2 AND kind = 'initial' ORDER BY paid_at LIMIT 1`,
    ).bind(this.userId, id).first<PaymentRow>()

    const priceChanged = amount !== existing.amount || currency !== existing.currency
    if (initial && priceChanged) {
      await this.db.prepare(`UPDATE sub_payment SET amount = ?4, currency = ?5 WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`)
        .bind(this.userId, id, initial.id, amount ?? 0, currency)
        .run()
      return
    }
    if (!initial && amount !== null && amount > 0) {
      const paidAt = startDate ?? existing.created_at
      await this.db.prepare(
        `INSERT INTO sub_payment (${PAYMENT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(this.userId, newId(), id, paidAt, amount, currency, 'initial', '', paidAt, expiry, now).run()
    }
  }

  /**
   * Trim a history to the account's ceiling, always keeping the first receipt.
   *
   * Without the exception, a subscription older than the ceiling would lose the row that records when
   * it started — and the "initial" receipt is the only thing that says so.
   */
  private async trimPayments(id: string, limit: number): Promise<void> {
    const rows = await this.db.prepare(
      `SELECT id, paid_at, kind FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2 ORDER BY paid_at ASC`,
    ).bind(this.userId, id).all<{ id: string; paid_at: number; kind: string }>()
    const total = rows.results.length
    if (total <= limit) return
    const initial = rows.results.find((row) => row.kind === 'initial')
    const keep = new Set<string>()
    if (initial) keep.add(initial.id)
    for (const row of rows.results.slice(total - (limit - keep.size))) keep.add(row.id)
    const doomed = rows.results.filter((row) => !keep.has(row.id))
    if (doomed.length === 0) return
    await this.db.batch(doomed.map((row) => this.db.prepare(
      `DELETE FROM sub_payment WHERE user_id = ?1 AND subscription_id = ?2 AND id = ?3`,
    ).bind(this.userId, id, row.id)))
  }
}

/** The context a store needs, read off an account's settings row. */
export function storeContext(settings: SubscriptionSettings, now?: number): StoreContext {
  return { timezone: settings.timezone, paymentLimit: settings.paymentHistoryLimit, now }
}
