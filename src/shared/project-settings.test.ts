import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, mergeSettingsPatch } from './constants'

describe('project board marks in the account settings', () => {
  it('defaults to no marks and no notification overrides', () => {
    expect(DEFAULT_SETTINGS.project).toEqual({ pinnedBoards: [], starredBoards: [], notifications: {} })
    expect(mergeSettings({}).project).toEqual({ pinnedBoards: [], starredBoards: [], notifications: {} })
  })

  it('keeps a per-board notification choice and drops junk levels', () => {
    const merged = mergeSettings({ project: { notifications: { b1: 'off', b2: 'mentions', b3: 'loud', '': 'all' } } })
    expect(merged.project.notifications).toEqual({ b1: 'off', b2: 'mentions' })
  })

  it('keeps the reader\'s pins and favourites', () => {
    const merged = mergeSettings({ project: { pinnedBoards: ['b1', 'b2'], starredBoards: ['b3'] } })
    expect(merged.project).toEqual({ pinnedBoards: ['b1', 'b2'], starredBoards: ['b3'], notifications: {} })
  })

  it('drops duplicates, non-strings and blanks, and caps the list', () => {
    const many = Array.from({ length: 250 }, (_, index) => `b${index}`)
    const merged = mergeSettings({ project: { pinnedBoards: ['b1', 'b1', '', 7, ...many], starredBoards: 'nope' } })
    expect(merged.project.pinnedBoards).toHaveLength(200)
    expect(merged.project.pinnedBoards[0]).toBe('b1')
    expect(new Set(merged.project.pinnedBoards).size).toBe(200)
    expect(merged.project.starredBoards).toEqual([])
  })

  it('patches one board without dropping the others', () => {
    const current = mergeSettings({ project: { notifications: { b1: 'off', b2: 'all' } } })
    const patched = mergeSettingsPatch(current, { project: { notifications: { b2: 'mentions' } } })
    expect(patched.project.notifications).toEqual({ b1: 'off', b2: 'mentions' })
  })

  it('leaves the other sections untouched', () => {
    const merged = mergeSettings({ project: { pinnedBoards: ['b1'] } })
    expect(merged.todo).toEqual(DEFAULT_SETTINGS.todo)
    expect(merged.appearance).toEqual(DEFAULT_SETTINGS.appearance)
  })
})