import { describe, expect, it } from 'vitest'
import {
  PROJECT_CALCULATIONS,
  PROJECT_CONDITIONS_BY_VALUE_TYPE,
  PROJECT_FILTER_CONDITIONS,
  PROJECT_PROPERTY_CAPABILITIES,
  PROJECT_PROPERTY_TYPES,
  PROJECT_ROLES,
  PROJECT_VIEW_TYPES,
  effectiveProjectRole,
  emptyProjectFilterGroup,
  emptyProjectViewFields,
  isProjectFilterGroup,
  projectRoleAtLeast,
} from './model'
import { PROJECT_ID_PATTERN, PROJECT_LIMITS, isProjectId, newProjectId } from './limits'

describe('the project vocabulary', () => {
  it('declares the twenty property types and the reference fifteen conditions plus the two numeric additions (X-8)', () => {
    expect(PROJECT_PROPERTY_TYPES).toHaveLength(20)
    expect(PROJECT_FILTER_CONDITIONS).toHaveLength(17)
    expect(PROJECT_CALCULATIONS).toHaveLength(21)
    expect(PROJECT_VIEW_TYPES).toHaveLength(11)
    expect(PROJECT_VIEW_TYPES).toContain('dashboard')
    expect(PROJECT_VIEW_TYPES).toContain('collection')
    expect(PROJECT_VIEW_TYPES).toContain('sprint')
    expect(PROJECT_ROLES).toEqual(['viewer', 'commenter', 'editor', 'admin'])
  })

  it('offers every condition through at least one value type, so no condition is unreachable', () => {
    const offered = Object.values(PROJECT_CONDITIONS_BY_VALUE_TYPE).flatMap((entry) => [...entry.conditions])
    expect([...new Set(offered)].sort()).toEqual([...PROJECT_FILTER_CONDITIONS].sort())
    for (const entry of Object.values(PROJECT_CONDITIONS_BY_VALUE_TYPE)) {
      if (entry.conditions.length === 0) continue
      expect(entry.conditions).toContain(entry.default)
    }
  })

  it('gives every property type a capability, including the two the reference never registers', () => {
    expect(Object.keys(PROJECT_PROPERTY_CAPABILITIES).sort()).toEqual([...PROJECT_PROPERTY_TYPES].sort())
    // X-8 deliberately makes number filterable/groupable, unlike the reference.
    expect(PROJECT_PROPERTY_CAPABILITIES.number.canFilter).toBe(true)
    expect(PROJECT_PROPERTY_CAPABILITIES.number.canGroup).toBe(true)
    expect(PROJECT_PROPERTY_CAPABILITIES.createdBy).toEqual({
      canFilter: true, filterValueType: 'person', canGroup: true, readOnly: true,
    })
    expect(PROJECT_PROPERTY_CAPABILITIES.select.canGroup).toBe(true)
    expect(PROJECT_PROPERTY_CAPABILITIES.multiSelect.canGroup).toBe(false)
  })

  it('starts a view with an empty filter that matches everything', () => {
    const fields = emptyProjectViewFields()
    expect(fields.filter).toEqual(emptyProjectFilterGroup())
    expect(isProjectFilterGroup(fields.filter)).toBe(true)
    expect(isProjectFilterGroup({ propertyId: 'p', condition: 'is', values: [] })).toBe(false)
    expect(fields.cardOrder).toEqual([])
    expect(fields.defaultTemplateId).toBe('')
  })
})

describe('project ids', () => {
  it('mints an id of the shape the reference archives use, with the type in front', () => {
    const id = newProjectId('board')
    expect(id).toHaveLength(PROJECT_LIMITS.idLength)
    expect(id.startsWith('b')).toBe(true)
    expect(PROJECT_ID_PATTERN.test(id)).toBe(true)
    expect(isProjectId(id)).toBe(true)
  })

  it('takes the UUID spelling the reference built-in templates use for properties and options', () => {
    expect(isProjectId('d777ba3b-8728-40d1-87a6-59406bbbbfb0')).toBe(true)
    expect(isProjectId('716fy9hw4p38a5mf8rq5ap6txoo')).toBe(true)
  })

  it('refuses anything that could escape an object key', () => {
    for (const bad of ['../etc/passwd', 'a/b', 'a b', '', 'x'.repeat(28), 'A'.repeat(27), null, 7]) {
      expect(isProjectId(bad)).toBe(false)
    }
  })

  it('does not hand out the same id twice', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newProjectId('card')))
    expect(ids.size).toBe(200)
  })
})

describe('effective role', () => {
  const base = { ownerId: 'owner', userId: 'reader', boardType: 'P' as const, minimumRole: '' as const, memberRole: null }

  it('makes the owner an admin even without a membership row', () => {
    expect(effectiveProjectRole({ ...base, userId: 'owner' })).toBe('admin')
  })

  it('gives a private board nothing to a stranger', () => {
    expect(effectiveProjectRole(base)).toBeNull()
  })

  it('grants an open board its minimum to any signed-in account', () => {
    expect(effectiveProjectRole({ ...base, boardType: 'O', minimumRole: 'commenter' })).toBe('commenter')
  })

  it('takes the stronger of the membership and the minimum, never the weaker', () => {
    expect(effectiveProjectRole({ ...base, boardType: 'O', minimumRole: 'editor', memberRole: 'viewer' })).toBe('editor')
    expect(effectiveProjectRole({ ...base, memberRole: 'admin' })).toBe('admin')
  })

  it('answers the same question the permission matrix asks', () => {
    expect(projectRoleAtLeast('editor', 'commenter')).toBe(true)
    expect(projectRoleAtLeast('commenter', 'editor')).toBe(false)
    expect(projectRoleAtLeast(null, 'viewer')).toBe(false)
  })
})