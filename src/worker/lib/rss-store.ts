/**
 * The reading library as rows.
 *
 * The account used to keep this as one JSON column, so starring an article sent the whole library
 * and a second device's newer save quietly replaced subscriptions it had never touched. Rows let one
 * change stay one change: a write is diffed against what is stored and only the rows that moved are
 * touched. Article text is still not here on purpose — a feed's entries are rebuilt from the network
 * and live on the device that fetched them, so what the account owns is the decisions a reader made
 * about them.
 *
 * The legacy column doubles as the migration marker, which is what separates an empty library from
 * an unmigrated one: rows are only authoritative once the account has an `rss_state` row, and the
 * column is set to NULL the moment it has been split. A reader who deleted every subscription keeps
 * the state row and an empty table set, and never re-runs the split.
 */
import { emptyLibrary, parseRssLibrary, type RssFeed, type RssGroup, type RssLibrary } from '@shared/rss/model'

/** The marks that were six arrays and two maps inside the JSON blob. */
export const RSS_MARK_KINDS = ['read', 'star', 'later', 'hidden', 'opened', 'note', 'copy'] as const
export type RssMarkKind = (typeof RSS_MARK_KINDS)[number]

const LIST_KINDS: readonly RssMarkKind[] = ['read', 'star', 'later', 'hidden']

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
    'paused', 'pinned',
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

/** `<entryId>|<kind>`, the way the library spells a saved-note key. */
export function splitSavedNoteKey(key: string): { entryId: string; kind: 'note' | 'copy' } | null {
  const cut = key.lastIndexOf('|')
  const tail = key.slice(cut + 1)
  if (cut <= 0 || (tail !== 'note' && tail !== 'copy')) return null
  const entryId = key.slice(0, cut)
  return entryId ? { entryId, kind: tail } : null
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
  const readIds: string[] = []
  const favorites: string[] = []
  const readLater: string[] = []
  const hiddenIds: string[] = []
  const opened: Record<string, number> = {}
  const savedNotes: Record<string, string> = {}
  for (const mark of rows.marks) {
    const entryId = mark.entry_id
    if (mark.kind === 'read') readIds.push(entryId)
    else if (mark.kind === 'star') favorites.push(entryId)
    else if (mark.kind === 'later') readLater.push(entryId)
    else if (mark.kind === 'hidden') hiddenIds.push(entryId)
    else if (mark.kind === 'opened') opened[entryId] = mark.at
    else if (mark.kind === 'note' || mark.kind === 'copy') savedNotes[`${entryId}|${mark.kind}`] = mark.value
  }
  return parseRssLibrary({
    feeds: rows.feeds.map(feed => feedFromRow(feed, tagsByFeed.get(feed.id) ?? [])),
    groups: rows.groups.map(groupFromRow),
    readIds,
    favorites,
    readLater,
    hiddenIds,
    opened,
    savedNotes,
    lastChannel: rows.state.last_channel,
  }).data
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
    feed.lastModified, feed.paused ? 1 : 0, feed.pinned ? 1 : 0,
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
  const rows: SqlValue[][] = []
  const lists = [library.readIds, library.favorites, library.readLater, library.hiddenIds]
  lists.forEach((ids, index) => {
    const kind = LIST_KINDS[index]!
    ids.forEach((entryId, position) => {
      rows.push([kind, entryId, '', keep.get(`${kind}|${entryId}`) ?? -position])
    })
  })
  for (const [entryId, at] of Object.entries(library.opened)) {
    rows.push(['opened', entryId.slice(0, 80), '', at])
  }
  for (const [key, noteId] of Object.entries(library.savedNotes)) {
    const mark = splitSavedNoteKey(key)
    if (mark) rows.push([mark.kind, mark.entryId, noteId, 0])
  }
  return rows
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
  const library = envelope ? parseRssLibrary(envelope.library).data ?? emptyLibrary() : emptyLibrary()
  const savedAt = envelope?.savedAt ?? 0
  await runBatches(db, diffRows(rows, userId, library, savedAt).pending)
  await db.prepare('UPDATE users SET rss = NULL WHERE id = ?1').bind(userId).run()
  return { savedAt, library }
}

