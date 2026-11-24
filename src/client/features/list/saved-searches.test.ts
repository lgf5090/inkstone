import { describe, expect, it } from 'vitest'
import { mergeSettings } from '@shared/constants'
import { removeNoteSearch, saveNoteSearch } from './saved-searches'

describe('saved note searches', () => {
  it('adds the newest search first and replaces the same name instead of duplicating it', () => {
    const current = [
      { id: 'one', name: 'Reading', query: 'tag:reading' },
      { id: 'two', name: 'Work', query: 'tag:work' },
    ]
    expect(saveNoteSearch(current, 'three', ' reading ', 'created:>=2026-01-01')).toEqual([
      { id: 'three', name: 'reading', query: 'created:>=2026-01-01' },
      { id: 'two', name: 'Work', query: 'tag:work' },
    ])
  })

  it('survives the account settings merge with bounded, validated entries', () => {
    const merged = mergeSettings({
      search: {
        savedSearches: [
          { id: 'valid-id', name: ' Reading ', query: ' tag:reading ' },
          { id: 'bad', name: '', query: 'tag:work' },
          { id: 'dupe-id', name: 'Duplicate', query: 'tag:work' },
          { id: 'dupe-id', name: 'Duplicate', query: 'tag:home' },
        ],
      },
    })
    expect(merged.search.savedSearches).toEqual([
      { id: 'valid-id', name: 'Reading', query: 'tag:reading' },
      { id: 'dupe-id', name: 'Duplicate', query: 'tag:work' },
    ])
  })

  it('ignores blank input and removes only the requested id', () => {
    const current = [{ id: 'one', name: 'Reading', query: 'tag:reading' }]
    expect(saveNoteSearch(current, 'two', ' ', 'tag:work')).toEqual(current)
    expect(removeNoteSearch(current, 'missing')).toEqual(current)
    expect(removeNoteSearch(current, 'one')).toEqual([])
  })
})
