/// <reference types="node" />
// The worker tsconfig project lists only @cloudflare/workers-types, and `node:sqlite` is a Node module
// the platform does not have. A published collection is gated on two things a mock cannot show: the
// partial unique index that decides what "one live directory per target" means, and the `json_each`
// element rule a tag collection matches its members by. Both are run for real here, through the same D1
// binding shape `tests/doubles/d1-sqlite.ts` implements (that file cannot be imported: a composite
// project may not pull in a file outside its own include list).
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { collectionChannelToken, normalizeChannelToken } from '@shared/share-channel'
import { resolveShareTarget } from '@shared/share-selection'
import type { AppBindings, Env } from '../env'
import { SCHEMA_STATEMENTS } from '../db/schema'
import { errorResponse } from '../lib/errors'
import { newId, newSlug } from '../lib/id'
import { hashPassword } from '../lib/password'
import { SHARE_HUB_SCHEMA_STATEMENTS } from './hub-schema'
import { serializeShareTags } from './store'
import { shareSelectionSql } from './selection-sql'
import {
  MAX_MANUAL_COLLECTION_MEMBERS,
  collectionMemberConditions,
  collectionMemberCountSql,
  collectionMembersSql,
  collectionScope,
  collectionTargetRecord,
  collectionTargetType,
  decodeCollectionCursor,
  manualCollectionCountSql,
  manualCollectionMembersSql,
  manualTargetValue,
  nextCollectionCursor,
  toShareCollection,
  type CollectionMemberRow,
  type ShareCollectionRow,
} from './collections'
import { publicCollectionRoutes, shareCollectionRoutes } from '../routes/share-collections'

const OWNER = 'owner-account'
const OTHER = 'other-account'
const NOW = 1_760_000_000_000

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

/** The verb D1 judges a statement by, so a write or a RETURNING through `all()` still answers correctly. */
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
            return { results: sqlite.prepare(sql).all(...bindArgs(sql, values)), meta: { changes: 0 } }
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

/** The tables a directory reads and a passcode gate writes, plus the hub's own six. */
function makeDb(): SqliteDatabase {
  const sqlite = new DatabaseSync(':memory:') as unknown as SqliteDatabase
  for (const statement of SHARE_HUB_SCHEMA_STATEMENTS) sqlite.exec(statement)
  for (const statement of SCHEMA_STATEMENTS) {
    if (/CREATE TABLE IF NOT EXISTS (notes|shares|share_asset_sessions|login_attempts) \(/.test(statement)) {
      sqlite.exec(statement)
    }
  }
  return sqlite
}

interface Seed {
  folders?: Array<{ id: string; name: string; userId?: string }>
  tags?: Array<{ id: string; name: string; userId?: string }>
  links?: Array<{
    noteId: string
    userId?: string
    slug?: string
    folderId?: string | null
    tags?: string[]
    title?: string
    excerpt?: string
    content?: string
    isEnabled?: number
    expiresAt?: number | null
    deletedAt?: number | null
    passwordHash?: string | null
    updatedAt?: number
  }>
  collections?: Array<{
    id: string
    slug: string
    userId?: string
    targetType: string
    targetValue: string
    title?: string | null
    passwordHash?: string | null
    expiresAt?: number | null
    isEnabled?: number
    memberSort?: string | null
  }>
  members?: Array<{ collectionId: string; noteId: string; sortOrder: number }>
}

function seed(input: Seed): D1Database {
  const sqlite = makeDb()
  const db = d1Over(sqlite)
  for (const folder of input.folders ?? []) {
    db.prepare(
      `INSERT INTO share_folders (id, user_id, parent_id, name, icon, color, position, created_at, updated_at)
       VALUES (?1, ?2, NULL, ?3, NULL, NULL, 1000, 1000, 1000)`,
    )
      .bind(folder.id, folder.userId ?? OWNER, folder.name)
      .run()
  }
  for (const tag of input.tags ?? []) {
    db.prepare(`INSERT INTO share_tags (id, user_id, name, color, is_pinned, created_at) VALUES (?1, ?2, ?3, NULL, 0, 1000)`)
      .bind(tag.id, tag.userId ?? OWNER, tag.name)
      .run()
  }
  for (const link of input.links ?? []) {
    const userId = link.userId ?? OWNER
    db.prepare(
      `INSERT INTO notes (id, user_id, title, content, excerpt, is_pinned, created_at, updated_at, deleted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, 1000, ?6, ?7)`,
    )
      .bind(link.noteId, userId, link.title ?? 'A note', link.content ?? 'private body text', link.excerpt ?? 'a short excerpt', link.updatedAt ?? 1000, link.deletedAt ?? null)
      .run()
    db.prepare(
      `INSERT INTO shares (slug, note_id, user_id, folder_id, tags, password_hash, expires_at, views, is_enabled, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, 1000)`,
    )
      .bind(
        link.slug ?? `slug-${link.noteId}`,
        link.noteId,
        userId,
        link.folderId ?? null,
        serializeShareTags(link.tags ?? []),
        link.passwordHash ?? null,
        link.expiresAt ?? null,
        link.isEnabled ?? 1,
      )
      .run()
  }
  for (const collection of input.collections ?? []) {
    db.prepare(
      `INSERT INTO share_collections
         (id, slug, user_id, target_type, target_value, password_hash, expires_at, is_enabled, member_sort, title, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1000, 1000)`,
    )
      .bind(
        collection.id,
        collection.slug,
        collection.userId ?? OWNER,
        collection.targetType,
        collection.targetValue,
        collection.passwordHash ?? null,
        collection.expiresAt ?? null,
        collection.isEnabled ?? 1,
        collection.memberSort ?? null,
        collection.title ?? null,
      )
      .run()
  }
  for (const member of input.members ?? []) {
    db.prepare(`INSERT INTO share_collection_members (collection_id, note_id, sort_order) VALUES (?1, ?2, ?3)`)
      .bind(member.collectionId, member.noteId, member.sortOrder)
      .run()
  }
  return db
}

/** The hub's owner routes, with the account the mount would have authenticated. */
function ownerApp(userId: string): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  // `onError` hands its handler `(err, c)`, so the adapter is the one the mounted app uses: the same
  // call `app.ts` makes, and the reason a refused request answers with its own status rather than a 500.
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    await next()
  })
  app.route('/api/share', shareCollectionRoutes)
  return app
}

function publicApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.route('/api/public', publicCollectionRoutes)
  return app
}

/**
 * The bindings a directory read touches: the database, and nothing else. Cast for the same reason the
 * organizer's suite builds its minimal object — `Env` names bindings (assets, KV) this route never
 * reaches, and a fake one of each would be a fixture with nothing in it.
 */
function env(db: D1Database): Env {
  return { DB: db } as Env
}

async function jsonAt<T>(app: Hono<AppBindings>, db: D1Database, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await app.request(`http://inkstone.test${path}`, init, env(db))
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T }
}

const FOLDER_ID = newId()
const FOLDER_OTHER_ID = newId()
const FOLDER_THIRD_ID = newId()
const TAG_ID = newId()
const TAG_NAME = 'weekly'
const NOTE_A = newId()
const NOTE_B = newId()
const NOTE_TRASHED = newId()
const COLLECTION_ID = newId()
const COLLECTION_OTHER_ID = newId()
const COLLECTION_THIRD_ID = newId()
const COLLECTION_SLUG = newSlug()
/** Member links addressed by a slug of the shape the share routes mint, so a page reads like a real one. */
const MEMBER_SLUG_A = newSlug()
const MEMBER_SLUG_B = newSlug()
const MEMBER_SLUG_C = newSlug()

describe('what a collection covers', () => {
  it('matches a tag collection by the tag name, never by the id the record is addressed by', () => {
    // The reference bug: `target_value` is the record id and `shares.tags` is an array of names, so a
    // collection whose tag id and name differ matched nothing and the page was empty under a sidebar
    // count that said it was full.
    const scope = collectionScope({ target_type: 'tag', target_value: TAG_ID }, TAG_NAME)
    expect(scope).toEqual({ kind: 'derived', target: { type: 'tag', value: TAG_NAME } })
    // Read through the narrowed target, because `{ type: 'none' }` has no value to compare: an assertion
    // that quietly fell back to `''` would pass the day the scope stopped being a live tag.
    if (scope.kind !== 'derived' || scope.target.type === 'none') {
      throw new Error('a published tag must resolve to the name its members carry')
    }
    expect(scope.target.value).not.toBe(TAG_ID)
    expect(collectionTargetRecord({ target_type: 'tag', target_value: TAG_ID })).toEqual({ type: 'tag', value: TAG_ID })
  })

  it('covers nothing when the tag it was published for is gone', () => {
    const scope = collectionScope({ target_type: 'tag', target_value: TAG_ID }, null)
    expect(scope).toEqual({ kind: 'derived', target: { type: 'none' } })
    expect(resolveShareTarget({ type: 'tag', value: TAG_ID }, null)).toEqual({ type: 'none' })
  })

  it('reads a stored kind it does not know as a collection that covers nothing', () => {
    // `share_collections.target_type` is CHECK-constrained, so this row could not have been inserted
    // through the schema; the read still refuses to guess, because guessing is how an unknown kind would
    // end up matching every share in the account.
    const row = { target_type: 'blog', target_value: FOLDER_ID }
    expect(collectionTargetType(row)).toBeNull()
    expect(collectionScope(row, null)).toEqual({ kind: 'unreadable' })
    expect(collectionTargetRecord(row)).toBeNull()
    expect(toShareCollection(collectionRow(row), 3)).toBeNull()
  })

  it('applies the same active rule to a directory, as one call and not a second copy', () => {
    const target = { type: 'tag' as const, value: TAG_NAME }
    const members = collectionMemberConditions({ target, now: NOW, firstBind: 2 })
    const owner = shareSelectionSql({ status: 'active', target }, { now: NOW, firstBind: 2 })
    expect(members).toEqual(owner)
    expect(members.conditions.join(' AND ')).toContain('s.is_enabled = 1')
    // The paused and the expired are excluded by the status rule, and nothing else is filtering them out.
    expect(members.conditions).toHaveLength(2)
  })

  it('gives every hand-picked collection its own target value', () => {
    // The live-target index is unique per (account, kind, value): a shared constant would make the
    // second enabled hand-picked directory a constraint violation rather than a second directory.
    expect(manualTargetValue(COLLECTION_ID)).toBe(COLLECTION_ID)
    expect(manualTargetValue(COLLECTION_OTHER_ID)).not.toBe(manualTargetValue(COLLECTION_ID))
  })
})

/** A collection row built from a target pair, for the read-time rules. */
function collectionRow(target: { target_type: string; target_value: string }): ShareCollectionRow {
  return {
    id: COLLECTION_ID,
    slug: COLLECTION_SLUG,
    user_id: OWNER,
    target_type: target.target_type,
    target_value: target.target_value,
    password_hash: null,
    expires_at: null,
    is_enabled: 1,
    member_sort: null,
    title: 'Hand picked',
    created_at: 1000,
    updated_at: 1000,
  }
}

describe('the collection cursor', () => {
  const rows = (count: number, offset = 0): CollectionMemberRow[] =>
    Array.from({ length: count }, (_, index) => ({
      title: `Note ${index}`,
      excerpt: 'a short excerpt',
      is_pinned: 0,
      updated_at: NOW - index * 1000,
      slug: newSlug(),
      password_hash: null,
      sort_order: offset + index,
    }))

  it('offers no cursor for a page that came back short', () => {
    expect(nextCollectionCursor(rows(3), 50, null)).toBeNull()
    expect(nextCollectionCursor([], 50, null)).toBeNull()
  })

  it('round-trips the shipped order, the title order and the hand-picked position', () => {
    const page = rows(4)
    const plain = decodePageCursor(nextCollectionCursor(page, 4, null))
    expect(plain).toEqual({ isPinned: 0, updatedAt: page[3]!.updated_at, slug: page[3]!.slug })

    const titled = decodePageCursor(nextCollectionCursor(page, 4, 'title'))
    expect(titled?.title).toBe('Note 3')

    const handPicked = decodePageCursor(nextCollectionCursor(page, 4, 'manual'))
    expect(handPicked?.sortOrder).toBe(offsetOfLast(page))
  })

  it('refuses a cursor it did not mint instead of quietly restarting the page', () => {
    expect(decodeCollectionCursor(undefined)).toBeNull()
    // A slug that is not a slug is the case that matters: the cursor is base64 of data the client holds,
    // and a truncated one would otherwise read as "give me the first page again".
    expect(() => decodeCollectionCursor(btoa(`0|${NOW}|not-a-slug`).replaceAll('=', ''))).toThrow('invalid collection cursor')
    expect(() => decodeCollectionCursor(btoa(`7|${NOW}|${newSlug()}`).replaceAll('=', ''))).toThrow('invalid collection cursor')
    expect(() => decodeCollectionCursor(btoa(`0|${NOW}|${newSlug()}|zzz`).replaceAll('=', ''))).toThrow('invalid collection cursor')
  })

  it('marks every directory link with a token the visit writer accepts', () => {
    // The page hands out slugs and whoever renders them stamps the marker; both sides call
    // `collectionChannelToken`, so this is the assertion that the marker a real reader clicks is one the
    // analytics will not refuse.
    const token = collectionChannelToken(COLLECTION_SLUG)
    expect(normalizeChannelToken(token)).toBe(token)
  })
})

function offsetOfLast(page: CollectionMemberRow[]): number {
  return page[page.length - 1]?.sort_order ?? 0
}

/** A page cursor handed back by `nextCollectionCursor` is `string | null`; the decoder reads absence as undefined. */
function decodePageCursor(cursor: string | null): ReturnType<typeof decodeCollectionCursor> {
  return decodeCollectionCursor(cursor ?? undefined)
}

describe('collections owned by the account', () => {
  it('publishes a folder once and re-states its policy on the second press', async () => {
    const db = seed({ folders: [{ id: FOLDER_ID, name: 'Published' }] })
    const app = ownerApp(OWNER)
    const first = await jsonAt<{ id: string; slug: string }>(app, db, '/api/share/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetType: 'folder', targetValue: FOLDER_ID }),
    })
    expect(first.status).toBe(201)
    const again = await jsonAt<{ id: string; slug: string }>(app, db, '/api/share/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetType: 'folder', targetValue: FOLDER_ID, password: 'a passcode that is long enough' }),
    })
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ id: first.body.id, slug: first.body.slug })

    const list = await jsonAt<{ collections: Array<{ count: number; hasPassword: boolean }> }>(app, db, '/api/share/collections')
    expect(list.body.collections).toHaveLength(1)
    expect(list.body.collections[0]?.hasPassword).toBe(true)
  })

  it('lets an account publish two enabled hand-picked directories, which is what the index is for', async () => {
    const db = seed({ links: [{ noteId: NOTE_A }, { noteId: NOTE_B }] })
    const app = ownerApp(OWNER)
    const bodies = [
      { targetType: 'manual', title: 'First set', noteIds: [NOTE_A] },
      { targetType: 'manual', title: 'Second set', noteIds: [NOTE_B] },
    ]
    const created = []
    for (const body of bodies) {
      const response = await jsonAt<{ id: string; slug: string }>(app, db, '/api/share/collections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      created.push(response)
    }
    // A shared `target_value` would have made the second one a constraint error out of the database.
    expect(created.map((response) => response.status)).toEqual([201, 201])
    const list = await jsonAt<{ collections: Array<{ targetValue: string; count: number; title: string }> }>(app, db, '/api/share/collections')
    expect(list.body.collections).toHaveLength(2)
    expect(new Set(list.body.collections.map((collection) => collection.targetValue)).size).toBe(2)
    expect(list.body.collections.map((collection) => collection.count).sort()).toEqual([1, 1])
  })

  it('refuses a folder the account does not own with the same 404 a missing one gets', async () => {
    const db = seed({ folders: [{ id: FOLDER_ID, name: 'Theirs', userId: OTHER }] })
    const app = ownerApp(OWNER)
    const response = await jsonAt<{ error?: { code: string } }>(app, db, '/api/share/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetType: 'folder', targetValue: FOLDER_ID }),
    })
    expect(response.status).toBe(404)
    const list = await jsonAt<{ collections: unknown[] }>(app, db, '/api/share/collections')
    expect(list.body.collections).toEqual([])
  })

  it('counts what a directory holds right now, and not what it held when it was published', async () => {
    const db = seed({
      folders: [{ id: FOLDER_ID, name: 'Published' }],
      links: [
        { noteId: NOTE_A, folderId: FOLDER_ID },
        // Paused, and trashed: neither is a member of a public page, and neither is counted.
        { noteId: NOTE_B, folderId: FOLDER_ID, isEnabled: 0 },
        { noteId: NOTE_TRASHED, folderId: FOLDER_ID, deletedAt: 1500 },
      ],
      collections: [{ id: COLLECTION_ID, slug: COLLECTION_SLUG, targetType: 'folder', targetValue: FOLDER_ID }],
    })
    const list = await jsonAt<{ collections: Array<{ count: number; title: string }> }>(ownerApp(OWNER), db, '/api/share/collections')
    expect(list.body.collections[0]?.count).toBe(1)
    // The title is the folder's live name, read at request time rather than stored on the row.
    expect(list.body.collections[0]?.title).toBe('Published')
  })

  it('answers a foreign collection id as nothing, on every write path', async () => {
    const db = seed({
      collections: [{ id: COLLECTION_ID, slug: COLLECTION_SLUG, userId: OTHER, targetType: 'folder', targetValue: FOLDER_ID }],
    })
    const app = ownerApp(OWNER)
    const patch = await jsonAt(app, db, `/api/share/collections/${COLLECTION_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isEnabled: false }),
    })
    expect(patch.status).toBe(404)
    const removed = await jsonAt(app, db, `/api/share/collections/${COLLECTION_ID}`, { method: 'DELETE' })
    expect(removed.status).toBe(404)
    const stillThere = await db
      .prepare(`SELECT is_enabled FROM share_collections WHERE id = ?1`)
      .bind(COLLECTION_ID)
      .first<{ is_enabled: number }>()
    expect(stillThere?.is_enabled).toBe(1)
  })

  it('replaces a hand-picked roster in the order the owner gave', async () => {
    const db = seed({
      links: [{ noteId: NOTE_A }, { noteId: NOTE_B }],
      collections: [{ id: COLLECTION_ID, slug: COLLECTION_SLUG, targetType: 'manual', targetValue: COLLECTION_ID, title: 'Set' }],
    })
    const app = ownerApp(OWNER)
    const written = await jsonAt<{ members: number }>(app, db, `/api/share/collections/${COLLECTION_ID}/members`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: [NOTE_B, NOTE_A] }),
    })
    expect(written.body.members).toBe(2)
    const page = await jsonAt<{ notes: Array<{ slug: string }> }>(publicApp(), db, `/api/public/c/${COLLECTION_SLUG}`)
    expect(page.body.notes.map((note) => note.slug)).toEqual([`slug-${NOTE_B}`, `slug-${NOTE_A}`])

    // A folder collection has no roster to replace, and saying so beats rewriting its target.
    const db2 = seed({
      folders: [{ id: FOLDER_ID, name: 'Published' }],
      collections: [{ id: COLLECTION_ID, slug: COLLECTION_SLUG, targetType: 'folder', targetValue: FOLDER_ID }],
    })
    const refused = await jsonAt(ownerApp(OWNER), db2, `/api/share/collections/${COLLECTION_ID}/members`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: [NOTE_A] }),
    })
    expect(refused.status).toBe(400)
  })

  it('refuses a roster that names only notes the account has no link for', async () => {
    const db = seed({
      links: [{ noteId: NOTE_A, userId: OTHER }],
      collections: [{ id: COLLECTION_ID, slug: COLLECTION_SLUG, targetType: 'manual', targetValue: COLLECTION_ID, title: 'Set' }],
    })
    const response = await jsonAt<{ error?: { code: string } }>(ownerApp(OWNER), db, `/api/share/collections/${COLLECTION_ID}/members`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds: [NOTE_A] }),
    })
    expect(response.status).toBe(400)
  })

  it('bounds a roster at the ceiling it states', async () => {
    const noteIds = Array.from({ length: MAX_MANUAL_COLLECTION_MEMBERS + 1 }, () => newId())
    const db = seed({
      collections: [{ id: COLLECTION_ID, slug: COLLECTION_SLUG, targetType: 'manual', targetValue: COLLECTION_ID, title: 'Set' }],
    })
    const response = await jsonAt(ownerApp(OWNER), db, `/api/share/collections/${COLLECTION_ID}/members`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteIds }),
    })
    expect(response.status).toBe(400)
  })
})

describe('the public directory', () => {
  function published(passcode?: string): { db: D1Database; app: Hono<AppBindings>; slug: string } {
    const slug = newSlug()
    const db = seed({
      folders: [{ id: FOLDER_ID, name: 'Published' }],
      links: [
        {
          noteId: NOTE_A,
          slug: MEMBER_SLUG_A,
          folderId: FOLDER_ID,
          title: 'First page',
          excerpt: 'first excerpt',
          content: 'the private body of the first note',
        },
        { noteId: NOTE_B, slug: MEMBER_SLUG_B, folderId: FOLDER_ID, title: 'Second page', excerpt: 'second excerpt', updatedAt: 2000 },
      ],
      collections: [{ id: COLLECTION_ID, slug, targetType: 'folder', targetValue: FOLDER_ID, passwordHash: passcode ? passcode : null }],
    })
    return { db, app: publicApp(), slug }
  }

  it('lists the active members by slug, title and excerpt, and nothing else', async () => {
    const { db, app, slug } = published()
    const page = await jsonAt<{ title: string; count: number; notes: Array<Record<string, unknown>>; nextCursor: string | null; limit: number }>(
      app,
      db,
      `/api/public/c/${slug}`,
    )
    expect(page.status).toBe(200)
    expect(page.body.title).toBe('Published')
    expect(page.body.count).toBe(2)
    expect(page.body.notes.map((note) => note.slug)).toEqual([MEMBER_SLUG_B, MEMBER_SLUG_A])
    expect(page.body.notes[0]?.title).toBe('Second page')
    expect(page.body.notes[1]?.excerpt).toBe('first excerpt')
    expect(page.body.nextCursor).toBeNull()
    expect(Object.keys(page.body).sort()).toEqual(['count', 'limit', 'nextCursor', 'notes', 'title'])
  })

  it('shows a directory page no note id and no note body', async () => {
    const { db, app, slug } = published()
    const response = await app.request(`http://inkstone.test/api/public/c/${slug}`, {}, env(db))
    const text = await response.text()
    // An id is 26 characters of the id alphabet, and the reader gets none: the shape check is the rule
    // and the seeded ids name the rows it exists to keep out.
    expect(text).not.toMatch(/[0-9a-hjkmnp-tv-z]{26}/)
    expect(text).not.toContain(NOTE_A)
    expect(text).not.toContain(NOTE_B)
    expect(text).not.toContain(COLLECTION_ID)
    expect(text).not.toContain(FOLDER_ID)
    expect(text).not.toContain('the private body of the first note')
    expect(text).not.toContain(OWNER)
    expect(text).not.toContain('password_hash')
  })

  it('leaves out a paused, an expired and a trashed member without editing the collection', async () => {
    const slug = newSlug()
    const db = seed({
      folders: [{ id: FOLDER_ID, name: 'Published' }],
      links: [
        { noteId: NOTE_A, slug: MEMBER_SLUG_A, folderId: FOLDER_ID, isEnabled: 0 },
        { noteId: NOTE_B, slug: MEMBER_SLUG_B, folderId: FOLDER_ID, expiresAt: 1500 },
      ],
      collections: [{ id: COLLECTION_ID, slug, targetType: 'folder', targetValue: FOLDER_ID }],
    })
    const page = await jsonAt<{ count: number; notes: unknown[] }>(publicApp(), db, `/api/public/c/${slug}`)
    expect(page.body).toEqual({ title: 'Published', count: 0, notes: [], nextCursor: null, limit: 50 })
  })

  it('shrinks the page the moment one member is paused, with the collection untouched', async () => {
    // The rule the whole feature rests on: membership is derived per request, so a link the owner pauses
    // leaves a page nobody edited. Asserted live, because a seed that started paused proves only the
    // filter reads `is_enabled`.
    const { db, app, slug } = published()
    const before = await jsonAt<{ count: number; notes: Array<{ slug: string }> }>(app, db, `/api/public/c/${slug}`)
    expect(before.body.count).toBe(2)

    await db.prepare(`UPDATE shares SET is_enabled = 0 WHERE note_id = ?1`).bind(NOTE_B).run()
    const after = await jsonAt<{ count: number; notes: Array<{ slug: string }> }>(app, db, `/api/public/c/${slug}`)
    expect(after.body.count).toBe(1)
    expect(after.body.notes.map((note) => note.slug)).toEqual([MEMBER_SLUG_A])

    const collection = await db
      .prepare(`SELECT is_enabled, target_value FROM share_collections WHERE slug = ?1`)
      .bind(slug)
      .first<{ is_enabled: number; target_value: string }>()
    expect(collection).toEqual({ is_enabled: 1, target_value: FOLDER_ID })
  })

  it('answers a missing, a paused and an expired directory with one identical refusal', async () => {
    const liveSlug = newSlug()
    const pausedSlug = newSlug()
    const expiredSlug = newSlug()
    const missingSlug = newSlug()
    const db = seed({
      collections: [
        { id: COLLECTION_ID, slug: liveSlug, targetType: 'folder', targetValue: FOLDER_ID },
        { id: COLLECTION_OTHER_ID, slug: pausedSlug, targetType: 'folder', targetValue: FOLDER_OTHER_ID, isEnabled: 0 },
        { id: COLLECTION_THIRD_ID, slug: expiredSlug, targetType: 'folder', targetValue: FOLDER_THIRD_ID, expiresAt: 1500 },
      ],
    })
    const app = publicApp()
    const gone = []
    for (const asked of [missingSlug, pausedSlug, expiredSlug, 'short']) {
      gone.push(await jsonAt(app, db, `/api/public/c/${asked}`))
    }
    for (const response of gone) {
      expect(response.status).toBe(404)
    }
    // The one the reader is allowed to reach still answers, so the refusals above are not the route
    // failing to serve any directory at all.
    const served = await jsonAt<{ count: number }>(app, db, `/api/public/c/${liveSlug}`)
    expect(served.status).toBe(200)
  })

  it('asks for its own passcode before it shows anything about the directory', async () => {
    const passcode = await hashPassword('a passcode that is long enough')
    const { db, app, slug } = published(passcode)
    const denied = await jsonAt<{ error?: { code: string } }>(app, db, `/api/public/c/${slug}`)
    expect(denied.status).toBe(401)
    // Not the title, not the count, not how many members it has.
    expect(JSON.stringify(denied.body)).not.toContain('Published')

    const wrong = await jsonAt(app, db, `/api/public/c/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong but long enough' }),
    })
    expect(wrong.status).toBe(401)
    const ledger = await db
      .prepare(`SELECT fails FROM login_attempts WHERE key = ?1`)
      .bind(`collection:${slug}:ip:local`)
      .first<{ fails: number }>()
    expect(ledger?.fails).toBe(1)

    const accepted = await jsonAt<{ count: number }>(app, db, `/api/public/c/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'a passcode that is long enough' }),
    })
    expect(accepted.status).toBe(200)
    expect(accepted.body.count).toBe(2)
  })

  it('pages with a cursor that does not repeat or drop a member', async () => {
    const slug = newSlug()
    const links = Array.from({ length: 3 }, (_, index) => ({
      noteId: newId(),
      slug: newSlug(),
      folderId: FOLDER_ID,
      updatedAt: 1000 + index,
    }))
    const db = seed({
      folders: [{ id: FOLDER_ID, name: 'Published' }],
      links,
      collections: [{ id: COLLECTION_ID, slug, targetType: 'folder', targetValue: FOLDER_ID }],
    })
    const app = publicApp()
    const first = await jsonAt<{ notes: Array<{ slug: string }>; nextCursor: string | null }>(app, db, `/api/public/c/${slug}?limit=2`)
    expect(first.body.notes).toHaveLength(2)
    expect(first.body.nextCursor).not.toBeNull()
    const second = await jsonAt<{ notes: Array<{ slug: string }>; nextCursor: string | null }>(
      app,
      db,
      `/api/public/c/${slug}?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    )
    expect(second.body.notes).toHaveLength(1)
    expect(second.body.nextCursor).toBeNull()
    const slugs = [...first.body.notes, ...second.body.notes].map((note) => note.slug)
    expect(new Set(slugs).size).toBe(3)
    // The pages walk newest first, which is only decidable because each link was stamped apart.
    expect(slugs).toEqual([links[2]!.slug, links[1]!.slug, links[0]!.slug])

    const refused = await jsonAt(app, db, `/api/public/c/${slug}?cursor=not-a-cursor`)
    expect(refused.status).toBe(400)
  })

  it('lists a tag directory by the name its members carry, under an id that differs from it', async () => {
    const slug = newSlug()
    const db = seed({
      tags: [{ id: TAG_ID, name: TAG_NAME }],
      links: [{ noteId: NOTE_A, slug: MEMBER_SLUG_C, tags: [TAG_NAME], title: 'Tagged note' }],
      collections: [{ id: COLLECTION_ID, slug, targetType: 'tag', targetValue: TAG_ID }],
    })
    const page = await jsonAt<{ title: string; count: number; notes: Array<{ slug: string }> }>(publicApp(), db, `/api/public/c/${slug}`)
    expect(page.body.title).toBe(TAG_NAME)
    expect(page.body.count).toBe(1)
    expect(page.body.notes[0]?.slug).toBe(MEMBER_SLUG_C)
  })

  it('hands a hand-picked directory its stored order, and drops a member whose link was revoked', async () => {
    const slug = newSlug()
    const db = seed({
      links: [
        { noteId: NOTE_A, slug: MEMBER_SLUG_A },
        { noteId: NOTE_B, slug: MEMBER_SLUG_B },
      ],
      collections: [{ id: COLLECTION_ID, slug, targetType: 'manual', targetValue: COLLECTION_ID, title: 'Reading list' }],
      members: [
        { collectionId: COLLECTION_ID, noteId: NOTE_B, sortOrder: 0 },
        { collectionId: COLLECTION_ID, noteId: NOTE_A, sortOrder: 1 },
      ],
    })
    const app = publicApp()
    const before = await jsonAt<{ title: string; notes: Array<{ slug: string }> }>(app, db, `/api/public/c/${slug}`)
    expect(before.body.title).toBe('Reading list')
    expect(before.body.notes.map((note) => note.slug)).toEqual([MEMBER_SLUG_B, MEMBER_SLUG_A])

    await db.prepare(`DELETE FROM shares WHERE note_id = ?1`).bind(NOTE_B).run()
    const after = await jsonAt<{ count: number; notes: Array<{ slug: string }> }>(app, db, `/api/public/c/${slug}`)
    expect(after.body.count).toBe(1)
    expect(after.body.notes.map((note) => note.slug)).toEqual([MEMBER_SLUG_A])
  })
})

/**
 * The statements every collection read is built from, before a database ever sees them.
 *
 * An id or a timestamp spelled into the SQL text is a value that has to survive the schema's own quoting,
 * and a placeholder without a number is a bind this project's D1 statements cannot answer. Checked on the
 * generated text because a route that inlines one would still read correctly against the fixture — and
 * wrongly against anything else.
 */
describe('the statements a collection reads with', () => {
  function queries(): Array<{ sql: string; binds: Array<string | number> }> {
    return [
      collectionMembersSql({ userId: OWNER, target: { type: 'folder', value: FOLDER_ID }, now: NOW, cursor: null, limit: 50 }),
      collectionMemberCountSql({ userId: OWNER, target: { type: 'tag', value: TAG_NAME }, now: NOW }),
      manualCollectionMembersSql({
        userId: OWNER,
        collectionId: COLLECTION_ID,
        now: NOW,
        cursor: { isPinned: 0, updatedAt: NOW, slug: COLLECTION_SLUG },
        limit: 50,
      }),
      manualCollectionCountSql({ userId: OWNER, collectionId: COLLECTION_ID, now: NOW }),
    ]
  }

  it('binds every value and numbers every placeholder', () => {
    for (const { sql, binds } of queries()) {
      expect(sql).not.toMatch(/\?(?!\d)/)
      for (const value of [OWNER, OTHER, FOLDER_ID, TAG_NAME, COLLECTION_ID, String(NOW)]) {
        expect(sql).not.toContain(value)
      }
      // Every value the statement needs is in the bind list, in the order the placeholders number from 1.
      expect(binds.length).toBeGreaterThan(0)
      const numbered = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]))
      expect(new Set(numbered).size).toBeGreaterThan(0)
      expect(Math.max(...numbered)).toBe(binds.length)
    }
  })
})
