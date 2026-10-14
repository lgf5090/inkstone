// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { transferRoutes } from '../src/worker/routes/transfer'
import { TransferStore } from '../src/worker/transfer/store'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * The import half of the transfer route, against a real database.
 *
 * Nothing else in the suite drives `/import`: the export lease test covers the streaming side, and
 * no other file posts a form at it. These tests exist to pin two things the route -> store move must
 * not disturb — that a restore only ever reads and writes the asking account's rows, and that the
 * answer a client gets (created, updated, skipped, warnings) is decided by the same rules as before.
 * The claims are about behaviour, not about which file the SQL sits in.
 */

const ALICE = 'user-alice'
const BOB = 'user-bob'
/**
 * An export carries note ids the account already used, and the route only tracks a note as "already
 * here" when the id is one it recognises, so the fixtures use a real 26-character id rather than a
 * readable label.
 */
const NOTE_ID = '0123456789abcdefghjkmnpqrs'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

vi.mock('../src/worker/lib/lease', () => ({
  acquireLease: vi.fn(async () => Object.assign(async () => {}, { renew: async () => true })),
}))

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('*', async (c, next) => {
  c.set('database', { ftsEnabled: false })
  await next()
})
app.route('/transfer', transferRoutes)

let sqlite: DatabaseSync
let db: D1Database

function env() {
  return { DB: db } as unknown as AppBindings['Bindings']
}

function waitUntilCollector() {
  const tasks: Promise<unknown>[] = []
  return {
    ctx: {
      waitUntil: (task: Promise<unknown>) => { tasks.push(task) },
      passThroughOnException: () => {},
    },
    tasks,
  }
}

async function importForm(userId: string, form: FormData) {
  mocks.userId = userId
  const { ctx, tasks } = waitUntilCollector()
  const response = await app.request('/transfer/import', { method: 'POST', body: form as BodyInit }, env(), ctx)
  await Promise.all(tasks)
  return response
}

interface ImportBody {
  createdNotes: number
  updatedNotes: number
  skippedNotes: number
  createdFolders: number
  createdAttachments: number
  skippedAttachments: number
  warnings: string[]
}

async function importResult(userId: string, form: FormData): Promise<ImportBody> {
  const response = await importForm(userId, form)
  expect(response.status).toBe(200)
  return await response.json() as ImportBody
}

function markdownForm(path: string, text: string, conflict?: string) {
  const form = new FormData()
  if (conflict) form.append('conflict', conflict)
  form.append('file', new File([text], path, { type: 'text/markdown' }))
  return form
}

function bundleForm(notes: readonly Record<string, unknown>[], conflict?: string) {
  const bundle = {
    format: 'inkstone-export',
    version: 1,
    notes,
    folders: [],
    tags: [],
    attachments: [],
  }
  const form = new FormData()
  if (conflict) form.append('conflict', conflict)
  form.append('file', new File([JSON.stringify(bundle)], 'inkstone-export.json', { type: 'application/json' }))
  return form
}

function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return sqlite.prepare(sql).all(...(params as never[])) as T[]
}

function one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return sqlite.prepare(sql).get(...(params as never[])) as T | undefined
}

function insertNote(id: string, userId: string, title: string, rev: number, updatedAt: number) {
  sqlite.prepare(
    'INSERT INTO notes (id, user_id, title, content, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, userId, title, 'body', rev, 1000, updatedAt)
}

function insertFolder(id: string, userId: string, parentId: string | null, name: string) {
  sqlite.prepare(
    'INSERT INTO folders (id, user_id, parent_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, userId, parentId, name, 1000, 1000, 1000)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  mocks.userId = ALICE
})

describe('the import route', () => {
  it('restores a markdown file into the folder path it arrived under', async () => {
    const result = await importResult(ALICE, markdownForm('Notes/Work/Ideas.md', '# Idea\n\nA body with words.\n'))

    expect(result.createdNotes).toBe(1)
    expect(result.warnings).toEqual([])
    const note = one<{ title: string; content: string; folder_id: string | null; user_id: string }>(
      'SELECT title, content, folder_id, user_id FROM notes',
    )
    expect(note?.user_id).toBe(ALICE)
    expect(note?.title).toBe('Idea')
    // A leading "notes" directory is the export's own container, not a folder the user made, so only
    // the rest of the path becomes a tree — one folder, with its own change record beside the note's.
    expect(result.createdFolders).toBe(1)
    expect(rows<{ name: string }>('SELECT name FROM folders WHERE user_id = ?', ALICE).map((r) => r.name))
      .toEqual(['Work'])
    expect(rows<{ entity: string }>(
      'SELECT entity FROM changes WHERE user_id = ? ORDER BY entity', ALICE,
    ).map((r) => r.entity)).toEqual(expect.arrayContaining(['folder', 'note']))
  })

  it('gives a second account its own copy instead of touching the first one\'s note', async () => {
    const note = { id: NOTE_ID, title: 'First', content: 'Alice text', createdAt: 1000, updatedAt: 1000 }
    await importResult(ALICE, bundleForm([note]))
    await importResult(BOB, bundleForm([{ ...note, title: 'Second', content: 'Bob text', updatedAt: 2000 }]))

    const alice = one<{ id: string; title: string; content: string; rev: number }>(
      'SELECT id, title, content, rev FROM notes WHERE user_id = ?', ALICE,
    )
    const bob = one<{ id: string; title: string; content: string; rev: number }>(
      'SELECT id, title, content, rev FROM notes WHERE user_id = ?', BOB,
    )
    expect(alice?.id).toBe(NOTE_ID)
    expect(alice?.title).toBe('First')
    expect(alice?.content).toBe('Alice text')
    expect(alice?.rev).toBe(1)
    expect(bob?.content).toBe('Bob text')
    // The primary key is global, so Bob cannot keep the exported id; he gets a fresh one and a
    // mapping that remembers the id his export used.
    expect(bob?.id).not.toBe(alice?.id)
    expect(one<{ target_id: string }>(
      'SELECT target_id FROM import_mappings WHERE user_id = ? AND entity = ? AND source_id = ?', BOB, 'note', NOTE_ID,
    )?.target_id).toBe(bob?.id)
  })

  it('skips a note the account already owns when the client asks to skip', async () => {
    const note = { id: NOTE_ID, title: 'Original', content: 'Keep me', createdAt: 1000, updatedAt: 1000 }
    await importResult(ALICE, bundleForm([note]))
    const result = await importResult(ALICE, bundleForm(
      [{ ...note, content: 'Overwritten', updatedAt: 9000 }],
      'skip',
    ))

    expect(result).toMatchObject({ createdNotes: 0, updatedNotes: 0, skippedNotes: 1 })
    expect(rows<{ id: string }>('SELECT id FROM notes WHERE user_id = ?', ALICE)).toHaveLength(1)
    expect(one<{ content: string }>('SELECT content FROM notes WHERE user_id = ?', ALICE)?.content).toBe('Keep me')
  })

  it('writes the newer revision and keeps the one it replaced as a version', async () => {
    const note = { id: NOTE_ID, title: 'Original', content: 'Old text', createdAt: 1000, updatedAt: 1000 }
    await importResult(ALICE, bundleForm([note]))
    const result = await importResult(ALICE, bundleForm([{ ...note, content: 'New text', updatedAt: 5000 }]))

    expect(result.updatedNotes).toBe(1)
    const stored = one<{ content: string; rev: number; updated_at: number }>(
      'SELECT content, rev, updated_at FROM notes WHERE user_id = ?', ALICE,
    )
    expect(stored?.content).toBe('New text')
    expect(stored?.rev).toBe(2)
    expect(one<{ title: string; content: string }>('SELECT title, content FROM note_versions WHERE user_id = ?', ALICE))
      .toEqual({ title: 'Original', content: 'Old text' })
  })

  it('refuses a body that is not a form and reports it as a client error', async () => {
    mocks.userId = ALICE
    const response = await app.request(
      '/transfer/import',
      { method: 'POST', body: 'plain text', headers: { 'Content-Type': 'text/plain' } },
      env(),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 'bad_request',
        message: 'The request body must use multipart/form-data',
      },
    })
  })
})

describe('the transfer store', () => {
  function insertAttachment(id: string, userId: string, sha256: string, createdAt: number) {
    sqlite.prepare(
      `INSERT INTO attachments (id, user_id, note_id, filename, mime, size, sha256, storage, created_at)
       VALUES (?, ?, NULL, 'pic.png', 'image/png', 8, ?, 'r2', ?)`,
    ).run(id, userId, sha256, createdAt)
  }

  it('answers a restored-attachment probe only for the asking account', async () => {
    insertAttachment('att-alice', ALICE, 'hash-1', 1000)
    insertAttachment('att-bob', BOB, 'hash-2', 2000)

    const alice = await new TransferStore(db, ALICE, false).restoredAttachment('hash-2')
    expect(alice).toEqual({})

    const own = await new TransferStore(db, ALICE, false).restoredAttachment('hash-1')
    expect(own.byHash?.id).toBe('att-alice')

    const bob = await new TransferStore(db, BOB, false).restoredAttachment('hash-2')
    expect(bob.byHash?.id).toBe('att-bob')
  })

  it('follows a mapping only within the account that wrote it', async () => {
    insertAttachment('att-alice', ALICE, 'hash-1', 1000)
    await new TransferStore(db, ALICE, false).upsertImportMappings('attachment', [
      { sourceId: 'source-1', targetId: 'att-alice' },
    ])

    const targets = await new TransferStore(db, ALICE, false).attachmentTargetsByHash(['source-1', 'source-2'])
    expect([...targets]).toEqual([['source-1', 'att-alice']])
    expect([...await new TransferStore(db, BOB, false).attachmentTargetsByHash(['source-1'])]).toEqual([])
    expect((await new TransferStore(db, BOB, false).restoredAttachment('hash-1')).mapped).toBeUndefined()
  })

  it('reports a foreign attachment by id so the caller can reject it, and nothing else', async () => {
    insertAttachment('att-bob', BOB, 'hash-2', 2000)

    const found = await new TransferStore(db, ALICE, false).attachmentsByIds(['att-bob', 'missing-id'])
    // The probe is deliberately unscoped: a restore must learn that an exported id is taken before it
    // chooses a destination. The row's own user_id is what makes the caller treat it as foreign.
    expect(found.get('att-bob')?.user_id).toBe(BOB)
    expect(found.has('missing-id')).toBe(false)
  })

  it('re-parents this account\'s attachments and leaves another account\'s alone', async () => {
    insertAttachment('att-alice', ALICE, 'hash-1', 1000)
    insertAttachment('att-bob', BOB, 'hash-2', 2000)

    await new TransferStore(db, ALICE, false).setAttachmentNoteLinks([
      { id: 'att-alice', noteId: 'note-1' },
      { id: 'att-bob', noteId: 'note-2' },
    ])

    expect(one<{ note_id: string }>('SELECT note_id FROM attachments WHERE id = ?', 'att-alice')?.note_id).toBe('note-1')
    expect(one<{ note_id: string | null }>('SELECT note_id FROM attachments WHERE id = ?', 'att-bob')?.note_id).toBeNull()
  })

  it('scopes the cleanup queue to the asking account', async () => {
    sqlite.prepare('INSERT INTO attachment_cleanup (object_key, user_id, created_at) VALUES (?, ?, ?)').run(
      `r2:${ALICE}/abcdef0123456789abcdef0123.png`, ALICE, 1000,
    )
    sqlite.prepare('INSERT INTO attachment_cleanup (object_key, user_id, created_at) VALUES (?, ?, ?)').run(
      `r2:${BOB}/abcdef0123456789abcdef0123.png`, BOB, 1000,
    )

    const alice = await new TransferStore(db, ALICE, false).pendingCleanupObjectKeys(['abcdef0123456789abcdef0123'])
    expect(alice).toHaveLength(1)
    expect(alice[0]).toContain(ALICE)
    expect(await new TransferStore(db, BOB, false).pendingCleanupObjectKeys([])).toEqual([])
  })

  it('answers an export id only for the account that owns the note', async () => {
    insertNote(NOTE_ID, ALICE, 'Alice text', 1, 1000)

    const other = new TransferStore(db, BOB, false)
    expect([...await other.noteIndexesBySourceIds([NOTE_ID])]).toEqual([])
    expect(await other.noteIndexBySourceId(NOTE_ID)).toBeNull()

    const own = new TransferStore(db, ALICE, false)
    expect((await own.noteIndexesBySourceIds([NOTE_ID])).get(NOTE_ID)?.title).toBe('Alice text')
    expect((await own.noteIndexBySourceId(NOTE_ID))?.rev).toBe(1)
  })

  it('follows a mapping to the note it names rather than the id an export carried', async () => {
    // The exported id belongs to a live note of this account, and the account's own mapping says the
    // export really restored into a different one. The mapping is what a re-import has to update.
    insertNote(NOTE_ID, ALICE, 'Stranger', 1, 1000)
    insertNote('0123456789abcdefghjkmnpqrt', ALICE, 'Restored copy', 4, 4000)
    await new TransferStore(db, ALICE, false).upsertImportMappings('note', [
      { sourceId: NOTE_ID, targetId: '0123456789abcdefghjkmnpqrt' },
    ])

    const own = new TransferStore(db, ALICE, false)
    expect((await own.noteIndexBySourceId(NOTE_ID))?.title).toBe('Restored copy')
    expect((await own.noteIndexesBySourceIds([NOTE_ID])).get(NOTE_ID)?.title).toBe('Restored copy')
  })

  it('lists only its own folders for the path cache', async () => {
    insertFolder('folder-alice', ALICE, null, 'Work')
    insertFolder('folder-bob', BOB, null, 'Work')

    expect((await new TransferStore(db, ALICE, false).folderPathRows()).map((r) => r.id)).toEqual(['folder-alice'])
    expect((await new TransferStore(db, BOB, false).folderPathRows()).map((r) => r.id)).toEqual(['folder-bob'])
  })

  it('creates a folder segment once and reports the sibling that already owns the name', async () => {
    insertFolder('folder-alice', ALICE, null, 'Work')

    const store = new TransferStore(db, ALICE, false)
    expect(await store.createFolderSegment({
      id: 'folder-new', parentId: null, name: 'Reading', icon: null, color: null,
      position: 2000, createdAt: 2000, updatedAt: 2000,
    })).toBe(true)
    expect(one<{ id: string }>('SELECT id FROM folders WHERE id = ?', 'folder-new')?.id).toBe('folder-new')
    expect(one<{ entity: string }>('SELECT entity FROM changes WHERE entity_id = ?', 'folder-new')?.entity).toBe('folder')

    // The same name under the same parent loses to the unique sibling index rather than raising, and
    // the account then reads back the row that already answers to it.
    expect(await store.createFolderSegment({
      id: 'folder-dup', parentId: null, name: 'Work', icon: null, color: null,
      position: 3000, createdAt: 3000, updatedAt: 3000,
    })).toBe(false)
    expect(await store.existingFolderId(null, 'work')).toBe('folder-alice')
    expect(one<{ id: string }>('SELECT id FROM folders WHERE id = ?', 'folder-dup')).toBeUndefined()
    // No change record for a segment that was never created.
    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM changes WHERE entity_id = ?', 'folder-dup')!.n).toBe(0)

    // Another account cannot name, find or collide with this account's folder.
    const other = new TransferStore(db, BOB, false)
    expect(await other.existingFolderId(null, 'Work')).toBeNull()
    expect(await other.createFolderSegment({
      id: 'folder-bob-work', parentId: null, name: 'Work', icon: null, color: null,
      position: 4000, createdAt: 4000, updatedAt: 4000,
    })).toBe(true)
  })
})
