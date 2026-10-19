/**
 * The message a sweep sends: one body for everything that came due this hour.
 *
 * One message rather than one per subscription, which is the reference project's choice and the right
 * one: a reader with eight services renewing in the same week wants one reminder they can read, not
 * eight notifications that each say a date. The price is that a delivery log row names the first
 * subscription in the batch — which is why the schedule log keeps the whole list beside it.
 *
 * The copy comes from the notification catalog rather than from the interface's, because this runs on a
 * cron tick with no request behind it and therefore no reader to ask.
 */
import { formatAmount } from '@shared/subscriptions/format'
import type { ReminderRule, SubscriptionItem, SubscriptionSettings } from '@shared/subscriptions/model'
import { describeTimezone, fill, notifyCopy } from '@shared/subscriptions/notify-copy'
import { solar2lunar } from '@shared/subscriptions/lunar'
import { formatLocalDate, getTimezoneDateParts } from '@shared/subscriptions/time'

export interface NotifySubject {
  item: SubscriptionItem
  daysRemaining: number
  hoursRemaining: number
  /** The rule that fired, so the message can say why it arrived today rather than on some other day. */
  rule: { type: ReminderRule['type']; value: number; unit: ReminderRule['unit']; repeatInterval: number | null }
}

export interface NotificationBody {
  title: string
  content: string
}

export function buildNotificationBody(
  subjects: readonly NotifySubject[],
  settings: SubscriptionSettings,
  now = Date.now(),
): NotificationBody {
  const copy = notifyCopy(settings.locale)
  const parts: string[] = []

  for (const subject of subjects) {
    const { item } = subject
    const unit = item.periodUnit === 'day' ? copy.unitDay : item.periodUnit === 'year' ? copy.unitYear : copy.unitMonth
    const emoji = subject.daysRemaining < 0 ? '🚨' : subject.daysRemaining === 0 ? '⚠️' : '📅'
    const status = subject.daysRemaining < 0
      ? fill(copy.overdue, { count: Math.abs(subject.daysRemaining) })
      : subject.daysRemaining === 0 ? copy.dueToday : fill(copy.remaining, { count: subject.daysRemaining })

    const lines: string[] = [
      `${emoji} **${item.name}**`,
      `${copy.typeLabel}: ${item.customType || copy.otherType} (${copy.periodLabel}: ${item.periodValue} ${unit})`,
      `${copy.categoryLabel}: ${item.category || copy.uncategorized}`,
    ]
    const amount = formatAmount(item.amount, item.currency)
    if (amount) lines.push(`${copy.amountLabel}: ${amount}${copy.perPeriod}`)
    lines.push(`${copy.calendarLabel}: ${item.useLunar ? copy.lunarCalendar : copy.solar}`)
    lines.push(`${copy.expiryLabel}: ${formatLocalDate(item.expiryDate, settings.timezone, 'date')}`)

    if (settings.showLunar) {
      const parts2 = getTimezoneDateParts(item.expiryDate, settings.timezone)
      const lunar = solar2lunar(parts2.year, parts2.month, parts2.day)
      if (lunar) lines.push(`${copy.lunarLabel}: ${lunar.fullStr}`)
    }

    lines.push(`${copy.autoRenewLabel}: ${item.autoRenew ? copy.yes : copy.no}`)
    lines.push(`${copy.reminderLabel}: ${reminderLine(subject, copy)}`)
    lines.push(`${copy.statusLabel}: ${status}`)
    if (item.notes) lines.push(`${copy.notesLabel}: ${item.notes}`)
    parts.push(lines.join('\n'))
  }

  const stamp = `${copy.sentAt}: ${formatLocalDate(now, settings.timezone, 'datetime')}`
  const zone = `${copy.timezoneLabel}: ${describeTimezone(copy, settings.timezone)}`
  return { title: copy.title, content: `${parts.join('\n\n')}\n\n${stamp}\n${zone}` }
}

/**
 * The reminder line names the rule that fired, because "why now" is the question a reader asks when a
 * notification arrives on a day they did not expect one. A `before_expiry` rule of zero days and an
 * `on_expiry` rule mean the same thing to a reader and are said the same way.
 */
function reminderLine(subject: NotifySubject, copy: ReturnType<typeof notifyCopy>): string {
  const { rule } = subject
  if (rule.type === 'after_expiry') {
    return `${fill(copy.afterEvery, { count: rule.repeatInterval ?? 24 })}${copy.hourly}`
  }
  if (rule.type === 'on_expiry' || (rule.type === 'before_expiry' && rule.value === 0)) {
    return `${copy.onTheDay}${copy.onlyOnExpiry}`
  }
  if (rule.unit === 'hours') {
    return `${fill(copy.beforeHours, { count: rule.value })}${copy.hourly}`
  }
  return fill(copy.beforeDays, { count: rule.value })
}

/** The subject shape the scheduler builds, kept here so the body and its caller cannot disagree. */
export function subjectOf(
  item: SubscriptionItem,
  daysRemaining: number,
  hoursRemaining: number,
  rule: NotifySubject['rule'],
): NotifySubject {
  return { item, daysRemaining, hoursRemaining, rule }
}
