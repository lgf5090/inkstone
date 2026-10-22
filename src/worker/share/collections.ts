/**
 * Published collections: a folder, a tag or a hand-picked set given a stable public address.
 *
 * The address and the access policy are stored; the members are not, except for a `manual` collection.
 * Everything a folder or tag page shows is derived from `shares` on the request, so a page cannot display
 * a link the owner revoked a minute ago, and a rename moves the page with the record rather than against
 * a stored copy of its name. The visibility rule it derives under is the same `active` status the owner's
 * own list filters by — through `shareSelectionSql`, never spelled out again here: the reference carried
 * a second copy of that rule in each of its two statements, and two copies of a rule stop being identical
 * the day one of them is edited.
 *
 * A collection stores a folder or tag *record id*, while shares store a folder by id and a tag by *name*.
 * `resolveShareTarget()` is the only conversion between the two and it runs on every read, which is what
 * makes the past failure — a tag collection matching its tag's id against the array of names, an empty
 * page beside a sidebar count that said it was full — impossible to write again.
 *
 * `manual` is the one kind whose `target_value` is not a record. The partial unique index
 * `idx_share_collections_target` is over `(user_id, target_type, target_value) WHERE is_enabled = 1`, so
 * an empty value would let an account publish exactly one enabled hand-picked set and answer the second
 * with a constraint error rather than a product decision. `manualTargetValue()` stores the collection's
 * own id: unique per row, so the index keeps meaning "one live directory per target" and a hand-picked
 * set counts as a target of its own.
 */

import { LIMITS } from '@shared/constants'
import type { ShareCollection } from '@shared/share-hub'
import {
  isShareTargetType,
  resolveShareTarget,
  type ShareTarget,
  type ShareTargetRecord,
  type ShareTargetType,
} from '@shared/share-selection'
import { ApiError } from '../lib/errors'
import { isValidId, isValidSlug, newId, newSlug } from '../lib/id'
import { MAX_BATCH_SHARE_IDS } from './organizer'
import { shareSelectionSql, type ShareSqlConditions } from './selection-sql'

/** The member orders a collection page can list with. `default` is the shipped order. */
export const COLLECTION_MEMBER_SORTS = ['default', 'newest', 'oldest', 'title'] as const

/**
 * How many members one hand-picked directory may hold.
 *
 * A roster is the only collection write a stranger's page pays for on every visit, so an uncapped one is
 * a public page whose cost the owner sets. The number is the batch's own, imported rather than retyped:
 * a roster a single request could not even name is not a second ceiling worth having, and two numbers for
 * one question are two answers that can drift.
 */
export const MAX_MANUAL_COLLECTION_MEMBERS = MAX_BATCH_SHARE_IDS

export type CollectionMemberSort = (typeof COLLECTION_MEMBER_SORTS)[number]

export function isCollectionMemberSort(value: unknown): value is CollectionMemberSort {
  return typeof value === 'string' && (COLLECTION_MEMBER_SORTS as readonly string[]).includes(value)
}

/**
 * How many statements one collection write puts in a batch.
 *
 * D1 caps the statements a `batch()` call takes and the ceiling is not one number across plans, so the
 * roster writes work under a small constant of their own — the same one the organizer's link rewrites use.
 */
const STATEMENT_CHUNK = 50

/** A collection row's target as the table stores it: the type is a string until this module reads it. */
export interface CollectionTargetRow {
  target_type: string
  target_value: string
}

/** The kind a stored row claims to be, or null when the column holds something no rule answers. */
export type ShareCollectionKind = ShareTargetType | 'manual'

/**
 * The kind read from the column, validated.
 *
 * `share_collections.target_type` is CHECK-constrained to these three, so null means a row that came from
 * outside the schema. Naming it is still worth the read: the alternative is to treat an unknown value as
 * one of the three kinds it is not, and then the target rule, the member query and the page all answer a
 * question nobody asked.
 */
export function collectionTargetType(row: CollectionTargetRow): ShareCollectionKind | null {
  if (row.target_type === 'manual') return 'manual'
  return isShareTargetType(row.target_type) ? row.target_type : null
}

/** The record a folder or tag collection addresses; null for a hand-picked set and for a junk type. */
export function collectionTargetRecord(row: CollectionTargetRow): ShareTargetRecord | null {
  return isShareTargetType(row.target_type) ? { type: row.target_type, value: row.target_value } : null
}

/**
 * What a collection covers, decided from its row and the live name of its target.
 *
 * `manual` owns its roster. A `folder` or `tag` derives it from the resolved target. `unreadable` is a
 * row whose `target_type` holds something the schema's own CHECK forbids: the directory exists and has an
 * address, and it covers no share — it does not secretly cover all of them.
 */
export type CollectionScope =
  | { kind: 'manual' }
  | { kind: 'derived'; target: ShareTarget }
  | { kind: 'unreadable' }

export function collectionScope(row: CollectionTargetRow, tagName: string | null): CollectionScope {
  const kind = collectionTargetType(row)
  if (kind === 'manual') return { kind: 'manual' }
  if (!kind) return { kind: 'unreadable' }
  return {
    kind: 'derived',
    target: resolveShareTarget({ type: kind, value: row.target_value }, tagName),
  }
}

/** The target value a hand-picked collection stores: its own id, which is unique per row. */
export function manualTargetValue(collectionId: string): string {
  return collectionId
}

/**
 * What a collection page selects: its target plus the visibility rule every visitor-facing list applies.
 *
 * A null target is a hand-picked collection, whose roster is the members table; the visibility rule still
 * runs, so a paused member leaves the page without the collection being edited.
 */
export function collectionMemberConditions(params: {
  target: ShareTarget | null
  now: number
  firstBind: number
}): ShareSqlConditions {
  return shareSelectionSql({ status: 'active', target: params.target }, params)
}

/** One column of a page's order, and the cursor field that pages by it. */
interface KeysetField {
  /** The expression compared, qualified by the statement's own alias. */
  expression: string
  /** Whether the list runs high-to-low, which decides the direction of every comparison. */
  descending: boolean
  /** Set when the comparison has to carry its own collation, which is the title's case. */
  nocase?: boolean
  /** The cursor's value this field is paged by. */
  value: (cursor: CollectionCursor) => string | number
}

/** One page order, spelled as the columns it sorts by; the keyset follows from them, never beside them. */
interface MemberSortSpec {
  fields: KeysetField[]
  /** How the cursor carries this order's extra field, and null when the three it always carries suffice. */
  cursorField: 'title' | 'sortOrder' | null
}

const UPDATED_AT_DESC: KeysetField = { expression: 'n.updated_at', descending: true, value: (cursor) => cursor.updatedAt }
const UPDATED_AT_ASC: KeysetField = { expression: 'n.updated_at', descending: false, value: (cursor) => cursor.updatedAt }
const SLUG_DESC: KeysetField = { expression: 's.slug', descending: true, value: (cursor) => cursor.slug }
const SLUG_ASC: KeysetField = { expression: 's.slug', descending: false, value: (cursor) => cursor.slug }
const IS_PINNED: KeysetField = { expression: 'n.is_pinned', descending: true, value: (cursor) => cursor.isPinned }
const TITLE: KeysetField = { expression: 'n.title', descending: false, nocase: true, value: (cursor) => cursor.title ?? '' }
const SORT_ORDER: KeysetField = { expression: 'm.sort_order', descending: false, value: (cursor) => cursor.sortOrder ?? 0 }

const MEMBER_SORT_SPECS: Record<CollectionMemberSort, MemberSortSpec> = {
  default: { fields: [IS_PINNED, UPDATED_AT_DESC, SLUG_DESC], cursorField: null },
  newest: { fields: [UPDATED_AT_DESC, SLUG_DESC], cursorField: null },
  oldest: { fields: [UPDATED_AT_ASC, SLUG_ASC], cursorField: null },
  title: { fields: [TITLE, SLUG_ASC], cursorField: 'title' },
}

/** A hand-picked collection lists in the order the owner gave, so that is the order its cursor pages by. */
const MANUAL_SORT: MemberSortSpec = { fields: [SORT_ORDER, SLUG_ASC], cursorField: 'sortOrder' }

function memberSortSpec(sort: string | null | undefined): MemberSortSpec {
  if (sort === 'newest' || sort === 'oldest' || sort === 'title') return MEMBER_SORT_SPECS[sort]
  return MEMBER_SORT_SPECS.default
}

function collate(field: KeysetField): string {
  return field.nocase ? ' COLLATE NOCASE' : ''
}

/** The `ORDER BY` list a spec answers with, tie-breakers included. */
function orderTerms(spec: MemberSortSpec): string {
  return spec.fields
    .map((field) => `${field.expression}${collate(field)} ${field.descending ? 'DESC' : 'ASC'}`)
    .join(', ')
}

/**
 * The keyset predicate that continues a page after the cursor.
 *
 * Generated from the same fields that produced the `ORDER BY`, in the same order and with the same
 * directions: a predicate written beside the ordering is a predicate that can disagree with it, and the
 * disagreement shows up as a row skipped or repeated on the second page, which nobody sees coming. Each
 * field binds once, and the placeholders a longer prefix repeats point at that same bind.
 */
function keysetCondition(
  spec: MemberSortSpec,
  cursor: CollectionCursor,
  firstBind: number,
): { sql: string; binds: Array<string | number> } {
  const binds: Array<string | number> = spec.fields.map((field) => field.value(cursor))
  const ors: string[] = []
  for (let index = 0; index < spec.fields.length; index += 1) {
    const field = spec.fields[index]!
    const placeholder = `?${firstBind + index}`
    const step = `${field.expression} ${field.descending ? '<' : '>'} ${placeholder}${collate(field)}`
    if (index === 0) {
      ors.push(`(${step})`)
      continue
    }
    const equal = spec
      .fields.slice(0, index)
      .map((before, position) => `${before.expression} = ?${firstBind + position}${collate(before)}`)
    ors.push(`(${equal.join(' AND ')} AND ${step})`)
  }
  return { sql: `(${ors.join(' OR ')})`, binds }
}

/** One member row of a directory page. */
export interface CollectionMemberRow {
  title: string
  excerpt: string
  is_pinned: number
  updated_at: number
  slug: string
  password_hash: string | null
  /** Only a hand-picked collection's rows carry the position the owner arranged. */
  sort_order?: number
}

/** Where a page stopped, in the order the page was sorted by. */
export interface CollectionCursor {
  isPinned: number
  updatedAt: number
  slug: string
  /** Only the title order pages by the note title, which may itself hold the delimiter. */
  title?: string
  /** Only a hand-picked collection pages by the stored position. */
  sortOrder?: number
}

const MEMBER_COLUMNS = 'n.title, n.excerpt, n.is_pinned, n.updated_at, s.slug, s.password_hash'

/**
 * One page of a folder or tag collection's members.
 *
 * The account bind is `?1` and the member conditions start after it, so the page and its count number
 * their placeholders from the same place and cannot select different rows.
 */
export function collectionMembersSql(params: {
  userId: string
  target: ShareTarget
  now: number
  cursor: CollectionCursor | null
  limit: number
  sort?: string | null
}): { sql: string; binds: Array<string | number> } {
  const spec = memberSortSpec(params.sort)
  const member = collectionMemberConditions({ target: params.target, now: params.now, firstBind: 2 })
  const binds: Array<string | number> = [params.userId, ...member.binds]
  let cursorClause = ''
  if (params.cursor) {
    const keyset = keysetCondition(spec, params.cursor, binds.length + 1)
    binds.push(...keyset.binds)
    cursorClause = ` AND ${keyset.sql}`
  }
  binds.push(params.limit)
  return {
    sql: `SELECT ${MEMBER_COLUMNS}
            FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
           WHERE s.user_id = ?1 AND n.deleted_at IS NULL AND ${member.conditions.join(' AND ')}${cursorClause}
           ORDER BY ${orderTerms(spec)}
           LIMIT ?${binds.length}`,
    binds,
  }
}

/** How many members a folder or tag collection has right now, by the conditions the page lists with. */
export function collectionMemberCountSql(params: {
  userId: string
  target: ShareTarget
  now: number
}): { sql: string; binds: Array<string | number> } {
  const member = collectionMemberConditions({ target: params.target, now: params.now, firstBind: 2 })
  return {
    sql: `SELECT COUNT(*) AS members
            FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
           WHERE s.user_id = ?1 AND n.deleted_at IS NULL AND ${member.conditions.join(' AND ')}`,
    binds: [params.userId, ...member.binds],
  }
}

/**
 * The same page for a hand-picked collection: the owner's order, intersected with what is live now.
 *
 * Membership is the stored choice; visibility is still derived, so pausing or revoking one member's link
 * takes it off the page without editing the collection.
 */
export function manualCollectionMembersSql(params: {
  userId: string
  collectionId: string
  now: number
  cursor: CollectionCursor | null
  limit: number
}): { sql: string; binds: Array<string | number> } {
  const member = collectionMemberConditions({ target: null, now: params.now, firstBind: 3 })
  const binds: Array<string | number> = [params.userId, params.collectionId, ...member.binds]
  let cursorClause = ''
  if (params.cursor) {
    const keyset = keysetCondition(MANUAL_SORT, params.cursor, binds.length + 1)
    binds.push(...keyset.binds)
    cursorClause = ` AND ${keyset.sql}`
  }
  binds.push(params.limit)
  return {
    sql: `SELECT ${MEMBER_COLUMNS}, m.sort_order
            FROM share_collection_members m
            JOIN shares s ON s.note_id = m.note_id AND s.user_id = ?1
            JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
           WHERE m.collection_id = ?2 AND n.deleted_at IS NULL AND ${member.conditions.join(' AND ')}${cursorClause}
           ORDER BY ${orderTerms(MANUAL_SORT)}
           LIMIT ?${binds.length}`,
    binds,
  }
}

/** The hand-picked collection's own count, by the conditions its page lists with. */
export function manualCollectionCountSql(params: {
  userId: string
  collectionId: string
  now: number
}): { sql: string; binds: Array<string | number> } {
  const member = collectionMemberConditions({ target: null, now: params.now, firstBind: 3 })
  return {
    sql: `SELECT COUNT(*) AS members
            FROM share_collection_members m
            JOIN shares s ON s.note_id = m.note_id AND s.user_id = ?1
            JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
           WHERE m.collection_id = ?2 AND n.deleted_at IS NULL AND ${member.conditions.join(' AND ')}`,
    binds: [params.userId, params.collectionId, ...member.binds],
  }
}

export function collectionMembersStatement(db: D1Database, params: Parameters<typeof collectionMembersSql>[0]): D1PreparedStatement {
  const query = collectionMembersSql(params)
  return db.prepare(query.sql).bind(...query.binds)
}

export function collectionMemberCountStatement(db: D1Database, params: Parameters<typeof collectionMemberCountSql>[0]): D1PreparedStatement {
  const query = collectionMemberCountSql(params)
  return db.prepare(query.sql).bind(...query.binds)
}

export function manualCollectionMembersStatement(db: D1Database, params: Parameters<typeof manualCollectionMembersSql>[0]): D1PreparedStatement {
  const query = manualCollectionMembersSql(params)
  return db.prepare(query.sql).bind(...query.binds)
}

export function manualCollectionCountStatement(db: D1Database, params: Parameters<typeof manualCollectionCountSql>[0]): D1PreparedStatement {
  const query = manualCollectionCountSql(params)
  return db.prepare(query.sql).bind(...query.binds)
}

/**
 * The cursor names where the last page stopped, in the order the page was sorted by.
 *
 * Opaque on purpose: it exposes the owner's arrangement, and a client that composed one itself would be
 * reimplementing the ordering rule and would go on working after that rule changed.
 */
export function nextCollectionCursor(rows: CollectionMemberRow[], limit: number, sort: string | null): string | null {
  if (rows.length < limit) return null
  const last = rows[rows.length - 1]
  if (!last) return null
  const cursor: CollectionCursor = { isPinned: last.is_pinned, updatedAt: last.updated_at, slug: last.slug }
  if (sort === 'title') cursor.title = last.title
  if (sort === 'manual') cursor.sortOrder = last.sort_order ?? 0
  return encodeCollectionCursor(cursor)
}

function encodeCollectionCursor(cursor: CollectionCursor): string {
  // The fourth field, when there is one, is tagged: `t` for a note title (which may itself carry the
  // delimiter, so it travels encoded) and `#` for a hand-picked position. A title can never produce a raw
  // `#`, because encodeURIComponent escapes it.
  const fourth =
    cursor.title !== undefined
      ? `t${encodeURIComponent(cursor.title)}`
      : cursor.sortOrder !== undefined
        ? `#${cursor.sortOrder}`
        : undefined
  const raw =
    fourth === undefined
      ? `${cursor.isPinned}|${cursor.updatedAt}|${cursor.slug}`
      : `${cursor.isPinned}|${cursor.updatedAt}|${cursor.slug}|${fourth}`
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * Null for an absent cursor. A malformed one is an error the caller must answer, not a first page:
 * silently restarting would show a reader the same rows twice and call it a second page.
 */
export function decodeCollectionCursor(raw: string | undefined): CollectionCursor | null {
  if (!raw) return null
  const padded = raw.replaceAll('-', '+').replaceAll('_', '/')
  const decoded = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const [pinnedText, updatedText, slug, encodedFourth] = decoded.split('|')
  const isPinned = Number(pinnedText)
  const updatedAt = Number(updatedText)
  if (
    (isPinned !== 0 && isPinned !== 1) ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    !slug ||
    !isValidSlug(slug)
  ) {
    throw new Error('invalid collection cursor')
  }
  const cursor: CollectionCursor = { isPinned, updatedAt, slug }
  if (encodedFourth !== undefined) applyCursorFourthField(cursor, encodedFourth)
  return cursor
}

/** The tagged fourth field, decoded onto the cursor: a hand-picked position or an encoded title. */
function applyCursorFourthField(cursor: CollectionCursor, encodedFourth: string): void {
  if (/^#\d+$/.test(encodedFourth)) {
    cursor.sortOrder = Number(encodedFourth.slice(1))
    return
  }
  if (encodedFourth.startsWith('t')) {
    try {
      cursor.title = decodeURIComponent(encodedFourth.slice(1))
      return
    } catch {
      throw new Error('invalid collection cursor')
    }
  }
  throw new Error('invalid collection cursor')
}

/**
 * The live name of the folder or tag a collection points at, read at request time.
 *
 * One lookup answers both questions a page has: the name in its title, and the value its members have to
 * carry. A tag whose row is gone has no name to show and no name to match, so both halves come from this
 * one read and there is no stored copy of either to fall out of date.
 */
export async function collectionTargetName(
  db: D1Database,
  userId: string,
  target: ShareTargetRecord,
): Promise<string | null> {
  const table = target.type === 'folder' ? 'share_folders' : 'share_tags'
  const row = await db
    .prepare(`SELECT name FROM ${table} WHERE id = ?1 AND user_id = ?2`)
    .bind(target.value, userId)
    .first<{ name: string }>()
  return row?.name ?? null
}

/** The joins that resolve a stored target id to its live folder or tag name, for the owner's list. */
export function collectionTargetNameJoin(alias = 'c'): string {
  return `LEFT JOIN share_folders f ON ${alias}.target_type = 'folder' AND f.id = ${alias}.target_value AND f.user_id = ${alias}.user_id
          LEFT JOIN share_tags t ON ${alias}.target_type = 'tag' AND t.id = ${alias}.target_value AND t.user_id = ${alias}.user_id`
}

/** The live name the join resolves; null when the folder or tag is gone. */
export function collectionTargetNameSelect(alias = 'c'): string {
  return `CASE ${alias}.target_type WHEN 'folder' THEN f.name ELSE t.name END`
}

export interface ShareCollectionRow {
  id: string
  slug: string
  user_id: string
  target_type: string
  target_value: string
  password_hash: string | null
  expires_at: number | null
  is_enabled: number
  member_sort: string | null
  title: string | null
  created_at: number
  updated_at: number
  /** The owner's list reads the live target name beside the row; a public read does not ask for it. */
  target_name?: string | null
}

/** The columns every collection read addresses, in the order the rows are unpacked. */
const COLLECTION_COLUMNS = `id, slug, user_id, target_type, target_value, password_hash, expires_at,
            is_enabled, member_sort, title, created_at, updated_at`

/**
 * The same columns as the owner's list reads them.
 *
 * That one statement joins `share_folders` and `share_tags` beside the collection to carry the live target
 * name, and both of those tables hold an `id` and a `user_id` of their own: spelled bare, the read answers
 * `ambiguous column name` instead of a list. Every other read here is single-table and stays bare.
 */
const COLLECTION_COLUMNS_ALIASED = COLLECTION_COLUMNS.split(',').map((column) => `c.${column.trim()}`).join(', ')

/** The policy a collection answers its readers with; nothing here is a member list. */
export interface ShareCollectionPolicy {
  title: string | null
  /** Already through `hashPassword`, or null for a directory with no passcode. */
  passwordHash: string | null
  expiresAt: number | null
  memberSort: string | null
}

/** One new collection: the kind, the resolved target, and the policy it starts with. */
export interface ShareCollectionCreate extends ShareCollectionPolicy {
  targetType: ShareCollectionKind
  /** The folder or tag record id. Ignored for `manual`, whose target is its own id. */
  targetValue: string
}

/**
 * The owner's side of `share_collections`, bound to the account the request authenticated as.
 *
 * Membership for a folder or tag is never written here — it is derived from `shares` per request — so the
 * only member table this class touches is a hand-picked collection's own.
 */
export class ShareCollectionStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** Every collection of this account, newest first, each beside the live name of its target. */
  async listRows(): Promise<ShareCollectionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COLLECTION_COLUMNS_ALIASED},
                ${collectionTargetNameSelect()} AS target_name
           FROM share_collections c ${collectionTargetNameJoin()}
          WHERE c.user_id = ?1
          ORDER BY c.created_at DESC, c.id DESC`,
      )
      .bind(this.userId)
      .all<ShareCollectionRow>()
    return results ?? []
  }

  /** One of this account's collections; a foreign or missing id reads as nothing at all. */
  async byId(id: string): Promise<ShareCollectionRow | null> {
    const row = await this.db
      .prepare(`SELECT ${COLLECTION_COLUMNS} FROM share_collections WHERE id = ?1 AND user_id = ?2`)
      .bind(id, this.userId)
      .first<ShareCollectionRow>()
    return row ?? null
  }

  async countLive(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM share_collections WHERE user_id = ?1 AND is_enabled = 1`)
      .bind(this.userId)
      .first<{ n: number }>()
    return Number(row?.n ?? 0)
  }

  /** The enabled collection already covering a target, which is what makes publishing one a re-statement. */
  async liveForTarget(targetType: ShareCollectionKind, targetValue: string): Promise<ShareCollectionRow | null> {
    const row = await this.db
      .prepare(
        `SELECT ${COLLECTION_COLUMNS}
           FROM share_collections
          WHERE user_id = ?1 AND target_type = ?2 AND target_value = ?3 AND is_enabled = 1`,
      )
      .bind(this.userId, targetType, targetValue)
      .first<ShareCollectionRow>()
    return row ?? null
  }

  /** Creates one collection, with the target value chosen by its kind. */
  async create(input: ShareCollectionCreate): Promise<{ id: string; slug: string; row: ShareCollectionRow }> {
    if ((await this.countLive()) >= LIMITS.shareCollectionsMaxPerUser) {
      throw ApiError.badRequest(`An account can publish at most ${LIMITS.shareCollectionsMaxPerUser} collections`)
    }
    const id = newId()
    const slug = newSlug()
    const now = Date.now()
    const targetValue = input.targetType === 'manual' ? manualTargetValue(id) : input.targetValue
    try {
      await this.db
        .prepare(
          `INSERT INTO share_collections
             (id, slug, user_id, target_type, target_value, password_hash, expires_at, is_enabled, member_sort, title, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?10)`,
        )
        .bind(id, slug, this.userId, input.targetType, targetValue, input.passwordHash, input.expiresAt, input.memberSort, input.title, now)
        .run()
    } catch (error) {
      // The partial unique index is the last word on one live directory per target, and it is allowed to
      // speak: the route's own probe only covers the moment it read.
      if (isUniqueConstraintViolation(error)) {
        throw ApiError.conflict('This folder or tag already has a published collection')
      }
      throw error
    }
    const row = await this.byId(id)
    if (!row) throw ApiError.conflict('The collection could not be created. Try again')
    return { id, slug, row }
  }

  /** Re-states the policy of the collection already covering a target; its address does not move. */
  async applyPolicy(id: string, policy: ShareCollectionPolicy): Promise<boolean> {
    const written = await this.db
      .prepare(
        `UPDATE share_collections
            SET password_hash = ?1, expires_at = ?2, member_sort = ?3, title = ?4, updated_at = ?5
          WHERE id = ?6 AND user_id = ?7`,
      )
      .bind(policy.passwordHash, policy.expiresAt, policy.memberSort, policy.title, Date.now(), id, this.userId)
      .run()
    return Boolean(written.meta.changes)
  }

  /**
   * Pauses or resumes one collection.
   *
   * Resuming is not always possible: the target may have been published again while this record was
   * paused, and two live records for one target is exactly what the partial unique index forbids. The
   * probe turns that into a 409 the owner can read instead of a constraint message.
   */
  async setEnabled(row: ShareCollectionRow, enabled: boolean): Promise<boolean> {
    const next = enabled ? 1 : 0
    if (next === 1 && row.is_enabled === 0) {
      const conflict = await this.db
        .prepare(
          `SELECT id FROM share_collections
            WHERE user_id = ?1 AND is_enabled = 1 AND id <> ?2 AND target_type = ?3 AND target_value = ?4`,
        )
        .bind(this.userId, row.id, row.target_type, row.target_value)
        .first<{ id: string }>()
      if (conflict) throw ApiError.conflict('This folder or tag already has a published collection')
    }
    const written = await this.db
      .prepare(`UPDATE share_collections SET is_enabled = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4`)
      .bind(next, Date.now(), row.id, this.userId)
      .run()
    return Boolean(written.meta.changes)
  }

  /**
   * Revokes a collection.
   *
   * The member rows are part of the record and go with it; the shares it listed keep their own links,
   * their own passwords and their own history. Both deletes are owner-guarded, and the member delete is
   * addressed through the collection row rather than a bare id, so a foreign id empties nothing.
   */
  async delete(id: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM share_collection_members
            WHERE collection_id IN (SELECT id FROM share_collections WHERE id = ?1 AND user_id = ?2)`,
        )
        .bind(id, this.userId),
      this.db.prepare(`DELETE FROM share_collections WHERE id = ?1 AND user_id = ?2`).bind(id, this.userId),
    ])
    return Boolean(results.at(-1)?.meta.changes)
  }

  /**
   * Replaces a hand-picked collection's roster, in the order the owner gave it.
   *
   * The delete and the first chunk of inserts share one batch, so the ordinary roster is one transaction.
   * A roster at the ceiling needs more statements than one batch holds, so the rest follow in their own:
   * a half-replaced list is a directory in the wrong order for a moment, and visibility is derived anyway,
   * which beats a request that refuses to be served at all.
   */
  async replaceMembers(collectionId: string, noteIds: readonly string[]): Promise<number> {
    // The route reads the same ceiling off the body, but the store is the last word: a roster that came
    // from anywhere else still cannot outgrow the page that has to list it.
    if (noteIds.length > MAX_MANUAL_COLLECTION_MEMBERS) {
      throw ApiError.badRequest(`A hand-picked collection holds at most ${MAX_MANUAL_COLLECTION_MEMBERS} links`)
    }
    const insert = (noteId: string, index: number): D1PreparedStatement =>
      this.db
        .prepare(`INSERT INTO share_collection_members (collection_id, note_id, sort_order) VALUES (?1, ?2, ?3)`)
        .bind(collectionId, noteId, index)

    const first: D1PreparedStatement[] = [
      this.db.prepare(`DELETE FROM share_collection_members WHERE collection_id = ?1`).bind(collectionId),
      ...noteIds.slice(0, STATEMENT_CHUNK - 1).map((noteId, index) => insert(noteId, index)),
    ]
    const results = await this.db.batch(first)
    let written = results[0]?.meta.changes ?? 0
    for (let start = STATEMENT_CHUNK - 1; start < noteIds.length; start += STATEMENT_CHUNK) {
      const chunk = noteIds.slice(start, start + STATEMENT_CHUNK)
      const rest = await this.db.batch(chunk.map((noteId, offset) => insert(noteId, start + offset)))
      written += rest.reduce((total, result) => total + (result.meta.changes ?? 0), 0)
    }
    return written
  }
}

/** The columns a public read needs from one collection row, addressed by nothing but its slug. */
export interface PublicCollectionRow {
  id: string
  user_id: string
  target_type: string
  target_value: string
  password_hash: string | null
  expires_at: number | null
  is_enabled: number
  member_sort: string | null
  title: string | null
}

/**
 * The collection a directory answers with, addressed by its slug and with no account in sight.
 *
 * Deliberately account-free like `findShareBySlug`: a published collection exists so readers without one
 * can reach a set of links, and the slug is what was minted unguessable for that.
 */
export async function findCollectionBySlug(db: D1Database, slug: string): Promise<PublicCollectionRow | null> {
  const row = await db
    .prepare(
      `SELECT id, user_id, target_type, target_value, password_hash, expires_at, is_enabled, member_sort, title
         FROM share_collections WHERE slug = ?1`,
    )
    .bind(slug)
    .first<PublicCollectionRow>()
  return row ?? null
}

/** Whether a stored id is shaped like a folder or tag record, before it is ever put in a statement. */
export function isValidCollectionTarget(value: unknown): value is string {
  return isValidId(value)
}

/**
 * How many members each collection holds right now, in the order the rows came.
 *
 * One statement per collection, chunked into batches: the count and the page come from the same predicate
 * (the member conditions above), so a sidebar number and the directory it labels cannot answer with two
 * different sets of links.
 */
export async function collectionMemberCounts(
  db: D1Database,
  rows: readonly ShareCollectionRow[],
  now: number,
): Promise<number[]> {
  const counts: number[] = []
  for (let start = 0; start < rows.length; start += STATEMENT_CHUNK) {
    const chunk = rows.slice(start, start + STATEMENT_CHUNK)
    const statements = chunk.map((row) => {
      const scope = collectionScope(row, row.target_name ?? null)
      if (scope.kind === 'manual') {
        return manualCollectionCountStatement(db, { userId: row.user_id, collectionId: row.id, now })
      }
      // A row whose kind cannot be read has no rule to count by, and `SELECT 0` keeps its slot in the
      // batch without inventing a predicate for it.
      if (scope.kind === 'unreadable') return db.prepare(`SELECT 0 AS members`)
      return collectionMemberCountStatement(db, { userId: row.user_id, target: scope.target, now })
    })
    const results = await db.batch(statements)
    for (const result of results) {
      const counted = ((result?.results ?? []) as unknown) as Array<{ members: number }>
      counts.push(Number(counted[0]?.members ?? 0))
    }
  }
  return counts
}

/**
 * The collection as the owner's list answers, with its count read now.
 *
 * `title` is the target's live name for a folder or tag and the owner's own words for a hand-picked set:
 * renaming the folder renames the page, and there is no second title to keep in step with it. A row whose
 * kind cannot be read is not a collection the list can describe, so it answers null and the caller leaves
 * it out — the same row the public path reads as covering nothing.
 */
export function toShareCollection(row: ShareCollectionRow, members: number): ShareCollection | null {
  const kind = collectionTargetType(row)
  if (!kind) return null
  return {
    id: row.id,
    slug: row.slug,
    title: row.target_name ?? row.title ?? '',
    targetType: kind,
    targetValue: row.target_value,
    count: members,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at,
    isEnabled: row.is_enabled === 1,
    memberSort: isCollectionMemberSort(row.member_sort) ? row.member_sort : null,
    createdAt: row.created_at,
  }
}

/** Whether a database error is the live-target index speaking, which the hub answers with a 409. */
function isUniqueConstraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('UNIQUE') || message.includes('constraint')
}

/**
 * One page of members, whichever kind of collection this is, with the title it answers under and the
 * count the page is drawn from.
 *
 * A tag collection whose tag was deleted resolves to an address that matches nothing, which is a page with
 * no rows and no title rather than an error — the address still exists, and it holds nothing. A row whose
 * kind cannot be read is answered the same way. Page and count come from one batch built by the same
 * module that builds the owner's own count, so a directory and the number beside it in the hub cannot come
 * to mean different sets of links.
 */
export async function readDirectoryPage(
  db: D1Database,
  collection: PublicCollectionRow,
  params: { now: number; cursor: CollectionCursor | null; limit: number },
): Promise<{ title: string; cursorSort: string | null; rows: CollectionMemberRow[]; count: number }> {
  const { now, cursor, limit } = params
  const record = collectionTargetRecord(collection)
  // One lookup answers both questions a derived page has: the live name in its title, and the value its
  // members carry. The record is read from the row, so a rename moves the page with the folder or tag.
  const name = record ? await collectionTargetName(db, collection.user_id, record) : null
  const scope = collectionScope(collection, name)

  if (scope.kind === 'unreadable') return { title: '', cursorSort: collection.member_sort, rows: [], count: 0 }

  const statements =
    scope.kind === 'manual'
      ? [
          manualCollectionMembersStatement(db, {
            userId: collection.user_id,
            collectionId: collection.id,
            now,
            cursor,
            limit,
          }),
          manualCollectionCountStatement(db, { userId: collection.user_id, collectionId: collection.id, now }),
        ]
      : [
          collectionMembersStatement(db, {
            userId: collection.user_id,
            target: scope.target,
            now,
            cursor,
            limit,
            sort: collection.member_sort,
          }),
          collectionMemberCountStatement(db, { userId: collection.user_id, target: scope.target, now }),
        ]
  const results = await db.batch(statements)
  return {
    title: scope.kind === 'manual' ? collection.title ?? '' : name ?? '',
    cursorSort: scope.kind === 'manual' ? 'manual' : collection.member_sort,
    rows: rowsOf(results[0]),
    count: membersOf(results[1]),
  }
}

/** A batch slot unpacked the way this repo's D1 reads are: rows first, and no row is not an error. */
function rowsOf(result: { results?: unknown[] } | undefined): CollectionMemberRow[] {
  return ((result?.results ?? []) as unknown) as CollectionMemberRow[]
}

/** The member count out of a batch slot, or zero for a statement that answered with nothing. */
function membersOf(result: { results?: unknown[] } | undefined): number {
  const counted = ((result?.results ?? []) as unknown) as Array<{ members: number }>
  return Number(counted[0]?.members ?? 0)
}
