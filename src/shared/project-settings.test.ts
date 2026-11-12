import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './constants'

describe('project board marks in the account settings', () => {
  it('defaults to no marks', () => {
    expect(DEFAULT_SETTINGS.project).toEqual({ pinnedBoards: [], starredBoards: [] })
    expect(mergeSettings({}).project).toEqual({ pinnedBoards: [], starredBoards: [] })
  })

  it('keeps the reader\'s pins and favourites', () => {
    const merged = mergeSettings({ project: { pinnedBoards: ['b1', 'b2'], starredBoards: ['b3'] } })
    expect(merged.project).toEqual({ pinnedBoards: ['b1', 'b2'], starredBoards: ['b3'] })
  })

  it('drops duplicates, non-strings and blanks, and caps the list', () => {
    const many = Array.from({ length: 250 }, (_, index) => `b${index}`)
    const merged = mergeSettings({ project: { pinnedBoards: ['b1', 'b1', '', 7, ...many], starredBoards: 'nope' } })
    expect(merged.project.pinnedBoards).toHaveLength(200)
    expect(merged.project.pinnedBoards[0]).toBe('b1')
    expect(new Set(merged.project.pinnedBoards).size).toBe(200)
    expect(merged.project.starredBoards).toEqual([])
  })

  it('leaves the other sections untouched', () => {
    const merged = mergeSettings({ project: { pinnedBoards: ['b1'] } })
    expect(merged.todo).toEqual(DEFAULT_SETTINGS.todo)
    expect(merged.appearance).toEqual(DEFAULT_SETTINGS.appearance)
  })
})