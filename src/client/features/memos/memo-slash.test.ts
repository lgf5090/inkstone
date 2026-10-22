import { describe, expect, it } from 'vitest'
import { memoSlashEdit } from './memo-slash'

describe('the memo slash menu edits', () => {
  it('turns a heading token into that heading', () => {
    expect(memoSlashEdit('/h2', 0, 3, 'h2')).toEqual({ text: '## ', cursor: 3 })
  })

  it('replaces an existing list prefix instead of stacking one', () => {
    expect(memoSlashEdit('- /task', 2, 7, 'task')).toEqual({ text: '- [ ] ', cursor: 6 })
  })

  it('keeps text that was already on the line', () => {
    expect(memoSlashEdit('/quote remember this', 0, 6, 'quote')).toEqual({
      text: '> remember this',
      cursor: 15,
    })
  })

  it('opens an empty code block with the caret inside', () => {
    expect(memoSlashEdit('/code', 0, 5, 'code')).toEqual({ text: '```\n\n```', cursor: 4 })
  })

  it('adds a divider after the line that was there', () => {
    expect(memoSlashEdit('/divider after', 0, 8, 'divider')).toEqual({
      text: 'after\n\n---',
      cursor: 10,
    })
  })
})
