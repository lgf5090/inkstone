/**
 * Every read and write the backup HTTP routes make against D1.
 *
 * The shape follows `share/store.ts`: a store built per request from the account it serves, methods
 * that hand back rows or the boolean a guarded write matched, and nothing that knows about HTTP. What
 * stays with the route is the whole credential half — endpoint/bucket/username validation, the secret
 * pick-and-merge, `encryptSecret`/`decryptSecret`, the `ApiError` codes and message strings, the
 * outbound request budget, and the `runBackup`/`testTarget` calls that reach the network. The store
 * only ever sees an already-encrypted secret string and never logs it.
 *
 * Every statement here binds `user_id`: the listing and the run history filter on it, the update and
 * both deletes address `id = ? AND user_id = ?`, and the insert's `WHERE (SELECT COUNT(*) … WHERE
 * user_id = ?2) < ?9` guard is the per-account ceiling. The one write that must not be able to touch
 * another account's row is the update, and `updated_at = ?9` is what makes a lost concurrent edit
 * answer `false` instead of overwriting it.
 *
 * The delete is two statements and stays one D1 batch: a target removed with its archive rows still
 * present would leave rows nothing can list or delete. The batch's first result — the target delete —
 * is what the route's 404 turns on, exactly as before.
 */

import type { TargetRow } from './engine'

/** A backup run as the history row stores it; `detail` is the JSON the route parses per result. */
export interface BackupRunRow {
  id: string
  trigger: string
  status: string
  started_at: number
  finished_at: number | null
  note_count: number
  file_count: number
  bytes: number
  detail: string
}

/** A create the route has already validated, encrypted and clocked. */
export interface BackupTargetInsert {
  id: string
  type: TargetRow['type']
  name: string
  enabled: number
  /** The normalized config, already stringified by the route. */
  config: string
  /** Already through `encryptSecret`; the store never sees a plain credential. */
  secret: string | null
  createdAt: number
  /** The per-account ceiling, bound rather than spliced. */
  maxTargets: number
}

/** An update the route has merged, validated and encrypted, with its expected row version. */
export interface BackupTargetUpdate {
  id: string
  type: TargetRow['type']
  name: string
  enabled: number
  config: string
  secret: string | null
  updatedAt: number
  expectedUpdatedAt: number
}

export class BackupStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** Every target of this account, oldest first — the order the settings list renders. */
  async listTargets(): Promise<TargetRow[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM backup_targets WHERE user_id = ?1 ORDER BY created_at ASC`)
      .bind(this.userId)
      .all<TargetRow>()
    return results ?? []
  }

  /**
   * One target of this account, addressed by id and account; `null` is both "not there" and "not
   * mine", which the route answers 404 for.
   */
  async target(id: string): Promise<TargetRow | null> {
    return await this.db
      .prepare(`SELECT * FROM backup_targets WHERE id = ?1 AND user_id = ?2`)
      .bind(id, this.userId)
      .first<TargetRow>()
  }

  /**
   * Create a target while the account is under its ceiling.
   *
   * The count guard rides in the statement rather than a preceding read, so two concurrent creates
   * cannot both pass a check-then-insert; `false` means the guard refused, and the route turns it into
   * the 409 that names the limit.
   */
  async insertTarget(input: BackupTargetInsert): Promise<boolean> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO backup_targets (id, user_id, type, name, enabled, config, secret, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
          WHERE (SELECT COUNT(*) FROM backup_targets WHERE user_id = ?2) < ?9`,
      )
      .bind(
        input.id,
        this.userId,
        input.type,
        input.name,
        input.enabled,
        input.config,
        input.secret,
        input.createdAt,
        input.maxTargets,
      )
      .run()
    return Boolean(inserted.meta.changes)
  }

  /**
   * Refresh a target, but only while it still carries the `updated_at` the caller merged from.
   *
   * `false` is the route's 409: either the row moved under this request or it was never this
   * account's to change.
   */
  async updateTarget(input: BackupTargetUpdate): Promise<boolean> {
    const updated = await this.db
      .prepare(
        `UPDATE backup_targets SET type = ?1, name = ?2, enabled = ?3, config = ?4, secret = ?5, updated_at = ?6
           WHERE id = ?7 AND user_id = ?8 AND updated_at = ?9`,
      )
      .bind(
        input.type,
        input.name,
        input.enabled,
        input.config,
        input.secret,
        input.updatedAt,
        input.id,
        this.userId,
        input.expectedUpdatedAt,
      )
      .run()
    return Boolean(updated.meta.changes)
  }

  /**
   * Delete a target and the archive rows that name it, in one batch.
   *
   * The returned boolean is the *target* delete's, as it always was: an unknown or foreign id matches
   * nothing there, and the archive delete rides along whether or not anything matched.
   */
  async deleteTarget(id: string): Promise<boolean> {
    const [res] = await this.db.batch([
      this.db.prepare(`DELETE FROM backup_targets WHERE id = ?1 AND user_id = ?2`).bind(id, this.userId),
      this.db.prepare(`DELETE FROM backup_archives WHERE target_id = ?1 AND user_id = ?2`).bind(id, this.userId),
    ])
    return Boolean(res?.meta.changes)
  }

  /** This account's most recent runs, newest first, capped at the window the card shows. */
  async listRuns(): Promise<BackupRunRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, trigger, status, started_at, finished_at, note_count, file_count, bytes, detail
           FROM backup_runs WHERE user_id = ?1 ORDER BY started_at DESC LIMIT 50`,
      )
      .bind(this.userId)
      .all<BackupRunRow>()
    return results ?? []
  }
}
