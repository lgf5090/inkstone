/**
 * The reading library as rows.
 *
 * The account used to keep this as one JSON column, so starring an article sent the whole library
 * and a second device's newer save quietly replaced subscriptions it had never touched. Rows let one
 * change stay one change: a write is diffed against what is stored and only the rows that moved are
 * touched. Article rows live separately from the library: the scheduler stores bounded article text
 * for cross-device reading, while this module keeps subscriptions and the decisions made about them.
 *
 * The legacy column doubles as the migration marker, which is what separates an empty library from
 * an unmigrated one: rows are only authoritative once the account has an `rss_state` row, and the
 * column is set to NULL the moment it has been split. A reader who deleted every subscription keeps
 * the state row and an empty table set, and never re-runs the split.
 */
import { emptyLibrary, normaliseEntry, parseRssLibrary, RSS_LIMITS, type RssEntry, type RssFeed, type RssGroup, type RssLibrary } from '@shared/rss/model'
import { libraryMarkRows, marksIntoLibrary, RSS_LIST_MARK_KINDS, type RssMarkKind } from '@shared/rss/marks'
import type { RssPatch } from '@shared/rss/patch'

/** D1 binds at most 100 variables per statement; stay under it the way `routes/tags.ts` does. */
const PARAM_BUDGET = 90
const STATEMENT_BUDGET = 90

type SqlValue = string | number | null

interface RowSpec {
  table: string
  /** The written columns, in the order the values come. Primary key columns lead. */
  columns: readonly string[]
  /** The identifying columns, without `user_id`. */
  key: readonly string[]
}

const FEED_ROW: RowSpec = {
  table: 'rss_feed',
  columns: [
    'id', 'url', 'title', 'site_url', 'image_url', 'group_id', 'position', 'updated_at',
    'last_attempt_at', 'error', 'error_count', 'last_error_at', 'etag', 'last_modified',
    'paused', 'pinned', 'title_locked', 'read_before',
  ],
  key: ['id'],
}

const GROUP_ROW: RowSpec = {
  table: 'rss_group',
  columns: ['id', 'parent_id', 'name', 'position', 'collapsed', 'icon', 'color', 'created_at', 'updated_at'],
  key: ['id'],
}

const TAG_ROW: RowSpec = { table: 'rss_feed_tag', columns: ['feed_id', 'tag'], key: ['feed_id', 'tag'] }

const MARK_ROW: RowSpec = { table: 'rss_mark', columns: ['kind', 'entry_id', 'value', 'at'], key: ['kind', 'entry_id'] }
const ARTICLE_ROW: RowSpec = {
  table: 'rss_article',
  columns: ['entry_id', 'feed_id', 'title', 'link', 'author', 'published_ts', 'summary', 'content', 'image_url', 'audio_url', 'duration', 'episode', 'season', 'fetched_at'],
  key: ['entry_id'],
}

const STATE_ROW: RowSpec = { table: 'rss_state', columns: ['last_channel', 'saved_at'], key: [] }

export interface RssStored {
  savedAt: number
  library: RssLibrary | null
}

interface Row { [column: string]: SqlValue }

interface FeedRecord extends Row {
  id: string
  url: string
  title: string
  site_url: string
  image_url: string
  group_id: string
  position: number
  updated_at: number
  last_attempt_at: number
  error: string
  error_count: number
  last_error_at: number
  etag: string
  last_modified: string
  paused: number
  pinned: number
  title_locked: number
  read_before: number
}

interface GroupRecord extends Row {
  id: string
  parent_id: string | null
  name: string
  position: number
  collapsed: number
  icon: string | null
  color: string | null
  created_at: number
  updated_at: number
}

interface TagRecord extends Row { feed_id: string; tag: string }
interface MarkRecord extends Row { kind: string; entry_id: string; value: string; at: number }
interface StateRecord extends Row { last_channel: string; saved_at: number }

interface LibraryRows {
  feeds: FeedRecord[]
  groups: GroupRecord[]
  tags: TagRecord[]
  marks: MarkRecord[]
  state: StateRecord | null
}

function readLibraryRows(db: D1Database, userId: string): Promise<LibraryRows> {
  const statements = [
    ['rss_feed', ' ORDER BY position ASC, id ASC'],
    ['rss_group', ' ORDER BY position ASC, id ASC'],
    ['rss_feed_tag', ' ORDER BY feed_id ASC, tag ASC'],
    ['rss_mark', ' ORDER BY kind ASC, at DESC, entry_id ASC'],
    ['rss_state', ''],
  ] as const
  return db.batch(
    statements.map(([table, order]) => db.prepare(`SELECT * FROM ${table} WHERE user_id = ?1${order}`).bind(userId)),
  ).then(([feeds, groups, tags, marks, state]) => ({
    feeds: (feeds.results ?? []) as unknown as FeedRecord[],
    groups: (groups.results ?? []) as unknown as GroupRecord[],
    tags: (tags.results ?? []) as unknown as TagRecord[],
    marks: (marks.results ?? []) as unknown as MarkRecord[],
    state: ((state.results ?? []) as unknown as StateRecord[])[0] ?? null,
  }))
}

/** What the old column held: the library plus the instant it was accepted, in an envelope. */
export interface RssEnvelope {
  savedAt: number
  version: number
  library: unknown
}

export function readRssEnvelope(raw: string | null | undefined): RssEnvelope | null {
  if (typeof raw !== 'string' || !raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = parsed as { savedAt?: unknown; version?: unknown; library?: unknown }
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null
  if (!value.library || typeof value.library !== 'object') return null
  return {
    savedAt: Math.trunc(value.savedAt),
    version: typeof value.version === 'number' ? Math.trunc(value.version) : 0,
    library: value.library,
  }
}

function feedFromRow(row: FeedRecord, tags: string[]): RssFeed {
  return {
    id: String(row.id ?? ''),
    url: String(row.url ?? ''),
    title: String(row.title ?? ''),
    siteUrl: String(row.site_url ?? ''),
    imageUrl: String(row.image_url ?? ''),
    groupId: String(row.group_id ?? ''),
    tags,
    order: Number(row.position ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    lastAttemptAt: Number(row.last_attempt_at ?? 0),
    error: String(row.error ?? ''),
    errorCount: Number(row.error_count ?? 0),
    lastErrorAt: Number(row.last_error_at ?? 0),
    etag: String(row.etag ?? ''),
    lastModified: String(row.last_modified ?? ''),
    paused: Number(row.paused) === 1,
    pinned: Number(row.pinned) === 1,
    titleLocked: Number(row.title_locked) === 1,
    readBefore: Number(row.read_before ?? 0),
  }
}

function groupFromRow(row: GroupRecord): RssGroup {
  return {
    id: String(row.id ?? ''),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    name: String(row.name ?? ''),
    icon: row.icon ? String(row.icon) : null,
    color: row.color ? String(row.color) : null,
    position: Number(row.position ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    collapsed: Number(row.collapsed) === 1,
  }
}

/**
 * The stored rows, in the shape `parseRssLibrary` expects.
 *
 * The re-assembled object goes back through the whitelist rather than being built straight into a
 * library, so a half-written row set reads exactly like a half-written blob would: the ceilings, the
 * folder-link repair and the canonical-address dedupe cannot be bypassed by whoever wrote the rows.
 */
function rowsToLibrary(rows: LibraryRows): RssLibrary | null {
  if (!rows.state) return null
  const tagsByFeed = new Map<string, string[]>()
  for (const tag of rows.tags) {
    const list = tagsByFeed.get(tag.feed_id)
    if (list) list.push(tag.tag)
    else tagsByFeed.set(tag.feed_id, [tag.tag])
  }
  const marks = rows.marks.map(mark => ({
    kind: mark.kind as RssMarkKind,
    entryId: mark.entry_id,
    value: mark.value,
    at: mark.at,
  }))
  const parsed = parseRssLibrary(marksIntoLibrary(marks, {
    ...emptyLibrary(),
    feeds: rows.feeds.map(feed => feedFromRow(feed, tagsByFeed.get(feed.id) ?? [])),
    groups: rows.groups.map(groupFromRow),
    lastChannel: rows.state.last_channel,
  }))
  if (!parsed.data || parsed.dropped > 0 || parsed.truncated) {
    throw new Error('Stored RSS library could not be read without losing data')
  }
  return parsed.data
}

export interface RssStatement {
  sql: string
  params: (string | number | null)[]
}
function upserts(spec: RowSpec, userId: string, values: SqlValue[][]): RssStatement[] {
  if (!values.length) return []
  const columns = ['user_id', ...spec.columns]
  const per = columns.length
  const fit = Math.max(1, Math.floor(PARAM_BUDGET / per))
  const out: RssStatement[] = []
  for (let start = 0; start < values.length; start += fit) {
    const chunk = values.slice(start, start + fit)
    const rows = chunk.map((_row, j) => `(${columns.map((_column, i) => `?${j * per + i + 1}`).join(', ')})`)
    out.push({
      sql: `INSERT OR REPLACE INTO ${spec.table} (${columns.join(', ')}) VALUES ${rows.join(', ')}`,
      params: chunk.map(row => [userId, ...row]).flat(),
    })
  }
  return out
}

function deletes(spec: RowSpec, userId: string, keys: SqlValue[][]): RssStatement[] {
  if (!keys.length) return []
  if (!spec.key.length) return [{ sql: `DELETE FROM ${spec.table} WHERE user_id = ?1`, params: [userId] }]
  const columns = ['user_id', ...spec.key]
  const per = columns.length
  const fit = Math.max(1, Math.floor(PARAM_BUDGET / per))
  const out: RssStatement[] = []
  for (let start = 0; start < keys.length; start += fit) {
    const chunk = keys.slice(start, start + fit)
    const arms = chunk.map((_row, j) => `(${columns.map((column, i) => `${column} = ?${j * per + i + 1}`).join(' AND ')})`)
    out.push({ sql: `DELETE FROM ${spec.table} WHERE ${arms.join(' OR ')}`, params: chunk.map(row => [userId, ...row]).flat() })
  }
  return out
}

async function runBatches(db: D1Database, statements: readonly RssStatement[]): Promise<void> {
  for (let start = 0; start < statements.length; start += STATEMENT_BUDGET) {
    const chunk = statements.slice(start, start + STATEMENT_BUDGET)
    await db.batch(chunk.map(item => db.prepare(item.sql).bind(...item.params)))
  }
}


function feedValues(feed: RssFeed): SqlValue[] {
  return [
    feed.id, feed.url, feed.title, feed.siteUrl, feed.imageUrl, feed.groupId, feed.order,
    feed.updatedAt, feed.lastAttemptAt, feed.error, feed.errorCount, feed.lastErrorAt, feed.etag,
    feed.lastModified, feed.paused ? 1 : 0, feed.pinned ? 1 : 0, feed.titleLocked ? 1 : 0,
    feed.readBefore ?? 0,
  ]
}

function groupValues(group: RssGroup): SqlValue[] {
  return [
    group.id, group.parentId, group.name, group.position, group.collapsed ? 1 : 0, group.icon,
    group.color, group.createdAt, group.updatedAt,
  ]
}

/**
 * The mark rows a library implies.
 *
 * `keep` is what is already stored, so a full save does not churn rows it merely re-ordered: a list
 * mark's position is the reader's newest-first order, and rewriting five thousand rows to say the
 * same thing in another order is slow and pointless. A list mark that is new gets a small negative
 * `at` counting up from zero, which is what lets a library migrating out of the JSON blob keep its
 * order, while a mark made from now on carries a real clock and sorts ahead of all of them.
 */
function markValues(library: RssLibrary, keep: Map<string, number>): SqlValue[][] {
  const seen: Partial<Record<RssMarkKind, number>> = {}
  return libraryMarkRows(library).map((row) => {
    const position = seen[row.kind] ?? 0
    seen[row.kind] = position + 1
    const list = (RSS_LIST_MARK_KINDS as readonly string[]).includes(row.kind)
    const at = list ? keep.get(`${row.kind}|${row.entryId}`) ?? -position : row.at
    return [row.kind, row.entryId, row.value, at]
  })
}

function tagValues(library: RssLibrary): SqlValue[][] {
  return library.feeds.flatMap(feed => feed.tags.map(tag => [feed.id, tag] as SqlValue[]))
}

function normaliseStored(value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return Number(value)
  return value as SqlValue
}

/** The key columns lead `columns` for every row defined here, so a lookup is enough. */
function rowKey(spec: RowSpec, values: readonly SqlValue[]): string {
  return spec.key.map(column => String(values[spec.columns.indexOf(column)] ?? '')).join('|')
}

function storedValues(spec: RowSpec, row: Record<string, unknown>): SqlValue[] {
  return spec.columns.map(column => normaliseStored(row[column]))
}

/** A stored column and the value the library wants agree when neither side needs a cast. */
function sameValue(stored: SqlValue, wanted: SqlValue): boolean {
  if (stored === null) return wanted === null || wanted === '' || wanted === 0
  if (typeof wanted === 'number') return Number(stored) === wanted
  if (typeof wanted === 'string') return String(stored) === wanted
  return stored === wanted
}

function isChanged(spec: RowSpec, row: Record<string, unknown>, wanted: SqlValue[]): boolean {
  const stored = storedValues(spec, row)
  return wanted.some((value, index) => !sameValue(stored[index] ?? null, value))
}

/**
 * The statements that turn what is stored into what the library says, touching nothing else.
 *
 * The account's state row comes last on purpose: it is the marker that says the rows are the truth,
 * so a write that dies half-way must leave the reader reading the old library rather than an empty
 * one. Rows the library no longer wants are deleted only after the new ones are in.
 */
async function storeRssLibraryRows(
  db: D1Database,
  rows: LibraryRows,
  userId: string,
  library: RssLibrary,
  savedAt: number,
): Promise<RssWriteReport> {
  const { pending, written, deleted } = diffRows(rows, userId, library, savedAt)
  await runBatches(db, pending)
  return { statements: pending.length, rowsWritten: written, rowsDeleted: deleted, pending }
}

function diffRows(
  rows: LibraryRows,
  userId: string,
  library: RssLibrary,
  savedAt: number,
): { pending: RssStatement[]; written: number; deleted: number } {
  const keepAt = new Map<string, number>()
  for (const mark of rows.marks) keepAt.set(`${mark.kind}|${mark.entry_id}`, mark.at)

  const statements: RssStatement[] = []
  let written = 0
  let deleted = 0
  const tables: [RowSpec, Record<string, unknown>[], SqlValue[][]][] = [
    [FEED_ROW, rows.feeds, library.feeds.map(feedValues)],
    [GROUP_ROW, rows.groups, library.groups.map(groupValues)],
    [TAG_ROW, rows.tags, tagValues(library)],
    [MARK_ROW, rows.marks, markValues(library, keepAt)],
  ]
  for (const [spec, existing, wanted] of tables) {
    const byKey = new Map<string, SqlValue[]>()
    for (const row of wanted) byKey.set(rowKey(spec, row), row)
    const present = new Set<string>()
    const touched: SqlValue[][] = []
    const gone: SqlValue[][] = []
    for (const row of existing) {
      const stored = storedValues(spec, row)
      const key = rowKey(spec, stored)
      present.add(key)
      const match = byKey.get(key)
      if (!match) gone.push(spec.key.map(column => stored[spec.columns.indexOf(column)]))
      else if (isChanged(spec, row, match)) touched.push(match)
    }
    for (const [key, row] of byKey) {
      if (!present.has(key)) touched.push(row)
    }
    written += touched.length
    deleted += gone.length
    statements.push(...upserts(spec, userId, touched), ...deletes(spec, userId, gone))
  }

  const state: SqlValue[] = [library.lastChannel, savedAt]
  const storedState = rows.state
  const stateChanged = !storedState
    || !sameValue(normaliseStored(storedState.last_channel), state[0])
    || !sameValue(normaliseStored(storedState.saved_at), state[1])
  if (stateChanged) {
    written += 1
    statements.push(...upserts(STATE_ROW, userId, [state]))
  }
  return { pending: statements, written, deleted }
}

/**
 * What a write amounted to: the statements themselves, and how much of the library they move.
 *
 * A save that re-orders a list reports zero rows written, which is the point of diffing rather than
 * rewriting. `statements` is the count of D1 round trips the write needs.
 */
export interface RssWriteReport {
  statements: number
  rowsWritten: number
  rowsDeleted: number
  pending: RssStatement[]
}

/** Store a whole library. Every row it does not change is left alone. */
export async function storeRssLibrary(
  db: D1Database,
  userId: string,
  library: RssLibrary,
  savedAt: number,
): Promise<RssWriteReport> {
  return storeRssLibraryRows(db, await readLibraryRows(db, userId), userId, library, savedAt)
}

export type RssRowPatch = Omit<RssPatch, 'feeds'> & { feeds: { upsert: RssFeed[], remove: string[] } }

const MARK_CEILINGS: Record<RssMarkKind, number> = {
  read: RSS_LIMITS.readIds,
  star: RSS_LIMITS.favorites,
  later: RSS_LIMITS.readLater,
  hidden: RSS_LIMITS.hiddenIds,
  opened: RSS_LIMITS.openedRecords,
  note: RSS_LIMITS.savedNotes,
  copy: RSS_LIMITS.savedNotes,
}

/** Validate a marks-only change set with counts and touched keys, without reading every feed and mark. */
export async function rssMarkPatchFits(db: D1Database, userId: string, patch: RssPatch): Promise<boolean> {
  const state = await db.prepare('SELECT 1 FROM rss_state WHERE user_id = ?1').bind(userId).first()
  if (!state) await loadRssLibrary(db, userId)
  const counts = await db.prepare('SELECT kind, COUNT(*) AS count FROM rss_mark WHERE user_id = ?1 GROUP BY kind').bind(userId).all<{ kind: RssMarkKind, count: number }>()
  const current = new Map<RssMarkKind, number>(counts.results.map(row => [row.kind, Number(row.count)]))
  const touched = new Map<string, { remove: boolean, upsert: boolean }>()
  for (const row of patch.marks.remove) touched.set(`${row.kind}\u0000${row.entryId}`, { remove: true, upsert: false })
  for (const row of patch.marks.upsert) touched.set(`${row.kind}\u0000${row.entryId}`, { remove: false, upsert: true })
  const ids = [...new Set([...patch.marks.remove, ...patch.marks.upsert].map(row => row.entryId))]
  const existing = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80)
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(',')
    const rows = await db.prepare(`SELECT kind, entry_id FROM rss_mark WHERE user_id = ?1 AND entry_id IN (${placeholders})`)
      .bind(userId, ...chunk).all<{ kind: RssMarkKind, entry_id: string }>()
    for (const row of rows.results) existing.add(`${row.kind}\u0000${row.entry_id}`)
  }
  const projected = new Map(current)
  for (const [key, change] of touched) {
    const kind = key.slice(0, key.indexOf('\u0000')) as RssMarkKind
    const before = existing.has(key) ? 1 : 0
    const after = change.upsert ? 1 : 0
    projected.set(kind, (projected.get(kind) ?? 0) + after - before)
  }
  for (const [kind, count] of projected) {
    if (count > MARK_CEILINGS[kind]) return false
  }
  const savedNotes = (projected.get('note') ?? 0) + (projected.get('copy') ?? 0)
  return savedNotes <= RSS_LIMITS.savedNotes
}

/** Apply only the rows a change set names, so concurrent devices cannot delete each other's additions. */
export async function storeRssPatch(
  db: D1Database,
  userId: string,
  patch: RssRowPatch,
  savedAt: number,
): Promise<{ rows: number }> {
  const statements = [
    ...upserts(GROUP_ROW, userId, patch.groups.upsert.map(groupValues)),
    ...upserts(FEED_ROW, userId, patch.feeds.upsert.map(feedValues)),
    ...deletes(TAG_ROW, userId, patch.tags.remove.map(key => [key.feedId, key.tag])),
    ...upserts(TAG_ROW, userId, patch.tags.upsert.map(key => [key.feedId, key.tag])),
    ...deletes(FEED_ROW, userId, patch.feeds.remove.map(id => [id])),
    ...patch.feeds.remove.map(id => ({ sql: 'DELETE FROM rss_article WHERE user_id = ?1 AND feed_id = ?2', params: [userId, id] })),
    ...deletes(GROUP_ROW, userId, patch.groups.remove.map(id => [id])),
    ...deletes(MARK_ROW, userId, patch.marks.remove.map(row => [row.kind, row.entryId])),
    ...upserts(MARK_ROW, userId, patch.marks.upsert.map(row => [row.kind, row.entryId, row.value, row.at])),
    ...(patch.state ? upserts(STATE_ROW, userId, [[patch.state.lastChannel, savedAt]]) : [
      { sql: 'UPDATE rss_state SET saved_at = ?1 WHERE user_id = ?2', params: [savedAt, userId] },
      { sql: 'INSERT OR IGNORE INTO rss_state (user_id, last_channel, saved_at) VALUES (?1, ?, ?2)', params: [userId, savedAt] },
    ]),
  ]
  await runBatches(db, statements)
  const rows = patch.groups.upsert.length + patch.feeds.upsert.length
    + patch.tags.remove.length + patch.tags.upsert.length
    + patch.feeds.remove.length + patch.groups.remove.length
    + patch.marks.remove.length + patch.marks.upsert.length
    + 1
  return { rows }
}

/**
 * What the account has stored, reading the legacy column once and splitting it on the way out.
 *
 * The split is the whole migration: there is no cron over every account, and a reader who never
 * opens the app again never needs their marks moved. An account with neither rows nor a legacy
 * column has nothing, which is a different answer from an account that has empty rows.
 */
export async function loadRssLibrary(db: D1Database, userId: string): Promise<RssStored> {
  const rows = await readLibraryRows(db, userId)
  const stored = rowsToLibrary(rows)
  if (stored) return { savedAt: rows.state?.saved_at ?? 0, library: stored }

  const user = await db.prepare('SELECT rss FROM users WHERE id = ?1').bind(userId).first<{ rss: string | null }>()
  const raw = user?.rss ?? null
  if (!raw) return { savedAt: 0, library: null }

  const envelope = readRssEnvelope(raw)
  if (!envelope) throw new Error('Stored RSS library is unreadable; legacy data was left untouched')
  const parsed = parseRssLibrary(envelope.library)
  if (!parsed.data || parsed.dropped > 0 || parsed.truncated) {
    throw new Error('Stored RSS library could not be migrated without losing data')
  }
  const library = parsed.data
  const savedAt = envelope.savedAt
  await runBatches(db, diffRows(rows, userId, library, savedAt).pending)
  await db.prepare('UPDATE users SET rss = NULL WHERE id = ?1').bind(userId).run()
  return { savedAt, library }
}


/**
 * Whether the account the session names still has its row.
 *
 * The library writes in this module are addressed by account id, so an account deleted between the
 * session read and this request would otherwise have its rows written into a row that is already
 * gone. The route asks here rather than inlining the probe, because the same `users` row this module
 * already reads (the legacy `rss` column of `loadRssLibrary`) is what answers the question.
 */
export async function accountExists(db: D1Database, userId: string): Promise<boolean> {
  const account = await db.prepare('SELECT id FROM users WHERE id = ?1').bind(userId).first()
  return account !== null
}

/** The common migrated-account check for a reading upload: one feed row, not the whole library. */
export async function rssFeedExists(db: D1Database, userId: string, feedId: string): Promise<boolean> {
  const feed = await db.prepare('SELECT 1 FROM rss_feed WHERE user_id = ?1 AND id = ?2').bind(userId, feedId).first()
  if (feed) return true
  const state = await db.prepare('SELECT 1 FROM rss_state WHERE user_id = ?1').bind(userId).first()
  if (state) return false
  // No state row means either a new account or a legacy library that still needs its one-time split.
  const stored = await loadRssLibrary(db, userId)
  return Boolean(stored.library?.feeds.some(item => item.id === feedId))
}

interface ArticleRow {
  feed_id: string
  entry_id: string
  title: string
  link: string
  author: string
  published_ts: number | null
  summary: string
  content: string
  image_url: string
  audio_url: string
  duration: number | null
  episode: number | null
  season: number | null
  fetched_at: number
}

function articleValues(entry: RssEntry, fetchedAt: number): SqlValue[] {
  return [
    entry.id, entry.feedId, entry.title, entry.link, entry.author, entry.publishedTs,
    entry.summary, entry.content, entry.imageUrl, entry.audioUrl, entry.duration ?? null,
    entry.episode ?? null, entry.season ?? null, fetchedAt,
  ]
}

/** Server-side article storage: metadata and bounded bodies in D1 for cross-device reading. */
export async function saveServerRssArticles(db: D1Database, userId: string, feedId: string, entries: readonly RssEntry[], fetchedAt = Date.now()): Promise<number> {
  const statements = [
    ...upserts(ARTICLE_ROW, userId, entries.map(entry => articleValues({ ...entry, feedId }, fetchedAt))),
    {
      sql: `DELETE FROM rss_article WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid, ROW_NUMBER() OVER (ORDER BY published_ts DESC, fetched_at DESC, entry_id) AS rank,
                 SUM(length(content) + length(summary) + length(title)) OVER
                   (ORDER BY published_ts DESC, fetched_at DESC, entry_id ROWS UNBOUNDED PRECEDING) AS chars
            FROM rss_article WHERE user_id = ?1 AND feed_id = ?2
        ) WHERE rank > ?3 OR chars > ?4
      )`,
      params: [userId, feedId, RSS_LIMITS.entriesPerFeed, RSS_LIMITS.feedBytes],
    },
  ]
  await db.batch(statements.map(statement => db.prepare(statement.sql).bind(...statement.params)))
  const kept = await db.prepare('SELECT COUNT(*) AS count FROM rss_article WHERE user_id = ?1 AND feed_id = ?2')
    .bind(userId, feedId).first<{ count: number }>()
  return Number(kept?.count ?? 0)
}

function articleFromRow(row: ArticleRow): RssEntry | null {
  return normaliseEntry({
    id: row.entry_id,
    title: row.title,
    link: row.link,
    author: row.author,
    publishedTs: row.published_ts,
    summary: row.summary,
    content: row.content,
    imageUrl: row.image_url,
    audioUrl: row.audio_url,
    duration: row.duration,
    episode: row.episode,
    season: row.season,
  }, row.feed_id)
}

export async function loadServerRssArticles(db: D1Database, userId: string, feedId: string): Promise<RssEntry[]> {
  const { results } = await db.prepare(
    `SELECT feed_id, entry_id, title, link, author, published_ts, summary, content, image_url, audio_url, duration, episode, season, fetched_at
       FROM rss_article WHERE user_id = ?1 AND feed_id = ?2
      ORDER BY published_ts DESC, fetched_at DESC, entry_id ASC LIMIT ?3`,
  ).bind(userId, feedId, RSS_LIMITS.entriesPerFeed).all<ArticleRow>()
  return results.map(articleFromRow).filter((entry): entry is RssEntry => entry !== null)
}

export type RssArticleField = 'any' | 'title' | 'summary' | 'content' | 'author'
export type RssArticleMarkFilter = 'unread' | 'starred' | 'later'

export interface RssArticleQuery {
  feedId?: string
  query?: string
  field?: RssArticleField
  author?: string
  from?: number
  to?: number
  mark?: RssArticleMarkFilter
  limit?: number
}

export interface RssArticlePage {
  entries: RssEntry[]
  total: number
}

const ARTICLE_COLUMNS = 'feed_id, entry_id, title, link, author, published_ts, summary, content, image_url, audio_url, duration, episode, season, fetched_at'
const ARTICLE_FIELDS: Record<RssArticleField, string> = {
  any: "(instr(title, ?) > 0 OR instr(summary, ?) > 0 OR instr(content, ?) > 0 OR instr(author, ?) > 0)",
  title: 'instr(title, ?) > 0',
  summary: 'instr(summary, ?) > 0',
  content: 'instr(content, ?) > 0',
  author: 'instr(author, ?) > 0',
}

function articleScope(query: RssArticleQuery): { sql: string, params: SqlValue[] } {
  const clauses: string[] = []
  const params: SqlValue[] = []
  const bind = (value: SqlValue): string => {
    params.push(value)
    return `?${params.length + 1}`
  }
  if (query.feedId) clauses.push(`feed_id = ${bind(query.feedId.slice(0, 80))}`)
  const term = query.query?.trim().slice(0, 200) ?? ''
  if (term) {
    const field = query.field && ARTICLE_FIELDS[query.field] ? query.field : 'any'
    const expression = ARTICLE_FIELDS[field]
    const count = field === 'any' ? 4 : 1
    for (let index = 0; index < count; index++) clauses.push(expression.replaceAll('?', bind(term)))
  }
  const author = query.author?.trim().slice(0, 120) ?? ''
  if (author) clauses.push(`instr(author, ${bind(author)}) > 0`)
  if (typeof query.from === 'number' && Number.isFinite(query.from)) clauses.push(`published_ts >= ${bind(Math.trunc(query.from))}`)
  if (typeof query.to === 'number' && Number.isFinite(query.to)) clauses.push(`published_ts <= ${bind(Math.trunc(query.to))}`)
  clauses.push(`EXISTS (SELECT 1 FROM rss_feed feed WHERE feed.user_id = rss_article.user_id AND feed.id = rss_article.feed_id)`)
  clauses.push(`NOT EXISTS (SELECT 1 FROM rss_mark hidden WHERE hidden.user_id = rss_article.user_id AND hidden.kind = 'hidden' AND hidden.entry_id = rss_article.entry_id)`)
  if (query.mark === 'unread') {
    clauses.push(`NOT EXISTS (SELECT 1 FROM rss_mark read WHERE read.user_id = rss_article.user_id AND read.kind = 'read' AND read.entry_id = rss_article.entry_id)`)
  }
  else if (query.mark) {
    const kind = query.mark === 'starred' ? 'star' : 'later'
    clauses.push(`EXISTS (SELECT 1 FROM rss_mark mark WHERE mark.user_id = rss_article.user_id AND mark.kind = '${kind}' AND mark.entry_id = rss_article.entry_id)`)
  }
  return { sql: clauses.join(' AND '), params }
}

export async function queryServerRssArticles(db: D1Database, userId: string, query: RssArticleQuery = {}): Promise<RssArticlePage> {
  const scope = articleScope(query)
  const limit = Math.min(500, Math.max(1, Math.trunc(query.limit ?? 50)))
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM rss_article WHERE user_id = ?1 AND ${scope.sql}`)
    .bind(userId, ...scope.params).first<{ total: number }>()
  const { results } = await db.prepare(
    `SELECT ${ARTICLE_COLUMNS} FROM rss_article WHERE user_id = ?1 AND ${scope.sql}
      ORDER BY published_ts DESC, fetched_at DESC, entry_id ASC LIMIT ${limit}`,
  ).bind(userId, ...scope.params).all<ArticleRow>()
  return {
    entries: results.map(articleFromRow).filter((entry): entry is RssEntry => entry !== null),
    total: Number(count?.total ?? 0),
  }
}

export async function searchServerRssArticles(db: D1Database, userId: string, query: string, feedId = '', limit = 50): Promise<RssEntry[]> {
  const page = await queryServerRssArticles(db, userId, { query, feedId, limit })
  return page.entries
}

export async function loadServerRssArticle(db: D1Database, userId: string, entryId: string): Promise<RssEntry | null> {
  const { results } = await db.prepare(
    `SELECT ${ARTICLE_COLUMNS} FROM rss_article
      WHERE user_id = ?1 AND entry_id = ?2
        AND EXISTS (SELECT 1 FROM rss_feed feed WHERE feed.user_id = rss_article.user_id AND feed.id = rss_article.feed_id)
        AND NOT EXISTS (SELECT 1 FROM rss_mark mark WHERE mark.user_id = rss_article.user_id AND mark.kind = 'hidden' AND mark.entry_id = rss_article.entry_id)
      LIMIT 1`,
  ).bind(userId, entryId.slice(0, 80)).all<ArticleRow>()
  return results[0] ? articleFromRow(results[0]) : null
}

export async function loadServerRssArticleCounts(db: D1Database, userId: string): Promise<Map<string, number>> {
  const { results } = await db.prepare(
    `SELECT a.feed_id, COUNT(*) AS unread
       FROM rss_article a
      WHERE a.user_id = ?1
        AND NOT EXISTS (SELECT 1 FROM rss_mark m WHERE m.user_id = a.user_id AND m.kind = 'read' AND m.entry_id = a.entry_id)
        AND NOT EXISTS (SELECT 1 FROM rss_mark m WHERE m.user_id = a.user_id AND m.kind = 'hidden' AND m.entry_id = a.entry_id)
      GROUP BY a.feed_id`,
  ).bind(userId).all<{ feed_id: string, unread: number }>()
  return new Map(results.map(row => [row.feed_id, Number(row.unread)]))
}

export interface RssRule {
  id: string
  feedId: string
  keyword: string
  enabled: boolean
  createdAt: number
}

interface RuleRow {
  id: string
  feed_id: string
  keyword: string
  enabled: number
  created_at: number
}

export async function listRssRules(db: D1Database, userId: string): Promise<RssRule[]> {
  const { results } = await db.prepare('SELECT id, feed_id, keyword, enabled, created_at FROM rss_rule WHERE user_id = ?1 ORDER BY created_at DESC, id ASC')
    .bind(userId).all<RuleRow>()
  return results.map(row => ({ id: row.id, feedId: row.feed_id, keyword: row.keyword, enabled: row.enabled === 1, createdAt: row.created_at }))
}

export async function createRssRule(db: D1Database, userId: string, feedId: string, keyword: string): Promise<RssRule> {
  const rule: RssRule = { id: crypto.randomUUID(), feedId, keyword, enabled: true, createdAt: Date.now() }
  await db.prepare('INSERT INTO rss_rule (user_id, id, feed_id, keyword, enabled, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)')
    .bind(userId, rule.id, rule.feedId, rule.keyword, rule.createdAt).run()
  return rule
}

export async function deleteRssRule(db: D1Database, userId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM rss_rule WHERE user_id = ?1 AND id = ?2').bind(userId, id).run()
}

export interface RssReadingStats {
  total: number
  read: number
  unread: number
  favorites: number
  later: number
  feeds: Array<{ feedId: string, total: number, read: number }>
  daily: Array<{ date: string, count: number }>
}

export async function loadRssReadingStats(db: D1Database, userId: string): Promise<RssReadingStats> {
  const summary = await db.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM rss_mark m WHERE m.user_id = a.user_id AND m.kind = 'read' AND m.entry_id = a.entry_id) THEN 1 ELSE 0 END) AS read,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM rss_mark m WHERE m.user_id = a.user_id AND m.kind = 'star' AND m.entry_id = a.entry_id) THEN 1 ELSE 0 END) AS favorites,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM rss_mark m WHERE m.user_id = a.user_id AND m.kind = 'later' AND m.entry_id = a.entry_id) THEN 1 ELSE 0 END) AS later
       FROM rss_article a WHERE a.user_id = ?1`,
  ).bind(userId).first<{ total: number, read: number, favorites: number, later: number }>()
  const feeds = await db.prepare(
    `SELECT a.feed_id, COUNT(*) AS total,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM rss_mark m WHERE m.user_id = a.user_id AND m.kind = 'read' AND m.entry_id = a.entry_id) THEN 1 ELSE 0 END) AS read
       FROM rss_article a WHERE a.user_id = ?1 GROUP BY a.feed_id ORDER BY total DESC, a.feed_id ASC LIMIT 20`,
  ).bind(userId).all<{ feed_id: string, total: number, read: number }>()
  const daily = await db.prepare(
    `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS date, COUNT(*) AS count
       FROM rss_mark WHERE user_id = ?1 AND kind = 'opened' AND at >= ?2
      GROUP BY date ORDER BY date ASC`,
  ).bind(userId, Date.now() - 6 * 86_400_000).all<{ date: string, count: number }>()
  const total = Number(summary?.total ?? 0)
  const read = Number(summary?.read ?? 0)
  return {
    total,
    read,
    unread: Math.max(0, total - read),
    favorites: Number(summary?.favorites ?? 0),
    later: Number(summary?.later ?? 0),
    feeds: feeds.results.map(row => ({ feedId: row.feed_id, total: Number(row.total), read: Number(row.read) })),
    daily: daily.results.map(row => ({ date: row.date, count: Number(row.count) })),
  }
}
