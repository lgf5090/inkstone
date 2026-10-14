/**
 * Every read and write the auth HTTP routes make against D1.
 *
 * The shape follows `share/store.ts`, with one difference that has a reason: these are free
 * functions that take the `db` and, where there is one, the account id — not a store constructed
 * from `userId`. Half of what lives here runs *before* an account exists: the registration gate asks
 * whether the instance has any user, the create mints the id, and a sign-in is addressed by the
 * username the visitor typed. There is no session to build from, and inventing one would be an
 * abstraction with nothing behind it. The two functions that do run for a signed-in account take its
 * id explicitly, which is the same scoping the route applied by hand.
 *
 * What that means for scoping, statement by statement:
 *  - `hasAnyAccount`, `insertAccount` and `usernameTaken` are instance-level on purpose. They answer
 *    "is this deployment empty" and "is that name taken", questions no account owns; the insert's
 *    owner/member decision and its `app_meta` registration guard are the whole point of reading past
 *    one account, and the `ON CONFLICT(username) DO NOTHING` plus the guard is what makes a race
 *    answer `false` instead of writing twice. `username` is the lookup key here, exactly as `slug` is
 *    for `findShareBySlug`.
 *  - `accountByLoginName` returns the password hash to the route. Verification, the dummy verify on
 *    the missing-user path, the throttle ladder and the `ApiError` codes all stay outside this file:
 *    the store answers a row or nothing.
 *  - `updateProfile` and `replacePasswordHash` are the account's own row: `WHERE id = ?1` binds the
 *    session account, and the `password_hash = ?3` / `avatar_url = ?6` equality predicates are the
 *    optimistic guards — a hash or avatar that moved under the request changes nothing, and the route
 *    turns that `false` into its 409. The `users` table has no separate `user_id` column because its
 *    primary key *is* the account id.
 *
 * Each mutation keeps the exact D1 batch it is written in today. The profile write's cleanup row and
 * its update must land together — an avatar replaced without its object queued is an object nobody
 * will ever delete — and the password update and the TOTP challenge delete must too, so a session
 * that proved the old password cannot survive a change that did not happen. `results.at(-1)` (profile)
 * and the first result (password) are the route's answers and are preserved by position.
 */

import { rowToUser, USER_COLUMNS } from '../middleware/auth'

/** The row a sign-in compares against: the profile columns the session carries plus the verifier. */
export type AccountCredentialRow = Parameters<typeof rowToUser>[0] & { password_hash: string }

/** A create the route has already validated, hashed and clocked. */
export interface AccountCreate {
  id: string
  username: string
  /** Already through `hashPassword`; this file never sees the plain password. */
  passwordHash: string
  /** The default settings for the visitor's locale, already stringified. */
  settings: string
  now: number
}

/** A profile write the route has planned: what to change, and the avatar it replaces. */
export interface ProfileUpdate {
  name: string
  replaceName: boolean
  avatarUrl: string
  replaceAvatar: boolean
  /** The avatar the session still shows, which is both the guard and the object to free. */
  currentAvatarUrl: string
  /** `attachmentCleanupTarget()` of the replaced object, or `null` when nothing has to be freed. */
  cleanupObjectKey: string | null
  /** The clock the route read for the cleanup row and the response. */
  now: number
}

/** Whether the instance has any account at all — the first sign-up is the owner by this answer. */
export async function hasAnyAccount(db: D1Database): Promise<boolean> {
  const countRow = await db.prepare(`SELECT 1 AS n FROM users LIMIT 1`).first<{ n: number }>()
  return Boolean(countRow)
}

/**
 * Create the account, or change nothing.
 *
 * `false` covers both refusals the route tells apart: the username was taken, and the instance is no
 * longer empty while registration is closed. Which one it was is the route's question, so it asks
 * `usernameTaken` next; the SQL here is one statement and stays one statement.
 */
export async function insertAccount(db: D1Database, input: AccountCreate): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO users
         (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       SELECT ?1, ?2, ?3, ?2, ?2, '',
              CASE WHEN NOT EXISTS (SELECT 1 FROM users) THEN 'owner' ELSE 'member' END,
              ?4, ?5, ?5
        WHERE NOT EXISTS (SELECT 1 FROM users)
           OR COALESCE((SELECT value FROM app_meta WHERE key = 'setting:allow_registration'), '0') = '1'
       ON CONFLICT(username) DO NOTHING`,
    )
    .bind(input.id, input.username, input.passwordHash, input.settings, input.now)
    .run()
  return Boolean(result.meta.changes)
}

/** Whether that username is already someone's — the 409 the register route answers with. */
export async function usernameTaken(db: D1Database, username: string): Promise<boolean> {
  const taken = await db.prepare(`SELECT id FROM users WHERE username = ?1`).bind(username).first()
  return taken !== null
}

/**
 * The account behind a login name, hash included.
 *
 * Deliberately unscoped by account: a visitor has not proved anything yet, and the username is what
 * they typed. Whether the name is even shaped like one is the route's check before it calls here.
 */
export async function accountByLoginName(
  db: D1Database,
  username: string,
): Promise<AccountCredentialRow | null> {
  return await db
    .prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ?1`)
    .bind(username)
    .first<AccountCredentialRow>()
}

/**
 * Write the profile, freeing the avatar it replaces, in one batch.
 *
 * The cleanup row is selected from the account itself (`WHERE id = ?3 AND avatar_url = ?4`), so a
 * replacement that raced another write queues nothing, and the update's `(?3 = 0 OR avatar_url = ?6)`
 * is the same race seen from the other side.
 */
export async function updateProfile(
  db: D1Database,
  userId: string,
  input: ProfileUpdate,
): Promise<boolean> {
  const statements: D1PreparedStatement[] = []
  if (input.cleanupObjectKey !== null) {
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         SELECT ?1, id, ?2 FROM users WHERE id = ?3 AND avatar_url = ?4`,
      ).bind(input.cleanupObjectKey, input.now, userId, input.currentAvatarUrl),
    )
  }
  statements.push(
    db.prepare(
      `UPDATE users SET
         name = CASE WHEN ?1 = 1 THEN ?2 ELSE name END,
         avatar_url = CASE WHEN ?3 = 1 THEN ?4 ELSE avatar_url END
       WHERE id = ?5 AND (?3 = 0 OR avatar_url = ?6)`,
    ).bind(
      input.replaceName ? 1 : 0,
      input.name,
      input.replaceAvatar ? 1 : 0,
      input.avatarUrl,
      userId,
      input.currentAvatarUrl,
    ),
  )
  const results = await db.batch(statements)
  return Boolean(results.at(-1)?.meta.changes)
}

/**
 * Set a new password hash, dropping the login challenges the old one proved.
 *
 * Both statements ride the one batch the route used, and the answer is still the *first* result's:
 * `false` means the hash moved under this request, so nothing was written and the caller's session
 * must not be rotated. The delete's `EXISTS (SELECT 1 FROM users WHERE id = ?1 AND password_hash = ?2)`
 * keeps it keyed to the same account and the same new hash, so a raced write deletes nothing.
 */
export async function replacePasswordHash(
  db: D1Database,
  userId: string,
  newHash: string,
  expectedHash: string,
): Promise<boolean> {
  const [update] = await db.batch([
    db.prepare(`UPDATE users SET password_hash = ?1 WHERE id = ?2 AND password_hash = ?3`)
      .bind(newHash, userId, expectedHash),
    db.prepare(
      `DELETE FROM totp_login_challenges
        WHERE user_id = ?1
          AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND password_hash = ?2)`,
    ).bind(userId, newHash),
  ])
  return Boolean(update?.meta.changes)
}
