// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOOLS_SHORTLINKS_SCHEMA_STATEMENTS } from '../src/worker/tools/shortlinks/schema'
import { ShortlinksStore } from '../src/worker/tools/shortlinks/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-integrity'

describe('Shortlinks data integrity', () => {
  let sqlite: DatabaseSync
  let store: ShortlinksStore

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    for (const statement of TOOLS_SHORTLINKS_SCHEMA_STATEMENTS) sqlite.exec(statement)
    store = new ShortlinksStore(makeD1(sqlite), USER)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('treats URL case as the same target but still allows an explicit duplicate', async () => {
    const first = await store.createLink({ url: 'https://Example.com/Path', custom_slug: 'int-a' })
    await expect(store.createLink({ url: 'https://example.com/path', custom_slug: 'int-b' })).rejects.toThrow(
      /already been shortened/i,
    )
    const duplicate = await store.createLink({
      url: 'https://EXAMPLE.com/PATH',
      custom_slug: 'int-c',
      allow_duplicate: true,
    })
    expect(duplicate.id).not.toBe(first.id)
    const row = sqlite
      .prepare('SELECT normalized_url FROM tools_shortlinks_links WHERE id = ?')
      .get(first.id) as { normalized_url: string }
    expect(row.normalized_url).toBe('https://example.com/path')
  })

  it('normalises a custom slug to lowercase before checking availability', async () => {
    await store.createLink({ url: 'https://example.com/docs-1', custom_slug: 'Docs' })
    await expect(store.createLink({ url: 'https://example.com/docs-2', custom_slug: 'docs' })).rejects.toThrow(
      /slug is not available/i,
    )
    const stored = sqlite.prepare('SELECT slug FROM tools_shortlinks_slugs').all() as Array<{ slug: string }>
    expect(stored.map((row) => row.slug)).toEqual(['docs'])
  })

  it('accepts the one-letter codes the old reserved list rejected', async () => {
    await expect(store.createLink({ url: 'https://example.com/s', custom_slug: 's' })).resolves.toBeTruthy()
    await expect(store.createLink({ url: 'https://example.com/l', custom_slug: 'l' })).resolves.toBeTruthy()
  })

  it('rejects a duplicate bundle name with a conflict, not a 500', async () => {
    await store.createBundle({ name: 'Campaign 2026' })
    await expect(store.createBundle({ name: 'Campaign 2026' })).rejects.toThrow(/already exists/i)
  })

  it('maps a concurrent duplicate URL to one success and one 409', async () => {
    const results = await Promise.allSettled([
      store.createLink({ url: 'https://example.com/race', custom_slug: 'race-a' }),
      store.createLink({ url: 'https://example.com/race', custom_slug: 'race-b' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected && rejected.status === 'rejected' ? rejected.reason.message : '').toMatch(/already been shortened/i)
  })
})
