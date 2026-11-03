/**
 * What the Memos page tells the assistant about itself.
 *
 * The page already knows the space it is showing, the filters narrowing it, how many memos are on screen,
 * and the first few titles. None of that is a secret, and all of it is what "this memo" or "these three"
 * means in a sentence typed beside the page — so it is handed over as bounded facts, the same shape every
 * other page uses, rather than given a context type of its own.
 */
import type { AssistantPageContext } from '@shared/assistant'
import type { Memo, MemoState } from '@shared/memos/types'

export interface MemoPageContextInput {
  /** The section as the sidebar names it: home, a space, the archive. */
  sectionLabel: string
  /** The space the feed is restricted to, when it is one. */
  spaceId: string | null
  spaceName: string | null
  state: MemoState
  search: string
  tag: string | null
  filterExpression: string
  quick: readonly string[]
  visible: number
  /** The memos currently on screen, newest first. */
  memos: readonly Memo[]
  /** The memo open in the detail panel, when one is. */
  openMemo: Memo | null
}

function fact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function titleOf(memo: Memo): string {
  return fact(memo.title || memo.snippet || memo.id)
}

/** The filters as one human-readable line, or `all` when nothing narrows the feed. */
function filtersOf(input: MemoPageContextInput): string {
  const parts: string[] = []
  if (input.search.trim()) parts.push(`search "${fact(input.search)}"`)
  if (input.tag) parts.push(`tag ${fact(input.tag)}`)
  if (input.quick.length) parts.push(`quick ${fact(input.quick.join(', '))}`)
  if (input.filterExpression.trim()) parts.push(`expression ${fact(input.filterExpression)}`)
  return parts.length ? parts.join('; ') : 'all'
}

export function buildMemoPageContext(input: MemoPageContextInput): AssistantPageContext {
  const space = input.spaceId
    ? input.spaceName ?? input.spaceId
    : 'all'
  const facts = [
    `state: ${input.state}`,
    `space: ${space}`,
    `filter: ${filtersOf(input)}`,
    `visible: ${input.visible}`,
  ]
  const recent = input.memos.slice(0, 3).map(titleOf)
  if (recent.length) facts.push(`recent: ${fact(recent.map((title) => `"${title}"`).join(' | '))}`)
  if (input.openMemo) facts.push(`open memo: ${titleOf(input.openMemo)}`)
  return {
    surface: 'memos',
    label: `Memos · ${input.sectionLabel}`,
    facts: facts.slice(0, 8),
  }
}
