import { describe, expect, it } from 'vitest'
import {
  KANBAN_COMMENT_MAX_CHARS,
  kanbanAddComment,
  kanbanCommentExcerpt,
  kanbanCommentTime,
  kanbanCommentsOf,
  kanbanEditComment,
  kanbanLastCommentAuthor,
  kanbanRemoveComment,
} from './comments'
import type { KanbanItem } from './types'

function card(comments?: unknown): KanbanItem {
  return { id: 'i1', title: 'Card', properties: {}, comments: comments as KanbanItem['comments'] }
}

const NOON = new Date(Date.UTC(2026, 8, 20, 12, 0, 0))

const two = card([
  { id: 'c1', text: 'First', at: '2026-09-20T12:00:00.000Z' },
  { id: 'c2', text: 'Second', author: 'Ada', at: '2026-09-20T13:00:00.000Z' },
])

describe('what a board stores as a comment', () => {
  it('keeps the comments a card holds, in the order they were written', () => {
    const item = card([
      { id: 'c1', text: 'First', at: '2026-09-20T12:00:00.000Z' },
      { id: 'c2', text: 'Second', author: 'Ada', at: '2026-09-20T13:00:00.000Z' },
    ])
    expect(kanbanCommentsOf(item).map((c) => c.text)).toEqual(['First', 'Second'])
    expect(kanbanCommentsOf(item)[1]?.author).toBe('Ada')
  })

  it('drops entries a hand-written or imported fence cannot mean as a comment', () => {
    const item = card([
      null,
      'a string',
      { id: 'x', text: '   ' },
      { id: 'y', text: 42 },
      { text: 'no id to key it by' },
      { id: '', text: 'no id to edit or remove it by' },
      { id: 'ok', text: 'Kept' },
    ])
    expect(kanbanCommentsOf(item).map((c) => c.id)).toEqual(['ok'])
  })

  it('says nothing has been written about a card that holds none', () => {
    expect(kanbanCommentsOf(card())).toEqual([])
    expect(kanbanCommentsOf(card('not a list'))).toEqual([])
  })
})

describe('writing comments into a card', () => {
  it('appends a comment stamped with the moment it was written', () => {
    const next = kanbanAddComment(card(), { text: '  Ship it  ', author: 'Ada' }, NOON)
    const [comment] = kanbanCommentsOf(next)
    expect(comment).toMatchObject({ text: 'Ship it', author: 'Ada', at: '2026-09-20T12:00:00.000Z' })
    expect(next).not.toBe(card())
  })

  it('leaves no author key behind when the writer stayed anonymous', () => {
    const next = kanbanAddComment(card(), { text: 'Hi', author: '   ' }, NOON)
    expect('author' in kanbanCommentsOf(next)[0]!).toBe(false)
  })

  it('gives two comments written in the same instant different ids', () => {
    const once = kanbanAddComment(card(), { text: 'One' }, NOON)
    const twice = kanbanAddComment(once, { text: 'Two' }, NOON)
    const [first, second] = kanbanCommentsOf(twice)
    expect(first?.id).toBeTruthy()
    expect(first?.id).not.toBe(second?.id)
  })

  it('bounds what one comment may hold', () => {
    const next = kanbanAddComment(card(), { text: 'x'.repeat(KANBAN_COMMENT_MAX_CHARS + 50) }, NOON)
    expect(kanbanCommentsOf(next)[0]?.text).toHaveLength(KANBAN_COMMENT_MAX_CHARS)
  })

  it('writes nothing when there is nothing to say', () => {
    const item = card([{ id: 'c1', text: 'Kept', at: '2026-09-20T12:00:00.000Z' }])
    expect(kanbanAddComment(item, { text: '   ' }, NOON)).toBe(item)
  })
})

describe('editing and removing a comment', () => {
  it('rewrites one comment and hands the other back untouched', () => {
    const next = kanbanEditComment(two, 'c1', '  First, edited  ')
    const comments = kanbanCommentsOf(next)
    expect(comments.map((c) => c.text)).toEqual(['First, edited', 'Second'])
    expect(comments[1]).toBe(kanbanCommentsOf(two)[1])
  })

  it('spends no edit on a comment that already says that, or on one the card does not hold', () => {
    expect(kanbanEditComment(two, 'c1', 'First')).toBe(two)
    expect(kanbanEditComment(two, 'ghost', 'Whatever')).toBe(two)
    expect(kanbanRemoveComment(two, 'ghost')).toBe(two)
  })

  it('removes exactly the named comment', () => {
    const next = kanbanRemoveComment(two, 'c1')
    expect(kanbanCommentsOf(next).map((c) => c.id)).toEqual(['c2'])
  })

  it('refuses to save an empty edit, and trims a long one to the bound', () => {
    expect(kanbanEditComment(two, 'c1', '   ')).toBe(two)
    const next = kanbanEditComment(two, 'c1', 'y'.repeat(KANBAN_COMMENT_MAX_CHARS + 10))
    expect(kanbanCommentsOf(next)[0]?.text).toHaveLength(KANBAN_COMMENT_MAX_CHARS)
  })
})

describe('reading a comment back to the reader', () => {
  it('turns a stored instant into a moment, and refuses to guess at one that is not', () => {
    expect(kanbanCommentTime({ id: 'c', text: 'x', at: '2026-09-20T12:00:00.000Z' })).toBe(NOON.getTime())
    expect(kanbanCommentTime({ id: 'c', text: 'x', at: 'yesterday, I think' })).toBeNull()
    expect(kanbanCommentTime({ id: 'c', text: 'x' })).toBeNull()
  })

  it('offers the name the writer last used, so the next one need not type it again', () => {
    expect(kanbanLastCommentAuthor(two)).toBe('Ada')
    expect(kanbanLastCommentAuthor(card([{ id: 'c1', text: 'a', at: 'x' }, { id: 'c2', text: 'b', at: 'x' }]))).toBe('')
    expect(kanbanLastCommentAuthor(card())).toBe('')
  })

  it('names a comment by a short excerpt of what it says', () => {
    expect(kanbanCommentExcerpt('First line\nsecond line')).toBe('First line')
    expect(kanbanCommentExcerpt('  spaced   out  ')).toBe('spaced out')
    expect(kanbanCommentExcerpt('x'.repeat(40))).toBe(`${'x'.repeat(24)}…`)
    expect(kanbanCommentExcerpt('')).toBe('')
  })
})
