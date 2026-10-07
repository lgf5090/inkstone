// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildSnapshot, materializeSnapshot } from '../src/worker/backup/snapshot'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { BACKUP_TEMPLATES_NAME, parseMarkdownBackupManifest } from '../src/shared/backup-format'
import { makeD1 } from './doubles/d1-sqlite'
import { newId } from '../src/worker/lib/id'
import { sha256Hex } from '../src/worker/lib/encoding'

const USER = 'user-1'
const LIBRARY = {
  app: 'inkstone',
  kind: 'template-library',
  version: 1,
  exportedAt: 1,
  categories: [{ id: 'cat-1', name: 'Notes', builtin: false, position: 0, createdAt: 1, icon: '📝', color: null }],
  templates: [{
    id: 'tpl-1',
    categoryId: 'cat-1',
    name: 'Weekly',
    description: '',
    content: '# Week\n',
    tags: [],
    builtin: false,
    isPinned: true,
    isStarred: true,
    createdAt: 1,
    updatedAt: 1,
  }],
}

let sqlite: DatabaseSync
let env: { DB: D1Database }
const NOTE_ID = newId()

function seedLibrary(value: string | null) {
  sqlite.prepare('UPDATE users SET template_library = ?1 WHERE id = ?2').run(value, USER)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, 'one', 'h', 'one', 'One', '', 'member', '{}', 1, 1)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO notes (id, user_id, title, title_key, content, excerpt, rev, word_count, char_count, content_hash, created_at, updated_at)
     VALUES (?1, ?2, 'Hello', 'hello', '# Hello', 'Hello', 1, 1, 7, 'h', 1, 1)`,
  ).run(NOTE_ID, USER)
  env = { DB: makeD1(sqlite) }
})

describe('a backup snapshot of the template library', () => {
  it('writes the library as its own file and pins it in the manifest', async () => {
    seedLibrary(JSON.stringify({ savedAt: 5, library: LIBRARY }))
    const snapshot = await buildSnapshot(env as never, USER)
    const templates = snapshot.payloadFiles.find((file) => file.path === BACKUP_TEMPLATES_NAME)
    expect(templates).toBeDefined()
    expect(templates!.kind).toBe('templates')
    const [materialized] = (await materializeSnapshot(snapshot)).filter((file) => file.path === BACKUP_TEMPLATES_NAME)
    expect(new TextDecoder().decode(materialized!.body)).toBe(JSON.stringify(LIBRARY))
    const manifest = parseMarkdownBackupManifest(
      JSON.parse(new TextDecoder().decode(
        (await materializeSnapshot(snapshot)).find((file) => file.path === 'manifest.json')!.body,
      )),
    )
    expect(manifest?.templates).toEqual({
      path: BACKUP_TEMPLATES_NAME,
      bytes: templates!.byteLength,
      sha256: await sha256Hex(materialized!.body),
    })
  })

  it('leaves the section out for an account that has never touched the library', async () => {
    seedLibrary(null)
    const snapshot = await buildSnapshot(env as never, USER)
    expect(snapshot.payloadFiles.some((file) => file.path === BACKUP_TEMPLATES_NAME)).toBe(false)
    const manifestFile = (await materializeSnapshot(snapshot)).find((file) => file.path === 'manifest.json')
    const manifest = parseMarkdownBackupManifest(JSON.parse(new TextDecoder().decode(manifestFile!.body)))
    expect(manifest?.templates).toBeUndefined()
    expect(manifest?.notes).toHaveLength(1)
  })

  it('writes no template file when the stored library has gone to junk', async () => {
    seedLibrary('not json at all')
    const snapshot = await buildSnapshot(env as never, USER)
    expect(snapshot.payloadFiles.some((file) => file.path === BACKUP_TEMPLATES_NAME)).toBe(false)
    seedLibrary('{"savedAt": 5, "library": {"app": "other"}}')
    const other = await buildSnapshot(env as never, USER)
    expect(other.payloadFiles.some((file) => file.path === BACKUP_TEMPLATES_NAME)).toBe(false)
    expect(other.noteCount).toBe(1)
  })
})
