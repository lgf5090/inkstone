import type { DatabaseSync } from 'node:sqlite'

/**
 * The attempt-budget table `src/worker/lib/throttle.ts` owns.
 *
 * A route that checks a lock reads the table before anything has written it, so a test database that
 * exercises one of those routes has to create it: a feature schema (CloudDrive's, or anybody else's)
 * only ships its own tables, and the failure mode is a 500 that looks like a bug in the route.
 */
export function createLoginAttemptsTable(sqlite: DatabaseSync): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  last_fail_at INTEGER NOT NULL,
  locked_until INTEGER
)`)
}
