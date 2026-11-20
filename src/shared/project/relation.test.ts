import { describe, expect, it } from 'vitest'
import { newProjectId } from './limits'
import { parseProjectRelationIds, remapProjectRelationValue, serializeProjectRelationIds } from './relation'

describe('relation value encoding', () => {
  const first = newProjectId('card')
  const second = newProjectId('card')

  it('reads a JSON array and a bare legacy id', () => {
    expect(parseProjectRelationIds(JSON.stringify([first, second]))).toEqual([first, second])
    expect(parseProjectRelationIds(first)).toEqual([first])
    expect(parseProjectRelationIds('')).toEqual([])
  })

  it('drops ids that are not project ids', () => {
    expect(parseProjectRelationIds(JSON.stringify([first, '../etc', '']))).toEqual([first])
  })

  it('serializes a deduplicated array and null for empty', () => {
    expect(serializeProjectRelationIds([first, first, second])).toBe(JSON.stringify([first, second]))
    expect(serializeProjectRelationIds([])).toBeNull()
    expect(serializeProjectRelationIds(['bad id'])).toBeNull()
  })

  it('remaps the ids it knows and keeps the rest', () => {
    const map = new Map([[first, second]])
    expect(remapProjectRelationValue(JSON.stringify([first]), map)).toBe(JSON.stringify([second]))
    expect(remapProjectRelationValue(first, map)).toBe(JSON.stringify([second]))
  })
})
