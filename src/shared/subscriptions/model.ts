/**
 * The subscription app's vocabulary: what a subscription is, what a payment is, and what a reminder
 * rule means — shared by the worker that stores them and the browser that draws them.
 *
 * Times cross the wire as ISO 8601 and are stored as epoch milliseconds. The reference project kept
 * ISO strings in KV; D1 sorts and compares integers, so the conversion happens at the repository
 * boundary and nowhere else. Every function here is pure, which is what lets the scheduler, the route
 * and a component agree about a subscription without any of them owning the rules.
 */

export const PERIOD_UNITS = ['day', 'month', 'year'] as const
export type PeriodUnit = (typeof PERIOD_UNITS)[number]

export const SUBSCRIPTION_MODES = ['cycle', 'reset'] as const
export type SubscriptionMode = (typeof SUBSCRIPTION_MODES)[number]

export const CURRENCY_CODES = ['CNY', 'USD', 'HKD', 'TWD', 'JPY', 'EUR', 'GBP', 'KRW', 'TRY'] as const
export type CurrencyCode = (typeof CURRENCY_CODES)[number]

export const REMINDER_KINDS = ['before_expiry', 'on_expiry', 'after_expiry'] as const
export type ReminderKind = (typeof REMINDER_KINDS)[number]

export const REMINDER_UNITS = ['days', 'hours'] as const
export type ReminderUnit = (typeof REMINDER_UNITS)[number]

export const REPEAT_UNTIL = ['renewed', 'acknowledged', 'never'] as const
export type RepeatUntil = (typeof REPEAT_UNTIL)[number]

export const CHANNEL_KINDS = [
  'telegram',
  'notifyx',
  'webhook',
  'wechatbot',
  'email',
  'bark',
  'gotify',
  'serverchan',
  'pushplus',
] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export const PAYMENT_KINDS = ['initial', 'manual', 'auto'] as const
export type PaymentKind = (typeof PAYMENT_KINDS)[number]

/** Where a subscription sits relative to its own expiry date, as the list and the detail panel say it. */
export type SubscriptionStatus = 'active' | 'soon' | 'today' | 'expired' | 'disabled'

/** How many days ahead the list calls something "soon" and the overview counts as expiring. */
export const SOON_DAYS = 7

/** The most rules one subscription may carry. Ten is already more than a person reads. */
export const RULES_LIMIT = 10

/** The payment history ceiling, matching the reference project's own bounds. */
export const PAYMENT_LIMIT_MIN = 10
export const PAYMENT_LIMIT_MAX = 1000
export const PAYMENT_LIMIT_DEFAULT = 100

/** Field ceilings. The worker enforces them; the form uses the same numbers for its counters. */
export const NAME_MAX = 120
export const LABEL_MAX = 40
export const NOTES_MAX = 2000
export const PERIOD_VALUE_MAX = 120
export const RULE_VALUE_MAX = 3650
export const REPEAT_INTERVAL_MAX = 720

/** How long a delivery log line is kept, and how long a dedupe marker blocks a repeat. */
export const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const DEDUPE_RETENTION_MS = 48 * 60 * 60 * 1000

/** The language a notification body is written in. Chrome the worker cannot localize per request. */
export const NOTIFY_LOCALES = ['zh-CN', 'en-US'] as const
export type NotifyLocale = (typeof NOTIFY_LOCALES)[number]

/**
 * A subscription as the browser receives it.
 *
 * The fields after `updatedAt` are derived on the server — remaining days, the next rule that will
 * fire, how much has been paid — because they depend on the account's timezone and on "now", and a
 * browser that computed them itself would disagree with the scheduler about both.
 */
export interface SubscriptionItem {
  id: string
  name: string
  customType: string
  category: string
  amount: number | null
  currency: CurrencyCode
  startDate: string | null
  expiryDate: string
  periodValue: number
  periodUnit: PeriodUnit
  subscriptionMode: SubscriptionMode
  useLunar: boolean
  isActive: boolean
  autoRenew: boolean
  notes: string
  lastPaymentDate: string | null
  createdAt: string
  updatedAt: string

  daysRemaining: number
  hoursRemaining: number
  nextReminderAt: string | null
  paymentCount: number
  paidTotal: number
}

/** What a create or a full update sends. Derived fields are ignored if a caller sends them. */
export interface SubscriptionInput {
  name: string
  customType?: string
  category?: string
  amount?: number | null
  currency?: CurrencyCode
  startDate?: string | null
  expiryDate: string
  periodValue?: number
  periodUnit?: PeriodUnit
  subscriptionMode?: SubscriptionMode
  useLunar?: boolean
  isActive?: boolean
  autoRenew?: boolean
  notes?: string
  reminderRules?: ReminderRuleInput[]
}

export interface PaymentRecord {
  id: string
  subscriptionId: string
  paidAt: string
  amount: number
  currency: CurrencyCode
  kind: PaymentKind
  note: string
  periodStart: string | null
  periodEnd: string | null
}

export interface ReminderRule {
  id: string
  type: ReminderKind
  value: number
  unit: ReminderUnit
  repeatInterval: number | null
  repeatUntil: RepeatUntil
  isEnabled: boolean
  createdAt: string
}

export interface ReminderRuleInput {
  id?: string
  type?: ReminderKind
  value?: number
  unit?: ReminderUnit
  repeatInterval?: number | null
  repeatUntil?: RepeatUntil
  isEnabled?: boolean
  createdAt?: string
}

export interface SubscriptionSettings {
  timezone: string
  notificationHours: string[]
  showLunar: boolean
  paymentHistoryLimit: number
  locale: NotifyLocale
  /** The last four characters of the inbound token, or empty when none was ever made. */
  inboundTokenHint: string
}

/** One channel as the settings screen sees it: whether it may send, never what it holds. */
export interface ChannelState {
  kind: ChannelKind
  enabled: boolean
  configured: boolean
  hint: string
  lastTestAt: string | null
  lastTestStatus: '' | 'success' | 'failed'
  lastTestError: string
}

export interface PaymentHighlight {
  name: string
  amount: number
  currency: CurrencyCode
  customType: string
  paymentDate: string
  note: string
}

export interface UpcomingRenewal {
  id: string
  name: string
  amount: number
  currency: CurrencyCode
  customType: string
  renewalDate: string
  daysUntilRenewal: number
}

export interface ExpenseShare {
  label: string
  amount: number
  percentage: number
}

export interface MonthExpense {
  /** `YYYY-MM`, so the axis reads the same in either language. */
  month: string
  amount: number
}

export interface NotifyLogEntry {
  id: string
  subscriptionId: string
  subscriptionName: string
  ruleId: string
  channel: ChannelKind
  status: 'success' | 'failed'
  title: string
  body: string
  error: string
  detail: string
  createdAt: string
}

export interface ScheduleLogEntry {
  id: string
  startedAt: string
  finishedAt: string
  timezone: string
  hour: string
  hours: string[]
  inWindow: boolean
  checkedCount: number
  matchedCount: number
  dedupedCount: number
  sentCount: number
  renewedCount: number
  status: 'ok' | 'skipped' | 'error'
  reason: string
  detail: string
}

export interface SubscriptionOverview {
  monthly: { amount: number; trend: number; direction: 'up' | 'down' | 'flat' }
  yearly: { amount: number; monthlyAverage: number }
  active: { active: number; total: number; expiringSoon: number }
  recentPayments: PaymentHighlight[]
  upcoming: UpcomingRenewal[]
  byType: ExpenseShare[]
  byCategory: ExpenseShare[]
  months: MonthExpense[]
  timezone: string
  scheduler: ScheduleLogEntry | null
  history: ScheduleLogEntry[]
}

/** Everything the app needs on first paint, in one response. */
export interface SubscriptionBundle {
  items: SubscriptionItem[]
  categories: string[]
  settings: SubscriptionSettings
  channels: ChannelState[]
  overview: SubscriptionOverview
}

/** One subscription with the rows that belong to it. */
export interface SubscriptionDetail {
  item: SubscriptionItem
  payments: PaymentRecord[]
  rules: ReminderRule[]
  nextReminder: NextReminder | null
  upcoming: NextReminder[]
}

export interface NextReminder {
  ruleId: string
  type: ReminderKind
  value: number
  unit: ReminderUnit
  nextFireTime: string
}

export interface RenewOptions {
  paymentDate?: string
  amount?: number
  periodMultiplier?: number
  note?: string
}

export interface NotifyLogFilter {
  subscriptionId?: string
  channel?: ChannelKind
  status?: 'success' | 'failed'
  since?: string
  until?: string
  limit?: number
}

/**
 * The four rules a new subscription starts with: 7, 3 and 1 days before, and the day itself.
 *
 * The ids are made by the caller so this stays a pure function — a test can then assert the shape
 * without stubbing a random source, and the worker keeps one id generator for every table.
 */
export function defaultPresetRules(idOf: () => string, now = Date.now()): ReminderRule[] {
  const createdAt = new Date(now).toISOString()
  const rule = (value: number, type: ReminderKind): ReminderRule => ({
    id: idOf(),
    type,
    value,
    unit: 'days',
    repeatInterval: null,
    repeatUntil: 'renewed',
    isEnabled: true,
    createdAt,
  })
  return [rule(7, 'before_expiry'), rule(3, 'before_expiry'), rule(1, 'before_expiry'), rule(0, 'on_expiry')]
}

/**
 * Coerce whatever a caller sent into a rule the engine can evaluate.
 *
 * Anything unrecognised falls back rather than throwing: a rule is a preference, and a bad field in
 * one of ten should not lose the other nine. `value` is floored and clamped, because a fractional day
 * would never compare equal to an integer `daysDiff` and would silently never fire.
 */
export function normalizeRule(raw: ReminderRuleInput | null | undefined, idOf: () => string, now = Date.now()): ReminderRule {
  const source = raw ?? {}
  const type = REMINDER_KINDS.includes(source.type as ReminderKind) ? (source.type as ReminderKind) : 'before_expiry'
  const unit = source.unit === 'hours' ? 'hours' : 'days'
  const rawValue = Number(source.value)
  const value = Number.isFinite(rawValue) && rawValue >= 0
    ? Math.min(RULE_VALUE_MAX, Math.floor(rawValue))
    : 0
  const rawInterval = Number(source.repeatInterval)
  const repeatInterval = type === 'after_expiry' && Number.isFinite(rawInterval) && rawInterval > 0
    ? Math.min(REPEAT_INTERVAL_MAX, Math.floor(rawInterval))
    : null
  const repeatUntil = REPEAT_UNTIL.includes(source.repeatUntil as RepeatUntil)
    ? (source.repeatUntil as RepeatUntil)
    : 'renewed'
  return {
    id: typeof source.id === 'string' && source.id !== '' ? source.id : idOf(),
    type,
    value,
    unit,
    repeatInterval,
    repeatUntil,
    isEnabled: source.isEnabled !== false,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date(now).toISOString(),
  }
}

/**
 * The single-reminder fields an older export carries, expressed as the one rule they meant.
 *
 * Nothing this app writes uses these columns any more; the function exists so a dump taken from the
 * reference project can be imported without inventing a rule for every subscription by hand.
 */
export function legacyFieldToRule(
  legacy: { reminderUnit?: string; reminderValue?: number; reminderDays?: number; reminderHours?: number },
  idOf: () => string,
  now = Date.now(),
): ReminderRule {
  const unitRaw = String(legacy.reminderUnit ?? 'day').toLowerCase()
  const unit: ReminderUnit = unitRaw === 'hour' || unitRaw === 'hours' ? 'hours' : 'days'
  const fallback = unit === 'hours' ? legacy.reminderHours : legacy.reminderDays
  const candidate = Number(legacy.reminderValue ?? fallback)
  const value = Number.isFinite(candidate) && candidate >= 0 ? Math.min(RULE_VALUE_MAX, Math.floor(candidate)) : 7
  return normalizeRule(
    { type: value === 0 ? 'on_expiry' : 'before_expiry', value, unit, isEnabled: true },
    idOf,
    now,
  )
}

/** Where a subscription stands, from its own flags and the distance to its expiry. */
export function subscriptionStatus(item: { isActive: boolean }, daysRemaining: number): SubscriptionStatus {
  if (!item.isActive) return 'disabled'
  if (daysRemaining < 0) return 'expired'
  if (daysRemaining === 0) return 'today'
  if (daysRemaining <= SOON_DAYS) return 'soon'
  return 'active'
}

/** Clamp a requested payment-history ceiling into the range the repository will honour. */
export function clampPaymentLimit(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return PAYMENT_LIMIT_DEFAULT
  return Math.min(PAYMENT_LIMIT_MAX, Math.max(PAYMENT_LIMIT_MIN, Math.floor(numeric)))
}

/** A currency code the app knows, or the default. Unknown codes are refused at the route instead. */
export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCY_CODES as readonly string[]).includes(value)
}

export function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === 'string' && (CHANNEL_KINDS as readonly string[]).includes(value)
}

export function isPeriodUnit(value: unknown): value is PeriodUnit {
  return typeof value === 'string' && (PERIOD_UNITS as readonly string[]).includes(value)
}

export function isSubscriptionMode(value: unknown): value is SubscriptionMode {
  return typeof value === 'string' && (SUBSCRIPTION_MODES as readonly string[]).includes(value)
}

/** Round to cents, which is the only precision a subscription amount ever has. */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/** The settings an account starts with: Shanghai time, every hour open, Chinese bodies. */
export const DEFAULT_SETTINGS: SubscriptionSettings = {
  timezone: 'Asia/Shanghai',
  notificationHours: [],
  showLunar: false,
  paymentHistoryLimit: PAYMENT_LIMIT_DEFAULT,
  locale: 'zh-CN',
  inboundTokenHint: '',
}

/**
 * The hours a reminder may be sent in, as the scheduler compares them.
 *
 * Three spellings mean "any hour" and all three normalise to `['*']`: an empty list, a literal `*`,
 * and the word `ALL`. A number is clamped and padded, because `8` and `08` are the same hour and a
 * comparison against `'08'` would miss the former.
 */
export function normalizeNotificationHours(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string' ? input.split(',') : []
  const out: string[] = []
  for (const entry of raw) {
    const value = String(entry).trim()
    if (!value) continue
    const upper = value.toUpperCase()
    if (upper === '*' || upper === 'ALL') {
      if (!out.includes('*')) out.push('*')
      continue
    }
    if (/^\d+$/.test(value)) {
      const hour = Math.min(23, Math.max(0, Math.floor(Number(value))))
      const padded = String(hour).padStart(2, '0')
      if (!out.includes(padded)) out.push(padded)
      continue
    }
    if (!out.includes(upper)) out.push(upper)
  }
  return out
}

/** Whether a reminder may be sent at this hour, given the account's window. */
export function hourIsOpen(hours: readonly string[], hour: string): boolean {
  return hours.length === 0 || hours.includes('*') || hours.includes(hour)
}
