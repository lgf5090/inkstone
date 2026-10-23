import { describe, expect, it } from 'vitest'
import { LIMITS } from '@shared/constants'
import {
  ANALYTICS_CARD_LIMIT,
  DAY_MS,
  VISITOR_FP_DISPLAY_CHARS,
  analyticsWindow,
  bucketsFromVisitRows,
  buildBucketedTimeline,
  buildShareTimeline,
  computeDelta,
  computeVisitorFingerprint,
  getRangeStartTimestamp,
  isBot,
  isSelfReferrer,
  normalizeHost,
  parseAnalyticsRequest,
  parseBotName,
  parseBrowser,
  parseDeviceType,
  parseOS,
  parseReferrerHost,
  perDayRate,
  publicVisitorFingerprint,
  sanitizeVisitReferrer,
  shareRangeFromQuery,
  timelineBucketCount,
  toBreakdown,
  visitorFingerprint,
} from './analytics'
import { resetVisitorKeyCache } from './visitor-key'
import type { VisitorKeyEnv } from './visitor-key'
import type { ShareTimelineRange } from '@shared/share-hub'

const NOW = 2_000_000_000_000

/** A UA no rule below claims, so a parser's fallback is the only thing it can exercise. */
const PLAIN_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

describe('visit classification', () => {
  it('reads a desktop, a phone and a tablet out of the same string family', () => {
    expect(parseDeviceType(PLAIN_DESKTOP_UA)).toBe('desktop')
    expect(parseOS(PLAIN_DESKTOP_UA)).toBe('macOS')
    expect(parseBrowser(PLAIN_DESKTOP_UA)).toBe('Chrome')
    expect(isBot(PLAIN_DESKTOP_UA)).toBe(false)

    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
    expect(parseDeviceType(iphone)).toBe('mobile')
    expect(parseOS(iphone)).toBe('iOS')
    expect(parseBrowser(iphone)).toBe('Safari')

    const ipad =
      'Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
    expect(parseDeviceType(ipad)).toBe('tablet')
    expect(parseOS(ipad)).toBe('iOS')

    const androidPhone =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36'
    expect(parseDeviceType(androidPhone)).toBe('mobile')
    expect(parseOS(androidPhone)).toBe('Android')
    // Bare Android is a tablet until the string says it is a phone, and Linux under it loses to it.
    expect(parseDeviceType('Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36')).toBe('tablet')

    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
    expect(parseOS(edge)).toBe('Windows')
    expect(parseBrowser(edge)).toBe('Edge')

    expect(parseOS('Mozilla/5.0 (X11; CrOS x86_64) AppleWebKit/537.36')).toBe('ChromeOS')
    expect(parseOS('Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0')).toBe('Linux')
    expect(parseBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0')).toBe('Firefox')
    expect(parseBrowser('nothing recognizable')).toBe('Other')
    // An empty UA has no shape to read, so every bucket answers its own fallback label.
    expect(parseDeviceType('')).toBe('desktop')
    expect(parseOS('')).toBe('Other')
    expect(parseBrowser('')).toBe('Other')
  })

  it('names the crawlers and leaves a browser unnamed', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true)
    expect(isBot('curl/8.4.0')).toBe(true)
    expect(isBot('python-requests/2.31.0')).toBe(true)
    // No UA at all is the shapeless case, and it is a bot for counting purposes.
    expect(isBot('')).toBe(true)
    expect(isBot('   ')).toBe(true)

    expect(parseBotName('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe('Googlebot')
    expect(parseBotName('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)')).toBe('Bingbot')
    expect(parseBotName('Baiduspider+(+http://www.baidu.com/search/spider.htm)')).toBe('Baiduspider')
    expect(parseBotName('Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)')).toBe('ByteSpider')
    expect(parseBotName('Twitterbot/1.0')).toBe('TwitterBot')
    expect(parseBotName('facebookexternalhit/1.1')).toBe('FacebookBot')
    expect(parseBotName('TelegramBot (like TwitterBot)')).toBe('TelegramBot')
    expect(parseBotName('curl/7.88.1')).toBe('cURL')
    expect(parseBotName('python-requests/2.31.0')).toBe('Python')
    expect(parseBotName('Go-http-client/1.1')).toBe('Go-Client')
    expect(parseBotName('SomeCrawler/1.0')).toBe('Crawler')
    expect(parseBotName('a-bot-of-no-particular-name')).toBe('Bot')
    expect(parseBotName('')).toBe('Empty UA')
    expect(parseBotName(PLAIN_DESKTOP_UA)).toBeNull()
  })
})

describe('referrer parsing', () => {
  it('normalizes hosts, reads referrers and refuses what is not a source', () => {
    expect(normalizeHost('www.google.com')).toBe('google.com')
    expect(normalizeHost('google.com:443')).toBe('google.com')
    expect(normalizeHost('SUB.DOMAIN.COM:8080')).toBe('sub.domain.com')

    expect(parseReferrerHost('https://github.com/user/repo?ref=readme')).toBe('github.com')
    expect(parseReferrerHost('https://www.twitter.com/post/123')).toBe('twitter.com')
    expect(parseReferrerHost('invalid-url')).toBeNull()
    expect(parseReferrerHost(null)).toBeNull()
    // An app scheme is only a source when the package is one this table knows.
    expect(parseReferrerHost('android-app://com.linkedin.android')).toBe('linkedin.com')
    expect(parseReferrerHost('android-app://com.example.unknown')).toBeNull()
  })

  it('stores origin+path only, and nothing for a scheme a browser cannot follow', () => {
    const stripped = sanitizeVisitReferrer('https://news.example.com/story/1?token=secret#a')
    expect(stripped).toEqual({ referrer: 'https://news.example.com/story/1', referrerHost: 'news.example.com' })

    expect(sanitizeVisitReferrer('javascript:alert(1)')).toEqual({ referrer: null, referrerHost: null })
    expect(sanitizeVisitReferrer(null)).toEqual({ referrer: null, referrerHost: null })
    expect(sanitizeVisitReferrer('not a url')).toEqual({ referrer: null, referrerHost: null })
    // The link's own page is not a referrer, with or without the trailing slash.
    expect(sanitizeVisitReferrer('https://inkstone.app/s/abc', '/s/abc').referrer).toBeNull()
    expect(sanitizeVisitReferrer('https://inkstone.app/s/abc/', '/s/abc').referrer).toBeNull()
    expect(sanitizeVisitReferrer(`https://example.com/${'x'.repeat(LIMITS.shareReferrerMaxLength)}`).referrer)
      .toHaveLength(LIMITS.shareReferrerMaxLength)
  })

  it('tells a self-referral from a visit that came from the link itself', () => {
    expect(isSelfReferrer('https://inkstone.app/notes/123', 'inkstone.app')).toBe(true)
    expect(isSelfReferrer('https://www.inkstone.app/notes/123', 'inkstone.app')).toBe(true)
    expect(isSelfReferrer('https://inkstone.app:8787/notes/123', 'inkstone.app:8787')).toBe(true)
    expect(isSelfReferrer('https://external-site.com', 'inkstone.app')).toBe(false)
    expect(isSelfReferrer(null, 'inkstone.app')).toBe(false)
    expect(isSelfReferrer('garbage', 'inkstone.app')).toBe(false)
    // A tap on the link from its own page is a visit from outside, not a self-referral.
    expect(isSelfReferrer('https://inkstone.app/s/abc', 'inkstone.app', 'abc')).toBe(false)
    expect(isSelfReferrer('https://inkstone.app/s/other', 'inkstone.app', 'abc')).toBe(true)
  })
})

describe('visitor fingerprint privacy', () => {
  it('hashes to a stable 32-char digest and never to a null for a configured key', async () => {
    const first = await computeVisitorFingerprint('203.0.113.195', PLAIN_DESKTOP_UA, 'key-a', new Date(NOW))
    const again = await computeVisitorFingerprint('203.0.113.195', PLAIN_DESKTOP_UA, 'key-a', new Date(NOW))
    expect(first).toHaveLength(32)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(first).toBe(again)
  })

  it('separates visitors by address, by UA, by key and by UTC day', async () => {
    const base = await computeVisitorFingerprint('203.0.113.195', PLAIN_DESKTOP_UA, 'key-a', new Date(NOW))
    expect(await computeVisitorFingerprint('198.51.100.42', PLAIN_DESKTOP_UA, 'key-a', new Date(NOW))).not.toBe(base)
    expect(await computeVisitorFingerprint('203.0.113.195', 'Mozilla/5.0 Windows', 'key-a', new Date(NOW))).not.toBe(base)
    expect(await computeVisitorFingerprint('203.0.113.195', PLAIN_DESKTOP_UA, 'key-b', new Date(NOW))).not.toBe(base)
    // The salt is per UTC day, so a digest cannot be replayed across a date boundary.
    const nextDay = await computeVisitorFingerprint('203.0.113.195', PLAIN_DESKTOP_UA, 'key-a', new Date(NOW + DAY_MS))
    expect(nextDay).not.toBe(base)
  })

  it('answers null only when there is nothing to hash', async () => {
    expect(await computeVisitorFingerprint(null, null, 'key-a', new Date(NOW))).toBeNull()
    expect(await computeVisitorFingerprint('   ', '', 'key-a', new Date(NOW))).toBeNull()
    // Either handle alone is enough to tell two visits apart.
    expect(await computeVisitorFingerprint('203.0.113.195', null, 'key-a', new Date(NOW))).toHaveLength(32)
    expect(await computeVisitorFingerprint(null, PLAIN_DESKTOP_UA, 'key-a', new Date(NOW))).toHaveLength(32)
  })

  it('publishes only the head of the digest, and nothing for an unknown visitor', () => {
    expect(VISITOR_FP_DISPLAY_CHARS).toBe(8)
    expect(publicVisitorFingerprint('0123456789abcdef0123456789abcdef')).toBe('01234567')
    expect(publicVisitorFingerprint(null)).toBe('')
  })

  it('takes its salt from resolveVisitorKey, configured or minted, and never answers null for a plain deployment', async () => {
    const meta = new Map<string, string>()
    const db = {
      prepare(sql: string) {
        let bound: unknown[] = []
        const statement = {
          bind(...values: unknown[]) {
            bound = values
            return statement
          },
          async first() {
            return sql.includes('SELECT value FROM app_meta')
              ? { value: meta.get(String(bound[0])) ?? undefined }
              : null
          },
          async run() {
            if (sql.includes('INSERT INTO app_meta')) meta.set(String(bound[0]), String(bound[1]))
            return { meta: { changes: 1 } }
          },
        }
        return statement
      },
    } as unknown as VisitorKeyEnv['DB']

    // A deployment with no secret still fingerprints: the key is minted into app_meta and read back.
    resetVisitorKeyCache()
    const env: VisitorKeyEnv = { DB: db }
    const minted = await visitorFingerprint(env, '203.0.113.195', PLAIN_DESKTOP_UA, new Date(NOW))
    expect(minted).toHaveLength(32)
    expect(meta.size).toBe(1)
    expect(await visitorFingerprint(env, '203.0.113.195', PLAIN_DESKTOP_UA, new Date(NOW))).toBe(minted)

    resetVisitorKeyCache()
    const configured = await visitorFingerprint(
      { DB: db, VISIT_FP_SECRET: 'deployment-secret' },
      '203.0.113.195',
      PLAIN_DESKTOP_UA,
      new Date(NOW),
    )
    expect(configured).toHaveLength(32)
    expect(configured).not.toBe(minted)
    expect(await visitorFingerprint(env, null, null, new Date(NOW))).toBeNull()
    resetVisitorKeyCache()
  })
})

describe('analytics math', () => {
  it('keeps the per-day rate honest on a one-day window', () => {
    expect(perDayRate(300, 1)).toBe(300)
    expect(perDayRate(300, 7)).toBe(42.9)
    expect(perDayRate(0, 7)).toBe(0)
    // A window shorter than a day is still measured per day, never per zero days.
    expect(perDayRate(5, 0)).toBe(5)
  })

  it('reports no trend against an empty previous period', () => {
    expect(computeDelta(150, 100)).toBe(50)
    expect(computeDelta(50, 100)).toBe(-50)
    expect(computeDelta(100, 100)).toBe(0)
    // 0/0 is indeterminate and 0 to n is a rise from nothing: neither is a number to print.
    expect(computeDelta(50, 0)).toBeUndefined()
    expect(computeDelta(0, 0)).toBeUndefined()
  })

  it('cuts a breakdown at the one card limit the API applies', () => {
    const wide = new Map(Array.from({ length: ANALYTICS_CARD_LIMIT + 5 }, (_, index) => [`n${index}`, index + 1]))
    const items = toBreakdown(wide, 100)
    expect(items).toHaveLength(ANALYTICS_CARD_LIMIT)
    // Sorted by count, largest first, and the percentages are of the caller's total.
    expect(items[0]).toEqual({ name: `n${ANALYTICS_CARD_LIMIT + 4}`, count: ANALYTICS_CARD_LIMIT + 5, percentage: 15 })
    expect(toBreakdown(new Map([['a', 3], ['b', 1]]), 4)).toEqual([
      { name: 'a', count: 3, percentage: 75 },
      { name: 'b', count: 1, percentage: 25 },
    ])
    // A total of zero has no denominator; a percentage of 0 beats a divide by zero.
    expect(toBreakdown(new Map([['a', 0]]), 0)).toEqual([{ name: 'a', count: 0, percentage: 0 }])
  })
})

describe('range resolution and window math', () => {
  function query(values: Record<string, string>) {
    return { req: { query: (key: string) => values[key] } }
  }

  it('falls back to 7d without a range and 30d for an unknown one', () => {
    expect(shareRangeFromQuery(undefined)).toBe('7d')
    expect(shareRangeFromQuery('24h')).toBe('24h')
    expect(shareRangeFromQuery('7d')).toBe('7d')
    expect(shareRangeFromQuery('30d')).toBe('30d')
    expect(shareRangeFromQuery('all')).toBe('all')
    expect(shareRangeFromQuery('zzz')).toBe('30d')
  })

  it('starts each range window at the right distance and puts `all` at epoch', () => {
    expect(getRangeStartTimestamp('24h', NOW)).toBe(NOW - DAY_MS)
    expect(getRangeStartTimestamp('7d', NOW)).toBe(NOW - 7 * DAY_MS)
    expect(getRangeStartTimestamp('30d', NOW)).toBe(NOW - 30 * DAY_MS)
    expect(getRangeStartTimestamp('all', NOW)).toBe(0)
  })

  it('scopes the all window to the earliest visit and keeps 30d without one', () => {
    expect(analyticsWindow('all', NOW, NOW - 10 * DAY_MS)).toEqual({
      startTs: NOW - 10 * DAY_MS,
      duration: 10 * DAY_MS,
      prevStartTs: NOW - 20 * DAY_MS,
    })
    expect(analyticsWindow('all', NOW, NOW)).toEqual({
      startTs: NOW,
      // A window of no width at all would divide by zero in the per-day rate.
      duration: DAY_MS,
      prevStartTs: NOW - DAY_MS,
    })
    expect(analyticsWindow('all', NOW, null).startTs).toBe(NOW - 30 * DAY_MS)
    expect(analyticsWindow('7d', NOW)).toEqual({ startTs: NOW - 7 * DAY_MS, duration: 7 * DAY_MS, prevStartTs: NOW - 14 * DAY_MS })
    expect(analyticsWindow('24h', NOW).prevStartTs).toBe(NOW - 2 * DAY_MS)
    expect(analyticsWindow('30d', NOW).startTs).toBe(NOW - 30 * DAY_MS)
  })

  it('reads the three traffic filters with bots excluded by default', () => {
    const parsed = parseAnalyticsRequest(query({ range: '7d' }))
    expect(parsed.range).toBe('7d')
    expect(parsed.filters).toEqual({ excludeBots: true, excludeSelfReferrers: false, excludeOwner: false })
    expect(parsed.clause).toBe(' AND is_bot = 0')

    const raw = parseAnalyticsRequest(query({ excludeBots: 'false' }))
    expect(raw.clause).toBe('')

    // The bot filter stays on unless it is turned off, so the other two add to it rather than replace it.
    const narrowed = parseAnalyticsRequest(query({ excludeSelf: 'true', excludeOwner: 'true' }))
    expect(narrowed.clause).toBe(' AND is_bot = 0 AND is_self_referrer = 0 AND is_owner = 0')

    const rawBots = parseAnalyticsRequest(query({ excludeBots: 'false', excludeSelf: 'true', excludeOwner: 'true' }))
    expect(rawBots.filters).toEqual({ excludeBots: false, excludeSelfReferrers: true, excludeOwner: true })
    expect(rawBots.clause).toBe(' AND is_self_referrer = 0 AND is_owner = 0')
  })
})

describe('timeline bucketing', () => {
  it('answers one bucket per range and keeps out-of-window rows out of them', () => {
    const counts: Record<ShareTimelineRange, number> = { '24h': 24, '7d': 7, '30d': 30, all: 12 }
    for (const [range, expected] of Object.entries(counts) as Array<[ShareTimelineRange, number]>) {
      expect(timelineBucketCount(range)).toBe(expected)
    }

    const window = analyticsWindow('7d', NOW)
    const rows = [
      { visited_at: window.startTs - 1, visitor_fp: 'before' },
      { visited_at: NOW - 2 * DAY_MS, visitor_fp: 'a' },
      { visited_at: NOW - 2 * DAY_MS + 1, visitor_fp: 'a' },
      { visited_at: NOW - DAY_MS, visitor_fp: null },
      { visited_at: NOW + DAY_MS, visitor_fp: 'future' },
    ]
    const buckets = bucketsFromVisitRows(rows, '7d', window.startTs, window.duration)
    expect(buckets).toHaveLength(7)
    // The window's last bucket is the day ending now; the two rows above share it and one visitor.
    expect(buckets[5]).toEqual({ views: 2, visitors: 1 })
    expect(buckets[6]).toEqual({ views: 1, visitors: 0 })
    expect(buckets.reduce((sum, bucket) => sum + bucket.views, 0)).toBe(3)
    expect(buildShareTimeline(rows, '7d', window.startTs, window.duration)).toEqual(
      buildBucketedTimeline(buckets, '7d', window.startTs, window.duration),
    )

    const sparse = buildBucketedTimeline([], '7d', window.startTs, window.duration)
    expect(sparse.every((point) => point.views === 0 && point.visitors === 0)).toBe(true)
    expect(sparse.map((point) => point.timestamp)).toEqual(
      Array.from({ length: 7 }, (_, index) => window.startTs + index * DAY_MS),
    )
    // A day bucket is labelled by the local date it starts on, which is what the axis prints.
    expect(sparse.map((point) => point.label)).toHaveLength(7)
    const start = new Date(window.startTs)
    expect(sparse[0]?.label).toBe(
      `${String(start.getMonth() + 1).padStart(2, '0')}/${String(start.getDate()).padStart(2, '0')}`,
    )
  })

  it('labels hourly buckets by hour and the unbounded range by month', () => {
    const hours = buildBucketedTimeline([{ views: 1, visitors: 1 }], '24h', NOW, DAY_MS)
    expect(hours).toHaveLength(24)
    expect(hours[0]?.label).toBe(`${String(new Date(NOW).getHours()).padStart(2, '0')}:00`)

    const months = buildBucketedTimeline([], 'all', NOW - 360 * DAY_MS, 360 * DAY_MS)
    expect(months).toHaveLength(12)
    expect(months[0]?.label).toMatch(/^\d{4}-\d{2}$/)
  })
})
