import { describe, expect, it } from 'vitest'
import {
  SUBSCRIPTION_MENTION_PREFIX,
  isSubscriptionMention,
  subscriptionMentionLabel,
  subscriptionMentionName,
} from '../src/shared/subscriptions/mention'

/**
 * The prefix that keeps a subscription mention out of the note resolver's way.
 *
 * Both sides read the same syntax — the worker to build a turn's context, the chat to decide what a click
 * on a `[[…]]` means — and the failure mode of getting it wrong is not an error message but a junk note
 * called `sub:Netflix` appearing in the vault because a click was answered as a title.
 */

describe('a subscription mention target', () => {
  it('is recognised by its prefix, whatever case it was written in', () => {
    expect(isSubscriptionMention('sub:Netflix')).toBe(true)
    expect(isSubscriptionMention('  SUB:Netflix  ')).toBe(true)
    expect(isSubscriptionMention('Netflix')).toBe(false)
    expect(isSubscriptionMention('sub:')).toBe(true)
  })

  it('gives back the name the reader typed, without the syntax', () => {
    expect(subscriptionMentionName('sub:Netflix')).toBe('Netflix')
    expect(subscriptionMentionName('sub:  Nintendo Switch Online ')).toBe('Nintendo Switch Online')
    expect(subscriptionMentionName('sub:')).toBe('')
    expect(subscriptionMentionName('Netflix'), 'a note title is not a subscription').toBe('')
  })

  it('labels itself with the name, and keeps a fallback for an empty one', () => {
    expect(subscriptionMentionLabel('sub:Netflix', 'subscription')).toBe('Netflix')
    expect(subscriptionMentionLabel('sub:', 'subscription')).toBe('subscription')
  })

  it('uses the prefix the worker resolves with', () => {
    // One string for two resolvers: if the client's copy ever drifts, a mention the worker understands
    // would stop being a door in the transcript.
    expect(SUBSCRIPTION_MENTION_PREFIX).toBe('sub:')
  })
})
