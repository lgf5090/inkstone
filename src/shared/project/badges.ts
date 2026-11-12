/**
 * B-6: the three badges a card carries in every view. The checkbox count includes the GFM task items
 * written inside a text block's Markdown, which is what the reference counts by rendering the block;
 * fenced code is stripped first so a `- [ ]` inside an example is not counted as a real task.
 */
import type { ProjectComment, ProjectContent } from './model'

export interface ProjectCardBadges {
  description: boolean
  comments: number
  checked: number
  checkboxes: number
}

const FENCE = /(?:^|(?<=\n))[ \t]*(```|~~~)[\s\S]*?(?:\n[ \t]*\1[ \t]*(?:\n|$)|$)/g
const TASK_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/gm

export function countProjectMarkdownCheckboxes(markdown: string): { total: number, checked: number } {
  const withoutFences = markdown.replace(FENCE, '\n')
  let total = 0
  let checked = 0
  for (const match of withoutFences.matchAll(TASK_ITEM)) {
    total += 1
    if (match[1] !== ' ') checked += 1
  }
  return { total, checked }
}

export function projectCardBadges(
  contents: readonly ProjectContent[],
  comments: readonly ProjectComment[],
): ProjectCardBadges {
  let description = false
  let checked = 0
  let checkboxes = 0
  for (const block of contents) {
    if (block.type === 'text') {
      description = true
      const counts = countProjectMarkdownCheckboxes(block.title)
      checkboxes += counts.total
      checked += counts.checked
    } else if (block.type === 'checkbox') {
      checkboxes += 1
      if (block.fields.checked === true) checked += 1
    }
  }
  return { description, comments: comments.length, checked, checkboxes }
}

export function hasProjectCardBadges(badges: ProjectCardBadges): boolean {
  return badges.description || badges.comments > 0 || badges.checkboxes > 0
}