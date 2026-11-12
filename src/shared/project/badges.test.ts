import { describe, expect, it } from 'vitest'
import type { ProjectComment, ProjectContent } from './model'
import { countProjectMarkdownCheckboxes, hasProjectCardBadges, projectCardBadges } from './badges'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }

function block(id: string, type: ProjectContent['type'], title: string, fields: ProjectContent['fields'] = {}): ProjectContent {
  return { id, cardId: 'c1', boardId: 'b1', type, title, fields, position: 0, ...stamps }
}
function comment(id: string): ProjectComment {
  return { id, cardId: 'c1', boardId: 'b1', authorId: 'u1', body: 'hi', createAt: 1, updateAt: 1, deleteAt: 0 }
}

describe('markdown checkbox counting (B-6)', () => {
  it('counts GFM task items and checked ones across list markers', () => {
    const md = '- [ ] todo\n* [x] done\n+ [X] done too\n1. [ ] numbered\nplain line'
    expect(countProjectMarkdownCheckboxes(md)).toEqual({ total: 4, checked: 2 })
  })

  it('ignores task-like lines inside fenced code', () => {
    const md = '- [ ] real\n```\n- [ ] example\n```\n~~~\n* [x] example\n~~~'
    expect(countProjectMarkdownCheckboxes(md)).toEqual({ total: 1, checked: 0 })
  })

  it('does not count a checkbox without a following space or end', () => {
    expect(countProjectMarkdownCheckboxes('- [x]nospace')).toEqual({ total: 0, checked: 0 })
  })
})

describe('card badges (B-6)', () => {
  it('aggregates description, comments and checkbox progress', () => {
    const badges = projectCardBadges(
      [block('a', 'text', '- [x] done\n- [ ] todo'), block('b', 'checkbox', 'Step', { checked: true }), block('c', 'checkbox', 'Step2', { checked: false })],
      [comment('m1'), comment('m2')],
    )
    expect(badges).toEqual({ description: true, comments: 2, checked: 2, checkboxes: 4 })
    expect(hasProjectCardBadges(badges)).toBe(true)
  })

  it('reports no badges for an empty card', () => {
    const badges = projectCardBadges([], [])
    expect(badges).toEqual({ description: false, comments: 0, checked: 0, checkboxes: 0 })
    expect(hasProjectCardBadges(badges)).toBe(false)
  })

  it('a divider alone is not a description badge', () => {
    expect(projectCardBadges([block('d', 'divider', '')], []).description).toBe(false)
  })
})