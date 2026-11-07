import { describe, expect, it } from 'vitest'
import type { ProjectProperty } from './model'
import { applyProjectPropertyPatch } from './property-patch'

function property(id: string, name = id): ProjectProperty {
  return { id, name, type: 'text', options: [] }
}

const ids = (list: ProjectProperty[]) => list.map((p) => p.id)

describe('the cardProperties patch', () => {
  it('leaves the list untouched when both patch lists are empty', () => {
    const current = [property('A'), property('B'), property('C')]
    expect(applyProjectPropertyPatch(current, [], [])).toEqual(current)
  })

  it('replaces in place, appends new ids, and keeps survivors in order (§6.2 acceptance)', () => {
    const current = [property('A'), property('B'), property('C')]
    const next = applyProjectPropertyPatch(current, [property('B', 'B-prime'), property('D')], ['A'])
    expect(ids(next)).toEqual(['B', 'C', 'D'])
    expect(next[0]!.name).toBe('B-prime')
  })

  it('does not move an updated property forward', () => {
    const first = applyProjectPropertyPatch([property('A'), property('B'), property('C')], [property('B', 'B-prime'), property('D')], ['A'])
    const second = applyProjectPropertyPatch(first, [property('C', 'C-prime')], [])
    expect(ids(second)).toEqual(['B', 'C', 'D'])
    expect(second[1]!.name).toBe('C-prime')
  })

  it('skips entries without a string id without disturbing the rest', () => {
    const dirty = { name: 'no id', type: 'text', options: [] } as unknown as ProjectProperty
    const current = [property('A'), dirty, property('B')]
    const next = applyProjectPropertyPatch(current, [property('C'), { ...dirty, id: undefined } as unknown as ProjectProperty], [])
    expect(ids(next)).toEqual(['A', 'B', 'C'])
  })

  it('appends a deleted-then-readded id only once', () => {
    const current = [property('A'), property('B'), property('C')]
    const next = applyProjectPropertyPatch(current, [property('A', 'A-prime')], ['A'])
    expect(ids(next)).toEqual(['B', 'C', 'A'])
    expect(next[2]!.name).toBe('A-prime')
  })

  it('drops a deleted id and ignores deleting an id that is not present', () => {
    const current = [property('A'), property('B')]
    expect(ids(applyProjectPropertyPatch(current, [], ['A', 'ghost']))).toEqual(['B'])
  })
})