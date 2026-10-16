/**
 * The notes a reply cites.
 *
 * A search the assistant ran leaves no trace in its answer unless the reply carries what it read, so the
 * tool results are read back into citations here. The two things worth pinning are which tools count — a
 * listing is a table of contents, not a source — and that the url a citation stores is the app's own note
 * path, because a transcript is exported and shared and must not carry the origin it was written on.
 */
import { describe, expect, it } from 'vitest'
import { NOTE_CITATION_LIMIT, noteCitationsFromTool } from '../src/worker/assistant/note-citations'
import { decodeSources } from '../src/worker/assistant/store'

const ID = '01hzzzzzzzzzzzzzzzzzzzzz11'

describe('what a tool call cites', () => {
  it('cites the hits a search returned, with the passage that matched', () => {
    const citations = noteCitationsFromTool('search_notes', {
      results: [{ id: ID, title: 'Quarterly plan', excerpt: 'hiring in Q3' }],
    })
    expect(citations).toHaveLength(1)
    expect(citations[0]).toMatchObject({ kind: 'note', id: ID, title: 'Quarterly plan', cited: 'hiring in Q3' })
    expect(citations[0]!.url).toBe(`/n/${ID}`)
  })

  it('cites the note a read opened, and the section when one was asked for', () => {
    const citations = noteCitationsFromTool('read_note', {
      note_id: ID,
      title: 'Quarterly plan',
      url: `https://notes.example.com/n/${ID}`,
      section: { title: 'Hiring', slug: 'hiring', level: 2, line: 4 },
    })
    expect(citations).toEqual([{ url: `/n/${ID}`, title: 'Quarterly plan', kind: 'note', id: ID, cited: 'Hiring' }])
  })

  it('cites nothing for a listing, which is a table of contents rather than a source', () => {
    expect(noteCitationsFromTool('list_notes', { notes: [{ id: ID, title: 'A note' }] })).toEqual([])
    expect(noteCitationsFromTool('count_notes', { total: 3 })).toEqual([])
  })

  it('caps one search so a wide result does not become a wall of cards', () => {
    const results = Array.from({ length: 9 }, (_, index) => ({ id: `01hzzzzzzzzzzzzzzzzzzzzz${10 + index}`, title: `n${index}` }))
    expect(noteCitationsFromTool('search_notes', { results })).toHaveLength(NOTE_CITATION_LIMIT)
  })

  it('survives a result that is not the shape it expects', () => {
    expect(noteCitationsFromTool('search_notes', null)).toEqual([])
    expect(noteCitationsFromTool('search_notes', { results: [{ title: 'no id' }] })).toEqual([])
    expect(noteCitationsFromTool('read_note', { title: 'no id' })).toEqual([])
  })
})

describe('a citation that was stored and read back', () => {
  it('keeps a note citation, rebuilding the path it opens with', () => {
    const stored = JSON.stringify([{ url: `/n/${ID}`, title: 'Quarterly plan', kind: 'note', id: ID, cited: 'hiring' }])
    expect(decodeSources(stored)).toEqual([
      { url: `/n/${ID}`, title: 'Quarterly plan', kind: 'note', id: ID, cited: 'hiring' },
    ])
  })

  it('still drops a row that is neither a note nor a page', () => {
    const stored = JSON.stringify([
      { url: '/n/not-an-id', title: 'broken', kind: 'note', id: 'not-an-id' },
      { url: 'javascript:alert(1)', title: 'nope' },
    ])
    expect(decodeSources(stored)).toEqual([])
  })

  it('keeps a web citation exactly as it was written', () => {
    expect(decodeSources(JSON.stringify([{ url: 'https://example.com/a', title: 'A page' }])))
      .toEqual([{ url: 'https://example.com/a', title: 'A page' }])
  })
})
