/**
 * Every read and write the community-template HTTP routes make against D1.
 *
 * The shape follows `tags/store.ts`: a store built per request from the account it serves, methods
 * that take already-validated input and hand back rows or counts, and nothing in between that knows
 * about HTTP. The scoping column here is `author_id`, not `user_id` — same rule, different name:
 * the count probe binds the calling account as `author_id`, the publish stamps the row with it, the
 * use update excludes it (an author must not boost their own row), and the unpublish is addressed
 * by an id the caller just ran through `authorOf`. The listing is the one deliberate cross-account
 * read, because a shared directory is the whole feature; no account-scoped column belongs on it.
 *
 * The hourly publish/use budgets stay with the route: they talk to the throttle tables, not here.
 */

import type { CommunityTemplateInput } from '@shared/types'

/** A directory row as the listing reads it; `author_name` is resolved per read, not stored per copy. */
export interface CommunityRow {
  id: string
  author_id: string
  author_name: string
  name: string
  description: string
  content: string
  tags: string
  category: string
  uses: number
  created_at: number
}

/**
 * `author_name` is read from the account rather than the copy frozen into the row
 * at publish time, so an author who changes their display name is credited with the
 * name readers should see today.
 */
const COMMUNITY_SELECT = `ct.id, ct.author_id,
  COALESCE(NULLIF(u.name, ''), NULLIF(u.username, ''), ct.author_name, 'Inkstone') AS author_name,
  ct.name, ct.description, ct.content, ct.tags, ct.category, ct.uses, ct.created_at`
const COMMUNITY_FROM = `FROM community_templates ct
  LEFT JOIN users u ON u.id = ct.author_id`

/** One keyset position the route has already parsed and validated. */
export interface CommunityCursor {
  createdAt: number
  id: string
}

/** A publish the route has planned: the id is settled, the author name resolved, the clock read. */
export interface CommunityPublishInput {
  id: string
  authorName: string
  template: CommunityTemplateInput
  now: number
}

export class CommunityTemplatesStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * One page of the directory, newest first, plus the one extra row the route uses to decide
   * `hasMore`. Deliberately every account's rows: this is the shared listing.
   */
  async listPage(before: CommunityCursor | null, limit: number): Promise<CommunityRow[]> {
    const { results } = await this.db
      .prepare(
        before
          ? `SELECT ${COMMUNITY_SELECT} ${COMMUNITY_FROM}
             WHERE (ct.created_at < ?1 OR (ct.created_at = ?1 AND ct.id < ?2))
             ORDER BY ct.created_at DESC, ct.id ASC LIMIT ?3`
          : `SELECT ${COMMUNITY_SELECT} ${COMMUNITY_FROM}
             ORDER BY ct.created_at DESC, ct.id ASC LIMIT ?1`,
      )
      .bind(...(before ? [before.createdAt, before.id, limit + 1] : [limit + 1]))
      .all<CommunityRow>()
    return results ?? []
  }

  /**
   * The account that owns a template id, whoever that is.
   *
   * The one read here without an owner filter on purpose: it answers a client-supplied id, and the
   * update and unpublish rules ("only the author") are only meaningful across accounts.
   */
  async authorOf(id: string): Promise<{ author_id: string } | null> {
    const row = await this.db
      .prepare(`SELECT author_id FROM community_templates WHERE id = ?1`)
      .bind(id)
      .first<{ author_id: string }>()
    return row ?? null
  }

  /** How many templates the calling account has published — the ceiling input for the route's refusal. */
  async publishedCount(): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM community_templates WHERE author_id = ?1`,
      )
      .bind(this.userId)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  /** The calling account's display name, or `null` when its row has none. */
  async profileName(): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT name FROM users WHERE id = ?1`)
      .bind(this.userId)
      .first<{ name: string }>()
    return row?.name ?? null
  }

  /**
   * Publish or refresh a template.
   *
   * `created_at` is deliberately absent from the UPDATE list: re-publishing an
   * existing template refreshes its text but must not jump it back to the top
   * of the directory.
   */
  async publish(input: CommunityPublishInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO community_templates (id, author_id, author_name, name, description, content, tags, category, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           author_name = excluded.author_name,
           name = excluded.name,
           description = excluded.description,
           content = excluded.content,
           tags = excluded.tags,
           category = excluded.category`,
      )
      .bind(
        input.id,
        this.userId,
        input.authorName,
        input.template.name,
        input.template.description,
        input.template.content,
        JSON.stringify(input.template.tags),
        input.template.category,
        input.now,
      )
      .run()
  }

  /** The directory view of one row the caller has just written, so the answer matches the listing. */
  async publishedRow(id: string): Promise<CommunityRow | null> {
    const row = await this.db
      .prepare(
        `SELECT ${COMMUNITY_SELECT} ${COMMUNITY_FROM} WHERE ct.id = ?1`,
      )
      .bind(id)
      .first<CommunityRow>()
    return row ?? null
  }

  /** Whether a template id exists at all — the use route answers a stranger's id as 404, not 403. */
  async exists(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT id FROM community_templates WHERE id = ?1`)
      .bind(id)
      .first<{ id: string }>()
    return row !== null
  }

  /**
   * Count one adoption of a template, except by its own author.
   *
   * The `author_id != ?2` predicate is the whole rule: the calling account is bound as `?2`, so a
   * self-visit matches nothing and the count stays honest.
   */
  async recordUse(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE community_templates SET uses = uses + 1 WHERE id = ?1 AND author_id != ?2`,
      )
      .bind(id, this.userId)
      .run()
  }

  /** The row's adoption count after the bump, or `null` if the row is gone. */
  async uses(id: string): Promise<number | null> {
    const row = await this.db
      .prepare(`SELECT uses FROM community_templates WHERE id = ?1`)
      .bind(id)
      .first<{ uses: number }>()
    return row?.uses ?? null
  }

  /**
   * Take a template off the directory.
   *
   * Addressed by the plain id, as it always was: the route has just proved through `authorOf` that
   * this id belongs to the calling account, and that probe is what makes the write scoped.
   */
  async unpublish(id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM community_templates WHERE id = ?1`)
      .bind(id)
      .run()
  }
}
