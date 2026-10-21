import type { Memo } from '@shared/memos/types'

export const MEMO_TAG_SUGGESTION_LIMIT = 3

export function suggestMemoTags(
  items: readonly Memo[],
  activeTag: string | null,
  limit = MEMO_TAG_SUGGESTION_LIMIT,
): string[] {
  if (limit <= 0) return []
  const counts = new Map<string, number>()
  const active = activeTag?.trim() ?? ''
  for (const memo of items) {
    for (const tag of memo.tags) {
      const value = tag.trim()
      if (!value || value === active) continue
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, limit)
    .map(([tag]) => tag)
}
