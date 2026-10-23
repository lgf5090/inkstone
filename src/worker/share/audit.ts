/**
 * The share link's own change history: what an edit moved, who can read it back, and how long it is
 * kept.
 *
 * `share_audit_log` is append-only (see `hub-schema.ts`), so the recording side never rewrites a row:
 * the entry carries the field-level before/after and the reader only lists. The one thing the table
 * must not become is a second copy of the secrets it describes, so a passcode change is recorded as
 * `hasPassword: false -> true` — neither the plain passcode nor either hash — and the tag list is
 * recorded as the stored JSON array, which is names the owner already sees in the hub.
 *
 * Recording is deliberately best-effort and reading is strict. The trail describes an edit that has
 * already landed and is owned by the account that made it; refusing a finished, visible write because
 * an history row could not be appended is worse than a missing line in a log. The failure is therefore
 * logged at warn with the reason it is tolerated, which is the only silence this module allows.
 */

import type { ShareAuditFieldChange, ShareAuditLogEntry, ShareAuditLogResponse } from '@shared/share-hub'
import { LIMITS } from '@shared/constants'
import { newId } from '../lib/id'
import { parseShareTags } from './store'

export type ShareAuditAction = ShareAuditLogEntry['action']

const SHARE_AUDIT_ACTIONS: readonly ShareAuditAction[] = ['create', 'update', 'revoke', 'batch']

/**
 * How many entries one account keeps.
 *
 * The cap is enforced where history is written — `recordShareAudit` trims the account's own tail in the
 * same batch as its inserts — rather than in a sweep nobody schedules: an append-only table with no
 * writer-side ceiling grows for as long as the owner edits links, and the read is the only place a
 * reader would ever notice.
 */
export const SHARE_AUDIT_RETAINED_ROWS_PER_ACCOUNT = 500

/**
 * How many entries one request may append in a single batch.
 *
 * D1 caps the statements one `batch()` call accepts, and the cap differs by plan, so the ceiling this
 * module works under is the smallest number it can rely on. A filing write is one entry per link it
 * moved, and a hub selection can name hundreds.
 */
const SHARE_AUDIT_INSERT_CHUNK = 50

/** The presence-shaped view of a link the diff is computed from. Nothing here is a secret. */
export interface ShareAuditFieldSnapshot {
  slug: string
  isEnabled: number | null
  expiresAt: number | null
  folderId: string | null
  tags: string[] | null
  hasPassword: boolean
}

/** One link's row read, turned into the shape the diff compares. */
export function shareAuditSnapshot(row: {
  slug: string
  is_enabled: number | null
  expires_at: number | null
  folder_id: string | null
  tags: string | null
  password_hash: string | null
}): ShareAuditFieldSnapshot {
  return {
    slug: row.slug,
    isEnabled: row.is_enabled,
    expiresAt: row.expires_at,
    folderId: row.folder_id,
    tags: parseShareTags(row.tags),
    // Presence only, always: the hash is a secret-shaped value even inside a log.
    hasPassword: Boolean(row.password_hash),
  }
}

function changedField(
  field: string,
  before: string | number | boolean | null,
  after: string | number | boolean | null,
): ShareAuditFieldChange | null {
  if (before === after) return null
  return { field, from: before, to: after }
}

/**
 * The fields two snapshots disagree on, in a stable order.
 *
 * A missing `before` is a link that did not exist yet, and "no diff" is the honest answer: the entry
 * that gets written for that case is a `create`, whose history starts at nothing.
 */
export function shareAuditDiff(
  before: ShareAuditFieldSnapshot | null | undefined,
  after: ShareAuditFieldSnapshot,
): ShareAuditFieldChange[] {
  if (!before) return []
  const changes = [
    changedField('slug', before.slug, after.slug),
    changedField('has_password', before.hasPassword, after.hasPassword),
    changedField('expires_at', before.expiresAt, after.expiresAt),
    changedField('is_enabled', before.isEnabled, after.isEnabled),
    changedField('folder_id', before.folderId, after.folderId),
    changedField('tags', before.tags ? JSON.stringify(before.tags) : null, after.tags ? JSON.stringify(after.tags) : null),
  ]
  return changes.filter((change): change is ShareAuditFieldChange => change !== null)
}

/** One entry to append. `changed` is the diff; the JSON shape is this module's business, not the caller's. */
export interface ShareAuditEntry {
  userId: string
  noteId: string
  slug: string
  action: ShareAuditAction
  changed: readonly ShareAuditFieldChange[]
  createdAt: number
}

/** The columns the trim and the insert both address, so a typo cannot make them disagree. */
const AUDIT_INSERT_SQL = `INSERT INTO share_audit_log (id, user_id, note_id, slug, action, changed_json, created_at)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`

const AUDIT_TRIM_SQL = `DELETE FROM share_audit_log
 WHERE user_id = ?1
   AND id NOT IN (SELECT id FROM share_audit_log WHERE user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)`

/**
 * Appends the entries and holds each account's tail inside the cap.
 *
 * The inserts and the trim share one D1 batch whenever the request fits in one, because D1 gives a batch
 * one transaction: split across two calls, a request that died in between would leave an account whose
 * history grows past the ceiling forever, which is the failure the cap exists to prevent. A hub batch can
 * name more links than one batch holds statements for, so the inserts are chunked and the trim rides the
 * last one; a request that died between two chunks leaves a history a little long until the next write
 * trims it, the same tolerated failure as a lost append.
 */
export async function recordShareAudit(db: D1Database, entries: readonly ShareAuditEntry[]): Promise<void> {
  if (!entries.length) return
  // Every entry of one request belongs to the account that made it, and the entry carries that id, so
  // there is no separate caller argument to get wrong: the trimmed accounts are read off the rows.
  const userIds = [...new Set(entries.map((entry) => entry.userId))]
  try {
    for (let start = 0; start < entries.length; start += SHARE_AUDIT_INSERT_CHUNK) {
      const chunk = entries.slice(start, start + SHARE_AUDIT_INSERT_CHUNK)
      const statements: D1PreparedStatement[] = chunk.map((entry) =>
        db
          .prepare(AUDIT_INSERT_SQL)
          .bind(newId(), entry.userId, entry.noteId, entry.slug, entry.action, JSON.stringify(entry.changed), entry.createdAt),
      )
      if (start + chunk.length >= entries.length) {
        for (const userId of userIds) {
          statements.push(db.prepare(AUDIT_TRIM_SQL).bind(userId, SHARE_AUDIT_RETAINED_ROWS_PER_ACCOUNT))
        }
      }
      await db.batch(statements)
    }
  } catch (error) {
    // Best-effort on purpose: the owner's write has already landed, and a 500 here would tell them it
    // had not. The reason is printed because a trail that silently stopped growing is a defect no
    // reader can see coming.
    console.warn('[inkstone] share audit append failed:', error instanceof Error ? error.message : error)
  }
}

interface ShareAuditRow {
  id: string
  note_id: string
  slug: string
  action: string
  changed_json: string | null
  created_at: number
}

/**
 * What `changed_json` holds, read back as field changes.
 *
 * The column's own default is `{}` and a legacy row could hold anything, so the shape is checked
 * rather than trusted: only an array of `{field}` objects is a change list, and anything else reads as
 * "no fields named" — which is what a `create` or a `revoke` entry says anyway.
 */
export function parseShareAuditChanges(raw: string | null): ShareAuditFieldChange[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.warn('[inkstone] share audit JSON unreadable, reading as no changes:', error instanceof Error ? error.message : error)
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (item): item is ShareAuditFieldChange =>
      typeof item === 'object' && item !== null && typeof (item as { field?: unknown }).field === 'string',
  )
}

/** The stored action, narrowed: an unknown value reads as the ordinary edit it most likely was. */
function shareAuditAction(raw: string): ShareAuditAction {
  return (SHARE_AUDIT_ACTIONS as readonly string[]).includes(raw) ? (raw as ShareAuditAction) : 'update'
}

/**
 * One page of one link's history, oldest-last.
 *
 * Both statements are scoped by `user_id` *and* `note_id`, so another account's link answers with the
 * same empty page a link that never had a share answers with — the history of a link is not a way to
 * find out whether somebody else owns it.
 */
export async function readShareAudit(
  db: D1Database,
  userId: string,
  noteId: string,
  page: number,
  limit: number,
): Promise<ShareAuditLogResponse> {
  const size = clampAuditPage(limit)
  const pageIndex = Math.max(0, Math.trunc(page) - 1)
  // One batch, two statements: a page and its total read the same rows, and two round trips would let
  // the count be of a table the page was already past.
  const results = await db.batch([
    db
      .prepare(
        `SELECT id, note_id, slug, action, changed_json, created_at
           FROM share_audit_log
          WHERE user_id = ?1 AND note_id = ?2
          ORDER BY created_at DESC, id DESC
          LIMIT ?3 OFFSET ?4`,
      )
      .bind(userId, noteId, size, pageIndex * size),
    db
      .prepare(`SELECT COUNT(*) AS total FROM share_audit_log WHERE user_id = ?1 AND note_id = ?2`)
      .bind(userId, noteId),
  ])
  const rows = ((results[0]?.results ?? []) as unknown) as ShareAuditRow[]
  const counted = ((results[1]?.results ?? []) as unknown) as Array<{ total: number }>
  const total = Number(counted[0]?.total ?? 0)
  const entries: ShareAuditLogEntry[] = rows.map((row) => ({
    id: row.id,
    noteId: row.note_id,
    slug: row.slug,
    action: shareAuditAction(row.action),
    changed: parseShareAuditChanges(row.changed_json),
    createdAt: row.created_at,
  }))
  return { entries, total, page: pageIndex + 1, limit: size }
}

/**
 * The page size the hub asks for, clamped to the one number that states it.
 *
 * `LIMITS.shareAuditEntriesPerPage` is both the shipped page and its ceiling: a request for more rows
 * than that is a page of history the owner's own screen cannot show, and answering it would be a walk
 * over the account's whole log.
 */
export function shareAuditPageLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return LIMITS.shareAuditEntriesPerPage
  return clampAuditPage(Number(raw))
}

/** The same ceiling read from a number that is already a number. */
function clampAuditPage(value: number): number {
  if (!Number.isFinite(value)) return LIMITS.shareAuditEntriesPerPage
  return Math.min(Math.max(1, Math.trunc(value)), LIMITS.shareAuditEntriesPerPage)
}
