export interface MemoMentionRange {
  username: string
  start: number
  end: number
}

const MENTION = /(^|[^\p{L}\p{N}_@/.-])@([a-z0-9][a-z0-9_-]{2,31})(?![\p{L}\p{N}_-])/gu

export function findMentionRanges(text: string): MemoMentionRange[] {
  if (!text.includes('@')) return []
  const ranges: MemoMentionRange[] = []
  for (const match of text.matchAll(MENTION)) {
    const username = match[2]
    if (!username) continue
    const start = (match.index ?? 0) + match[1]!.length
    ranges.push({ username, start, end: start + username.length + 1 })
  }
  return ranges
}
