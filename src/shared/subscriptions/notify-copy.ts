/**
 * Which catalog a notification body is written from, and the two helpers that assemble one.
 *
 * The language is the account's, stored on its settings row: the scheduler runs on a cron tick with no
 * request behind it, so there is nobody to ask. `fill` is deliberately smaller than the interface's
 * formatter — two placeholders and no plural rules, because the only number these sentences carry is a
 * day count and both languages write that the same way.
 */
import { EN_US_SUBSCRIPTIONS_NOTIFY } from '../locales/en-US-subscriptions-notify'
import { ZH_CN_SUBSCRIPTIONS_NOTIFY } from '../locales/zh-CN-subscriptions-notify'
import type { NotifyLocale } from './model'
import { formatTimezoneOffset } from './time'

export interface NotifyCopy {
  title: string
  typeLabel: string
  periodLabel: string
  categoryLabel: string
  amountLabel: string
  calendarLabel: string
  expiryLabel: string
  lunarLabel: string
  autoRenewLabel: string
  reminderLabel: string
  statusLabel: string
  notesLabel: string
  sentAt: string
  timezoneLabel: string
  solar: string
  lunarCalendar: string
  yes: string
  no: string
  uncategorized: string
  otherType: string
  dueToday: string
  overdue: string
  remaining: string
  beforeDays: string
  beforeHours: string
  afterEvery: string
  onTheDay: string
  onlyOnExpiry: string
  hourly: string
  perPeriod: string
  unitDay: string
  unitMonth: string
  unitYear: string
  testTitle: string
  testContent: string
  zoneNames: Record<string, string>
}

/** The assignment is the type check: a key one catalog has and the other lacks fails to compile here. */
const COPY: Record<NotifyLocale, NotifyCopy> = {
  'en-US': EN_US_SUBSCRIPTIONS_NOTIFY,
  'zh-CN': ZH_CN_SUBSCRIPTIONS_NOTIFY,
}

export function notifyCopy(locale: NotifyLocale | string | undefined): NotifyCopy {
  return COPY[locale === 'en-US' ? 'en-US' : 'zh-CN']
}

/** Replace `{name}` placeholders. An unknown key becomes nothing rather than the literal braces. */
export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key]
    return value === undefined ? '' : String(value)
  })
}

/** `China Standard Time (UTC+8)`: a name a reader recognizes, and the offset that makes it exact. */
export function describeTimezone(copy: NotifyCopy, timezone: string): string {
  const name = copy.zoneNames[timezone] ?? timezone
  return `${name} (${formatTimezoneOffset(timezone)})`
}
