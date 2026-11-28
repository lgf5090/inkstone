// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'
import { applyBackupReader, readBackupReader } from '../src/worker/reader/backup'
import type { Env } from '../src/worker/env'

const USER = 'user-reader'
let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

function env(files?: unknown): Env {
  return { DB: db, FILES: files } as unknown as Env
}

describe('reader backup', () => {
  it('round-trips shelf state and reports missing book objects', async () => {
    await db.prepare(`INSERT INTO reader_books (id,user_id,title,author,format,filename,language,publisher,size,unit_count,r2_key,has_cover,toc,added_at,updated_at,has_blob) VALUES ('b1',?,'Book','','epub','b.epub','','',10,1,?,0,'[]',1,1,1)`).bind(USER, `reader/${USER}/b1.epub`).run()
    await db.prepare(`INSERT INTO reader_progress (user_id,book_id,position,fraction,updated_at) VALUES (?,'b1','null',0.5,2)`).bind(USER).run()
    await db.prepare(`INSERT INTO reader_sync_versions (user_id,entity,entity_id,book_id,updated_at,deleted) VALUES (?,'books','b1','',1,0)`).bind(USER).run()
    const text = await readBackupReader(db, USER)
    expect(text).not.toBeNull()
    sqlite.exec('DELETE FROM reader_books; DELETE FROM reader_progress; DELETE FROM reader_sync_versions;')
    const result = await applyBackupReader(env(), USER, text!)
    expect(result).toEqual({ books: 1, missingObjects: 1 })
    expect(sqlite.prepare('SELECT title FROM reader_books').get()).toEqual({ title: 'Book' })
    expect(sqlite.prepare('SELECT fraction FROM reader_progress').get()).toEqual({ fraction: 0.5 })
    expect(sqlite.prepare('SELECT entity FROM reader_sync_versions').get()).toEqual({ entity: 'books' })
  })

  it('marks objects that are present in the bucket backup', async () => {
    await db.prepare(`INSERT INTO reader_books (id,user_id,title,author,format,filename,language,publisher,size,unit_count,r2_key,has_cover,toc,added_at,updated_at,has_blob) VALUES ('b1',?,'Book','','epub','b.epub','','',10,1,?,0,'[]',1,1,1)`).bind(USER, `reader/${USER}/b1.epub`).run()
    const text = await readBackupReader(db, USER)
    sqlite.exec('DELETE FROM reader_books')
    const files = { get: async () => ({ size: 10 }) }
    await applyBackupReader(env(files), USER, text!)
    expect(sqlite.prepare('SELECT has_blob, size FROM reader_books').get()).toEqual({ has_blob: 1, size: 10 })
  })

  it('refuses an object key outside the restoring account', async () => {
    await db.prepare(`INSERT INTO reader_books (id,user_id,title,author,format,filename,language,publisher,size,unit_count,r2_key,has_cover,toc,added_at,updated_at,has_blob) VALUES ('b1',?,'Book','','epub','b.epub','','',10,1,?,0,'[]',1,1,1)`).bind(USER, `reader/${USER}/b1.epub`).run()
    const text = await readBackupReader(db, USER)
    const document = JSON.parse(text!)
    document.objects[0].key = 'reader/other/b1.epub'
    await expect(applyBackupReader(env(), USER, JSON.stringify(document))).rejects.toThrow(/outside this account/)
  })
})
