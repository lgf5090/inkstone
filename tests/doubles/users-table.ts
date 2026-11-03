import type { DatabaseSync } from 'node:sqlite'

/**
 * The account table `src/worker/db/schema.ts` owns.
 *
 * CloudDrive reads the owner's policy (quota, upload ceilings, WebDAV, the member switches) out of
 * that account's settings row, so a test database that exercises any of those routes needs the table
 * to exist even when nobody signs in: the same missing-table failure a throttle row causes, one layer
 * up. `role` is the only column the policy lookup looks at.
 */
export function createUsersTable(sqlite: DatabaseSync): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  login TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  settings TEXT NOT NULL DEFAULT '{}',
  template_library TEXT,
  quickadd TEXT,
  rss TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
)`)
}
