// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOOLS_SHORTLINKS_SCHEMA_STATEMENTS } from '../src/worker/tools/shortlinks/schema'
import { ShortlinksStore } from '../src/worker/tools/shortlinks/store'
import { isBot } from '../src/worker/tools/shortlinks/ua'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-bot'
const GOOGLEBOT =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const WECHAT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47'

describe('Shortlinks bot detection', () => {
  it('keeps explicit crawler tokens and drops the library user agents that were false positives', () => {
    expect(isBot(GOOGLEBOT)).toBe(true)
    expect(isBot('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)')).toBe(true)
    expect(isBot('okhttp/4.12.0')).toBe(false)
    expect(isBot('axios/1.6.0')).toBe(false)
    expect(isBot('node-fetch/3.3.2')).toBe(false)
    expect(isBot('python-requests/2.31.0')).toBe(false)
    expect(isBot(WECHAT)).toBe(false)
    expect(isBot(CHROME)).toBe(false)
  })
})

describe('Shortlinks bot storage and filtering', () => {
  let sqlite: DatabaseSync
  let store: ShortlinksStore

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    for (const statement of TOOLS_SHORTLINKS_SCHEMA_STATEMENTS) sqlite.exec(statement)
    store = new ShortlinksStore(makeD1(sqlite), USER)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('stores bot clicks with is_bot = 1 and lets the settings switch include or exclude them', async () => {
    const link = await store.createLink({ url: 'https://bot.example.com', custom_slug: 'bot-a' })
    const slug = link.slugs[0].slug
    await store.recordClick(slug, link.id, USER, { isBot: 1, userAgent: GOOGLEBOT })
    await store.recordClick(slug, link.id, USER, { isBot: 0, userAgent: CHROME, visitorFp: 'human-a' })

    const rows = sqlite
      .prepare('SELECT is_bot FROM tools_shortlinks_clicks ORDER BY clicked_at, is_bot')
      .all() as Array<{ is_bot: number }>
    expect(rows.map((row) => row.is_bot)).toEqual([0, 1])

    const filtered = await store.getLinkAnalytics(link.id, '30d')
    expect(filtered.total_clicks).toBe(1)
    expect(filtered.bot_clicks).toBe(1)
    expect(filtered.bot_ratio).toBeCloseTo(0.5)

    await store.updateSettings({ filter_bots: false })
    const all = await store.getLinkAnalytics(link.id, '30d')
    expect(all.total_clicks).toBe(2)
    expect(all.bot_clicks).toBe(1)
    expect(all.bot_ratio).toBeCloseTo(0.5)
  })

  it('reports the bot share on the dashboard without double counting the filtered total', async () => {
    const link = await store.createLink({ url: 'https://bot-dashboard.example.com', custom_slug: 'bot-b' })
    const slug = link.slugs[0].slug
    await store.recordClick(slug, link.id, USER, { isBot: 1, userAgent: GOOGLEBOT })
    await store.recordClick(slug, link.id, USER, { isBot: 0, userAgent: WECHAT, visitorFp: 'wechat-a' })

    const stats = await store.getDashboardStats('30d')
    expect(stats.total_clicks).toBe(1)
    expect(stats.bot_clicks).toBe(1)
    expect(stats.bot_ratio).toBeCloseTo(0.5)
  })
})
