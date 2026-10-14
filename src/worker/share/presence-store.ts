/**
 * Every read and write the share-presence HTTP routes make against D1.
 *
 * Presence is the show room behind a public share, and the split here follows `share/store.ts`: a
 * store built from the account that owns the show, plus a handful of free functions for the reader
 * half. The owner half (`SharePresenceStore`) is ordinary tenant-scoped persistence — the presenter
 * is authenticated, and `share_presence` rows carry the account that started the show. The reader
 * half has no account: an audience member arrives with nothing but the show's slug and the capability
 * token the presenter handed out, so the room's row is looked up the same deliberate cross-account
 * way `findShareBySlug` looks a share up by its unguessable slug. Those reads are keyed by `slug`
 * alone, and the token check that guards them (`tokenMatches`, the hash comparison) stays in the
 * route, because verifying a secret is not persistence.
 *
 * Not everything on this route is a `share_presence` row. How many browsers are watching is measured
 * out of the read-budget ledger (`login_attempts`), which the throttle layer owns — so that count is
 * not here either; see `lib/throttle.ts`.
 *
 * The clock is always the caller's: every statement that filters or stamps a lease takes `now` as an
 * argument, so this module never reads `Date.now()` and the route keeps the timing decisions. Each
 * statement is a single, unbached run exactly as the route wrote it — presence has no multi-statement
 * batch to preserve — and the mutation methods hand back the boolean or nothing the route needs,
 * never a `Response`. The `token_hash` is computed by the route and passed in already hashed; the
 * plain token never reaches this file.
 */

/** A row of `share_presence`, shaped the way D1 hands it back. */
export interface SharePresenceRow {
  slug: string
  user_id: string
  note_id: string
  token_hash: string
  slide: number
  page: number
  step: number
  updated_at: number
  expires_at: number
}

/** The share a show needs: a live link, the note it points at, and the note's own title for the viewer. */
export interface PresentableShare {
  slug: string
  note_id: string
  user_id: string
  expires_at: number | null
  title: string
}

/** A live link, the note it points at, and whether that note is behind a passcode. */
export interface LiveShare {
  slug: string
  title: string
  password_hash: string | null
  expires_at: number | null
}

/** A show the owner has started: the resolved share plus what the route hashed and clocked. */
export interface PresenceStart {
  slug: string
  noteId: string
  /** Already through `hashToken`; this file never sees the plain capability token. */
  tokenHash: string
  now: number
  expiresAt: number
}

/** A position the owner is publishing, with the lease the route already computed. */
export interface PresenceWrite {
  slug: string
  slide: number
  page: number
  step: number
  now: number
  expiresAt: number
}

export class SharePresenceStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * The live share of one of this account's notes, title included.
   *
   * Returns the row whether or not it has expired: `expires_at` comes back so the route can decide
   * what an expired link means. The `s.user_id = ?1` predicate is the tenant guard; a foreign or
   * missing note simply matches nothing and answers `null`.
   */
  async presentableShare(noteId: string): Promise<PresentableShare | null> {
    const share = await this.db
      .prepare(
        `SELECT s.slug, s.note_id, s.user_id, s.expires_at, n.title
           FROM shares s JOIN notes n ON n.id = s.note_id
          WHERE s.user_id = ?1 AND s.note_id = ?2`,
      )
      .bind(this.userId, noteId)
      .first<PresentableShare>()
    return share ?? null
  }

  /**
   * Start or restart the show, resetting it to the first step.
   *
   * `ON CONFLICT(slug) DO UPDATE` reuses the row when a speaker starts again, so a re-start takes over
   * the room rather than failing on the primary key. It writes the account's own id, which is the same
   * id every later owner-side statement matches against.
   */
  async startPresence(input: PresenceStart): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO share_presence (slug, user_id, note_id, token_hash, slide, page, step, updated_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, 0, 0, 0, ?5, ?6)
         ON CONFLICT(slug) DO UPDATE SET token_hash = ?4, slide = 0, page = 0, step = 0, updated_at = ?5, expires_at = ?6`,
      )
      .bind(input.slug, this.userId, input.noteId, input.tokenHash, input.now, input.expiresAt)
      .run()
  }

  /**
   * Publish the position, refreshing the lease. There is no INSERT on purpose — a position can only
   * be written into a show that was started, so a stale client cannot resurrect a revoked token.
   *
   * `false` (zero `changes`) means the row is gone, belongs to another account, or its lease ran out
   * before this write; the route turns that into its "not running" 404. The `user_id = ?7` predicate
   * keeps the update to the account that owns the room.
   */
  async writePosition(input: PresenceWrite): Promise<boolean> {
    const updated = await this.db
      .prepare(
        `UPDATE share_presence SET slide = ?2, page = ?3, step = ?4, updated_at = ?5, expires_at = ?6
          WHERE slug = ?1 AND user_id = ?7 AND expires_at > ?5`,
      )
      .bind(input.slug, input.slide, input.page, input.step, input.now, input.expiresAt, this.userId)
      .run()
    return Boolean(updated.meta.changes)
  }

  /** Stop this account's show for a known slug; a row that is not the account's matches nothing. */
  async stopPresence(slug: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM share_presence WHERE slug = ?1 AND user_id = ?2`)
      .bind(slug, this.userId)
      .run()
  }

  /**
   * Clear this account's finished shows: rows whose lease ran out but whose browser never sent the
   * stop press. Scoped to the account (`user_id = ?1`) and the clock the route passed, so one owner's
   * cleanup cannot touch another's live room.
   */
  async deleteExpiredShows(now: number): Promise<void> {
    await this.db
      .prepare(`DELETE FROM share_presence WHERE user_id = ?1 AND expires_at <= ?2`)
      .bind(this.userId, now)
      .run()
  }
}

/**
 * A running show's row, addressed by its public slug, with no account in sight.
 *
 * Deliberately cross-account like `findShareBySlug`: an audience member proves nothing but the slug
 * and the token, and the slug is minted unguessable. `expires_at > ?2` is the lease — a show whose
 * clock ran out answers `null` here, the same "no show running" a caller with no business asking gets.
 * The `token_hash` rides back so the route can compare it; comparing it is the route's job, not ours.
 */
export async function loadPresenceRow(db: D1Database, slug: string, now: number): Promise<SharePresenceRow | null> {
  return await db
    .prepare(
      `SELECT slug, user_id, note_id, token_hash, slide, page, step, updated_at, expires_at
         FROM share_presence WHERE slug = ?1 AND expires_at > ?2`,
    )
    .bind(slug, now)
    .first<SharePresenceRow>()
}

/**
 * The share a public show rides on, addressed by slug.
 *
 * Account-free by design: the reader path resolves the link exactly as `findShareBySlug` does, and
 * `password_hash` comes back so the route can decide whether a passcode gates the room. The `n.id =
 * s.note_id` join reads the note the owner published; the note is scoped to the share by that join,
 * and the share is scoped to nothing but its slug because a public link is what it is.
 */
export async function loadLiveShareBySlug(db: D1Database, slug: string): Promise<LiveShare | null> {
  const share = await db
    .prepare(
      `SELECT s.slug, s.password_hash, s.expires_at, n.title
         FROM shares s JOIN notes n ON n.id = s.note_id
        WHERE s.slug = ?1`,
    )
    .bind(slug)
    .first<LiveShare>()
  return share ?? null
}

/**
 * Drop a show whose link vanished mid-lease, addressed by slug.
 *
 * The public counterpart to `stopPresence`, and unscoped for the same reason `loadPresenceRow` is:
 * the caller has already proved the room through the token and the read budget, so the row is keyed
 * by nothing but the unguessable slug. A revoked or expired link reaches here only through a caller
 * that could read the row in the first place.
 */
export async function deletePresenceRowBySlug(db: D1Database, slug: string): Promise<void> {
  await db.prepare(`DELETE FROM share_presence WHERE slug = ?1`).bind(slug).run()
}
