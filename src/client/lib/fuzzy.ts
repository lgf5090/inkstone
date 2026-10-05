


export interface FuzzyMatch {
  score: number
  ranges: [number, number][]
}


const LOWER_CACHE_BUDGET_CHARS = 2_000_000
const loweredCache = new Map<string, string>()
let loweredCacheChars = 0

/**
 * Listings call this once per row per keystroke with a haystack the row already keeps a
 * stable reference to, so V8's cached string hash makes the lookup O(1) while
 * text.toLowerCase() would re-copy the whole body every time.
 */
function lowered(text: string): string {
  const hit = loweredCache.get(text)
  if (hit !== undefined) return hit
  const lower = text.toLowerCase()
  if (lower.length > LOWER_CACHE_BUDGET_CHARS) return lower
  loweredCache.set(text, lower)
  loweredCacheChars += text.length
  if (loweredCacheChars > LOWER_CACHE_BUDGET_CHARS) {
    loweredCache.clear()
    loweredCacheChars = lower.length
  }
  return lower
}

export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  if (!query) return { score: 0, ranges: [] }

  const haystack = lowered(text)
  const needle = query.toLowerCase().trim()
  if (!needle) return { score: 0, ranges: [] }


  const direct = haystack.indexOf(needle)
  if (direct >= 0) {
    let score = 1000 - direct * 2
    if (direct === 0) score += 300
    else if (isBoundary(haystack, direct)) score += 150
    score += Math.max(0, 120 - text.length)
    return { score, ranges: [[direct, direct + needle.length]] }
  }


  const ranges: [number, number][] = []
  let ti = 0
  let score = 0
  let streak = 0

  for (let qi = 0; qi < needle.length; qi++) {
    const ch = needle[qi]!
    if (ch === ' ') {
      streak = 0
      continue
    }
    const found = haystack.indexOf(ch, ti)
    if (found < 0) return null

    if (found === ti && ranges.length) {
      streak++
      score += 12 + streak * 6
      const last = ranges[ranges.length - 1]!
      last[1] = found + 1
    } else {
      streak = 0
      score += found === 0 ? 40 : isBoundary(haystack, found) ? 22 : 4
      ranges.push([found, found + 1])
    }
    ti = found + 1
  }

  score -= Math.floor(text.length / 12)
  score -= ranges.length * 2
  return { score, ranges }
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1]!
  return /[\s\-_/.·\u3001\uff0c,\uff08(\u3010[]/.test(prev)
}


export function splitByRanges(
  text: string,
  ranges: [number, number][],
): { text: string; hit: boolean }[] {
  if (!ranges.length) return [{ text, hit: false }]
  const merged = mergeRanges(ranges)
  const out: { text: string; hit: boolean }[] = []
  let cursor = 0

  for (const [start, end] of merged) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false })
    out.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
  return out.filter((part) => part.text)
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else out.push([...range] as [number, number])
  }
  return out
}


export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
  limit = 50,
): { item: T; match: FuzzyMatch }[] {
  if (!query.trim()) return items.slice(0, limit).map((item) => ({ item, match: { score: 0, ranges: [] } }))

  const scored: { item: T; match: FuzzyMatch }[] = []
  for (const item of items) {
    const match = fuzzyMatch(getText(item), query)
    if (match) scored.push({ item, match })
  }
  scored.sort((a, b) => b.match.score - a.match.score)
  return scored.slice(0, limit)
}
