// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CreateLinkSchema } from '../src/shared/tools/shortlinks/schemas'
import { TOOLS_SHORTLINKS_SCHEMA_STATEMENTS } from '../src/worker/tools/shortlinks/schema'
import { ShortlinksStore } from '../src/worker/tools/shortlinks/store'
import { testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-tags'

describe('Shortlinks tags', () => {
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

  it('normalises tag names, removes duplicates and returns them with the link', async () => {
    const link = await store.createLink({
      url: 'https://tags.example.com/one',
      custom_slug: 'tag-one',
      tags: ['Docs', 'SEO', 'docs'],
    })
    expect(link.tags).toEqual(['docs', 'seo'])
    expect((await store.getLinkById(link.id))?.tags).toEqual(['docs', 'seo'])
  })

  it('filters the list by tag and replaces tags on update', async () => {
    const first = await store.createLink({ url: 'https://tags.example.com/a', custom_slug: 'tag-a', tags: ['news'] })
    await store.createLink({ url: 'https://tags.example.com/b', custom_slug: 'tag-b', tags: ['docs'] })

    const filtered = await store.listLinks({ tag: 'NEWS' })
    expect(filtered.total).toBe(1)
    expect(filtered.items[0].id).toBe(first.id)
    expect(filtered.items[0].tags).toEqual(['news'])

    const updated = await store.updateLink(first.id, { tags: ['archive', 'news'] })
    expect(updated.tags).toEqual(['archive', 'news'])
    expect((await store.listLinks({ tag: 'archive' })).total).toBe(1)
  })

  it('drops associations when a link is deleted and keeps tags through a backup round-trip', async () => {
    const bucket = testR2Bucket()
    const link = await store.createLink({ url: 'https://tags.example.com/keep', custom_slug: 'tag-keep', tags: ['keep'] })
    const backup = await store.createBackup(bucket)

    await store.deleteLink(link.id)
    const orphan = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM tools_shortlinks_link_tags WHERE link_id = ?')
      .get(link.id) as { cnt: number }
    expect(orphan.cnt).toBe(0)

    const restored = await store.restoreBackup(String(backup.id), bucket)
    expect(restored.imported).toBe(1)
    const links = await store.listLinks({ tag: 'keep' })
    expect(links.total).toBe(1)
    expect(links.items[0].tags).toEqual(['keep'])
  })

  it('rejects more than ten tags and characters outside the tag alphabet', () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `tag-${index}`)
    expect(CreateLinkSchema.safeParse({ url: 'https://tags.example.com', tags: eleven }).success).toBe(false)
    expect(CreateLinkSchema.safeParse({ url: 'https://tags.example.com', tags: ['bad,tag'] }).success).toBe(false)
    expect(CreateLinkSchema.safeParse({ url: 'https://tags.example.com', tags: ['valid tag'] }).success).toBe(true)
  })
})
