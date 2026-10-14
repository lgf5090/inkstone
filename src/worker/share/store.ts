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
  password_hash: string | null
  expires_at: number | null
  views: number
  created_at: number
}

/** A share joined with the note it publishes, for the owner's listing. */
export type ShareListItemRow = ShareRow & { note_title: string; deleted_at: number | null }

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
        `SELECT s.slug, s.note_id, s.user_id, s.password_hash, s.expires_at, s.views, s.created_at,
                n.title AS note_title, n.deleted_at
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
 * The only place a share's `views` number moves, kept off the response path on purpose.
 *
 * A reader who has already been served must not lose the note because the counter was unreachable,
 * so the write runs under `waitUntil` and its failure cannot reach the caller. The number itself is
 * what the owner reads in the share list, so a refusal is reported rather than dropped: a share whose
 * views silently stop growing is a product defect, and an invisible one is impossible to find.
 *
 * Best-effort by design: the catch and the warning are the agreed error surface, and the route
 * decides the `waitUntil` timing around this call.
 */
export async function countShareView(db: D1Database, slug: string): Promise<void> {
  try {
    await db.prepare(`UPDATE shares SET views = views + 1 WHERE slug = ?1`).bind(slug).run()
  } catch (error) {
    console.warn(`[inkstone] Share view count failed for ${slug}:`, error instanceof Error ? error.message : error)
  }
}
