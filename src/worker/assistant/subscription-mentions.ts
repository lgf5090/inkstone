/**
 * `[[sub:…]]` mentions resolved into the subscription's own facts.
 *
 * A subscription id is the same 26-character shape as a note id, so letting both resolvers claim a bare
 * `[[<id>]]` would mean whichever ran first could report the other's target as missing. The `sub:` prefix
 * is what keeps the two apart, and `note-mentions` skips anything carrying it rather than reporting it
 * as a note that has been deleted.
 *
 * What is quoted is the row's own fields — price, cycle, dates, what has been paid — never the notes
 * field, which is free text a reader may have used for anything. A note is the thing a mention exists to
 * bring words from; a subscription is a row, and the row is what the question is about.
 */
import { SubscriptionsStore, storeContext } from '../subscriptions/store'
import { loadSettings } from '../subscriptions/settings'
import { formatAmount, formatPaid } from '@shared/subscriptions/format'
import type { PaidAmount } from '@shared/subscriptions/model'
import { SUBSCRIPTION_MENTION_PREFIX } from '@shared/subscriptions/mention'

/** How many mentions one turn may resolve, and how many receipts each one carries. */
export const MAX_SUBSCRIPTION_MENTIONS = 8
const RECEIPTS_PER_MENTION = 5

interface SubscriptionMention {
  id: string | null
  name: string | null
}

/** Every `[[sub:…]]` in the text, in order and deduplicated. */
export function subscriptionMentions(text: string): SubscriptionMention[] {
  const out: SubscriptionMention[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const inner = (match[1] ?? '').trim()
    const pipe = inner.indexOf('|')
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : ''
    if (!target.startsWith(SUBSCRIPTION_MENTION_PREFIX)) continue
    const value = target.slice(SUBSCRIPTION_MENTION_PREFIX.length).trim()
    if (!value) continue
    const key = value.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    // A 26-character target is an id, which cannot point at the wrong row; anything else is a name the
    // reader typed, which can.
    const id = /^[0-9a-hjkmnp-tv-z]{26}$/.test(value) ? value : null
    out.push({ id, name: id ? (alias || null) : value })
  }
  return out
}

/**
 * The block a turn carries for the subscriptions it mentioned, or an empty string for none.
 *
 * A name that matches two rows is named as ambiguous rather than one being picked: "what does my Netflix
 * cost" answered from the standard plan when the reader meant the premium one is worse than no answer,
 * and the reader can say which they meant in the next message.
 */
export async function resolveSubscriptionMentions(
  db: D1Database,
  userId: string,
  text: string,
  now = Date.now(),
): Promise<string> {
  const mentions = subscriptionMentions(text)
  if (!mentions.length) return ''
  const settings = await loadSettings(db, userId)
  const store = new SubscriptionsStore(db, userId)
  const context = storeContext(settings, now)
  const sections: string[] = []

  for (const mention of mentions.slice(0, MAX_SUBSCRIPTION_MENTIONS)) {
    const label = mention.name ?? mention.id ?? ''
    // The id first, because it cannot point at the wrong row. A name is looked up over the live list,
    // and only the row that survives is re-read for its detail.
    const candidates = mention.id
      ? [{ id: mention.id }]
      : (await store.list(context))
        .filter((item) => item.name.toLocaleLowerCase() === label.toLocaleLowerCase())
        .map((item) => ({ id: item.id }))
    if (!candidates.length) {
      sections.push(`[[sub:${label}]] — no subscription of that name`)
      continue
    }
    if (candidates.length > 1) {
      sections.push(`[[sub:${label}]] — ${candidates.length} subscriptions share that name; say which one`)
      continue
    }
    const detail = await store.get(candidates[0]!.id, context)
    if (!detail) {
      sections.push(`[[sub:${label}]] — the subscription this mention points at no longer exists`)
      continue
    }
    sections.push(present(detail.item, detail.rules, detail.payments))
  }
  return sections.length ? `[mentioned subscriptions]\n\n${sections.join('\n\n')}` : ''
}

/**
 * The plan the reader is looking at, as a context block.
 *
 * A mention has to be named in the sentence; this one is pointed at by the app, so an id is enough and
 * there is no ambiguity to resolve. It says whose plan it is in the header, because a model that cannot
 * tell "the row on screen" from "a row the reader mentioned" answers a question about the wrong thing.
 */
export async function subscriptionContextById(
  db: D1Database,
  userId: string,
  id: string,
  now = Date.now(),
): Promise<string> {
  if (!id) return ''
  const settings = await loadSettings(db, userId)
  const store = new SubscriptionsStore(db, userId)
  const detail = await store.get(id, storeContext(settings, now))
  // `get` answers for a trashed row too, and the trash is not "on the screen" of the list the dock sits
  // beside. The client only ever sends a live selection; the server does not take that on trust, because
  // what lands here is read into a turn that leaves for the model provider.
  if (!detail || detail.item.deletedAt) return ''
  return `[subscription on the reader's screen]\n\n${present(detail.item, detail.rules, detail.payments)}`
}

function present(
  item: {
    name: string
    customType: string
    category: string
    amount: number | null
    currency: string
    periodValue: number
    periodUnit: string
    expiryDate: string
    daysRemaining: number
    isActive: boolean
    autoRenew: boolean
    paidByCurrency: PaidAmount[]
    nextReminderAt: string | null
    trialEndsAt: string | null
    subscriptionMode: string
  },
  rules: readonly { type: string; value: number; unit: string; repeatInterval: number | null; isEnabled: boolean }[],
  payments: readonly { paidAt: string; amount: number; currency: string; kind: string }[],
): string {
  const lines = [
    `name: ${item.name}`,
    item.customType ? `type: ${item.customType}` : '',
    item.category ? `category: ${item.category}` : '',
    `price: ${item.amount === null ? 'no price recorded' : `${formatAmount(item.amount, item.currency)} / ${item.periodValue} ${item.periodUnit}`}`,
    `expiry: ${item.expiryDate.slice(0, 10)} (${item.daysRemaining} days remaining)`,
    `billing mode: ${item.subscriptionMode}`,
    `active: ${item.isActive ? 'yes' : 'no'}`,
    `auto-renew: ${item.autoRenew ? 'yes' : 'no'}`,
    item.trialEndsAt ? `trial ends: ${item.trialEndsAt.slice(0, 10)}` : '',
    `paid in total: ${formatPaid(item.paidByCurrency) || 'nothing yet'}`,
    item.nextReminderAt ? `next reminder: ${item.nextReminderAt.slice(0, 16).replace('T', ' ')}` : 'next reminder: none',
    rules.length ? `reminders: ${rules.filter((rule) => rule.isEnabled).map((rule) => rule.type === 'on_expiry' ? 'on the day' : rule.type === 'after_expiry' ? `every ${rule.repeatInterval ?? 24}h after` : `${rule.value} ${rule.unit} before`).join(', ') || 'all switched off'}` : 'reminders: none',
    payments.length ? `last receipts: ${payments.slice(0, RECEIPTS_PER_MENTION).map((payment) => `${payment.paidAt.slice(0, 10)} ${formatAmount(payment.amount, payment.currency)} (${payment.kind})`).join('; ')}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}
