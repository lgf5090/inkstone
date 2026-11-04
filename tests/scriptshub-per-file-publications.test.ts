// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'
import { SCRIPTSHUB_SCHEMA_STATEMENTS } from '../src/worker/scriptshub/schema'
import { ScriptsHubStore } from '../src/worker/scriptshub/store'
import { makeD1 } from './doubles/d1-sqlite'

const ME = 'user-a'

let sqlite: DatabaseSync
let store: ScriptsHubStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCRIPTSHUB_SCHEMA_STATEMENTS.join(';'))
  store = new ScriptsHubStore(makeD1(sqlite), ME)
})

async function makeTwoFiles() {
  const created = await store.createSnippet({ title: 'Two files', language: 'shell' })
  const first = created.files[0]!
  const saved = await store.saveSnippet(created.id, {
    title: created.title,
    description: '',
    folderId: null,
    language: 'shell',
    sourceUrl: '',
    notes: '',
    tags: [],
    files: [
      { id: first.id, name: 'main.sh', language: 'shell', content: 'echo main\n' },
      { name: 'helper.sh', language: 'shell', content: 'echo helper\n' },
    ],
  })
  return saved
}

describe('every file owns its own publication', () => {
  it('publishes two files of one snippet at two unrelated paths', async () => {
    const detail = await makeTwoFiles()
    const [main, helper] = detail.files
    const a = await store.createPublication(detail.id, { fileId: main!.id, path: 'system/main.sh', visibility: 'public' })
    const b = await store.createPublication(detail.id, { fileId: helper!.id, path: 'tools/helper.sh', visibility: 'public' })
    expect(a.path).toBe('system/main.sh')
    expect(b.path).toBe('tools/helper.sh')
    const reread = await store.getSnippet(detail.id)
    expect(reread.publications.map((entry) => entry.path).sort()).toEqual(['system/main.sh', 'tools/helper.sh'])
    expect(reread.publications.every((entry) => entry.fileId === main!.id || entry.fileId === helper!.id)).toBe(true)
  })

  it('refuses a second publication for the same file and a path another file already owns', async () => {
    const detail = await makeTwoFiles()
    const [main, helper] = detail.files
    await store.createPublication(detail.id, { fileId: main!.id, path: 'system/main.sh', visibility: 'public' })
    await expect(store.createPublication(detail.id, { fileId: main!.id, path: 'system/main-two.sh', visibility: 'public' }))
      .rejects.toThrow(/already has a distribution/i)
    await expect(store.createPublication(detail.id, { fileId: helper!.id, path: 'system/main.sh', visibility: 'public' }))
      .rejects.toThrow(/already in use/i)
  })

  it('keeps a rename attached and removes the address only when the file is deleted', async () => {
    const detail = await makeTwoFiles()
    const [main, helper] = detail.files
    await store.createPublication(detail.id, { fileId: main!.id, path: 'system/main.sh', visibility: 'public' })
    await store.createPublication(detail.id, { fileId: helper!.id, path: 'tools/helper.sh', visibility: 'public' })

    const renamed = await store.saveSnippet(detail.id, {
      title: detail.title,
      description: '',
      folderId: null,
      language: 'shell',
      sourceUrl: '',
      notes: '',
      tags: [],
      files: [
        { id: main!.id, name: 'renamed-main.sh', language: 'shell', content: 'echo main\n' },
        { id: helper!.id, name: 'helper.sh', language: 'shell', content: 'echo helper\n' },
      ],
    })
    expect(renamed.publications.map((entry) => entry.path).sort()).toEqual(['system/main.sh', 'tools/helper.sh'])

    const dropped = await store.saveSnippet(detail.id, {
      title: detail.title,
      description: '',
      folderId: null,
      language: 'shell',
      sourceUrl: '',
      notes: '',
      tags: [],
      files: [{ id: helper!.id, name: 'helper.sh', language: 'shell', content: 'echo helper\n' }],
    })
    expect(dropped.publications.map((entry) => entry.path)).toEqual(['tools/helper.sh'])
  })
})

describe('migration 267 repairs the old single-file shape', () => {
  function oldDatabase() {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE scriptshub_snippets (user_id TEXT, id TEXT, title TEXT);
      CREATE TABLE scriptshub_files (user_id TEXT, id TEXT, snippet_id TEXT, name TEXT, position INTEGER, created_at INTEGER);
      CREATE TABLE scriptshub_publications (
        user_id TEXT NOT NULL, id TEXT NOT NULL, snippet_id TEXT NOT NULL, file_id TEXT NOT NULL,
        path TEXT NOT NULL, is_enabled INTEGER NOT NULL DEFAULT 1, visibility TEXT NOT NULL DEFAULT 'public',
        token_hash TEXT, expires_at INTEGER, short_slug TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_served_at INTEGER, PRIMARY KEY (user_id, id)
      )
    `)
    return db
  }

  const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 267)!

  it('re-points a vanished file at the first file, keeps the valid row and is safe to run twice', () => {
    const db = oldDatabase()
    db.prepare("INSERT INTO scriptshub_snippets VALUES ('u', 's', 'Script')").run()
    db.prepare("INSERT INTO scriptshub_files VALUES ('u', 'f1', 's', 'main.sh', 0, 1)").run()
    db.prepare("INSERT INTO scriptshub_files VALUES ('u', 'f2', 's', 'helper.sh', 1, 1)").run()
    db.prepare(`INSERT INTO scriptshub_publications (user_id, id, snippet_id, file_id, path, created_at, updated_at)
                VALUES ('u', 'p1', 's', 'gone-id', 'old/path.sh', 1, 1)`).run()
    db.prepare(`INSERT INTO scriptshub_publications (user_id, id, snippet_id, file_id, path, created_at, updated_at)
                VALUES ('u', 'p2', 's', 'f2', 'tools/helper.sh', 2, 2)`).run()
    for (const statement of migration.statements) db.exec(statement)
    for (const statement of migration.statements) db.exec(statement)

    const rows = db.prepare('SELECT id, file_id, path FROM scriptshub_publications ORDER BY id').all() as Array<{ id: string; file_id: string; path: string }>
    expect(rows).toEqual([
      { id: 'p1', file_id: 'f1', path: 'old/path.sh' },
      { id: 'p2', file_id: 'f2', path: 'tools/helper.sh' },
    ])
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_scriptshub_publications_file'").get() as { name: string } | undefined
    expect(index?.name).toBe('idx_scriptshub_publications_file')
    expect(() => db.prepare(`INSERT INTO scriptshub_publications (user_id, id, snippet_id, file_id, path, created_at, updated_at)
                             VALUES ('u', 'p3', 's', 'f2', 'third.sh', 3, 3)`).run()).toThrow()
  })
})
