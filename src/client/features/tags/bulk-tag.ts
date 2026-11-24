import { appendFrontMatterTag } from '@shared/markdown-utils'

export function addTagToNoteContent(content: string, tag: string): string {
  const clean = tag.trim().replace(/^#/, '').trim()
  if (!clean) return content
  const withFrontMatter = /^---[ \t]*(?:\r?\n|$)/.test(content)
    ? content
    : `---\ntags: []\n---\n\n${content}`
  return appendFrontMatterTag(withFrontMatter, clean)
}
