import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { trashPurgeStatements } from '../src/worker/routes/notes'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'

const MINE = 'user-a'
const OTHER = 'user-b'

let sqlite: DatabaseSync
let db: D1Database

const count = (sql: string, ...args: unknown[]) => Number(
  (sqlite.prepare(sql).get(...args) as { n: number }).n,
)

function note(id: string, user: string, titleKey: string, trashed: boolean) {
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, rev, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, 'body', 1, 1, 1, ?)`,
  ).run(id, user, titleKey, titleKey, trashed ? 999 : null)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  // Two notes share a title so the link can be retargeted before the trashed one disappears.
  note('keep', MINE, 'Same Title', false)
  note('trash-1', MINE, 'Same Title', true)
  note('trash-2', MINE, 'Other', true)
  note('theirs', OTHER, 'Same Title', true)
  sqlite.prepare('INSERT INTO tags (id, user_id, name, created_at) VALUES (?, ?, ?, 1)').run('t1', MINE, 'x')
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run('trash-1', 't1')
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run('theirs', 't1')
  sqlite.prepare(
    `INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id)
     VALUES ('trash-1', 'Same Title', 'Same Title', 'keep', ?)`,
  ).run(MINE)
  sqlite.prepare(
    `INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id)
     VALUES ('keep', 'Same Title', 'Same Title', 'trash-1', ?)`,
  ).run(MINE)
  sqlite.prepare(
    `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
     VALUES ('v1', 'trash-1', ?, 'x', 'body', 4, 1)`,
  ).run(MINE)
  sqlite.prepare(
    `INSERT INTO shares (slug, note_id, user_id, created_at) VALUES ('slug-a', 'trash-1', ?, 1)`,
  ).run(MINE)
  sqlite.prepare(
    `INSERT INTO share_asset_sessions (id, slug, password_hash, expires_at, created_at)
     VALUES ('sas1', 'slug-a', 'h', 9_999_999_999_999, 1)`,
  ).run()
  sqlite.prepare(
    `INSERT INTO attachments (id, user_id, note_id, filename, mime, size, sha256, storage, created_at)
     VALUES ('at1', ?, 'trash-1', 'f.png', 'image/png', 10, 'hash', 'r2', 1)`,
  ).run(MINE)
  sqlite.prepare(
    `INSERT INTO import_mappings (user_id, entity, source_id, target_id, updated_at)
     VALUES (?, 'note', 'old/path.md', 'trash-1', 1)`,
  ).run(MINE)
})

async function purge(ids: string[], user = MINE) {
  const statements = trashPurgeStatements(db, user, JSON.stringify(ids), Date.now(), true)
  const results = await db.batch(statements)
  return results.at(-1)?.meta.changes ?? 0
}

const trashedIdsOf = (user: string) => sqlite.prepare(
  'SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY id ASC',
).all(user).map((row) => String((row as { id: unknown }).id))

describe('trashPurgeStatements', () => {
  it('drops the whole cascade for the given ids and reports how many notes went', async () => {
    const ids = trashedIdsOf(MINE)
    expect(ids).toEqual(['trash-1', 'trash-2'])
    expect(await purge(ids)).toBe(2)
    expect(count('SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL', MINE)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM note_tags WHERE note_id IN (?, ?)', 'trash-1', 'trash-2')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM links WHERE user_id = ? AND source_note_id = ?', MINE, 'trash-1')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM note_versions WHERE note_id = ?', 'trash-1')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM shares WHERE note_id = ?', 'trash-1')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM share_asset_sessions')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM import_mappings WHERE target_id = ?', 'trash-1')).toBe(0)
    expect(sqlite.prepare('SELECT note_id FROM attachments WHERE id = ?').get('at1')?.note_id).toBeNull()
    expect(count('SELECT COUNT(*) AS n FROM changes WHERE user_id = ? AND op = ?', MINE, 'delete')).toBe(2)
    expect(count('SELECT COUNT(*) AS n FROM fts_index_queue WHERE user_id = ? AND kind = ?', MINE, 'delete')).toBe(2)
  })

  it('retargets inbound links to a surviving note before the trashed row goes', async () => {
    await purge(trashedIdsOf(MINE))
    const link = sqlite.prepare('SELECT target_note_id FROM links WHERE source_note_id = ?').get('keep')
    expect(link?.target_note_id).toBe('keep')
  })

  it('leaves another account untouched even when the id list overlaps nothing', async () => {
    await purge(trashedIdsOf(MINE))
    expect(count('SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL', OTHER)).toBe(1)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM note_tags WHERE note_id = ?').get('theirs')?.n).toBe(1)
  })

  it('scales to a 500 id page without dropping rows', async () => {
    for (let index = 0; index < 498; index++) {
      note(`bulk-${index}`, MINE, `Bulk ${index}`, true)
    }
    const ids = trashedIdsOf(MINE)
    expect(ids).toHaveLength(500)
    expect(await purge(ids)).toBe(500)
    expect(count('SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL', MINE)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM changes WHERE user_id = ? AND op = ?', MINE, 'delete')).toBe(500)
  })

  it('queues an AI vector deletion only for notes that still have one', async () => {
    sqlite.prepare(
      `INSERT INTO ai_note_embeddings (user_id, note_id, model, vector, indexed_at)
       VALUES (?, 'trash-1', '@cf/baai/bge-m3', ?, 1)`,
    ).run(MINE, new Uint8Array(8).buffer)
    await purge(trashedIdsOf(MINE))
    const queued = sqlite.prepare(
      'SELECT note_id FROM ai_index_queue WHERE user_id = ? AND kind = ? ORDER BY note_id',
    ).all(MINE, 'delete').map((row) => String((row as { note_id: unknown }).note_id))
    expect(queued).toEqual(['trash-1'])
  })
})
