import { describe, expect, it } from 'vitest'
import { LIMITS } from '@shared/constants'
import {
  DEFAULT_PREFERENCES,
  GRAPH_PREFS_KEY,
  loadPreferences,
  persistPreferences,
  toggleListItem,
} from './graph-settings'

const NOTE_ID = '0123456789abcdefghjkmnpqrs'

function storageFor(value: unknown): Pick<Storage, 'getItem'> {
  return { getItem: () => (typeof value === 'string' ? value : JSON.stringify(value)) }
}

describe('graph preferences', () => {
  it('answers the defaults when nothing is stored', () => {
    expect(loadPreferences({ getItem: () => null })).toEqual(DEFAULT_PREFERENCES)
  })

  it('survives a payload that is not JSON', () => {
    expect(loadPreferences(storageFor('{oops'))).toEqual(DEFAULT_PREFERENCES)
  })

  it('survives a payload that is not an object', () => {
    expect(loadPreferences(storageFor('[1,2]'))).toEqual(DEFAULT_PREFERENCES)
  })

  it('clamps a stored force past its slider range', () => {
    const prefs = loadPreferences(storageFor({ repulsion: 99_000, linkDistance: -5, nodeScale: 40 }))
    expect(prefs.repulsion).toBe(1800)
    expect(prefs.linkDistance).toBe(40)
    expect(prefs.nodeScale).toBe(1.8)
  })

  it('keeps the node limit inside the bounds the route clamps to', () => {
    expect(loadPreferences(storageFor({ limit: 10 })).limit).toBe(LIMITS.graphNodeLimitMin)
    expect(loadPreferences(storageFor({ limit: 10_000 })).limit).toBe(LIMITS.graphNodeLimitMax)
  })

  it('migrates the single tag a stored preference held before', () => {
    const prefs = loadPreferences(storageFor({ tag: '  Work  ' }))
    expect(prefs.tags).toEqual(['Work'])
  })

  it('merges a legacy tag into a stored tag list without duplicating', () => {
    const prefs = loadPreferences(storageFor({ tag: 'Work', tags: ['work', 'Home', 'Work'] }))
    expect(prefs.tags).toEqual(['work', 'Home'])
  })

  it('drops ids that are not note ids from the pin and exclusion lists', () => {
    const prefs = loadPreferences(storageFor({
      pinnedNodeIds: [NOTE_ID, '../etc/passwd', '', NOTE_ID],
      excludedNoteIds: [NOTE_ID, 'not-an-id'],
    }))
    expect(prefs.pinnedNodeIds).toEqual([NOTE_ID])
    expect(prefs.excludedNoteIds).toEqual([NOTE_ID])
  })

  it('keeps a colour rule only when both its query and colour are usable', () => {
    const prefs = loadPreferences(storageFor({
      colorGroups: [
        { id: 'a', query: ' tag:x', color: '#dc2626' },
        { query: '', color: '#dc2626' },
        { query: 'tag:y', color: 'red' },
        { query: 'tag:z', color: '#059669' },
      ],
    }))
    expect(prefs.colorGroups).toEqual([
      { id: 'a', query: 'tag:x', color: '#dc2626' },
      { id: 'group-1', query: 'tag:z', color: '#059669' },
    ])
  })

  it('caps the colour rules at the legend has room for', () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({ query: `t${index}`, color: '#dc2626' }))
    expect(loadPreferences(storageFor({ colorGroups: many })).colorGroups).toHaveLength(LIMITS.graphColorGroupMax)
  })

  it('falls back to both when a stored direction is not one the route knows', () => {
    expect(loadPreferences(storageFor({ direction: 'sideways' })).direction).toBe('both')
  })

  it('writes back exactly what it read', () => {
    const items = new Map<string, string>()
    const store = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value) },
    }
    const prefs = { ...DEFAULT_PREFERENCES, tags: ['Work'], pinnedNodeIds: [NOTE_ID], limit: 120 }
    persistPreferences(prefs, store)
    expect(items.get(GRAPH_PREFS_KEY)).toBeTruthy()
    expect(loadPreferences(store)).toEqual(prefs)
  })

  it('reports no written payload when storage refuses', () => {
    const store = { setItem: () => { throw new Error('quota') } }
    expect(persistPreferences(DEFAULT_PREFERENCES, store)).toBeNull()
  })

  it('toggles a list item on and off', () => {
    expect(toggleListItem(['a', 'b'], 'b')).toEqual(['a'])
    expect(toggleListItem(['a'], 'c')).toEqual(['a', 'c'])
  })

  it('treats a tag spelled with other casing as the same item', () => {
    expect(toggleListItem(['Work', 'home'], 'wORK')).toEqual(['home'])
  })
})
