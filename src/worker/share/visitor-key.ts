import { getMeta } from '../db/metadata'

/**
 * The key the visitor fingerprint is salted with.
 *
 * A distinct-visitor count needs to tell two visits from the same place apart, and the only handles
 * a worker gets are an IP and a `user_agent` — both of which are personal data. The answer is a
 * keyed hash truncated to 32 hex chars, salted per UTC day so the stored value cannot be replayed
 * across a date boundary, and never reversible to the address it came from.
 *
 * The key itself has to survive a restart and stay off the reader's side of the wire, which leaves
 * exactly two places for it: a deployment secret, or a row this worker mints for itself. Reading
 * only the first is what makes the whole feature silently wrong when it is unset — every UV number
 * in the app answers zero, and a zero that looks like a measurement is worse than no measurement.
 * So `VISIT_FP_SECRET` wins when present, and a random key generated once into `app_meta` covers
 * every deployment that has not set one.
 */
const VISITOR_KEY_META = 'share-visitor-key-v1'

/** The shape this module reads, so a test can hand it a literal instead of a whole `Env`. */
export interface VisitorKeyEnv {
  DB: D1Database
  VISIT_FP_SECRET?: string
}

let cachedKey: { configured: string | null; derived: string } | null = null

/**
 * The salt source for one deployment: the configured secret, or the minted one.
 *
 * The minted value is read back rather than kept from the write because two isolates can generate
 * concurrently and only one of them lands; the loser must fingerprint with the winner's key or the
 * same visitor starts counting twice.
 */
export async function resolveVisitorKey(env: VisitorKeyEnv): Promise<string | null> {
  const configured = env.VISIT_FP_SECRET?.trim()
  if (configured) return configured
  if (cachedKey) return cachedKey.derived

  const existing = await getMeta(env.DB, VISITOR_KEY_META)
  const minted = existing ?? randomVisitorKey()
  if (!existing) {
    await env.DB
      .prepare(`INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING`)
      .bind(VISITOR_KEY_META, minted)
      .run()
  }
  const settled = (await getMeta(env.DB, VISITOR_KEY_META)) ?? minted
  cachedKey = { configured: null, derived: settled }
  return settled
}

function randomVisitorKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Drops the memoised key. The key only changes when a deployment adds `VISIT_FP_SECRET` to a running
 * environment or wipes its database, and both restart the worker — but the test suite exercises them
 * inside one process, and leaving a stale key cached there would have the next case fingerprint with
 * the previous case's salt.
 */
export function resetVisitorKeyCache(): void {
  cachedKey = null
}
