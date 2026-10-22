import { renderMarkdown } from '../../lib/markdown/renderer'

export const MEMO_OUTLINE_MAX_LEVEL = 3

export interface MemoOutlineItem {
  level: number
  text: string
  id: string
}

export function parseMemoOutline(content: string): MemoOutlineItem[] {
  if (!content.trim()) return []
  const { headings } = renderMarkdown(content, { hideFrontMatter: true })
  return headings
    .filter((heading) => heading.level <= MEMO_OUTLINE_MAX_LEVEL && heading.text.trim() !== '')
    .map((heading) => ({
      level: heading.level,
      text: heading.text.trim(),
      id: heading.slug,
    }))
}
