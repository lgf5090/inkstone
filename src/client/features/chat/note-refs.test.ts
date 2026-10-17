// @vitest-environment jsdom
/**
 * The two things a reply can be turned into: a door to a note it named, and a note of its own.
 *
 * Both are chips and buttons that promise something, so what is pinned here is the promise: a note tool's
 * payload yields the notes it mentions and nothing else, a task listing yields nothing (its id would open
 * an unrelated note, or none), and a title taken from a reply does not arrive wearing the `##` that made
 * it a heading.
 */
import { describe, expect, it } from 'vitest'
import { noteRefsFromToolResult } from './note-refs'
import { leadingProse } from './save-to-note'

const NOTE_A = '01hzzzzzzzzzzzzzzzzzzzzz11'
const NOTE_B = '01hzzzzzzzzzzzzzzzzzzzzz12'
const TASK = '01hzzzzzzzzzzzzzzzzzzzzz21'

describe('the notes a tool call named', () => {
  it('reads the notes out of a search, in the order they came back', () => {
    const result = JSON.stringify({
      results: [
        { id: NOTE_A, title: 'Quarterly plan', excerpt: 'first' },
        { id: NOTE_B, title: 'Meeting minutes', excerpt: 'second' },
      ],
    })
    expect(noteRefsFromToolResult('search_notes', result)).toEqual([
      { id: NOTE_A, title: 'Quarterly plan' },
      { id: NOTE_B, title: 'Meeting minutes' },
    ])
  })

  it('reads a listing and a single read the same way', () => {
    expect(noteRefsFromToolResult('list_notes', JSON.stringify({ total: 2, notes: [{ id: NOTE_A, title: 'A' }] })))
      .toEqual([{ id: NOTE_A, title: 'A' }])
    // `read_note` answers with the worker's own field names, and they are not the search's: a note id
    // there is `note_id`, so a chip keyed only on `id` never appears for the one tool that read a note.
    expect(noteRefsFromToolResult('read_note', JSON.stringify({
      note_id: NOTE_B,
      title: 'B',
      url: '/n/' + NOTE_B,
      rev: 3,
      content: 'x',
      start_offset: 0,
      end_offset: 1,
    }))).toEqual([{ id: NOTE_B, title: 'B' }])
    expect(noteRefsFromToolResult('create_note', JSON.stringify({ created: { id: NOTE_A, title: 'A' } })))
      .toEqual([{ id: NOTE_A, title: 'A' }])
  })

  it('offers nothing for a tool whose ids are not notes', () => {
    // A task has an id and a title too. A chip that opened it in the notebook would be a link to
    // whatever note happened to share that id — which is nothing, or a stranger's note.
    const tasks = JSON.stringify({ tasks: [{ id: TASK, title: 'Review the plan' }] })
    expect(noteRefsFromToolResult('list_tasks', tasks)).toEqual([])
  })

  it('offers nothing it cannot read', () => {
    expect(noteRefsFromToolResult('search_notes', 'not json')).toEqual([])
    expect(noteRefsFromToolResult('search_notes', JSON.stringify({ error: 'the tool failed' }))).toEqual([])
    expect(noteRefsFromToolResult('search_notes', JSON.stringify({ results: [{ id: 'short', title: 'x' }] }))).toEqual([])
    expect(noteRefsFromToolResult('search_notes', undefined)).toEqual([])
  })

  it('names each note once, however many rows mention it', () => {
    const result = JSON.stringify({
      results: [{ id: NOTE_A, title: 'A' }, { id: NOTE_A, title: 'A' }],
      updated: { id: NOTE_A, title: 'A' },
    })
    expect(noteRefsFromToolResult('search_notes', result)).toEqual([{ id: NOTE_A, title: 'A' }])
  })
})

describe('the title a saved reply takes', () => {
  it('drops the marks that made the first line a heading or a bullet', () => {
    expect(leadingProse('## 三点结论\n\n正文')).toBe('三点结论')
    expect(leadingProse('- 先做这个\n- 再做那个')).toBe('先做这个')
    expect(leadingProse('1. 第一步')).toBe('第一步')
    expect(leadingProse('> 引用开头')).toBe('引用开头')
    expect(leadingProse('**加粗**开头')).toBe('加粗开头')
  })

  it('takes the first line that has anything on it', () => {
    expect(leadingProse('\n\n   \n正文在这里')).toBe('正文在这里')
    expect(leadingProse('')).toBe('')
  })
})
