// @vitest-environment node
/**
 * A draft written before history existed.
 *
 * The version table and the head number arrived over three migrations. A database that has been running
 * since before them still has the old `chat_artifacts` shape and a ledger that says everything is done,
 * so the boot has to add the column and write one version row for every draft already there. A second
 * boot must not add a second copy.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const CONVERSATION = '01hzzzzzzzzzzzzzzzzzzzzz02'
const ARTIFACT = '01hzzzzzzzzzzzzzzzzzzzzz01'

/** Put a current database back into the shape it had before migrations 110-112 ran. */
function rewindArtifactHistory(sqlite: DatabaseSync): void {
  sqlite.exec('DROP TABLE chat_artifact_versions')
  sqlite.exec('ALTER TABLE chat_artifacts DROP COLUMN version')
  sqlite.exec('DELETE FROM schema_migrations WHERE version IN (110, 111, 112)')
  sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
}

describe('artifact history migration', () => {
  it('adds the version column and backfills the head row of an older database', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA journal_mode = OFF')
    // Build the rest of the schema at its current shape, then rewind only the part this migration owns.
    await initializeDatabase(testBindings(makeD1(sqlite)))
    rewindArtifactHistory(sqlite)
    sqlite.prepare(
      `INSERT INTO chat_artifacts (user_id, id, conversation_id, title, content, note_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(USER, ARTIFACT, CONVERSATION, 'Old draft', 'Old body', 10, 20)

    await initializeDatabase(testBindings(makeD1(sqlite)))

    const row = sqlite.prepare('SELECT version FROM chat_artifacts WHERE id = ?').get(ARTIFACT) as { version: number }
    expect(row.version).toBe(1)
    const versions = sqlite.prepare(
      'SELECT version, source, title, content FROM chat_artifact_versions WHERE artifact_id = ?',
    ).all(ARTIFACT) as Array<{ version: number, source: string, title: string, content: string }>
    expect(versions).toEqual([{ version: 1, source: 'import', title: 'Old draft', content: 'Old body' }])
    const ledger = sqlite.prepare('SELECT version FROM schema_migrations WHERE version IN (110,111,112) ORDER BY version').all() as Array<{ version: number }>
    expect(ledger.map((entry) => entry.version)).toEqual([110, 111, 112])

    // A second boot sees the ledger complete and the fingerprint's schema; it must not add a second row.
    sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
    await initializeDatabase(testBindings(makeD1(sqlite)))
    const count = sqlite.prepare('SELECT count(*) AS n FROM chat_artifact_versions WHERE artifact_id = ?').get(ARTIFACT) as { n: number }
    expect(count.n).toBe(1)
  })
})
