/**
 * Every read and write the share HTTP routes make against D1.
 *
 * The shape follows `tags/store.ts`: a store built per request from the account it serves, methods
 * that take already-validated input and hand back rows or the boolean the route needs to answer
 * with, and nothing in between that knows about HTTP. Every owner-side statement carries `user_id`,
 * so one account can neither list, overwrite nor delete another account's share.
 *
 * The reader half has no account at all: a public link is addressed by nothing but its slug. Those
 * statements live as free functions below — `SELECT * FROM shares WHERE slug = ?1` and the page
 * metadata read are deliberate cross-account probes, since a share exists precisely so somebody
 * without an account can reach one note, and the slug is minted unguessable. The note load and the
 * view counter have no literal `user_id` either: they are scoped by the owner id this module just
 * read from the share the slug resolved, or by the slug itself.
 *
 * `broadcastCursor` does not live here (a share write records no change), and neither the
 * passcode hashing nor the verify throttle is the store's business — the route keeps those.
 */

/** One `shares` row, as the table stores it. */
export interface ShareRow {
  slug: string
  note_id: string
  user_id: string
  folder_id: string | null
  /** A JSON array of tag *names*, as `@shared/share-selection` explains: a folder is stored by id, a tag by name. */
  tags: string | null
  password_hash: string | null
  expires_at: number | null
  views: number
  is_enabled: number
  last_viewed_at: number | null
  created_at: number
}

/** A share joined with the note it publishes, for the owner's listing. */
export type ShareListItemRow = ShareRow & {
  note_title: string
  note_excerpt: string
  deleted_at: number | null
  is_pinned: number
  is_starred: number
}

/**
 * A share the route has already validated.
 *
 * `replacePassword` and `replaceExpiry` are the route's "the client actually named this field"
 * tests: the conflict clause refreshes the hash and the expiry only when the request asked it to,
 * so re-sharing a note without a password keeps the passcode a previous request set.
 */
export interface ShareUpsertInput {
  slug: string
  noteId: string
  /** Already through `hashPassword` (or `null` to clear it); the store never sees the plain text. */
  passwordHash: string | null
  expiresAt: number | null
  now: number
  replacePassword: boolean
  replaceExpiry: boolean
}

export class ShareStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * Every share of this account with its note's title and trash state.
   *
   * The join keeps the title in the row the listing answers with, so the share center costs one
   * statement however many links the account owns.
   */
  async listShares(): Promise<ShareListItemRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.slug, s.note_id, s.user_id, s.folder_id, s.tags, s.password_hash, s.expires_at,
                s.views, s.is_enabled, s.last_viewed_at, s.created_at,
                n.title AS note_title, n.excerpt AS note_excerpt, n.deleted_at,
                n.is_pinned, n.is_starred
           FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
          WHERE s.user_id = ?1
          ORDER BY s.created_at DESC, s.slug DESC`,
      )
      .bind(this.userId)
      .all<ShareListItemRow>()
    return results ?? []
  }

  /** The share of one of this account's notes; `null` is both "not there" and "not mine". */
  async shareForNote(noteId: string): Promise<ShareRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM shares WHERE note_id = ?1 AND user_id = ?2`)
      .bind(noteId, this.userId)
      .first<ShareRow>()
    return row ?? null
  }

  /** Whether this account owns a live (un-trashed) note — the only check a share target needs. */
  async liveNoteExists(noteId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT id FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
      .bind(noteId, this.userId)
      .first<{ id: string }>()
    return row !== null
  }

  /**
   * Publish or refresh a note's share.
   *
   * One statement, as it always was: re-sharing an existing note keeps its slug (the insert's is
   * discarded by the conflict target) and updates only what the request named. The
   * `WHERE shares.user_id = excluded.user_id` guard means an existing row of another account is
   * matched by nothing, which the route reports as a 409 through the returned `false`.
   */
  async upsertShare(input: ShareUpsertInput): Promise<boolean> {
    const written = await this.db
      .prepare(
        `INSERT INTO shares (slug, note_id, user_id, password_hash, expires_at, views, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
         ON CONFLICT(note_id) DO UPDATE SET
           password_hash = CASE WHEN ?7 = 1 THEN excluded.password_hash ELSE shares.password_hash END,
           expires_at = CASE WHEN ?8 = 1 THEN excluded.expires_at ELSE shares.expires_at END
         WHERE shares.user_id = excluded.user_id`,
      )
      .bind(
        input.slug,
        input.noteId,
        this.userId,
        input.passwordHash,
        input.expiresAt,
        input.now,
        input.replacePassword ? 1 : 0,
        input.replaceExpiry ? 1 : 0,
      )
      .run()
    return Boolean(written.meta.changes)
  }

  /** Revoke the share of one of this account's notes; a missing or foreign row simply matches nothing. */
  async deleteShare(noteId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM shares WHERE note_id = ?1 AND user_id = ?2`)
      .bind(noteId, this.userId)
      .run()
  }
}

/** One `shares` row addressed by its public slug, with no account in sight. */
export async function findShareBySlug(db: D1Database, slug: string): Promise<ShareRow | null> {
  const row = await db
    .prepare(`SELECT * FROM shares WHERE slug = ?1`)
    .bind(slug)
    .first<ShareRow>()
  return row ?? null
}

/** The note a public link publishes, with the author's display fields. */
export interface SharedNoteRow {
  title: string
  content: string
  created_at: number
  updated_at: number
  name: string
  avatar_url: string
}

/**
 * The note the resolved share points at, together with its author's name and avatar.
 *
 * There is no session user on the reader path: `ownerId` is the `user_id` the caller just read
 * from the share row the slug resolved, which is exactly the predicate the route used to bind,
 * so the statement stays scoped to the pair this link was minted for.
 */
export async function loadSharedNote(
  db: D1Database,
  noteId: string,
  ownerId: string,
): Promise<SharedNoteRow | null> {
  const row = await db
    .prepare(
      `SELECT n.title, n.content, n.created_at, n.updated_at, u.name, u.avatar_url
         FROM notes n JOIN users u ON u.id = n.user_id
        WHERE n.id = ?1 AND n.user_id = ?2 AND n.deleted_at IS NULL`,
    )
    .bind(noteId, ownerId)
    .first<SharedNoteRow>()
  return row ?? null
}

/** The columns the public `/s/:slug` document needs to build its meta tags. */
export interface SharePageMeta {
  password_hash: string | null
  expires_at: number | null
  title: string
  excerpt: string
}

/**
 * The share's meta for the pre-rendered document, addressed by slug.
 *
 * Deliberately account-free like `findShareBySlug`: the document is what a search engine and a
 * messaging app see before anybody types a passcode, and it exposes nothing beyond the title and
 * the excerpt the shell would show for an open link anyway.
 */
export async function loadSharePageMeta(
  db: D1Database,
  slug: string,
): Promise<SharePageMeta | null> {
  const row = await db
    .prepare(
      `SELECT s.password_hash, s.expires_at, n.title, n.excerpt
         FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
        WHERE s.slug = ?1 AND n.deleted_at IS NULL`,
    )
    .bind(slug)
    .first<SharePageMeta>()
  return row ?? null
}

/**
 * One read of one public link, as the analytics row records it.
 *
 * Every field here is already classified or truncated: `visitorFp` is the keyed digest rather than
 * the address it came from, `channel` is a validated marker or the empty string that stands for a
 * refused one, and the three flags are the recording side's answer, so no reading has to re-derive
 * them from a `user_agent` a later rule would reinterpret.
 */
export interface ShareVisitRecord {
  userId: string
  noteId: string
  slug: string
  visitedAt: number
  visitorFp: string | null
  country: string | null
  region: string | null
  city: string | null
  referrer: string | null
  referrerHost: string | null
  deviceType: string | null
  os: string | null
  browser: string | null
  language: string | null
  userAgent: string | null
  isBot: boolean
  isSelfReferrer: boolean
  isOwner: boolean
  channel: string | null
}

const VISIT_COLUMNS = [
  'user_id',
  'note_id',
  'slug',
  'visited_at',
  'visitor_fp',
  'country',
  'region',
  'city',
  'referrer',
  'referrer_host',
  'device_type',
  'os',
  'browser',
  'language',
  'user_agent',
  'is_bot',
  'is_self_referrer',
  'is_owner',
  'channel',
] as const

/**
 * Records a visit and moves the link's own counters in one batch.
 *
 * Two sequential statements would leave a window in which the row exists and the counter does not —
 * and the counter is what the list sorts by and the stale report reads, so a link that lost a batch
 * halfway would show a visit count below the log it can already print. `batch` gives both statements
 * the same transaction, which is as close to atomic as D1 has.
 *
 * Best-effort like `countShareView`: the caller hangs this off the response with `waitUntil`, so a
 * failure is logged and dropped rather than shown to a reader who has already been served the note.
 */
export async function recordShareVisit(
  db: D1Database,
  visit: ShareVisitRecord,
): Promise<void> {
  const placeholders = VISIT_COLUMNS.map((_, index) => `?${index + 1}`).join(', ')
  const insert = db
    .prepare(`INSERT INTO share_visits (${VISIT_COLUMNS.join(', ')}) VALUES (${placeholders})`)
    .bind(
      visit.userId,
      visit.noteId,
      visit.slug,
      visit.visitedAt,
      visit.visitorFp,
      visit.country,
      visit.region,
      visit.city,
      visit.referrer,
      visit.referrerHost,
      visit.deviceType,
      visit.os,
      visit.browser,
      visit.language,
      visit.userAgent,
      visit.isBot ? 1 : 0,
      visit.isSelfReferrer ? 1 : 0,
      visit.isOwner ? 1 : 0,
      visit.channel,
    )
  const bump = db
    .prepare(`UPDATE shares SET views = views + 1, last_viewed_at = ?2 WHERE slug = ?1`)
    .bind(visit.slug, visit.visitedAt)
  try {
    await db.batch([insert, bump])
  } catch (error) {
    console.warn(`[inkstone] Share visit recording failed for ${visit.slug}:`, error instanceof Error ? error.message : error)
  }
}

/**
 * The tag names stored on a share row.
 *
 * Valid JSON that is not an *array of strings* is not a tag list either: a stored scalar or object
 * would otherwise reach the payload as `tags`, and every caller's `.includes` would be reading it as
 * one. The element rule in `@shared/share-selection` asks "is this in the array", so what the payload
 * calls an array has to be one.
 */
export function parseShareTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch (error) {
    console.warn('[inkstone] share tags JSON unreadable, reading as no tags:', error instanceof Error ? error.message : error)
    return []
  }
}

/** The JSON a `shares.tags` column holds for a set of tag names. */
export function serializeShareTags(tags: readonly string[]): string {
  return JSON.stringify(tags)
}
