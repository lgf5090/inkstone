import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEVELOPMENT_ICONS_CORE_SCHEMA_STATEMENTS } from '../src/worker/development/icons/schema'
import {
  countAssets,
  countsFor,
  listAssets,
  setState,
  type IconListInput,
} from '../src/worker/development/icons/store'

const base: IconListInput = { limit: 60, state: 'all', sort: 'created' }

const USER = 'u-counts'
const LUCIDE = 'c-lucide'
const REMIX = 'c-remix'
const SIMPLE = 'c-simple'
const TAG = 't-solid'

/**
 * A D1-shaped facade over Node's built-in SQLite.
 *
 * The counting bug this guards against was a data-shape bug — the rail, the facet chips and the grid
 * each asked the database a different question — so the test runs the real SQL over a real database
 * rather than mocking the store.
 */
function d1From(database: DatabaseSync): D1Database {
  const make = (sql: string) => {
    let bound: unknown[] = []
    const statement = {
      bind(...values: unknown[]) {
        bound = values
        return statement
      },
      async first<T>() {
        return (database.prepare(sql).get(...(bound as never[])) ?? null) as T | null
      },
      async all<T>() {
        const results = database.prepare(sql).all(...(bound as never[])) as T[]
        return { results, success: true, meta: {} } as unknown as D1Result<T>
      },
      async run() {
        const info = database.prepare(sql).run(...(bound as never[]))
        return { success: true, meta: { changes: Number(info.changes) } } as unknown as D1Result<unknown>
      },
    }
    return statement
  }
  return {
    prepare: make,
    batch: async (statements: { run: () => Promise<unknown> }[]) => Promise.all(statements.map((entry) => entry.run())),
  } as unknown as D1Database
}

function seed(database: DatabaseSync): void {
  const now = Date.now()
  database.prepare(
    `INSERT INTO development_icons_collections (user_id, id, name, slug, description, source, license, homepage, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'iconify', 'MIT', '', 0, ?, ?)`,
  ).run(USER, LUCIDE, 'Lucide', 'lucide', now, now)
  database.prepare(
    `INSERT INTO development_icons_collections (user_id, id, name, slug, description, source, license, homepage, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'iconify', 'Apache-2.0', '', 0, ?, ?)`,
  ).run(USER, REMIX, 'Remix Icon', 'ri', now, now)
  database.prepare(
    `INSERT INTO development_icons_collections (user_id, id, name, slug, description, source, license, homepage, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'iconify', 'CC0-1.0', '', 0, ?, ?)`,
  ).run(USER, SIMPLE, 'Simple Icons', 'simple-icons', now, now)
  database.prepare(
    `INSERT INTO development_icons_tags (user_id, id, name, name_key, color, parent_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'solid', 'solid', '#64748b', NULL, 0, ?, ?)`,
  ).run(USER, TAG, now, now)

  const insert = database.prepare(
    `INSERT INTO development_icons_assets
       (user_id, id, collection_id, name, name_key, format, mime, bytes, width, height, view_box, sha256,
        r2_key, thumb_key, keywords, color_mode, license, source_url, sanitized, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'svg', 'image/svg+xml', 300, 24, 24, '0 0 24 24', ?, ?, NULL, '', ?, '', '', 1, ?, ?)`,
  )
  const rows = 900
  for (let index = 0; index < rows; index += 1) {
    const collection = index < 400 ? LUCIDE : index < 800 ? REMIX : SIMPLE
    // Remix carries both outline and `-fill` names; simple-icons is a brand set.
    const name = collection === LUCIDE
      ? `lucide-${index}`
      : collection === REMIX
        ? index % 2 === 0 ? `remix-${index}` : `remix-${index}-fill`
        : `brand-${index}`
    const color = index % 3 === 0 ? 'multi' : 'mono'
    insert.run(USER, `a-${index}`, collection, name, name, `sha-${index}`, `key-${index}`, color, now + index, now + index)
  }

  const state = database.prepare(
    `INSERT INTO development_icons_user_state (user_id, asset_id, favorited, pinned, pinned_at, use_count, last_used_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  )
  for (let index = 0; index < 100; index += 1) state.run(USER, `a-${index}`, 1, index < 50 ? 1 : 0, index < 50 ? now : null, now, now)
  // Five rows were used long ago: the rail used to call these "recent" while the grid counted them, and
  // the other way around after the window moved.
  for (let index = 100; index < 105; index += 1) {
    database.prepare(
      `INSERT INTO development_icons_user_state (user_id, asset_id, favorited, pinned, pinned_at, use_count, last_used_at, updated_at)
       VALUES (?, ?, 0, 0, NULL, 1, ?, ?)`,
    ).run(USER, `a-${index}`, now - 40 * 24 * 60 * 60 * 1000, now)
  }

  const link = database.prepare(
    `INSERT INTO development_icons_tag_links (user_id, asset_id, tag_id, created_at) VALUES (?, ?, ?, ?)`,
  )
  for (let index = 0; index < 60; index += 1) link.run(USER, `a-${index}`, TAG, now)
}

describe('development icon counts', () => {
  let database: DatabaseSync
  let db: D1Database

  beforeEach(() => {
    database = new DatabaseSync(':memory:')
    for (const statement of DEVELOPMENT_ICONS_CORE_SCHEMA_STATEMENTS) database.exec(statement)
    seed(database)
    db = d1From(database)
  })

  it('reports a style for every icon, so the four buckets add up to the library', async () => {
    const counts = await countsFor(db, USER, 'shard')
    expect(counts.all).toBe(900)
    const styleTotal = ['line', 'fill', 'duotone', 'brand']
      .map((style) => counts.styles[style] ?? 0)
      .reduce((sum, value) => sum + value, 0)
    expect(styleTotal).toBe(counts.all)
    expect(counts.styles.line).toBe(600)
    expect(counts.styles.fill).toBe(200)
    expect(counts.styles.brand).toBe(100)
    expect(counts.styles.duotone).toBe(0)
    expect(Object.keys(counts.styles)).not.toContain('unknown')
  })

  it('keeps every smart view count equal to that view’s list total', async () => {
    const counts = await countsFor(db, USER, 'shard')
    for (const state of ['all', 'favorites', 'pinned', 'recent', 'uncategorized'] as const) {
      const page = await listAssets(db, USER, { ...base, state })
      expect(page.total, state).toBe(counts[state])
    }
    expect(counts.favorites).toBe(100)
    expect(counts.pinned).toBe(50)
    // The five rows used 40 days ago sit outside the 30-day window in both places.
    expect(counts.recent).toBe(100)
    expect(counts.uncategorized).toBe(0)
  })

  it('keeps facet counts equal to the list totals for the same filter', async () => {
    const counts = await countsFor(db, USER, 'shard')
    for (const style of ['line', 'fill', 'duotone', 'brand'] as const) {
      const page = await listAssets(db, USER, { ...base, style })
      expect(page.total, style).toBe(counts.styles[style] ?? 0)
    }
    for (const [id, expected] of Object.entries(counts.collections)) {
      const page = await listAssets(db, USER, { ...base, collectionId: id })
      expect(page.total, id).toBe(expected)
    }
    for (const colorMode of ['mono', 'multi'] as const) {
      const page = await listAssets(db, USER, { ...base, colorMode })
      expect(page.total, colorMode).toBe(counts.colorModes[colorMode] ?? 0)
    }
    const tagged = await listAssets(db, USER, { ...base, tagId: TAG })
    expect(tagged.total).toBe(counts.tags[TAG])
    expect((counts.colorModes.mono ?? 0) + (counts.colorModes.multi ?? 0)).toBe(900)
  })

  it('updates favorite and pin counts as soon as the state changes', async () => {
    const before = await countsFor(db, USER, 'shard')
    await setState(db, USER, 'a-200', { favorited: true, pinned: true })
    const after = await countsFor(db, USER, 'shard')
    expect(after.favorites).toBe(before.favorites + 1)
    expect(after.pinned).toBe(before.pinned + 1)

    await setState(db, USER, 'a-0', { favorited: false, pinned: false })
    const final = await countsFor(db, USER, 'shard')
    expect(final.favorites).toBe(before.favorites)
    expect(final.pinned).toBe(before.pinned)
  })

  it('counts with the same predicate the paged list uses', async () => {
    expect(await countAssets(db, USER, { state: 'favorites' })).toBe(100)
    expect(await countAssets(db, USER, { style: 'fill' })).toBe(200)
    expect((await listAssets(db, USER, { ...base, state: 'favorites' })).items.every((item) => item.favorited)).toBe(true)
  })
})
