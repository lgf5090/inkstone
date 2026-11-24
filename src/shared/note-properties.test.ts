import { describe, expect, it } from 'vitest'
import { indexNoteProperties } from './note-properties'

describe('indexNoteProperties', () => {
  it('flattens front matter values with stable keys and ordinals', () => {
    const rows = indexNoteProperties('---\nStatus: Active\nrating: 4\npublished: true\naliases: [alpha, beta]\n---\nBody')
    expect(rows.map((row) => [row.keyKey, row.ordinal, row.text])).toEqual([
      ['status', 0, 'Active'],
      ['rating', 0, '4'],
      ['published', 0, 'true'],
      ['aliases', 0, 'alpha'],
      ['aliases', 1, 'beta'],
    ])
    expect(rows.find((row) => row.keyKey === 'rating')?.number).toBe(4)
    expect(rows.find((row) => row.keyKey === 'published')?.boolean).toBe(1)
  })

  it('keeps empty properties searchable and ignores malformed front matter', () => {
    expect(indexNoteProperties('---\nempty:\n---\nBody').map((row) => row.text)).toEqual([''])
    expect(indexNoteProperties('---\nbroken: [\n---\nBody')).toEqual([])
    expect(indexNoteProperties('Body only')).toEqual([])
  })
})
