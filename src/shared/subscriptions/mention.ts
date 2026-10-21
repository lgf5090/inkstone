/**
 * The mention syntax for a subscription, in one place both sides can read.
 *
 * The worker resolves `[[sub:Netflix]]` when it builds a turn's context, and the chat has to recognise the
 * same prefix before it treats a `[[…]]` target as a note title — a click that ends in "create a note
 * called sub:Netflix" is a junk document made out of a plan the reader already pays for. Client code may
 * not reach into the worker, so the prefix lives here.
 */

export const SUBSCRIPTION_MENTION_PREFIX = 'sub:'

/** Whether a wiki-link target names a subscription rather than a note. */
export function isSubscriptionMention(target: string): boolean {
  return target.trim().toLowerCase().startsWith(SUBSCRIPTION_MENTION_PREFIX)
}

/** What the reader called it, with the prefix and any surrounding space gone. Empty means no name at all. */
export function subscriptionMentionName(target: string): string {
  if (!isSubscriptionMention(target)) return ''
  return target.trim().slice(SUBSCRIPTION_MENTION_PREFIX.length).trim()
}

/** The text a mention is drawn as: the name, because the prefix is syntax, not part of the label. */
export function subscriptionMentionLabel(target: string, fallback: string): string {
  return subscriptionMentionName(target) || fallback
}
