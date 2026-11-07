// The host-key state machine W2 must apply before credentials leave the Worker (plan §8.1.1).
//
// This file mirrors W3's `WebsshHostKeysStore.check/recordSighting` against the shared
// `webssh_host_keys` table. It lives under `do/` because W2 and W3 were built in parallel; the merge
// replaces it with the W3 store, and no second write path is invented here.

interface HostKeyRow {
  algorithm: string
  fingerprint: string
  trusted_at: number | null
  revoked_at: number | null
}

export type HostKeyState = 'untrusted' | 'trusted' | 'changed' | 'revoked'

export interface HostKeyDecision {
  state: HostKeyState
  trustedFingerprint: string | null
}

function decide(rows: HostKeyRow[], algorithm: string, fingerprint: string): HostKeyDecision {
  const presented = rows.find((row) => row.algorithm === algorithm && row.fingerprint === fingerprint)
  const trusted = rows.filter((row) => row.trusted_at !== null && row.revoked_at === null)
  const matchingTrusted = trusted.find((row) => row.fingerprint === fingerprint)
  let state: HostKeyState
  if (presented?.revoked_at !== null && presented?.revoked_at !== undefined) state = 'revoked'
  else if (matchingTrusted) state = 'trusted'
  else if (trusted.length) state = 'changed'
  else state = 'untrusted'
  return {
    state,
    trustedFingerprint: state === 'changed' ? trusted[0]!.fingerprint : matchingTrusted?.fingerprint ?? null,
  }
}

async function rows(db: D1Database, userId: string, hostId: string): Promise<HostKeyRow[]> {
  const result = await db.prepare(
    `SELECT algorithm, fingerprint, trusted_at, revoked_at
       FROM webssh_host_keys
      WHERE user_id = ?1 AND host_id = ?2
      ORDER BY last_seen_at DESC, fingerprint`,
  )
    .bind(userId, hostId)
    .all<HostKeyRow>()
  return result.results
}

/** The fingerprint a session should pin before connecting; null means the host has never been trusted. */
export async function trustedFingerprint(db: D1Database, userId: string, hostId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT fingerprint FROM webssh_host_keys
      WHERE user_id = ?1 AND host_id = ?2 AND trusted_at IS NOT NULL AND revoked_at IS NULL
      ORDER BY trusted_at DESC LIMIT 1`,
  )
    .bind(userId, hostId)
    .first<{ fingerprint: string }>()
  return row?.fingerprint ?? null
}

export async function hostKeyDecision(
  db: D1Database,
  userId: string,
  hostId: string,
  algorithm: string,
  fingerprint: string,
): Promise<HostKeyDecision> {
  return decide(await rows(db, userId, hostId), algorithm, fingerprint)
}

/** Record that this host presented a key; a trusted key keeps its trusted_at and refreshes last_seen. */
export async function recordHostKeySighting(
  db: D1Database,
  userId: string,
  hostId: string,
  algorithm: string,
  fingerprint: string,
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    `INSERT INTO webssh_host_keys (user_id, host_id, algorithm, fingerprint, first_seen_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(user_id, host_id, fingerprint) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(userId, hostId, algorithm, fingerprint, now)
    .run()
}

/**
 * Marks the first-seen key as trusted without a user prompt, but only when the state machine already
 * decided it is untrusted (no trusted key and not revoked). A changed key never reaches this call.
 */
export async function autoTrustHostKey(
  db: D1Database,
  userId: string,
  hostId: string,
  algorithm: string,
  fingerprint: string,
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    `INSERT INTO webssh_host_keys
       (user_id, host_id, algorithm, fingerprint, first_seen_at, last_seen_at, trusted_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5, NULL)
     ON CONFLICT(user_id, host_id, fingerprint) DO UPDATE SET
       algorithm = excluded.algorithm,
       last_seen_at = excluded.last_seen_at,
       trusted_at = excluded.trusted_at,
       revoked_at = NULL`,
  )
    .bind(userId, hostId, algorithm, fingerprint, now)
    .run()
}

/** The host row's own "last connected" marker, which W3's list sorts by. */
export async function markHostConnected(
  db: D1Database,
  userId: string,
  hostId: string,
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    `UPDATE webssh_hosts SET last_connected_at = ?3
      WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  )
    .bind(userId, hostId, now)
    .run()
}
