import { EXPIRING_SOON_DAYS } from './constants'
import type { ShareCategory } from './share-hub'

/**
 * Which shares a folder, a tag, a status filter or a published collection covers — stated once for
 * both halves of the app. The worker turns these rules into SQL (`worker/lib/share-selection-sql`);
 * the client evaluates them in JS to count what it already holds. A rule written out once per
 * surface is a rule that can disagree with itself: a tag collection matching a tag *id* against
 * `shares.tags` — an array of tag *names* — gives a page that is empty while the owner's own count
 * says it is full.
 *
 * A target has two forms, and the difference between them is the point:
 *
 * - `ShareTargetRecord` addresses a folder or tag *record* by id. That is what the owner selects,
 *   what the worker's batch routes take, and what `share_collections.target_value` stores (the
 *   record is what a rename moves the published page by);
 * - `ShareTarget` is what a share itself stores: `shares.folder_id`, or one element of `shares.tags`.
 *   Note the asymmetry — a folder is stored by id, a tag by name — because the tag array holds the
 *   names the owner's tags had when the share was last written.
 *
 * `resolveShareTarget()` is the only conversion between the two, and every predicate below takes an
 * already resolved target, so no caller has to know which form it is holding.
 */

/** The status vocabulary, in the order the toolbar lists it. `?status=` accepts these and nothing else. */
export const SHARE_STATUS_FILTERS = [
  'all',
  'active',
  'pinned',
  'starred',
  'paused',
  'password',
  'expiring_soon',
  'expiring',
  'permanent',
  'expired',
] as const

export type ShareStatusFilter = (typeof SHARE_STATUS_FILTERS)[number]

export function isShareStatusFilter(value: unknown): value is ShareStatusFilter {
  return typeof value === 'string' && (SHARE_STATUS_FILTERS as readonly string[]).includes(value)
}

/**
 * The categories whose screen is a status filter. The hub's dashboard and collections categories are
 * views of their own, which is why the record below covers the other ten only — and why it is a
 * record: a category that joins the union without a status stops compiling, instead of quietly
 * showing everything under a filter that does nothing.
 */
export type ShareStatusCategory = Exclude<ShareCategory, 'dashboard' | 'collections'>

export const SHARE_CATEGORY_STATUS: Record<ShareStatusCategory, ShareStatusFilter> = {
  all: 'all',
  active: 'active',
  paused: 'paused',
  pinned: 'pinned',
  starred: 'starred',
  password: 'password',
  expiring_soon: 'expiring_soon',
  expiring: 'expiring',
  permanent: 'permanent',
  expired: 'expired',
}

/** The status a category filters by; the two view categories carry no filter. */
export function shareCategoryStatus(category: ShareCategory): ShareStatusFilter {
  return category in SHARE_CATEGORY_STATUS
    ? SHARE_CATEGORY_STATUS[category as ShareStatusCategory]
    : 'all'
}

/**
 * The instant `expiring_soon` stops meaning it. The configured `EXPIRING_SOON_DAYS` is read here once
 * and nowhere else, so the window cannot mean 7 days on the list and something else in a count.
 */
export function expiringSoonCutoff(now: number): number {
  return now + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000
}

/**
 * What a selection reads from a share. Structural on purpose: the worker's list row, the client's
 * `ShareInfo` and a test fixture can all be handed to it — `ShareInfo` satisfies it as it stands —
 * so nobody has to convert a share into a second, parallel shape to ask whether it is selected.
 */
export interface ShareSelectionSubject {
  isEnabled: boolean
  expiresAt: number | null
  hasPassword: boolean
  folderId?: string | null
  tags?: readonly string[] | null
  isPinned?: boolean
  isStarred?: boolean
}

export type ShareTargetType = 'folder' | 'tag'

/** A folder or tag addressed by record id, as the owner selected it. */
export interface ShareTargetRecord {
  type: ShareTargetType
  value: string
}

/**
 * What a selection matches a share on, with `none` for an address that no longer resolves (a tag
 * collection whose tag was deleted): it covers no shares at all, and that is a value rather than an
 * error because a page whose target is gone is a page with nothing in it.
 */
export type ShareTarget = { type: ShareTargetType; value: string } | { type: 'none' }

export function isShareTargetType(value: unknown): value is ShareTargetType {
  return value === 'folder' || value === 'tag'
}

/**
 * Turns a record address into the value the shares store. A folder is already stored by id; a tag is
 * stored by name, so the caller reads the tag record and passes the name. `tagName` is null when the
 * record is gone, which is what makes the target cover nothing.
 */
export function resolveShareTarget(target: ShareTargetRecord, tagName: string | null): ShareTarget {
  if (target.type === 'folder') return { type: 'folder', value: target.value }
  return tagName === null ? { type: 'none' } : { type: 'tag', value: tagName }
}

/** Whether one share is selected by a status filter. */
export function shareMatchesStatus(
  subject: ShareSelectionSubject,
  status: ShareStatusFilter,
  now: number,
): boolean {
  switch (status) {
    case 'all':
      return true
    case 'active':
      return subject.isEnabled && (subject.expiresAt === null || subject.expiresAt > now)
    case 'paused':
      return !subject.isEnabled
    case 'pinned':
      return subject.isPinned === true
    case 'starred':
      return subject.isStarred === true
    case 'password':
      return subject.hasPassword
    case 'expiring_soon':
      return (
        subject.expiresAt !== null &&
        subject.expiresAt > now &&
        subject.expiresAt <= expiringSoonCutoff(now)
      )
    case 'expiring':
      return subject.expiresAt !== null && subject.expiresAt > now
    case 'permanent':
      return subject.expiresAt === null
    case 'expired':
      return subject.expiresAt !== null && subject.expiresAt <= now
  }
}

/** Whether one share carries a resolved target. `null` asks for no target constraint. */
export function shareMatchesTarget(
  subject: ShareSelectionSubject,
  target: ShareTarget | null,
): boolean {
  if (!target) return true
  if (target.type === 'none') return false
  if (target.type === 'folder') return (subject.folderId ?? null) === target.value
  return (subject.tags ?? []).includes(target.value)
}

/**
 * A folder or tag plus a status filter: everything a list, a collection page or a batch toggle
 * selects, in one call. An absent field means "no constraint from it".
 */
export interface ShareSelection {
  status?: ShareStatusFilter | null
  target?: ShareTarget | null
}

export function shareMatchesSelection(
  subject: ShareSelectionSubject,
  selection: ShareSelection,
  now: number,
): boolean {
  return (
    shareMatchesStatus(subject, selection.status ?? 'all', now) &&
    shareMatchesTarget(subject, selection.target ?? null)
  )
}

/**
 * The traffic filters on a visit table, the third family of selection rule. What a visit is
 * classified as is decided when it is recorded; these three flags decide which of those rows a
 * reading counts. `excludeBots` defaults to true — the only filter that is on unless it is turned
 * off, because an unfiltered reading is the exception an owner asks for.
 */
export interface VisitTrafficFilters {
  excludeBots?: boolean
  excludeSelfReferrers?: boolean
  excludeOwner?: boolean
}

/**
 * How a visit is classified. The flags are optional because the recording side leaves one unset when
 * it has nothing to say about it, and an unset flag is "not that" rather than "unknown": a row with
 * no "self-referrer" mark was not classified as one, so it survives a filter that excludes them.
 */
export interface VisitTrafficSubject {
  isBot?: boolean
  isSelfReferrer?: boolean
  isOwner?: boolean
}

export function visitMatchesTraffic(
  subject: VisitTrafficSubject,
  filters: VisitTrafficFilters,
): boolean {
  if (filters.excludeBots !== false && subject.isBot === true) return false
  if (filters.excludeSelfReferrers === true && subject.isSelfReferrer === true) return false
  if (filters.excludeOwner === true && subject.isOwner === true) return false
  return true
}

/**
 * The single-choice filter on the log view, which asks a different question from the toggles: "show
 * me only this kind of row" rather than "leave this kind out". `real` is the one value both families
 * share, so it is written as the three toggles rather than as a fourth condition of its own.
 */
export const VISIT_LOG_FILTERS = ['all', 'real', 'bot', 'owner', 'self'] as const

export type VisitLogFilter = (typeof VISIT_LOG_FILTERS)[number]

export function isVisitLogFilter(value: unknown): value is VisitLogFilter {
  return typeof value === 'string' && (VISIT_LOG_FILTERS as readonly string[]).includes(value)
}

export function visitMatchesLogFilter(
  subject: VisitTrafficSubject,
  filter: VisitLogFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'real':
      return visitMatchesTraffic(subject, {
        excludeBots: true,
        excludeSelfReferrers: true,
        excludeOwner: true,
      })
    case 'bot':
      return subject.isBot === true
    case 'owner':
      return subject.isOwner === true
    case 'self':
      return subject.isSelfReferrer === true
  }
}
