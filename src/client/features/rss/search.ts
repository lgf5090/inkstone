/**
 * Article search, in the app's own terms.
 *
 * The list box is the same one every other listing in Inkstone uses, which means a reader can type
 * an author's initials in Han and find them, or type `/k8s/i` and get the regex. That is
 * `query-match`'s contract, and the only thing added here is *where* a match may land — title first,
 * then the summary and the feed's name — and what a row keeps so it can underline what it matched.
 *
 * Scoring only happens while a query is typed. An empty box leaves the channel's own order alone,
 * because a list that reshuffles itself for no input is indistinguishable from a bug.
 */
import type { Query } from '../../lib/query-match'
import { queryKeepsRows, queryMatches } from '../../lib/query-match'
import type { RssEntry } from '@shared/rss/model'

export interface ScoredEntry {
  entry: RssEntry
  /** Where the query landed in the title, so the row can underline it. */
  ranges: [number, number][]
}

const SUMMARY_SCAN_CHARS = 400

export function searchEntries(
  entries: RssEntry[],
  query: Query,
  feedNames: Map<string, string>,
): ScoredEntry[] {
  if (queryKeepsRows(query)) return entries.map(entry => ({ entry, ranges: [] }))
  const scored: Array<ScoredEntry & { score: number }> = []
  for (const entry of entries) {
    const title = queryMatches(query, entry.title)
    if (title) {
      scored.push({ entry, ranges: title.ranges, score: title.score + 400 })
      continue
    }
    const summary = queryMatches(query, entry.summary.slice(0, SUMMARY_SCAN_CHARS))
    if (summary) {
      scored.push({ entry, ranges: [], score: summary.score })
      continue
    }
    const feed = queryMatches(query, feedNames.get(entry.feedId) ?? '')
    if (feed) scored.push({ entry, ranges: [], score: feed.score - 100 })
  }
  // Newest wins inside one score band, so a search over a merged channel still reads as a timeline.
  return scored
    .sort((a, b) => b.score - a.score || (b.entry.publishedTs ?? 0) - (a.entry.publishedTs ?? 0))
    .map(({ entry, ranges }) => ({ entry, ranges }))
}
