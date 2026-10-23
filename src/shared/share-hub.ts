/**
 * The payload shapes of the share hub: the organizer records a share is filed under, the analytics
 * readings a dashboard draws, the published collections, and the audit trail.
 *
 * `ShareInfo` itself stays in `@shared/types` beside the note types it has always sat with, so the
 * existing single-note panel and the public reader keep importing one thing. Everything here is new.
 */

export interface ShareFolder {
  id: string
  parentId: string | null
  name: string
  icon?: string | null
  color?: string | null
  position: number
  createdAt: number
  updatedAt: number
}

export interface ShareTag {
  id: string
  name: string
  color?: string | null
  isPinned: boolean
  createdAt: number
}

/**
 * Which screen the hub's sidebar selects. The ten status categories map onto `SHARE_CATEGORY_STATUS`
 * in `@shared/share-selection`; `dashboard` and `collections` are views of their own and carry no
 * status filter, which is why the mapping is a record and not a cast.
 */
export type ShareCategory =
  | 'dashboard'
  | 'collections'
  | 'all'
  | 'active'
  | 'paused'
  | 'pinned'
  | 'starred'
  | 'password'
  | 'expiring_soon'
  | 'expiring'
  | 'permanent'
  | 'expired'

export type ShareTimelineRange = '24h' | '7d' | '30d' | 'all'

export interface ShareBreakdownItem {
  name: string
  count: number
  percentage?: number
  /**
   * A name the worker resolved for a channel it can name: today the collection behind a
   * `collection-<slug>` marker, whose title lives in the account's folder/tag rows and cannot be
   * recovered from the token. User data, not localized copy — the client prints it as it is. Absent
   * for a marker the owner typed themselves, and for a collection whose record is gone.
   */
  label?: string
}

export interface ShareTimelinePoint {
  label: string
  timestamp: number
  views: number
  visitors: number
}

export interface ShareAnalyticsFilters {
  excludeBots: boolean
  excludeSelfReferrers: boolean
  excludeOwner: boolean
}

export interface ShareVisitLog {
  id: number
  noteId: string
  /**
   * Null when the note was deleted but its visit rows survive; the client labels it, the worker must
   * not bake in an English fallback.
   */
  noteTitle: string | null
  slug: string
  visitedAt: number
  country: string | null
  region: string | null
  city: string | null
  referrer: string | null
  referrerHost: string | null
  deviceType: string | null
  os: string | null
  browser: string | null
  isBot: boolean
  isSelfReferrer?: boolean
  isOwner?: boolean
  botName?: string | null
  /**
   * The `?ref=` marker the visit carried: a valid token, or null for both "the URL had none" and
   * "what it had was refused". The log table shows the token, never the URL.
   */
  channel?: string | null
  /**
   * A short display label, never the stored digest: the worker truncates the visitor fingerprint
   * before it leaves the API.
   */
  visitorFp?: string | null
}

/**
 * A public link nobody has opened inside the owner's threshold. `views` is the all-time counter, so
 * a link that was read once years ago is not reported as never read.
 */
export interface ShareStaleLink {
  noteId: string
  noteTitle: string | null
  slug: string
  lastViewedAt: number | null
  views: number
}

/**
 * The hygiene report: how many public links have gone quiet, of which how many were never opened at
 * all, and the oldest page of them. `thresholdDays` is the account's own number, and 0 means the
 * owner turned the report off — in which case there is nothing to list.
 */
export interface ShareStaleLinks {
  thresholdDays: number
  total: number
  neverViewed: number
  items: ShareStaleLink[]
}

/**
 * The expiry notice: links that lapsed since the owner last dismissed the notice. The dismissal is
 * one timestamp, so "new since" is just `expires_at > acknowledgedAt` — a link that expired again
 * after being acknowledged comes back, and one acknowledged once stays gone.
 */
export interface ShareExpiredLinks {
  acknowledgedAt: number | null
  total: number
  items: Array<{
    noteId: string
    noteTitle: string | null
    slug: string
    expiresAt: number
  }>
}

export interface ShareGlobalAnalytics {
  range: ShareTimelineRange
  totalShares: number
  activeShares: number
  totalViews: number
  totalVisitors: number
  viewsDelta?: number
  visitorsDelta?: number
  viewsPerDay: number
  viewsPerDayDelta?: number
  timeline: ShareTimelinePoint[]
  topNotes: Array<{
    noteId: string
    noteTitle: string | null
    slug: string
    views: number
    visitors: number
  }>
  topCountries: ShareBreakdownItem[]
  topReferrers: ShareBreakdownItem[]
  devices: ShareBreakdownItem[]
  osList: ShareBreakdownItem[]
  browsers: ShareBreakdownItem[]
  /**
   * Which copy of the link the visit came from. Marks the owner wrote are listed by name; visits
   * with no marker and visits whose marker was refused appear under the reserved names
   * `CHANNEL_UNMARKED` / `CHANNEL_UNRECOGNIZED`, never merged into one row.
   */
  channels: ShareBreakdownItem[]
  recentVisits: ShareVisitLog[]
  staleLinks: ShareStaleLinks
  expiredLinks?: ShareExpiredLinks
  filterStats?: {
    bots: number
    selfReferrals: number
    owner: number
  }
}

export interface ShareNoteAnalytics {
  range: ShareTimelineRange
  noteId: string
  noteTitle: string | null
  slug: string
  url: string
  createdAt: number
  expiresAt: number | null
  hasPassword: boolean
  isEnabled: boolean
  totalViews: number
  totalVisitors: number
  timeline: ShareTimelinePoint[]
  topCountries: ShareBreakdownItem[]
  topReferrers: ShareBreakdownItem[]
  devices: ShareBreakdownItem[]
  osList: ShareBreakdownItem[]
  browsers: ShareBreakdownItem[]
  channels: ShareBreakdownItem[]
  recentVisits: ShareVisitLog[]
}

export interface ShareSummaryResponse {
  totalShares: number
  sharedNoteIds: string[]
}

/**
 * The sidebar's counters: how many shares each category, folder and tag covers, plus the all-time
 * totals the footer prints. `/stats` answers this alone, so a hub that opens on the dashboard does
 * not pay for a list it is not showing.
 */
export interface ShareGlobalStats {
  totalShares: number
  activeShares: number
  pinnedShares: number
  starredShares: number
  pausedShares: number
  passwordShares: number
  expiringShares: number
  expiringSoonShares: number
  permanentShares: number
  expiredShares: number
  totalViews: number
  totalVisitors: number
  folderCounts: Record<string, { total: number; shared: number }>
  tagCounts: Record<string, { total: number; shared: number }>
}

export interface ShareStatsResponse {
  globalStats: ShareGlobalStats
}

export interface ShareListResponse {
  shares: ShareInfoView[]
  total: number
  truncated: boolean
  globalStats: ShareGlobalStats
}

/**
 * What the hub's list rows need on top of the public-link fields the single-note panel already
 * shares. Structural rather than a second `ShareInfo`: the panel's shape is a contract with the
 * reader page, and a hub row should not be able to break it by adding a column.
 */
export interface ShareInfoView {
  slug: string
  noteId: string
  url: string
  hasPassword: boolean
  expiresAt: number | null
  views: number
  uniqueVisitors: number
  createdAt: number
  isEnabled: boolean
  lastViewedAt: number | null
  noteTitle: string | null
  noteExcerpt?: string
  noteDeletedAt?: number | null
  folderId: string | null
  tags: string[]
  isPinned: boolean
  isStarred: boolean
}

export interface ShareVisitsResponse {
  visits: ShareVisitLog[]
  total: number
  page: number
  limit: number
  totalPages: number
}

/**
 * One published collection: a stable address plus the access policy for "everything in this folder"
 * or "everything with this tag". The members are not part of this shape — they are derived per
 * request from the shares themselves, so `count` is a reading taken now, not a stored snapshot.
 */
export interface ShareCollection {
  id: string
  slug: string
  title: string
  /** `manual` collections store their members; the other two derive them from the target. */
  targetType: 'folder' | 'tag' | 'manual'
  targetValue: string
  count: number
  hasPassword: boolean
  expiresAt: number | null
  isEnabled: boolean
  /** The member order the page lists with; null is the shipped one (pinned first, then newest). */
  memberSort: 'default' | 'newest' | 'oldest' | 'title' | null
  createdAt: number
}

export interface ShareCollectionListResponse {
  collections: ShareCollection[]
}

/**
 * One member of a public collection's directory. `hasPassword` is the member's own lock, not the
 * collection's: opening it asks for that password, and the collection's password does not stand in
 * for it.
 */
export interface PublicCollectionNote {
  slug: string
  title: string
  excerpt: string
  hasPassword: boolean
}

/**
 * What a collection page shows once its own password has been accepted — or immediately, for a
 * collection that has none. Nothing about the directory is answered before that, including its size.
 */
export interface PublicCollection {
  title: string
  count: number
  notes: PublicCollectionNote[]
  /** Opaque; null when the page was the last one. */
  nextCursor: string | null
  limit: number
}

/** One changed field of a share link; the passcode only ever travels as set/cleared (booleans). */
export interface ShareAuditFieldChange {
  field: string
  from?: string | number | boolean | null
  to?: string | number | boolean | null
}

/**
 * What the server settled a link's filing to, echoed back so the hub can move a row between folders
 * without refetching the list. The slug rides along because a row is addressed by it, not by the note.
 */
export interface ShareFiling {
  noteId: string
  slug: string
  folderId: string | null
  tags: string[]
}

export interface ShareAuditLogEntry {
  id: string
  noteId: string
  slug: string
  action: 'create' | 'update' | 'revoke' | 'batch'
  changed: ShareAuditFieldChange[]
  createdAt: number
}

export interface ShareAuditLogResponse {
  entries: ShareAuditLogEntry[]
  total: number
  page: number
  limit: number
}
