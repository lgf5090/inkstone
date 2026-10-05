import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeLinkKey } from '../src/shared/markdown-utils'
import { drainRewriteQueues } from '../src/worker/lib/rewrite-drain'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-1'
const TARGET = 'note-target'

function contentOf(id: string): string {
  return `Body of ${id} referencing [[Old Title]] here.`
}

function seed(candidateCount: number) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, folder_id TEXT, title TEXT NOT NULL,
      title_key TEXT NOT NULL, content TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '', rev INTEGER NOT NULL DEFAULT 1,
      word_count INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE links (source_note_id TEXT NOT NULL, target_key TEXT NOT NULL, target_title TEXT NOT NULL,
      target_note_id TEXT, user_id TEXT NOT NULL, PRIMARY KEY (source_note_id, target_key));
    CREATE TABLE tags (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT,
      is_manual INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (note_id, tag_id));
    CREATE TABLE note_versions (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, entity TEXT NOT NULL,
      entity_id TEXT NOT NULL, op TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE ai_index_queue (user_id TEXT NOT NULL, note_id TEXT NOT NULL, kind TEXT NOT NULL,
      created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
      PRIMARY KEY (user_id, note_id));
    CREATE TABLE fts_index_queue (user_id TEXT NOT NULL, note_id TEXT NOT NULL, kind TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (user_id, note_id));
    CREATE TABLE rewrite_queue (user_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL,
      old_value TEXT NOT NULL, new_value TEXT NOT NULL, created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, PRIMARY KEY (user_id, kind, source_id));
    CREATE INDEX idx_notes_user_id ON notes(user_id, id);
    CREATE INDEX idx_links_user_target ON links(user_id, target_note_id);
    CREATE INDEX idx_changes_user ON changes(user_id, seq);
    CREATE UNIQUE INDEX idx_tags_unique ON tags(user_id, name);
    CREATE INDEX idx_rewrite_queue_due ON rewrite_queue(user_id, created_at);
  `)
  sqlite.prepare('INSERT INTO notes (id, user_id, title, title_key, content, content_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(TARGET, USER, 'Old Title', normalizeLinkKey('Old Title'), 'I am the hub note', 'hash-target', 1, 1)
  for (let index = 0; index < candidateCount; index++) {
    const id = `note-${index}`
    sqlite.prepare('INSERT INTO notes (id, user_id, title, title_key, content, content_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, USER, id, normalizeLinkKey(id), contentOf(id), `hash-${id}`, 1, 1 + index)
    sqlite.prepare('INSERT INTO links (source_note_id, target_key, target_title, target_note_id, user_id) VALUES (?,?,?,?,?)')
      .run(id, normalizeLinkKey('Old Title'), 'Old Title', TARGET, USER)
  }
  sqlite.prepare('INSERT INTO rewrite_queue (user_id, kind, source_id, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(USER, 'note-title', TARGET, 'Old Title', 'New Title', 1_700_000_000_000)
  const env = { DB: makeD1(sqlite) } as unknown as Env
  return { env, sqlite }
}

const row = (sqlite: DatabaseSync) => sqlite.prepare(
  'SELECT attempts, claimed_at, created_at FROM rewrite_queue WHERE user_id = ? AND kind = ? AND source_id = ?',
).get(USER, 'note-title', TARGET) as { attempts: number; claimed_at: number | null } | undefined

const rewrittenContents = (sqlite: DatabaseSync) => (sqlite.prepare(
  'SELECT content FROM notes WHERE id <> ?1 ORDER BY id',
).all(TARGET) as { content: string }[]).map((entry) => entry.content)

describe('drainRewriteQueues', () => {
  it('applies a deferred rename and forgets the row', () => {
    const { env, sqlite } = seed(3)
    return drainRewriteQueues(env, false, 5, 60).then((processed) => {
      expect(processed).toBe(1)
      expect(row(sqlite)).toBeUndefined()
      const contents = rewrittenContents(sqlite)
      expect(contents).toHaveLength(3)
      for (const content of contents) {
        expect(content).toContain('[[New Title]]')
        expect(content).not.toContain('[[Old Title]]')
      }
    })
  })

  it('stops at the per-row note budget and keeps the row for the next round', async () => {
    const { env, sqlite } = seed(3)
    const processed = await drainRewriteQueues(env, false, 5, 2)
    expect(processed).toBe(0)
    const stuck = row(sqlite)
    expect(stuck).toBeDefined()
    expect(stuck?.attempts).toBe(0)
    const changed = rewrittenContents(sqlite).filter((content) => content.includes('[[New Title]]'))
    expect(changed).toHaveLength(2)
  })

  it('re-arms a failing row with an attempt counter instead of losing it', async () => {
    const { env, sqlite } = seed(2)
    sqlite.exec('DROP TABLE note_versions')
    const processed = await drainRewriteQueues(env, false, 5, 60)
    expect(processed).toBe(0)
    expect(row(sqlite)?.attempts).toBe(1)
    for (const content of rewrittenContents(sqlite)) expect(content).toContain('[[Old Title]]')
  })

  it('drops a row that keeps failing after five attempts so the queue can advance', async () => {
    const { env, sqlite } = seed(2)
    sqlite.exec('DROP TABLE note_versions')
    for (let round = 0; round < 6; round++) {
      // Re-arm keeps the claim marker so one run cannot re-pick the row; clearing it
      // emulates the claim TTL expiring between cron rounds.
      sqlite.exec('UPDATE rewrite_queue SET claimed_at = NULL')
      await drainRewriteQueues(env, false, 5, 60)
    }
    expect(row(sqlite)).toBeUndefined()
  })

  it('claims due rows without a temp sorter thanks to idx_rewrite_queue_due', () => {
    const { sqlite } = seed(1)
    const plan = (sqlite.prepare(
      `EXPLAIN QUERY PLAN SELECT kind, source_id, old_value, new_value, attempts FROM rewrite_queue
        WHERE user_id = ?1 AND (claimed_at IS NULL OR claimed_at <= ?2)
        ORDER BY created_at ASC LIMIT 1`,
    ).all(USER, 9e15) as { detail: string }[]).map((entry) => entry.detail).join(' | ')
    expect(plan).not.toContain('USE TEMP B-TREE')
  })
})
