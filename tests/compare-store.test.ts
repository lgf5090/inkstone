// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { TOOLS_COMPARE_SCHEMA_STATEMENTS } from '../src/worker/tools/compare/schema'
import { CompareStore } from '../src/worker/tools/compare/store'
import type { CompareKind } from '../src/shared/tools/compare/types'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'u1'
const OTHER = 'u2'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_COMPARE_SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

const asset = async (store: CompareStore, id: string, kind: CompareKind = 'text') =>
  store.createAsset({
    id,
    kind,
    filename: `${id}.txt`,
    mime: 'text/plain',
    size: 12,
    encoding: 'utf-8',
    sha256: `sha-${id}`,
    r2Key: `tools/compare/txt/${USER}/${id}.txt`,
  })

describe('CompareStore projects', () => {
  it('stores a project with both assets and reads it back', async () => {
    const store = new CompareStore(db, USER)
    await asset(store, 'a1')
    await asset(store, 'a2')
    const project = await store.createProject({
      name: 'Config change',
      kind: 'text',
      left_label: 'old.txt',
      right_label: 'new.txt',
      options: { ignoreWhitespace: true },
      summary: { added: 2, removed: 1 },
      left_asset_id: 'a1',
      right_asset_id: 'a2',
    })
    expect(project.name).toBe('Config change')
    expect(project.left_asset?.filename).toBe('a1.txt')
    expect(project.options.ignoreWhitespace).toBe(true)
    expect(project.options.ignoreLineEndings).toBe(true)
    expect(project.summary.added).toBe(2)
  })

  it('refuses an asset the reader does not own', async () => {
    const store = new CompareStore(db, USER)
    const other = new CompareStore(db, OTHER)
    await asset(other, 'foreign')
    await expect(store.createProject({ name: 'x', kind: 'text', left_asset_id: 'foreign' }))
      .rejects.toThrow(/attachment/i)
  })

  it('lists by kind and by name, newest first', async () => {
    const store = new CompareStore(db, USER)
    await store.createProject({ name: 'Alpha text', kind: 'text' })
    await store.createProject({ name: 'Beta image', kind: 'image' })
    const text = await store.listProjects({ limit: 20, offset: 0, kind: 'text', search: null })
    expect(text.total).toBe(1)
    expect(text.items[0]!.name).toBe('Alpha text')
    const search = await store.listProjects({ limit: 20, offset: 0, kind: null, search: 'beta' })
    expect(search.items.map((item) => item.name)).toEqual(['Beta image'])
    const all = await store.listProjects({ limit: 20, offset: 0, kind: null, search: null })
    expect(all.items[0]!.name).toBe('Beta image')
  })

  it('updates the name and the options', async () => {
    const store = new CompareStore(db, USER)
    const project = await store.createProject({ name: 'First', kind: 'text' })
    const updated = await store.updateProject(project.id, { name: 'Second', options: { ignoreCase: true } })
    expect(updated.name).toBe('Second')
    expect(updated.options.ignoreCase).toBe(true)
  })

  it('deletes the project and the assets only it referenced', async () => {
    const store = new CompareStore(db, USER)
    await asset(store, 'only')
    await asset(store, 'kept')
    const first = await store.createProject({ name: 'One', kind: 'text', left_asset_id: 'only' })
    await store.createProject({ name: 'Two', kind: 'text', left_asset_id: 'kept' })
    const keys = await store.deleteProject(first.id)
    expect(keys).toEqual([`tools/compare/txt/${USER}/only.txt`])
    expect(await store.getAsset('only')).toBeNull()
    expect(await store.getAsset('kept')).not.toBeNull()
    expect(await store.getProject(first.id)).toBeNull()
  })

  it('finds a shared project by slug without a user scope', async () => {
    const store = new CompareStore(db, USER)
    await asset(store, 's1')
    const project = await store.createProject({ name: 'Shared', kind: 'text', left_asset_id: 's1' })
    await store.setShareSlug(project.id, 'abc123')
    const shared = await CompareStore.findSharedProject(db, 'abc123')
    expect(shared?.project.name).toBe('Shared')
    expect(shared?.left?.r2_key).toBe(`tools/compare/txt/${USER}/s1.txt`)
    expect((await CompareStore.sharedAsset(db, 'abc123', 'right'))).toBeNull()
    expect(await CompareStore.findSharedProject(db, 'nope')).toBeNull()
  })
})

describe('CompareStore statistics', () => {
  it('aggregates runs by kind, extension and day', async () => {
    const store = new CompareStore(db, USER)
    const other = new CompareStore(db, OTHER)
    await store.recordRun({ kind: 'text', mode: 'side_by_side', left_ext: 'ts', added_lines: 4, removed_lines: 2, changed_blocks: 1 })
    await store.recordRun({ kind: 'text', mode: 'inline', left_ext: 'ts', identical: true })
    await store.recordRun({ kind: 'image', mode: 'difference', left_ext: 'png' })
    await other.recordRun({ kind: 'text', mode: 'side_by_side', left_ext: 'ts', added_lines: 100 })

    const stats = await store.stats('7d')
    expect(stats.total).toBe(3)
    expect(stats.identical).toBe(1)
    expect(stats.byKind.text).toBe(2)
    expect(stats.byKind.image).toBe(1)
    expect(stats.topExtensions[0]).toEqual({ ext: 'ts', count: 2 })
    expect(stats.averageChangedLines).toBe(6)
    expect(stats.trend).toHaveLength(7)
    expect(stats.trend.reduce((total, bucket) => total + bucket.count, 0)).toBe(3)
  })
})
