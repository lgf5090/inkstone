/**
 * Every read and write the settings HTTP routes make against D1.
 *
 * The shape follows `share/store.ts`: a store built per request from the account it serves, methods
 * that hand back rows, the boolean a compare-and-set matched or nothing, and no `Response` in sight.
 * What stays with the route is the merge itself (`mergeSettings` / `mergeSettingsPatch` are the
 * shared contract with the client), the owner-only check, the `ApiError` codes and message strings,
 * the retry ceiling and the change record that rides `commitChange`.
 *
 * All three statements are the account's own row: `WHERE id = ?1` binds `c.get('userId')`, and
 * `users.id` *is* the account — there is no separate `user_id` column to carry on this table. The
 * `stats` read is the exception worth spelling out: a `users` read would be one row, but the answer
 * is a count over six tables, so every subquery in it names `user_id = ?1` and the two derived tables
 * filter `notes` and `attachments` by the same bound account. One account can never see another's
 * totals, and no statement here reaches a row it does not bind.
 *
 * The settings write is a compare-and-set rather than a plain update, and that is the point of
 * handing back a boolean: two devices editing their appearance settings must not silently lose one
 * edit, so the write only lands while the column still holds the text the caller merged from. The
 * route owns what a refusal means — re-read and try again, then a 409.
 */

/** The counts `/api/settings/stats` answers with; every column is one number of the aggregate. */
export interface AccountStatsRow {
  notes: number
  trashed: number
  chars: number
  words: number
  attachments: number
  attachmentBytes: number
  folders: number
  tags: number
  versions: number
  links: number
}

export class SettingsStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /**
   * The stored settings text, or `null` when the account row is gone.
   *
   * `null` is not an empty settings object: the column is `NOT NULL`, so a missing row means the
   * session outlived the account, which the route answers 401 for.
   */
  async readSettings(): Promise<string | null> {
    const latest = await this.db
      .prepare(`SELECT settings FROM users WHERE id = ?1`)
      .bind(this.userId)
      .first<{ settings: string }>()
    return latest?.settings ?? null
  }

  /** Replace the settings text, but only while the column still holds `previousRaw`. */
  async writeSettingsIfUnchanged(nextRaw: string, previousRaw: string): Promise<boolean> {
    const updated = await this.db
      .prepare(
        `UPDATE users SET settings = ?1 WHERE id = ?2 AND settings = ?3`,
      )
      .bind(nextRaw, this.userId, previousRaw)
      .run()
    return Boolean(updated.meta.changes)
  }

  /**
   * The account's totals in one statement.
   *
   * The two derived tables are the note and attachment counts, cross-joined so a library with no
   * attachments still answers `0` rather than no row; the four scalar subqueries count the rest. A
   * missing account row answers `null`, and the route turns every field into `0`.
   */
  async stats(): Promise<AccountStatsRow | null> {
    const row = await this.db
      .prepare(
        `SELECT note_stats.*, attachment_stats.*,
           (SELECT COUNT(*) FROM folders WHERE user_id = ?1 AND deleted_at IS NULL) AS folders,
           (SELECT COUNT(*) FROM tags WHERE user_id = ?1) AS tags,
           (SELECT COUNT(*) FROM note_versions WHERE user_id = ?1) AS versions,
           (SELECT COUNT(*) FROM links WHERE user_id = ?1) AS links
         FROM (
           SELECT COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) AS notes,
                  COUNT(deleted_at) AS trashed,
                  COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN char_count ELSE 0 END), 0) AS chars,
                  COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN word_count ELSE 0 END), 0) AS words
             FROM notes WHERE user_id = ?1
         ) note_stats CROSS JOIN (
           SELECT COUNT(*) AS attachments, COALESCE(SUM(size), 0) AS attachmentBytes
             FROM attachments WHERE user_id = ?1
         ) attachment_stats`,
      )
      .bind(this.userId)
      .first<AccountStatsRow>()
    return row ?? null
  }
}
