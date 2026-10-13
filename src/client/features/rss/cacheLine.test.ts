/**
 * The cache line's own words, including the two cases where it has to admit what it does not know.
 *
 * A feed the ledger never measured gets a date and no count, and a channel where one feed answered
 * recently is not called stale by the other twelve — a notice that fires wrongly is a notice the
 * reader learns to ignore.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { shortSince } from '../../lib/time'
import { channelCachedSince, channelCacheLine, feedCacheLine } from './cacheLine'
import type { RssCacheMeta } from './store'

const HOUR = 60 * 60 * 1000

function meta(over: Partial<RssCacheMeta> = {}): RssCacheMeta {
  return { fetchedAt: Date.now() - HOUR, bytes: 5000, body: 4200, count: 15, ...over }
}

beforeAll(async () => {
  await initI18n()
})

describe('one feed line', () => {
  it('names the articles it holds and when they arrived', () => {
    const parts = feedCacheLine(meta()).split(' · ')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toContain('15')
  })

  it('says nothing was fetched when the ledger has no entry', () => {
    expect(feedCacheLine(undefined)).toBe(t('rss.never_fetched'))
  })

  it('gives a date but no count for a feed the ledger never measured', () => {
    // Five years back, so the wording of the date cannot change between the two calls to it.
    const fetchedAt = Date.now() - 5 * 365 * HOUR * 24
    expect(feedCacheLine({ fetchedAt, bytes: 100 })).toBe(t('rss.last_updated', { time: shortSince(fetchedAt) }))
  })
})

describe('a channel line', () => {
  it('totals the counts only when every feed has been measured', () => {
    expect(channelCacheLine([meta({ count: 3 }), meta({ count: 4 })])).toContain(t('rss.storage.articles_n', { n: 7 }))
    expect(channelCacheLine([meta({ count: 3 }), meta({ count: undefined })])).not.toContain(t('rss.storage.articles_n', { n: 3 }))
  })

  it('falls back to never fetched for a channel nothing has been stored for', () => {
    expect(channelCacheLine([undefined, undefined])).toBe(t('rss.never_fetched'))
  })
})

describe('the freshness notice', () => {
  it('is silent for a channel that answered today', () => {
    expect(channelCachedSince([meta({ fetchedAt: Date.now() - 2 * HOUR })], Date.now())).toBeNull()
  })

  it('is silent when one feed of the channel answered recently', () => {
    const metas = [meta({ fetchedAt: Date.now() - 40 * HOUR }), meta({ fetchedAt: Date.now() - HOUR })]
    expect(channelCachedSince(metas, Date.now())).toBeNull()
  })

  it('names the newest fetch once the whole channel is a day old', () => {
    const newest = Date.now() - 30 * HOUR
    const metas = [meta({ fetchedAt: newest }), meta({ fetchedAt: newest - 5 * HOUR })]
    expect(channelCachedSince(metas, Date.now())).toBe(newest)
  })

  it('says nothing when the device holds no ledger at all', () => {
    expect(channelCachedSince([undefined], Date.now())).toBeNull()
  })
})
