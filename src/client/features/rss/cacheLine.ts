/**
 * What this device holds, in the reader's words.
 *
 * The numbers come from the durable cache ledger rather than from the articles in memory, so a
 * subscription the reader has not opened this visit still says how much of it is on the disk — which
 * is the question the line answers. A feed the ledger has never measured says only when it was last
 * fetched, because inventing a count is how a cache line becomes a lie.
 */
import { shortSince } from '../../lib/time'
import { t } from '../../lib/i18n'
import type { RssCacheMeta } from './store'

/** How long a channel may look current from its own cache before the reader is told it is cached. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

export function feedCacheLine(meta: RssCacheMeta | undefined): string {
  if (!meta) return t('rss.never_fetched')
  const parts = [t('rss.last_updated', { time: shortSince(meta.fetchedAt) })]
  if (meta.count !== undefined) parts.unshift(t('rss.storage.articles_n', { n: meta.count }))
  return parts.join(' · ')
}

/** One line for a channel of several feeds: how many articles, and the oldest fetch among them. */
export function channelCacheLine(metas: Array<RssCacheMeta | undefined>): string {
  const held = metas.filter((meta): meta is RssCacheMeta => !!meta)
  if (!held.length) return t('rss.never_fetched')
  const counts = held.map(meta => meta.count).filter((count): count is number => count !== undefined)
  const parts = [t('rss.last_updated', { time: shortSince(Math.min(...held.map(meta => meta.fetchedAt))) })]
  if (counts.length === held.length) parts.unshift(t('rss.storage.articles_n', { n: counts.reduce((sum, count) => sum + count, 0) }))
  return parts.join(' · ')
}

/**
 * The moment the newest article on screen was fetched, when that moment is a long time ago.
 *
 * Only the newest is asked: a channel where one feed answered a minute ago is not showing a stale
 * list, and a notice that fires anyway teaches the reader to ignore the notice.
 */
export function channelCachedSince(metas: Array<RssCacheMeta | undefined>, now = Date.now()): number | null {
  const held = metas.filter((meta): meta is RssCacheMeta => !!meta)
  if (!held.length) return null
  const newest = Math.max(...held.map(meta => meta.fetchedAt))
  return now - newest > STALE_AFTER_MS ? newest : null
}
