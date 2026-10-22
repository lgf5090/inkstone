import type { ShareBreakdownItem, ShareTimelinePoint, ShareTimelineRange } from '@shared/share-hub'
import { LIMITS } from '@shared/constants'
import type { VisitTrafficFilters } from '@shared/share-selection'
import { visitTrafficSql } from './selection-sql'
import { resolveVisitorKey, type VisitorKeyEnv } from './visitor-key'

/**
 * How a visit is classified and how a reading is measured.
 *
 * Everything here is a pure function of already-stored values or of an incoming request's own fields
 * (an address, a `user_agent`, a `Referer`, a query string): no SQL, no HTTP context. The recording
 * side calls the classifiers and stores their answer, so a reading never re-derives a bot from a
 * string a later rule change would reinterpret; the reading side calls the math, which is why the
 * timeline, the per-day rate and the range vocabulary all live in one module the dashboards share.
 */

export function parseDeviceType(ua: string): string {
  if (!ua) return 'desktop'
  if (/iPad|Tablet/i.test(ua)) return 'tablet'
  if (/Mobile|Android.*Mobile|iPhone|iPod/i.test(ua)) return 'mobile'
  if (/Android/i.test(ua)) return 'tablet'
  return 'desktop'
}

export function parseOS(ua: string): string {
  if (!ua) return 'Other'
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS'
  if (/Linux/.test(ua)) return 'Linux'
  return 'Other'
}

const BOT_PATTERNS = new RegExp(
  [
    'bot\\b',
    'crawl',
    'spider',
    'slurp',
    'googlebot',
    'bingbot',
    'baiduspider',
    'yandexbot',
    'duckduckbot',
    'sogou',
    'bytespider',
    'yisouspider',
    'semrush',
    'ahrefs',
    'dotbot',
    'petalbot',
    'facebookexternalhit',
    'twitterbot',
    'slackbot',
    'discordbot',
    'telegrambot',
    'mediapartners',
    'embedly',
    'feedfetcher',
    'whatsapp',
    'skypeuri',
    'preview',
    'curl/',
    'wget/',
    'python-requests',
    'python-urllib',
    'go-http-client',
    'java/',
    'okhttp',
    'axios/',
    'node-fetch',
    'httpclient',
    'scrapy',
    'aiohttp',
    'libwww',
    'headlesschrome',
    'puppeteer',
    'phantomjs',
    'selenium',
    'playwright',
    'lighthouse',
    'pagespeed',
  ].join('|'),
  'i',
)

export function isBot(ua: string): boolean {
  if (!ua || ua.trim() === '') return true
  return BOT_PATTERNS.test(ua)
}

export function parseBotName(ua: string): string | null {
  if (!ua || ua.trim() === '') return 'Empty UA'
  if (/googlebot/i.test(ua)) return 'Googlebot'
  if (/bingbot/i.test(ua)) return 'Bingbot'
  if (/baiduspider/i.test(ua)) return 'Baiduspider'
  if (/bytespider/i.test(ua)) return 'ByteSpider'
  if (/sogou/i.test(ua)) return 'Sogou'
  if (/yisou/i.test(ua)) return 'YisouSpider'
  if (/yandex/i.test(ua)) return 'YandexBot'
  if (/duckduck/i.test(ua)) return 'DuckDuckBot'
  if (/telegrambot/i.test(ua)) return 'TelegramBot'
  if (/twitterbot/i.test(ua)) return 'TwitterBot'
  if (/facebookexternalhit/i.test(ua)) return 'FacebookBot'
  if (/slackbot/i.test(ua)) return 'Slackbot'
  if (/discordbot/i.test(ua)) return 'DiscordBot'
  if (/curl\//i.test(ua)) return 'cURL'
  if (/wget\//i.test(ua)) return 'Wget'
  if (/python/i.test(ua)) return 'Python'
  if (/go-http-client/i.test(ua)) return 'Go-Client'
  if (/headlesschrome/i.test(ua)) return 'HeadlessChrome'
  if (/puppeteer/i.test(ua)) return 'Puppeteer'
  if (/playwright/i.test(ua)) return 'Playwright'
  if (/spider|crawler|crawl/i.test(ua)) return 'Crawler'
  if (isBot(ua)) return 'Bot'
  return null
}

/**
 * The log table labels a visitor by the head of its fingerprint and nothing more; the stored digest
 * is a pseudonymous identifier, so only this much of it is ever allowed to leave the worker. Both
 * surfaces that show a fingerprint — the log rows and the session view — read this one number, so
 * the same visit cannot be labelled two different ways depending on which panel is open.
 */
export const VISITOR_FP_DISPLAY_CHARS = 8

export function publicVisitorFingerprint(digest: string | null): string {
  return digest ? digest.slice(0, VISITOR_FP_DISPLAY_CHARS) : ''
}

export function parseBrowser(ua: string): string {
  if (!ua) return 'Other'
  if (/EdgA?\//.test(ua)) return 'Edge'
  if (/OPR\/|Opera/.test(ua)) return 'Opera'
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet'
  if (/YaBrowser\//.test(ua)) return 'Yandex'
  if (/Brave/.test(ua)) return 'Brave'
  if (/Vivaldi\//.test(ua)) return 'Vivaldi'
  if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'Chrome'
  if (/Chromium\//.test(ua)) return 'Chromium'
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/MSIE|Trident/.test(ua)) return 'IE'
  return 'Other'
}

const APP_PACKAGE_TO_DOMAIN: Record<string, string> = {
  'com.linkedin.android': 'linkedin.com',
  'com.twitter.android': 'x.com',
  'com.facebook.katana': 'facebook.com',
  'com.facebook.lite': 'facebook.com',
  'com.instagram.android': 'instagram.com',
  'com.zhiliaoapp.musically': 'tiktok.com',
  'com.ss.android.ugc.trill': 'tiktok.com',
  'com.reddit.frontpage': 'reddit.com',
  'com.pinterest': 'pinterest.com',
  'com.Slack': 'slack.com',
  'com.discord': 'discord.com',
  'org.telegram.messenger': 'telegram.org',
  'com.whatsapp': 'whatsapp.com',
  'com.google.android.youtube': 'youtube.com',
  'com.google.android.gm': 'gmail.com',
  'com.microsoft.office.outlook': 'outlook.com',
}

const APP_SCHEME_PREFIXES = ['android-app://', 'ios-app://'] as const

export function normalizeHost(host: string): string {
  let lower = host.toLowerCase().trim()
  if (lower.startsWith('www.')) lower = lower.slice(4)
  const colonIndex = lower.indexOf(':')
  if (colonIndex !== -1) lower = lower.slice(0, colonIndex)
  return lower
}

function parseAppReferrer(rawReferrer: string): { packageName: string } | null {
  for (const prefix of APP_SCHEME_PREFIXES) {
    if (rawReferrer.startsWith(prefix)) {
      const rest = rawReferrer.slice(prefix.length)
      const pkg = rest.split('/')[0]
      return pkg ? { packageName: pkg } : null
    }
  }
  return null
}

export function parseReferrerHost(rawReferrer: string | null): string | null {
  if (!rawReferrer) return null
  const app = parseAppReferrer(rawReferrer)
  if (app) return APP_PACKAGE_TO_DOMAIN[app.packageName] ?? null
  try {
    return normalizeHost(new URL(rawReferrer).hostname)
  } catch {
    return null
  }
}

const REFERRER_PROTOCOLS = new Set(['http:', 'https:', 'android-app:', 'ios-app:'])

// Only browser-resolvable schemes earn a row; the raw candidate may carry query
// tokens or fragments, so http(s) stores origin+path only.
export function sanitizeVisitReferrer(
  rawReferrer: string | null,
  dropSelfPath?: string,
): { referrer: string | null; referrerHost: string | null } {
  if (!rawReferrer) return { referrer: null, referrerHost: null }
  try {
    const u = new URL(rawReferrer)
    if (!REFERRER_PROTOCOLS.has(u.protocol)) return { referrer: null, referrerHost: null }
    if (dropSelfPath && (u.pathname === dropSelfPath || u.pathname === `${dropSelfPath}/`)) {
      return { referrer: null, referrerHost: null }
    }
    const referrer = u.protocol === 'http:' || u.protocol === 'https:'
      ? `${u.origin}${u.pathname}`
      : u.href
    return {
      referrer: referrer.slice(0, LIMITS.shareReferrerMaxLength),
      referrerHost: parseReferrerHost(rawReferrer),
    }
  } catch { /* An unparseable candidate degrades analytics to a null referrer. */ return { referrer: null, referrerHost: null } }
}

export function isSelfReferrer(rawReferrer: string | null, requestHost: string, currentSlug?: string): boolean {
  if (!rawReferrer) return false
  try {
    const u = new URL(rawReferrer)
    const host = normalizeHost(requestHost)
    const isSameHost = normalizeHost(u.hostname) === host || normalizeHost(u.host) === host
    if (!isSameHost) return false
    if (currentSlug && (u.pathname === `/s/${currentSlug}` || u.pathname === `/s/${currentSlug}/`)) {
      return false
    }
    return true
  } catch {
    return false
  }
}

const encoder = new TextEncoder()

function toHex(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes)
  let out = ''
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, '0')
  }
  return out
}

function utcDateKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * The pseudonymous handle a distinct-visitor count is built from.
 *
 * `visitorKey` is the deployment's own key — `resolveVisitorKey()` hands one out whether or not the
 * environment has a secret, so there is no "secret missing" reading here and no path that returns a
 * null fingerprint for a configured-but-plain deployment. A null answer means one thing only: the
 * request carried neither an address nor a user agent, so there is nothing to hash and no visitor to
 * tell apart. The digest is salted per UTC day and truncated, so it cannot be replayed across a date
 * boundary or reversed to the address it came from.
 */
export async function computeVisitorFingerprint(
  ip: string | null | undefined,
  userAgent: string | null | undefined,
  visitorKey: string,
  now: Date = new Date(),
): Promise<string | null> {
  const ipStr = (ip ?? '').trim()
  const uaStr = (userAgent ?? '').trim()
  if (ipStr.length === 0 && uaStr.length === 0) return null

  const dateKey = utcDateKey(now)
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(visitorKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(dateKey))
  const salt = toHex(sig)

  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${ipStr}|${uaStr}|${salt}`))
  return toHex(digest).slice(0, 32)
}

/**
 * The fingerprint the recording path stores, with the key resolution folded in.
 *
 * One call rather than two steps at every reader: a route that hashed with a salt of its own, or with
 * none, would split one visitor into two rows and quietly inflate the account's UV — the failure the
 * auto-minted key in `visitor-key.ts` exists to prevent.
 */
export async function visitorFingerprint(
  env: VisitorKeyEnv,
  ip: string | null | undefined,
  userAgent: string | null | undefined,
  now: Date = new Date(),
): Promise<string | null> {
  const visitorKey = await resolveVisitorKey(env)
  if (visitorKey === null) {
    // Unreachable through `resolveVisitorKey` (it mints a key when none is configured), and a
    // fingerprint is not something to guess at: fail the recording rather than store a wrong one.
    throw new Error('visitor key unavailable')
  }
  return computeVisitorFingerprint(ip, userAgent, visitorKey, now)
}

/**
 * Views per day over a window of `daysSpan` days, to one decimal. The decimal is the point: on a
 * one-day window the rate equals the total, and an integer rounding made a 7-day window read
 * "42" next to a total that had just been divided by exactly 7 — the label said average, the
 * number said rounded. A window shorter than a day is still measured per day, never per zero.
 */
export function perDayRate(views: number, daysSpan: number): number {
  return Math.round((views / Math.max(1, daysSpan)) * 10) / 10
}

/**
 * The change against the previous period, or nothing at all when that period holds no traffic. A
 * previous of 0 can only answer 0% (a trend measured against nothing) or +100% (a rise from
 * nothing), and the second one is what made the first week of traffic to a blog read as "+100%";
 * both dashboards now draw no badge there instead.
 */
export function computeDelta(current: number, previous: number): number | undefined {
  if (previous === 0) return undefined
  return Math.round(((current - previous) / previous) * 100)
}

export function getRangeStartTimestamp(range: ShareTimelineRange, now: number): number {
  if (range === '24h') return now - 24 * 60 * 60 * 1000
  if (range === '7d') return now - 7 * 24 * 60 * 60 * 1000
  if (range === '30d') return now - 30 * 24 * 60 * 60 * 1000
  return 0
}

export const DAY_MS = 24 * 60 * 60 * 1000
const SHARE_ANALYTICS_RANGES: readonly string[] = ['24h', '7d', '30d', 'all']

/**
 * How many rows one top-N card may carry.
 *
 * The API cuts the list here and the client draws what it is given: a second cap in a component would
 * be a number the reader can only ever see half of, and a card that shows five of ten rows while the
 * response says ten is a card whose "top" means something different on every screen.
 */
export const ANALYTICS_CARD_LIMIT = 10

// An unknown range is a client bug, not a request for the whole table: 30d is
// the widest window a sanitized query may ask for.
export function shareRangeFromQuery(raw: string | undefined): ShareTimelineRange {
  if (!raw) return '7d'
  return (SHARE_ANALYTICS_RANGES.includes(raw) ? raw : '30d') as ShareTimelineRange
}

export interface AnalyticsRequest {
  range: ShareTimelineRange
  filters: VisitTrafficFilters
  clause: string
  now: number
}

export function parseAnalyticsRequest(c: { req: { query(key: string): string | undefined } }): AnalyticsRequest {
  const range = shareRangeFromQuery(c.req.query('range'))
  const filters: VisitTrafficFilters = {
    excludeBots: c.req.query('excludeBots') !== 'false',
    excludeSelfReferrers: c.req.query('excludeSelf') === 'true',
    excludeOwner: c.req.query('excludeOwner') === 'true',
  }
  return { range, filters, clause: visitTrafficSql(filters), now: Date.now() }
}

export interface AnalyticsWindow {
  startTs: number
  duration: number
  prevStartTs: number
}

// `all` has no fixed span, so it is scoped by the earliest visit the caller can
// find; without one the window stays recent instead of starting at epoch.
export function analyticsWindow(range: ShareTimelineRange, now: number, minVisitedAt: number | null = null): AnalyticsWindow {
  const startTs = range === 'all' ? (minVisitedAt ?? now - 30 * DAY_MS) : getRangeStartTimestamp(range, now)
  const duration = range === 'all' ? Math.max(now - startTs, DAY_MS) : now - startTs
  return { startTs, duration, prevStartTs: startTs - duration }
}

export function toBreakdown(map: Map<string, number>, total: number): ShareBreakdownItem[] {
  return Array.from(map.entries())
    .map(([name, count]) => ({
      name,
      count,
      percentage: total > 0 ? Math.round((count / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, ANALYTICS_CARD_LIMIT)
}

export interface TimelineBucket {
  views: number
  visitors: number
}

export function timelineBucketCount(range: ShareTimelineRange): number {
  if (range === '24h') return 24
  if (range === '7d') return 7
  if (range === '30d') return 30
  return 12
}

function timelineBucketLabel(range: ShareTimelineRange, bucketStart: number): string {
  const d = new Date(bucketStart)
  if (range === '24h') return `${String(d.getHours()).padStart(2, '0')}:00`
  if (range === 'all') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// Buckets are addressed by index so both the row path and a SQL GROUP BY can
// fill the same array; missing indexes stay zero-filled.
export function buildBucketedTimeline(
  buckets: TimelineBucket[],
  range: ShareTimelineRange,
  startTs: number,
  duration: number,
): ShareTimelinePoint[] {
  const numBuckets = timelineBucketCount(range)
  const bucketDuration = duration / numBuckets
  return Array.from({ length: numBuckets }, (_, index) => {
    const bucketStart = startTs + index * bucketDuration
    return {
      label: timelineBucketLabel(range, bucketStart),
      timestamp: bucketStart,
      views: buckets[index]?.views ?? 0,
      visitors: buckets[index]?.visitors ?? 0,
    }
  })
}

export function bucketsFromVisitRows(
  rows: Array<{ visited_at: number; visitor_fp: string | null }>,
  range: ShareTimelineRange,
  startTs: number,
  duration: number,
): TimelineBucket[] {
  const numBuckets = timelineBucketCount(range)
  const bucketDuration = duration / numBuckets
  const buckets: TimelineBucket[] = Array.from({ length: numBuckets }, () => ({ views: 0, visitors: 0 }))
  const uniqueVisitors: Array<Set<string>> = Array.from({ length: numBuckets }, () => new Set<string>())
  for (const row of rows) {
    const index = Math.floor((row.visited_at - startTs) / bucketDuration)
    if (index < 0 || index >= numBuckets) continue
    buckets[index].views += 1
    if (row.visitor_fp) uniqueVisitors[index].add(row.visitor_fp)
  }
  for (let i = 0; i < numBuckets; i++) {
    buckets[i].visitors = uniqueVisitors[i].size
  }
  return buckets
}

export function buildShareTimeline(
  rows: Array<{ visited_at: number; visitor_fp: string | null }>,
  range: ShareTimelineRange,
  startTs: number,
  duration: number,
): ShareTimelinePoint[] {
  return buildBucketedTimeline(bucketsFromVisitRows(rows, range, startTs, duration), range, startTs, duration)
}
