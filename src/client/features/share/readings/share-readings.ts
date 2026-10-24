/**
 * What the per-link readings and the visit log agree on, in one place.
 *
 * Three things are worth stating once rather than at each call site: the traffic toggles behind every
 * number (a reading that says "30 days, real visitors" and a log filtered to `real` have to mean the same
 * rows — see `REAL_VISITOR_TOGGLES`), the two reserved channel names (which are two different facts and
 * must never print as one label), and the ceiling on a visitor label (the server sends eight characters;
 * the client repeats the clamp rather than assume a caller upstream kept it).
 *
 * Nothing here fetches. A surface that reads the hub goes through `shareHubApi`.
 */
import { CHANNEL_UNMARKED, CHANNEL_UNRECOGNIZED } from '@shared/share-channel'
import type { ShareBreakdownItem, ShareTimelineRange } from '@shared/share-hub'
import type { VisitTrafficSubject } from '@shared/share-selection'
import type { TrafficParams } from '../../../lib/api-share-hub'
import { localeTag, t } from '../../../lib/i18n'
import { localizeDeviceName } from '../dashboard/dashboard-format'

/** The windows every reading accepts, in the order its control lists them. */
export const SHARE_RANGES = ['24h', '7d', '30d', 'all'] as const satisfies readonly ShareTimelineRange[]

export function rangeLabel(range: ShareTimelineRange): string {
  switch (range) {
    case '24h':
      return t('share.reading_range_24h')
    case '7d':
      return t('share.reading_range_7d')
    case '30d':
      return t('share.reading_range_30d')
    case 'all':
      return t('share.reading_range_all')
  }
}

/**
 * The three exclusions a reading names, in the owner's words rather than the API's.
 *
 * All three on is "real visitors" — the same set the log's single-choice `real` filter selects, because
 * `visitMatchesLogFilter('real')` is written as exactly these three toggles. Keeping one object for the
 * pair is what makes that equivalence checkable rather than a hope.
 */
export interface TrafficToggles {
  bots: boolean
  selfReferrers: boolean
  owner: boolean
}

/** All three on: the default every reading opens with, and what the log calls `real`. */
export const REAL_VISITOR_TOGGLES: TrafficToggles = { bots: true, selfReferrers: true, owner: true }

/** The same set with nothing excluded — what the log calls `all`. */
export const EVERY_VISITOR_TOGGLES: TrafficToggles = { bots: false, selfReferrers: false, owner: false }

export function trafficParams(toggles: TrafficToggles): TrafficParams {
  return {
    excludeBots: toggles.bots,
    excludeSelf: toggles.selfReferrers,
    excludeOwner: toggles.owner,
  }
}

/** Whether a row survives the real-visitor set — the client-side statement of the same rule the server runs. */
export function isRealVisitor(subject: VisitTrafficSubject): boolean {
  return subject.isBot !== true && subject.isSelfReferrer !== true && subject.isOwner !== true
}

/** How a traffic selection reads to the owner: named when it is one of the two presets, honest otherwise. */
export function trafficLabel(toggles: TrafficToggles): string {
  if (toggles.bots && toggles.selfReferrers && toggles.owner) return t('share.reading_traffic_real')
  if (!toggles.bots && !toggles.selfReferrers && !toggles.owner) return t('share.reading_traffic_all')
  return t('share.reading_traffic_custom')
}

/**
 * The longest visitor label the hub ever draws.
 *
 * The worker truncates the stored digest to this many characters before it leaves the API, and the clamp
 * is repeated here on purpose: a row that arrived longer would otherwise print more of a fingerprint than
 * the product ever agreed to show.
 */
export const VISITOR_LABEL_MAX = 8

/** The label for display, or null when the row carries none. Never anything but the label the server sent. */
export function visitorLabel(fingerprint: string | null | undefined): string | null {
  if (!fingerprint) return null
  return fingerprint.slice(0, VISITOR_LABEL_MAX)
}

/** One `DisplayNames` per locale: building it per row is measurable waste in a 100-row page. */
let regionCache: { tag: string; names: Intl.DisplayNames | null } | null = null

function regionNames(): Intl.DisplayNames | null {
  if (typeof Intl === 'undefined' || typeof Intl.DisplayNames !== 'function') return null
  const tag = localeTag()
  if (regionCache?.tag === tag) return regionCache.names
  let names: Intl.DisplayNames | null = null
  try {
    names = new Intl.DisplayNames([tag], { type: 'region' })
  } catch {
    // A runtime with no region data answers with the code instead; that is a degradation, not a failure.
    names = null
  }
  regionCache = { tag, names }
  return names
}

/**
 * A country named in the reader's locale, falling back to what the worker sent.
 *
 * The fallback is not cosmetic: `DisplayNames.of()` throws for anything that is not a region code, and
 * the value in that column is a geo lookup's output rather than this app's own enum. A breakdown card that
 * took down the whole reading because one row held `"n/a"` would be a worse answer than printing the
 * unreadable code.
 */
const REGION_CODE = /^([A-Z]{2}|[A-Z]{3}|\d{3})$/

export function countryName(code: string | null): string {
  if (!code) return t('share.reading_country_unknown')
  if (!REGION_CODE.test(code.toUpperCase())) return code
  try {
    return regionNames()?.of(code.toUpperCase()) || code
  } catch {
    return code
  }
}

/** The place a visit came from, as one line: country, then city when the reading has one. */
export function locationLabel(visit: { country: string | null, city: string | null }): string {
  const country = countryName(visit.country)
  return visit.city ? `${country} · ${visit.city}` : country
}

/**
 * The device a visit came in on, as one line: type, then the OS and browser the parse found.
 *
 * The type goes through the same translator the breakdown cards use, because `desktop` is the
 * server's stored token, not a word to show an owner: two surfaces naming the same row's value
 * differently is how one becomes a bug report about the other.
 */
export function deviceLabel(visit: { deviceType: string | null, os: string | null, browser: string | null }): string {
  const parts = [visit.deviceType && localizeDeviceName(visit.deviceType), visit.os, visit.browser]
    .filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : t('share.reading_device_unknown')
}

/**
 * A breakdown row's channel, named.
 *
 * `__unmarked__` ("this link was opened with no marker at all") and `__unrecognized__` ("the marker it
 * carried was refused") are different facts about different visits, and the breakdown keeps them as two
 * rows: a campaign that silently stopped working looks exactly like a link nobody shared again.
 */
export function channelItemName(item: ShareBreakdownItem): string {
  if (item.name === CHANNEL_UNMARKED) return t('share.channel_unmarked')
  if (item.name === CHANNEL_UNRECOGNIZED) return t('share.channel_unrecognized')
  // A token the worker could resolve to a directory prints that directory's title; anything else prints
  // the marker itself, which is the text the owner wrote into their own link.
  return item.label ?? item.name
}

/**
 * What one visit row says about its channel — the same two facts, kept apart at the row level too.
 *
 * `null` is the absent marker and `''` the stored refusal, which is exactly what the column holds.
 */
export function rowChannelName(channel: string | null | undefined): string {
  if (channel === null || channel === undefined) return t('share.channel_unmarked')
  if (channel === '') return t('share.channel_unrecognized')
  return channel
}

/** The rows a page of `limit` covers out of `total`, one-based; both zero for an empty reading. */
export function pageWindow(page: number, limit: number, total: number): { from: number, to: number } {
  if (total <= 0) return { from: 0, to: 0 }
  return { from: (page - 1) * limit + 1, to: Math.min(total, page * limit) }
}

/**
 * A value shaped like a secret: a password hash, a digest, or a long base64 run.
 *
 * The audit trail is written by the worker, which records a passcode as set/cleared and never the value.
 * This is the belt: if a payload ever carries something hash-shaped in a field we print, it is redacted
 * rather than rendered. A share slug (20 base36 characters) and a tag name are deliberately not matched —
 * both are things the owner has to see.
 */
const SECRET_SHAPED = /^(\$2[aby]\$[\x21-\x7e]{10,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{48,}={0,2})$/

export function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPED.test(value)
}
