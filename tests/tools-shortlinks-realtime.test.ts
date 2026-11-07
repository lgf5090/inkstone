// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOOLS_SHORTLINKS_SCHEMA_STATEMENTS } from '../src/worker/tools/shortlinks/schema'
import { ShortlinksStore } from '../src/worker/tools/shortlinks/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-realtime'

describe('Shortlinks realtime feed', () => {
  let sqlite: DatabaseSync
  let store: ShortlinksStore
  let linkId: number

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    for (const statement of TOOLS_SHORTLINKS_SCHEMA_STATEMENTS) sqlite.exec(statement)
    store = new ShortlinksStore(makeD1(sqlite), USER)
    const link = await store.createLink({ url: 'https://realtime.example.com', custom_slug: 'live-one', label: 'Live' })
    linkId = link.id
  })

  afterEach(() => {
    sqlite.close()
  })

  const insertClick = (slug: string, clickedAt: number, country: string, isBot = 0) => {
    sqlite
      .prepare(
        `INSERT INTO tools_shortlinks_clicks (user_id, link_id, slug, clicked_at, country, device_type, browser, is_bot)
         VALUES (?, ?, ?, ?, ?, 'mobile', 'Chrome', ?)`,
      )
      .run(USER, linkId, slug, clickedAt, country, isBot)
  }

  it('returns the latest page oldest-first with a cursor for the next poll', async () => {
    insertClick('live-one', 100, 'US')
    insertClick('live-one', 101, 'DE')
    insertClick('live-one', 102, 'CN')

    const feed = await store.listRealtimeClicks()
    expect(feed.items.map((item) => item.clicked_at)).toEqual([100, 101, 102])
    expect(feed.items[2]).toMatchObject({ slug: 'live-one', label: 'Live', country: 'CN', device_type: 'mobile' })
    expect(feed.latest_id).toBe(feed.items[2].id)

    insertClick('live-one', 103, 'JP')
    const next = await store.listRealtimeClicks(feed.latest_id)
    expect(next.items).toHaveLength(1)
    expect(next.items[0].country).toBe('JP')
    expect(next.latest_id).toBe(next.items[0].id)
  })

  it('marks bot clicks, caps the page and never leaks another account', async () => {
    insertClick('live-one', 200, 'US', 1)
    sqlite
      .prepare(
        `INSERT INTO tools_shortlinks_clicks (user_id, link_id, slug, clicked_at, country)
         VALUES ('other-user', 999, 'live-one', 300, 'FR')`,
      )
      .run()

    const feed = await store.listRealtimeClicks(undefined, 500)
    expect(feed.items).toHaveLength(1)
    expect(feed.items[0].is_bot).toBe(true)
    expect(feed.items[0].country).toBe('US')
  })
})
