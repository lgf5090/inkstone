// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/worker/env'
import { ApiError } from '../src/worker/lib/errors'
import { listMcpAttachments, readMcpAttachment, uploadMcpAttachment } from '../src/worker/mcp/library'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const NOTE = 'a'.repeat(26)
const FILE = '00000000000000000000000001'
const PLAINTEXT_FILE = '00000000000000000000000002'

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, deleted_at INTEGER, is_encrypted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, note_id TEXT, filename TEXT NOT NULL,
      mime TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER, height INTEGER, encryption TEXT NOT NULL DEFAULT 'none',
      plaintext_size INTEGER, sha256 TEXT, object_key TEXT, storage TEXT, created_at INTEGER NOT NULL);
  `)
  sqlite.prepare('INSERT INTO notes (id, user_id, is_encrypted) VALUES (?1, ?2, 1)').run(NOTE, USER)
  sqlite.prepare(`INSERT INTO attachments
    (id, user_id, note_id, filename, mime, size, encryption, plaintext_size, sha256, object_key, storage, created_at)
    VALUES (?1, ?2, ?3, 'secret.png', 'image/png', 40, 'note-lock-v1', 8, 'hash', 'notes/user/file.enc', 'r2', 1)`)
    .run(FILE, USER, NOTE)
  sqlite.prepare(`INSERT INTO attachments
    (id, user_id, note_id, filename, mime, size, encryption, plaintext_size, sha256, object_key, storage, created_at)
    VALUES (?1, ?2, ?3, 'pending.png', 'image/png', 8, 'none', NULL, 'hash', 'notes/user/plain.png', 'r2', 1)`)
    .run(PLAINTEXT_FILE, USER, NOTE)
  return { sqlite, db: makeD1(sqlite) }
}

describe('MCP encrypted attachment policy', () => {
  it('omits encrypted metadata and never returns ciphertext as file content', async () => {
    const { sqlite, db } = fixture()
    const page = await listMcpAttachments(db, USER, { noteId: NOTE })
    expect(page.attachments).toEqual([])
    await expect(readMcpAttachment({ DB: db } as Env, USER, { attachmentId: FILE })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
    await expect(readMcpAttachment({ DB: db } as Env, USER, { attachmentId: PLAINTEXT_FILE })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
    sqlite.close()
  })

  it('refuses plaintext MCP uploads to a locked note before touching storage', async () => {
    const { sqlite, db } = fixture()
    await expect(uploadMcpAttachment({
      env: { DB: db } as Env,
      userId: USER,
      origin: 'https://example.com',
      ftsEnabled: false,
      executionCtx: { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    }, {
      operationId: 'op-1',
      noteId: NOTE,
      filename: 'plain.txt',
      mime: 'text/plain',
      base64: 'cGxhaW4=',
    })).rejects.toBeInstanceOf(ApiError)
    sqlite.close()
  })
})
