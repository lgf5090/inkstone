import { describe, expect, it } from 'vitest'
import {
  computeDelta,
  fillBuckets,
  fillMissingOptions,
  formatAvgPerDay,
  pad2,
  rangeToSinceTs,
} from '../src/worker/tools/shortlinks/analytics'
import { countryFlag, countryName } from '../src/worker/tools/shortlinks/country'
import { computeVisitorFingerprint, dailySaltFor } from '../src/worker/tools/shortlinks/fingerprint'
import {
  isBareOriginSelfReferrer,
  isSelfReferrer,
  normalizeHost,
  parseAppReferrer,
  parseReferrerHost,
} from '../src/worker/tools/shortlinks/referrer'
import {
  generateRandomSlug,
  isReservedSlug,
  RANDOM_CHARSET,
  validateCustomSlug,
  validateRandomSlug,
  validateSlugLength,
} from '../src/worker/tools/shortlinks/slugs'
import { SLUG_ALPHABET_SIZE } from '../src/shared/tools/shortlinks/types'
import { extractTitle, isPrivateHost } from '../src/worker/tools/shortlinks/title-fetch'
import { isBot, parseBrowser, parseDeviceType, parseOS, parseUserAgentInfo } from '../src/worker/tools/shortlinks/ua'

describe('Shortlinks Slugs Engine', () => {
  it('uses exactly the advertised alphabet size', () => {
    expect(RANDOM_CHARSET).toHaveLength(SLUG_ALPHABET_SIZE)
  })

  it('generates random slug with valid characters and length', () => {
    const slug = generateRandomSlug(6)
    expect(slug).toHaveLength(6)
    for (const char of slug) {
      expect(RANDOM_CHARSET).toContain(char)
    }
  })

  it('validates random slug', () => {
    expect(validateRandomSlug('abc')).toBeNull()
    expect(validateRandomSlug('ab')).toContain('at least 3')
    expect(validateRandomSlug('_abc')).toContain('underscore')
    expect(validateRandomSlug('abc$')).toContain('alphanumeric')
    expect(validateRandomSlug('api')).toContain('reserved')
  })

  it('validates custom slug', () => {
    expect(validateCustomSlug('my-custom-slug')).toBeNull()
    expect(validateCustomSlug('a')).toBeNull()
    expect(validateCustomSlug('123-abc')).toBeNull()
    expect(validateCustomSlug('-abc')).toContain('hyphen')
    expect(validateCustomSlug('abc-')).toContain('hyphen')
    expect(validateCustomSlug('abc_def')).toContain('hyphen')
    expect(validateCustomSlug('login')).toContain('reserved')
    expect(validateCustomSlug('')).toContain('empty')
  })

  it('identifies reserved slugs', () => {
    expect(isReservedSlug('api')).toBe(true)
    expect(isReservedSlug('tools')).toBe(true)
    expect(isReservedSlug('mcp')).toBe(true)
    expect(isReservedSlug('my-safe-slug')).toBe(false)
  })

  it('validates slug length', () => {
    expect(validateSlugLength(5)).toBeNull()
    expect(validateSlugLength(2)).toContain('>= 3')
    expect(validateSlugLength(200)).toContain('<= 128')
  })
})

describe('Shortlinks User-Agent Engine', () => {
  it('detects desktop, mobile and tablet devices', () => {
    expect(parseDeviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)')).toBe('mobile')
    expect(parseDeviceType('Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)')).toBe('tablet')
    expect(parseDeviceType('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('desktop')
  })

  it('detects operating systems correctly', () => {
    expect(parseOS('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)')).toBe('ios')
    expect(parseOS('Mozilla/5.0 (Linux; Android 13; SM-S908B)')).toBe('android')
    expect(parseOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(parseOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos')
    expect(parseOS('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
  })

  it('detects browsers and bots', () => {
    expect(parseBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36')).toBe('Chrome')
    expect(parseBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) Mobile/15E148 MicroMessenger/8.0.38')).toBe('WeChat')
    expect(parseBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/120.0.0.0')).toBe('Edge')
    expect(isBot('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true)
    expect(isBot('curl/8.4.0')).toBe(true)
    expect(isBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false)
    expect(isBot('')).toBe(true)

    const parsed = parseUserAgentInfo('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) Mobile/15E148 MicroMessenger/8.0.38')
    expect(parsed.browser).toBe('WeChat')
    expect(parsed.deviceType).toBe('mobile')
    expect(parsed.os).toBe('ios')
    expect(parsed.isBot).toBe(0)
  })
})

describe('Shortlinks Referrer Engine', () => {
  it('normalizes hosts', () => {
    expect(normalizeHost('www.example.com')).toBe('example.com')
    expect(normalizeHost('EXAMPLE.COM')).toBe('example.com')
  })

  it('parses app referrers and host domains', () => {
    expect(parseAppReferrer('android-app://com.linkedin.android/https/linkedin.com')).toEqual({ packageName: 'com.linkedin.android' })
    expect(parseReferrerHost('android-app://com.linkedin.android/')).toBe('linkedin.com')
    expect(parseReferrerHost('https://www.google.com/search?q=test')).toBe('google.com')
    expect(parseReferrerHost(null)).toBeNull()
  })

  it('detects bare origin and self loop referrers', () => {
    expect(isBareOriginSelfReferrer('https://example.com/', 'example.com')).toBe(true)
    expect(isBareOriginSelfReferrer('https://example.com/page', 'example.com')).toBe(false)
    expect(isSelfReferrer('https://example.com/abc', 'example.com')).toBe(true)
    expect(isSelfReferrer('https://example.com/l/abc', 'example.com')).toBe(true)
    expect(isSelfReferrer('https://another.com/abc', 'example.com')).toBe(false)
  })
})

describe('Shortlinks Fingerprint Engine', () => {
  it('computes rotating salt and deterministic fingerprint per day', async () => {
    const d = new Date('2026-10-26T12:00:00Z')
    const salt1 = await dailySaltFor(d, 'secret-salt')
    const salt2 = await dailySaltFor(d, 'secret-salt')
    expect(salt1).toBe(salt2)

    const fp1 = await computeVisitorFingerprint('1.2.3.4', 'Mozilla/5.0', 'secret-salt', d)
    const fp2 = await computeVisitorFingerprint('1.2.3.4', 'Mozilla/5.0', 'secret-salt', d)
    expect(fp1).toHaveLength(16)
    expect(fp1).toBe(fp2)

    const fpEmpty = await computeVisitorFingerprint('', '', 'secret')
    expect(fpEmpty).toBeNull()

    const noSecret = await computeVisitorFingerprint('1.2.3.4', 'Mozilla/5.0', null, d)
    expect(noSecret).toBeNull()
  })
})

describe('Shortlinks Title Fetcher and SSRF Defense', () => {
  it('blocks private hosts and allows public hosts', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('127.0.0.1')).toBe(true)
    expect(isPrivateHost('10.0.0.5')).toBe(true)
    expect(isPrivateHost('172.16.0.1')).toBe(true)
    expect(isPrivateHost('192.168.1.1')).toBe(true)
    expect(isPrivateHost('169.254.169.254')).toBe(true)
    expect(isPrivateHost('0.0.0.0')).toBe(true)
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('github.com')).toBe(false)
  })

  it('extracts html titles and decodes entities', () => {
    const html = '<html><head><title>My &amp; Awesome &lt;Page&gt;</title></head><body></body></html>'
    expect(extractTitle(html)).toBe('My & Awesome <Page>')
    expect(extractTitle('<div>no title</div>')).toBeNull()
  })
})

describe('Shortlinks Analytics & Country Helpers', () => {
  it('computes delta percent', () => {
    expect(computeDelta(150, 100)).toBe(50)
    expect(computeDelta(50, 100)).toBe(-50)
    expect(computeDelta(100, 100)).toBe(0)
    expect(computeDelta(100, 0)).toBeUndefined()
  })

  it('formats avg per day', () => {
    expect(formatAvgPerDay(70, '7d')).toBe('10')
    expect(formatAvgPerDay(0, '30d')).toBe('0')
    expect(formatAvgPerDay(5, '30d')).toBe('0.17')
  })

  it('fills empty buckets for time ranges', () => {
    const fixedNow = 1761480000
    const map = new Map<string, number>()
    const buckets24h = fillBuckets('24h', map, fixedNow)
    expect(buckets24h).toHaveLength(24)
    expect(buckets24h[0].count).toBe(0)

    const buckets7d = fillBuckets('7d', map, fixedNow)
    expect(buckets7d).toHaveLength(7)

    const buckets30d = fillBuckets('30d', map, fixedNow)
    expect(buckets30d).toHaveLength(30)
  })

  it('fills missing options', () => {
    const items = [{ name: 'link', count: 12 }]
    const filled = fillMissingOptions(items, ['link', 'qr'])
    expect(filled).toHaveLength(2)
    expect(filled.find((i) => i.name === 'qr')?.count).toBe(0)
  })

  it('converts country codes to flag emojis and localized names', () => {
    expect(countryFlag('US')).toBe('🇺🇸')
    expect(countryFlag('CN')).toBe('🇨🇳')
    expect(countryFlag('GB')).toBe('🇬🇧')
    expect(countryFlag('JP')).toBe('🇯🇵')
    expect(countryFlag('')).toBe('🌐')

    expect(countryName('US', 'zh-CN')).toContain('美')
    expect(countryName('CN', 'zh-CN')).toContain('中')
    expect(countryName('US', 'en-US')).toBe('United States')
  })
})
