import { describe, expect, it } from 'vitest'
import type { ProjectCard } from './model'
import { projectAutomationDedupeKey, projectAutomationMatches, projectAutomationTriggered } from './automation'

const card = (values: Record<string, string>): ProjectCard => ({
  id: 'c1', boardId: 'b1', parentId: '', title: 'Card', icon: '', isTemplate: false,
  contentOrder: [], values, createdBy: 'u1', modifiedBy: 'u1',
  createAt: 1, updateAt: 1, deleteAt: 0,
})

describe('automation matching', () => {
  it('fires on every value write, or only when a named property changed', () => {
    const before = card({ status: 'open' })
    const after = card({ status: 'done' })
    expect(projectAutomationTriggered({ type: 'cardValueChanged' }, before, after)).toBe(true)
    expect(projectAutomationTriggered({ type: 'cardValueChanged', propertyId: 'status' }, before, after)).toBe(true)
    expect(projectAutomationTriggered({ type: 'cardValueChanged', propertyId: 'title' }, before, after)).toBe(false)
  })

  it('applies the four whitelisted condition operators', () => {
    const target = card({ status: 'done' })
    expect(projectAutomationMatches(null, target)).toBe(true)
    expect(projectAutomationMatches({ propertyId: 'status', op: 'equals', value: 'done' }, target)).toBe(true)
    expect(projectAutomationMatches({ propertyId: 'status', op: 'equals', value: 'open' }, target)).toBe(false)
    expect(projectAutomationMatches({ propertyId: 'status', op: 'notEquals', value: 'open' }, target)).toBe(true)
    expect(projectAutomationMatches({ propertyId: 'status', op: 'isSet', value: '' }, target)).toBe(true)
    expect(projectAutomationMatches({ propertyId: 'missing', op: 'isEmpty', value: '' }, target)).toBe(true)
  })

  it('names one write of one card for one rule', () => {
    expect(projectAutomationDedupeKey('r1', 'c1', 7)).toBe('r1:c1:7')
    expect(projectAutomationDedupeKey('r1', 'c1', 7)).toBe(projectAutomationDedupeKey('r1', 'c1', 7))
    expect(projectAutomationDedupeKey('r1', 'c1', 8)).not.toBe(projectAutomationDedupeKey('r1', 'c1', 7))
  })
})
