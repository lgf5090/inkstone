// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOOLS_SHORTLINKS_SCHEMA_STATEMENTS } from '../src/worker/tools/shortlinks/schema'
import { ShortlinksStore } from '../src/worker/tools/shortlinks/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-life'

describe('Shortlinks link lifecycle', () => {
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

  it('takes every alias down and back up with the link switch', async () => {
    const link = await store.createLink({
      url: 'https://example.com/life',
      custom_slug: 'life-main',
    })
    await store.addSlug(link.id, 'life-alias')

    expect(await store.findSlugForRedirect('life-main')).not.toBeNull()
    expect(await store.findSlugForRedirect('life-alias')).not.toBeNull()

    await store.setLinkLifecycle(link.id, 'disabled')
    expect(await store.findSlugForRedirect('life-main')).toBeNull()
    expect(await store.findSlugForRedirect('life-alias')).toBeNull()
    expect((await store.getLinkById(link.id))?.lifecycle_state).toBe('disabled')

    const active = await store.listLinks({ status: 'active' })
    expect(active.items).toHaveLength(0)
    const disabled = await store.listLinks({ status: 'disabled' })
    expect(disabled.items.map((item) => item.id)).toContain(link.id)

    await store.setLinkLifecycle(link.id, 'active')
    expect(await store.findSlugForRedirect('life-main')).not.toBeNull()
    expect(await store.findSlugForRedirect('life-alias')).not.toBeNull()
  })

  it('archives a clicked link instead of deleting it, hiding it from the list but keeping analytics', async () => {
    const link = await store.createLink({ url: 'https://example.com/archived', custom_slug: 'life-archived' })
    await store.recordClick('life-archived', link.id, USER, { visitorFp: 'life-v1' })

    await expect(store.deleteLink(link.id)).rejects.toThrow(/archiv/i)
    await store.archiveLink(link.id)

    expect(await store.findSlugForRedirect('life-archived')).toBeNull()
    const list = await store.listLinks({ status: 'all' })
    expect(list.items.map((item) => item.id)).not.toContain(link.id)
    const stats = await store.getLinkAnalytics(link.id, 'all')
    expect(stats.total_clicks).toBe(1)
  })

  it('deletes a zero-click link and releases its slug', async () => {
    const link = await store.createLink({ url: 'https://example.com/zero', custom_slug: 'life-zero' })
    await store.deleteLink(link.id)
    expect(await store.findSlugForRedirect('life-zero')).toBeNull()
    const recreated = await store.createLink({ url: 'https://example.com/zero-again', custom_slug: 'life-zero' })
    expect(recreated.id).not.toBe(link.id)
  })

  it('refuses a slug operation aimed at the wrong link id', async () => {
    const first = await store.createLink({ url: 'https://example.com/first', custom_slug: 'life-first' })
    const second = await store.createLink({ url: 'https://example.com/second', custom_slug: 'life-second' })
    await expect(store.disableSlug(second.id, 'life-first')).rejects.toThrow(/not found/i)
    await expect(store.deleteSlug(second.id, 'life-first')).rejects.toThrow(/not found/i)
    expect((await store.getLinkById(first.id))?.slugs[0].disabled_at).toBeNull()
  })

  it('returns 404 when deleting a bundle that does not exist', async () => {
    await expect(store.deleteBundle(999999)).rejects.toThrow(/not found/i)
  })

  it('treats the password hash, not the legacy flag, as the source of truth', async () => {
    const link = await store.createLink({
      url: 'https://example.com/protected',
      password: 'correct-password',
      custom_slug: 'life-protected',
    })
    sqlite.exec(`UPDATE tools_shortlinks_links SET is_password_protected = 0 WHERE id = ${link.id}`)
    expect((await store.getLinkById(link.id))?.password_protected).toBe(true)
    expect((await store.findSlugForRedirect('life-protected'))?.is_password_protected).toBe(true)
  })
})
