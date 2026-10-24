/// <reference types="node" />
// The worker tsconfig project lists only @cloudflare/workers-types, and `node:sqlite` is a Node module
// the platform does not have. It is reached here because a vitest worker is a Node process, and it is
// the only way to prove the organizer against the constraints its answers depend on: the sibling-name
// and tag-name unique indexes, the `json_each` element rule, and the transactional batch D1 runs. The
// double below is the same binding shape `tests/doubles/d1-sqlite.ts` implements — that file cannot be
// imported, since a composite project may not pull in a file outside its own include list.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '@shared/constants'
import { SCHEMA_STATEMENTS } from '../db/schema'
import { SHARE_HUB_SCHEMA_STATEMENTS } from './hub-schema'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import {
  ShareOrganizer,
  availableShareFolderName,
  nextShareFolderPosition,
  resolveShareFolderParent,
  shareFilingWrite,
  shareTagList,
} from './organizer'
import { serializeShareTags } from './store'
import { parseShareAuditChanges } from './audit'

const OWNER = 'owner-account'
const OTHER = 'other-account'

const ROOT_A = newId()
const ROOT_B = newId()
const NESTED = newId()
const TAG_WEEKLY = newId()
const TAG_ARCHIVE = newId()
const TAG_REPORT = newId()
const TAG_MONTHLY_REPORT = newId()
const NOTE_ONE = newId()
const NOTE_TWO = newId()
const FOREIGN_FOLDER = newId()
const FOREIGN_TAG = newId()

interface SqliteStatement {
  all(...args: unknown[]): Record<string, unknown>[]
  run(...args: unknown[]): { changes: number | bigint }
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}

function bindArgs(sql: string, values: unknown[]): unknown[] {
  return /\?\d+/.test(sql)
    ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
    : values
}

/** The verb D1 judges a statement by, so a write through `all()` still answers with `meta`. */
function topLevelVerb(sql: string): string | null {
  let depth = 0
  for (const match of sql.matchAll(/[()]|\b(select|insert|update|delete)\b/gi)) {
    const token = match[0]
    if (token === '(') depth += 1
    else if (token === ')') depth -= 1
    else if (depth === 0) return token.toLowerCase()
  }
  return null
}

/** The four D1 verbs the organizer uses; a batch is one transaction, which is what the detaches rely on. */
function d1Over(sqlite: SqliteDatabase): D1Database {
  const db = {
    prepare(sql: string) {
      let values: unknown[] = []
      const run = () => Number(sqlite.prepare(sql).run(...bindArgs(sql, values)).changes)
      const statement = {
        bind(...bound: unknown[]) {
          values = bound
          return statement
        },
        async all() {
          if (topLevelVerb(sql) === 'select') {
            return { results: sqlite.prepare(sql).all(...bindArgs(sql, values)) }
          }
          if (/\breturning\b/i.test(sql)) {
            const rows = sqlite.prepare(sql).all(...bindArgs(sql, values))
            return { results: rows, meta: { changes: rows.length } }
          }
          const changes = run()
          return { results: [], meta: { changes } }
        },
        async first() {
          const result = await statement.all()
          return (result.results as Record<string, unknown>[])[0] ?? null
        },
        async run() {
          return { meta: { changes: run() } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ all(): Promise<{ results: unknown[]; meta?: { changes: number } }> }>) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.all())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  return db as unknown as D1Database
}

interface SeedFolder {
  id: string
  userId?: string
  parentId?: string | null
  name: string
  position?: number
}

interface SeedTag {
  id: string
  userId?: string
  name: string
}

interface SeedNote {
  id: string
  userId?: string
}

interface SeedShare {
  noteId: string
  userId?: string
  slug?: string
  folderId?: string | null
  tags?: string[]
  isEnabled?: number
}

/** One database with everything the organizer touches: its six tables, plus the rows it files and joins. */
function seed(input: {
  folders?: SeedFolder[]
  tags?: SeedTag[]
  notes?: SeedNote[]
  shares?: SeedShare[]
}): D1Database {
  const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDatabase
  for (const statement of SHARE_HUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  for (const statement of SCHEMA_STATEMENTS) {
    // The two tables the organizer writes through, plus the passcode sessions a revoke has to clear.
    if (/CREATE TABLE IF NOT EXISTS (notes|shares|share_asset_sessions) \(/.test(statement)) sqlite.exec(statement)
  }
  const db = d1Over(sqlite)
  for (const folder of input.folders ?? []) {
    db.prepare(
      `INSERT INTO share_folders (id, user_id, parent_id, name, icon, color, position, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, 1000, 1000)`,
    )
      .bind(folder.id, folder.userId ?? OWNER, folder.parentId ?? null, folder.name, folder.position ?? 1000)
      .run()
  }
  for (const tag of input.tags ?? []) {
    db.prepare(`INSERT INTO share_tags (id, user_id, name, color, is_pinned, created_at) VALUES (?1, ?2, ?3, NULL, 0, 1000)`)
      .bind(tag.id, tag.userId ?? OWNER, tag.name)
      .run()
  }
  for (const note of input.notes ?? []) {
    db.prepare(
      `INSERT INTO notes (id, user_id, title, content, excerpt, created_at, updated_at)
       VALUES (?1, ?2, 'A note', 'body', 'excerpt', 1000, 1000)`,
    )
      .bind(note.id, note.userId ?? OWNER)
      .run()
  }
  for (const share of input.shares ?? []) {
    db.prepare(
      `INSERT INTO shares (slug, note_id, user_id, folder_id, tags, password_hash, expires_at, views, is_enabled, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 0, ?6, 1000)`,
    )
      .bind(
        share.slug ?? `slug-${share.noteId}`,
        share.noteId,
        share.userId ?? OWNER,
        share.folderId ?? null,
        serializeShareTags(share.tags ?? []),
        share.isEnabled ?? 1,
      )
      .run()
  }
  return db
}

async function firstRow<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...binds).first<T>()
}

async function allRows(db: D1Database, table: string): Promise<Array<Record<string, unknown>>> {
  const { results } = await db.prepare(`SELECT * FROM ${table}`).all()
  return (results ?? []) as unknown as Array<Record<string, unknown>>
}

/** Whether naming `parentId` as a parent would cross the depth ceiling the notebook allows. */
function depthViolation(
  rows: Array<{ id: string; parent_id: string | null; position: number; created_at: number }>,
  parentId: string,
): boolean {
  try {
    resolveShareFolderParent(rows, parentId)
    return false
  } catch (error) {
    return error instanceof ApiError
  }
}

describe('share folder rules', () => {
  it('keeps sibling names unique and the tree inside the shared depth limit', async () => {
    const db = seed({ folders: [{ id: ROOT_A, name: 'Published' }, { id: ROOT_B, name: 'Archive' }] })
    const organizer = new ShareOrganizer(db, OWNER)
    const created = await organizer.createFolder({ name: ' Quarterly ' })
    expect(created.name).toBe('Quarterly')
    expect(created.parent_id).toBeNull()

    const duplicate = await organizer.createFolder({ name: 'quarterly' }).catch((error: unknown) => error)
    expect((duplicate as ApiError).status).toBe(409)

    const child = await organizer.createFolder({ name: 'Deep', parentId: created.id })
    expect(child.parent_id).toBe(created.id)
    // A folder cannot be moved into its own descendant: the walk up from the requested parent reaches it.
    await expect(organizer.patchFolder(created.id, { parentId: child.id })).rejects.toBeInstanceOf(ApiError)

    let parent: string | null = null
    const rows = []
    for (let level = 0; level < LIMITS.folderDepthMax; level += 1) {
      const folder = await organizer.createFolder({ name: `Level ${level}`, parentId: parent })
      rows.push({ id: folder.id, parent_id: parent, position: folder.position, created_at: folder.created_at })
      parent = folder.id
    }
    expect(depthViolation(rows, parent!)).toBe(true)
  })

  it('files a new folder after its siblings and names an unnamed one uniquely', async () => {
    const db = seed({ folders: [{ id: ROOT_A, name: 'Published' }, { id: ROOT_B, name: 'Archive' }] })
    const organizer = new ShareOrganizer(db, OWNER)
    const first = await organizer.createFolder({ parentId: ROOT_A })
    expect(first.name).toBe('New folder')
    const second = await organizer.createFolder({ parentId: ROOT_A })
    expect(second.name).toBe('New folder 2')
    expect(second.position).toBeGreaterThan(first.position)

    const folders = await organizer.listFolders()
    expect(nextShareFolderPosition(folders, ROOT_A)).toBe(second.position + 1000)
    expect(availableShareFolderName(folders, ROOT_A)).toBe('New folder 3')
  })

  it('answers a foreign folder id as nothing at all, never as somebody else row', async () => {
    const db = seed({ folders: [{ id: FOREIGN_FOLDER, userId: OTHER, name: 'Theirs' }] })
    const organizer = new ShareOrganizer(db, OWNER)
    expect(await organizer.patchFolder(FOREIGN_FOLDER, { name: 'Hijacked' })).toBeNull()
    expect(await organizer.deleteFolder(FOREIGN_FOLDER)).toBe(false)
    expect(await organizer.listFolders()).toEqual([])
    // The record is still there, untouched: a foreign write matched nothing at all.
    const kept = await firstRow<{ name: string }>(db, `SELECT name FROM share_folders WHERE id = ?1`, FOREIGN_FOLDER)
    expect(kept?.name).toBe('Theirs')
  })

  it('refuses a foreign folder as a filing target with the same 404 it gives a missing one', async () => {
    const db = seed({
      folders: [{ id: FOREIGN_FOLDER, userId: OTHER, name: 'Theirs' }],
      notes: [{ id: NOTE_ONE }],
      shares: [{ noteId: NOTE_ONE }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    const error = await organizer.organizeNote(NOTE_ONE, { folderId: FOREIGN_FOLDER }).catch((caught: unknown) => caught)
    expect((error as ApiError).status).toBe(404)
    const kept = await firstRow<{ folder_id: string | null }>(db, `SELECT folder_id FROM shares WHERE note_id = ?1`, NOTE_ONE)
    expect(kept?.folder_id).toBeNull()
  })

  it('detaches nested folders upward and unfiles the links a deleted folder held', async () => {
    const db = seed({
      folders: [
        { id: ROOT_A, name: 'Published' },
        { id: ROOT_B, name: 'Archive' },
        { id: NESTED, parentId: ROOT_A, name: 'Nested' },
      ],
      notes: [{ id: NOTE_ONE }],
      shares: [{ noteId: NOTE_ONE, folderId: ROOT_A }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    expect(await organizer.deleteFolder(ROOT_A)).toBe(true)

    // The child moved to the deleted folder's own parent, and the link stopped naming a folder that is gone.
    const nested = await firstRow<{ parent_id: string | null }>(db, `SELECT parent_id FROM share_folders WHERE id = ?1`, NESTED)
    expect(nested?.parent_id).toBeNull()
    const share = await firstRow<{ folder_id: string | null }>(db, `SELECT folder_id FROM shares WHERE note_id = ?1`, NOTE_ONE)
    expect(share?.folder_id).toBeNull()
    expect(await firstRow<{ id: string }>(db, `SELECT id FROM share_folders WHERE id = ?1`, ROOT_A)).toBeNull()
  })

  it('refuses to create a folder over the account ceiling', async () => {
    const folders = Array.from({ length: LIMITS.shareFoldersMaxPerUser }, (_, index) => ({
      id: newId(),
      name: `Folder ${index}`,
    }))
    const organizer = new ShareOrganizer(seed({ folders }), OWNER)
    const error = await organizer.createFolder({ name: 'One too many' }).catch((caught: unknown) => caught)
    expect((error as ApiError).status).toBe(400)
  })
})

describe('share tag rules', () => {
  it('takes a deleted tag out of every link that carried it', async () => {
    const db = seed({
      tags: [{ id: TAG_WEEKLY, name: 'weekly' }, { id: TAG_ARCHIVE, name: 'archive' }],
      notes: [{ id: NOTE_ONE }, { id: NOTE_TWO }],
      shares: [
        { noteId: NOTE_ONE, tags: ['weekly', 'archive'] },
        { noteId: NOTE_TWO, tags: ['archive'] },
      ],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    const deleted = await organizer.deleteTag(TAG_WEEKLY)
    expect(deleted.removed).toBe(true)
    expect(deleted.rewritten).toBe(1)

    const first = await firstRow<{ tags: string }>(db, `SELECT tags FROM shares WHERE note_id = ?1`, NOTE_ONE)
    expect(JSON.parse(first!.tags)).toEqual(['archive'])
    const second = await firstRow<{ tags: string }>(db, `SELECT tags FROM shares WHERE note_id = ?1`, NOTE_TWO)
    expect(JSON.parse(second!.tags)).toEqual(['archive'])
  })

  it('carries a rename across the links, and never onto a substring of another name', async () => {
    const db = seed({
      tags: [{ id: TAG_REPORT, name: 'report' }, { id: TAG_MONTHLY_REPORT, name: 'monthly-report' }],
      notes: [{ id: NOTE_ONE }],
      shares: [{ noteId: NOTE_ONE, tags: ['report', 'monthly-report'] }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    const renamed = await organizer.patchTag(TAG_REPORT, { name: 'quarterly' })
    expect(renamed.row?.name).toBe('quarterly')
    expect(renamed.rewritten).toBe(1)

    const stored = await firstRow<{ tags: string }>(db, `SELECT tags FROM shares WHERE note_id = ?1`, NOTE_ONE)
    expect(JSON.parse(stored!.tags)).toEqual(['quarterly', 'monthly-report'])
  })

  it('refuses a rename that would collide with another tag, and leaves the links as they were', async () => {
    const db = seed({
      tags: [{ id: TAG_WEEKLY, name: 'weekly' }, { id: TAG_ARCHIVE, name: 'archive' }],
      notes: [{ id: NOTE_ONE }],
      shares: [{ noteId: NOTE_ONE, tags: ['weekly'] }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    const error = await organizer.patchTag(TAG_WEEKLY, { name: 'archive' }).catch((caught: unknown) => caught)
    expect((error as ApiError).status).toBe(409)
    const kept = await firstRow<{ name: string }>(db, `SELECT name FROM share_tags WHERE id = ?1`, TAG_WEEKLY)
    expect(kept?.name).toBe('weekly')
    const share = await firstRow<{ tags: string }>(db, `SELECT tags FROM shares WHERE note_id = ?1`, NOTE_ONE)
    expect(JSON.parse(share!.tags)).toEqual(['weekly'])
  })

  it('rejects a name that is not usable, and a foreign tag id answers as nothing', async () => {
    const db = seed({ tags: [{ id: FOREIGN_TAG, userId: OTHER, name: 'theirs' }] })
    const organizer = new ShareOrganizer(db, OWNER)
    expect(await organizer.patchTag(FOREIGN_TAG, { name: 'mine' })).toEqual({ row: null, rewritten: 0 })
    expect(await organizer.deleteTag(FOREIGN_TAG)).toEqual({ removed: false, rewritten: 0 })
    await expect(organizer.createTag('two words', null)).rejects.toBeInstanceOf(ApiError)
    await expect(organizer.createTag('a'.repeat(LIMITS.tagNameMaxLength + 1), null)).rejects.toBeInstanceOf(ApiError)
  })
})

describe('filing a link', () => {
  function filed(): D1Database {
    return seed({
      folders: [{ id: ROOT_A, name: 'Published' }, { id: ROOT_B, name: 'Archive' }],
      tags: [{ id: TAG_WEEKLY, name: 'weekly' }],
      notes: [{ id: NOTE_ONE }, { id: NOTE_TWO }],
      shares: [{ noteId: NOTE_ONE }, { noteId: NOTE_TWO }],
    })
  }

  it('stores the folder id and the resolved tag names, and refuses a name the account has no record of', async () => {
    const db = filed()
    const organizer = new ShareOrganizer(db, OWNER)
    const filing = await organizer.organizeNote(NOTE_ONE, { folderId: ROOT_A, tags: ['weekly'] })
    expect(filing).toEqual({ noteId: NOTE_ONE, slug: `slug-${NOTE_ONE}`, folderId: ROOT_A, tags: ['weekly'] })

    const stored = await firstRow<{ folder_id: string; tags: string }>(db, `SELECT folder_id, tags FROM shares WHERE note_id = ?1`, NOTE_ONE)
    expect(stored?.folder_id).toBe(ROOT_A)
    expect(JSON.parse(stored!.tags)).toEqual(['weekly'])

    const unknown = await organizer.organizeNote(NOTE_ONE, { tags: ['nope'] }).catch((caught: unknown) => caught)
    expect((unknown as ApiError).status).toBe(400)
    expect((unknown as ApiError).message).toContain('nope')

    const missingFolder = await organizer.organizeNote(NOTE_ONE, { folderId: newId() }).catch((caught: unknown) => caught)
    expect((missingFolder as ApiError).status).toBe(404)
  })

  it('leaves the column a write did not name alone', async () => {
    const db = seed({
      folders: [{ id: ROOT_A, name: 'Published' }, { id: ROOT_B, name: 'Archive' }],
      tags: [{ id: TAG_WEEKLY, name: 'weekly' }],
      notes: [{ id: NOTE_ONE }],
      shares: [{ noteId: NOTE_ONE, folderId: ROOT_A, tags: ['weekly'] }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    const clearedTags = await organizer.organizeNote(NOTE_ONE, { tags: [] })
    expect(clearedTags?.folderId).toBe(ROOT_A)
    expect(clearedTags?.tags).toEqual([])

    const movedFolder = await organizer.organizeNote(NOTE_ONE, { folderId: ROOT_B })
    expect(movedFolder?.tags).toEqual([])

    const nothing = await organizer.organizeNote(NOTE_ONE, {}).catch((caught: unknown) => caught)
    expect((nothing as ApiError).status).toBe(400)
  })

  it('answers a note with no link as not found, and never as another account link', async () => {
    const otherNote = newId()
    const db = seed({
      notes: [{ id: otherNote, userId: OTHER }, { id: NOTE_ONE }],
      shares: [{ noteId: otherNote, userId: OTHER }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    expect(await organizer.organizeNote(otherNote, { folderId: null })).toBeNull()
    // A note of this account that has no link is the same answer, so the endpoint cannot probe it.
    expect(await organizer.organizeNote(NOTE_ONE, { folderId: null })).toBeNull()
  })

  it('applies a filing to a selection and counts only the links that were named', async () => {
    const db = filed()
    const organizer = new ShareOrganizer(db, OWNER)
    const applied = await organizer.batchOrganize([NOTE_ONE, NOTE_TWO, newId()], { folderId: ROOT_B, tags: ['weekly'] })
    expect(applied).toBe(2)
    const rows = await allRows(db, 'shares')
    expect(rows.map((row) => row.folder_id).sort()).toEqual([ROOT_B, ROOT_B])
  })

  it('pauses and resumes a selection through is_enabled only', async () => {
    const db = seed({
      notes: [{ id: NOTE_ONE }, { id: NOTE_TWO }],
      shares: [{ noteId: NOTE_ONE }, { noteId: NOTE_TWO, isEnabled: 0 }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    // The count is the links the write touched, so a selection with one already-paused link still
    // answers for both rows the statement matched.
    expect(await organizer.batchEnabled([NOTE_ONE, NOTE_TWO], false)).toBe(2)
    expect(await organizer.batchEnabled([NOTE_ONE, NOTE_TWO], true)).toBe(2)
    const rows = await allRows(db, 'shares')
    expect(rows.map((row) => row.is_enabled).sort()).toEqual([1, 1])
  })

  it('revokes the links and leaves a history naming each one', async () => {
    const db = seed({
      notes: [{ id: NOTE_ONE }],
      shares: [{ noteId: NOTE_ONE, tags: ['weekly'] }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    expect(await organizer.batchRevoke([NOTE_ONE])).toBe(1)
    expect(await allRows(db, 'shares')).toEqual([])
    const log = await allRows(db, 'share_audit_log')
    expect(log).toHaveLength(1)
    expect(log[0]?.action).toBe('revoke')
  })

  it('writes one history entry per link a filing moved, and none for a filing that moved nothing', async () => {
    const db = seed({
      folders: [{ id: ROOT_A, name: 'Published' }, { id: ROOT_B, name: 'Archive' }],
      notes: [{ id: NOTE_ONE }, { id: NOTE_TWO }],
      shares: [{ noteId: NOTE_ONE, folderId: ROOT_A }, { noteId: NOTE_TWO, folderId: ROOT_A }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    await organizer.batchOrganize([NOTE_ONE, NOTE_TWO], { folderId: ROOT_B })
    await organizer.batchOrganize([NOTE_ONE, NOTE_TWO], { folderId: ROOT_B })

    const rows = await allRows(db, 'share_audit_log')
    expect(rows).toHaveLength(2)
    const changed = JSON.parse(String(rows[0]?.changed_json)) as Array<{ field: string; from: string; to: string }>
    expect(changed).toEqual([{ field: 'folder_id', from: ROOT_A, to: ROOT_B }])
    expect(parseShareAuditChanges('{}')).toEqual([])
  })

  it('records only that a passcode exists, never the hash or the secret', async () => {
    const db = seed({
      notes: [{ id: NOTE_ONE }],
      shares: [{ noteId: NOTE_ONE }],
    })
    const organizer = new ShareOrganizer(db, OWNER)
    await organizer.batchEnabled([NOTE_ONE], false)
    await organizer.batchEnabled([NOTE_ONE], true)
    const text = JSON.stringify(await allRows(db, 'share_audit_log'))
    expect(text).not.toContain('scrypt')
    expect(text).not.toContain('password')
  })
})

describe('organizer input parsing', () => {
  it('reads the two filing fields with absent and null kept apart', () => {
    expect(shareFilingWrite({})).toEqual({})
    expect(shareFilingWrite({ folderId: null })).toEqual({ folderId: null })
    expect(shareFilingWrite({ folderId: '  ' })).toEqual({ folderId: null })
    expect(shareFilingWrite({ tags: [] })).toEqual({ tags: [] })
    expect(() => shareFilingWrite({ folderId: 7 })).toThrow(ApiError)
  })

  it('bounds the tag list by what arrived, not by what survived the dedupe', () => {
    const atMost = Array.from({ length: LIMITS.shareTagsMaxPerShare }, (_, index) => `tag${index}`)
    expect(shareTagList(atMost)).toHaveLength(LIMITS.shareTagsMaxPerShare)
    expect(() => shareTagList([...atMost, 'one-too-many'])).toThrow(ApiError)
    expect(shareTagList(['alpha', '#alpha', ' alpha '])).toEqual(['alpha'])
  })
})
