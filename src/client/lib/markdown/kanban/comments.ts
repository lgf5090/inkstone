/**
 * Comments: what the board's readers say about a card. A kanban fence is a document, not a service,
 * so this is the whole of its activity record — an event log of who moved what when would need a
 * server to keep it honest, while a comment is something a reader writes and can see they wrote.
 * Everything that decides what a comment *is* lives here, so the composer, the rows and the fence
 * that stores them all agree on the same shape.
 */
import { createKanbanId } from './id'
import type { KanbanComment, KanbanItem } from './types'

/** How much one comment may hold, so a single card cannot balloon the fence. See `KANBAN_DESCRIPTION_MAX_CHARS`. */
export const KANBAN_COMMENT_MAX_CHARS = 1000
/** How much of a comment a button may name its target with. */
const EXCERPT_CHARS = 24

interface CommentDraft {
  text: string
  author?: string
}

function clampCommentText(text: string): string {
  return text.trim().slice(0, KANBAN_COMMENT_MAX_CHARS)
}

/**
 * A stored entry as a comment, or `null` when it is not one. A fence is written by hand and arrives
 * from imports, so anything missing an id to key by or a line to show is left out rather than
 * rendered as a blank row or silently rewritten.
 */
function readComment(raw: unknown): KanbanComment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Partial<KanbanComment>
  if (typeof entry.id !== 'string' || entry.id === '') return null
  if (typeof entry.text !== 'string') return null
  const text = entry.text.trim()
  if (text === '') return null
  const author = typeof entry.author === 'string' ? entry.author.trim() : ''
  const at = typeof entry.at === 'string' && entry.at !== '' ? entry.at : undefined
  const comment: KanbanComment = { id: entry.id, text }
  if (author) comment.author = author
  if (at) comment.at = at
  // Hand back the stored object itself when it was already in that shape: a batch that touches one
  // comment should leave the others the same objects, so a rewrite stays a one-line diff.
  const stored = raw as Record<string, unknown>
  const pristine = Object.keys(entry).length === Object.keys(comment).length
    && Object.keys(comment).every((key) => stored[key] === comment[key as keyof KanbanComment])
  return pristine ? entry as KanbanComment : comment
}

/** The comments a card holds, oldest first, with anything unreadable left out. */
export function kanbanCommentsOf(item: KanbanItem): KanbanComment[] {
  if (!Array.isArray(item.comments)) return []
  return item.comments.map(readComment).filter((comment): comment is KanbanComment => comment !== null)
}

function withComments(item: KanbanItem, comments: KanbanComment[]): KanbanItem {
  return { ...item, comments }
}

export function kanbanAddComment(item: KanbanItem, draft: CommentDraft, now = new Date()): KanbanItem {
  const text = clampCommentText(draft.text)
  if (text === '') return item
  const author = draft.author?.trim() ?? ''
  const comment: KanbanComment = { id: createKanbanId(), text }
  if (author) comment.author = author
  return withComments(item, [...kanbanCommentsOf(item), { ...comment, at: now.toISOString() }])
}

export function kanbanEditComment(item: KanbanItem, id: string, text: string): KanbanItem {
  const comments = kanbanCommentsOf(item)
  const index = comments.findIndex((comment) => comment.id === id)
  const kept = clampCommentText(text)
  if (index === -1 || kept === '' || comments[index]?.text === kept) return item
  const next = comments.slice()
  next[index] = { ...comments[index]!, text: kept }
  return withComments(item, next)
}

export function kanbanRemoveComment(item: KanbanItem, id: string): KanbanItem {
  const comments = kanbanCommentsOf(item)
  if (!comments.some((comment) => comment.id === id)) return item
  return withComments(item, comments.filter((comment) => comment.id !== id))
}

/** The moment a comment carries, or `null` when its stamp is something no clock could read. */
export function kanbanCommentTime(comment: KanbanComment): number | null {
  if (!comment.at) return null
  const stamp = Date.parse(comment.at)
  return Number.isNaN(stamp) ? null : stamp
}

/** The name the card was last written under: what the composer offers so the next one need not type it. */
export function kanbanLastCommentAuthor(item: KanbanItem): string {
  const comments = kanbanCommentsOf(item)
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const author = comments[index]?.author
    if (author) return author
  }
  return ''
}

/** A comment's first line, in as many characters as a control has room to name it with. */
export function kanbanCommentExcerpt(text: string): string {
  const firstLine = text.split('\n')[0]!.replace(/\s+/g, ' ').trim()
  return firstLine.length > EXCERPT_CHARS ? `${firstLine.slice(0, EXCERPT_CHARS)}…` : firstLine
}
