import { describe, expect, it } from 'vitest'
import { PROJECT_LIMITS, newProjectId } from './limits'
import {
  ProjectBatchSchema,
  ProjectBoardCreateSchema,
  ProjectBoardPatchSchema,
  ProjectCardPatchSchema,
  ProjectFilterGroupSchema,
  ProjectPropertySchema,
  ProjectSharePutSchema,
  ProjectViewFieldsSchema,
} from './validation'

describe('board input', () => {
  it('fills the defaults a new board needs and keeps the caller out of the storage columns', () => {
    const parsed = ProjectBoardCreateSchema.parse({})
    expect(parsed).toEqual({
      title: '', description: '', icon: '', showDescription: false,
      type: 'P', minimumRole: '', isTemplate: false, cardProperties: [],
    })
  })

  it('refuses a board type or minimum role outside the vocabulary', () => {
    expect(ProjectBoardCreateSchema.safeParse({ type: 'X' }).success).toBe(false)
    expect(ProjectBoardCreateSchema.safeParse({ minimumRole: 'owner' }).success).toBe(false)
    expect(ProjectBoardCreateSchema.safeParse({ minimumRole: '' }).success).toBe(true)
  })

  it('bounds a title in characters, so an emoji title is not rejected twice over', () => {
    const wide = '\u{1F600}'
    expect(wide.length).toBe(2)
    expect(ProjectBoardCreateSchema.safeParse({ title: 'a'.repeat(PROJECT_LIMITS.titleRunes) }).success).toBe(true)
    expect(ProjectBoardCreateSchema.safeParse({ title: 'a'.repeat(PROJECT_LIMITS.titleRunes + 1) }).success).toBe(false)
    expect(ProjectBoardCreateSchema.safeParse({ title: wide.repeat(PROJECT_LIMITS.titleRunes) }).success).toBe(true)
    expect(ProjectBoardCreateSchema.safeParse({ title: wide.repeat(PROJECT_LIMITS.titleRunes + 1) }).success).toBe(false)
  })

  it('refuses an id that could escape an object key', () => {
    expect(ProjectBoardCreateSchema.safeParse({ id: '../etc' }).success).toBe(false)
    expect(ProjectBoardCreateSchema.safeParse({ id: newProjectId('board') }).success).toBe(true)
  })

  it('leaves an absent patch field absent, so a patch never clears what it did not name', () => {
    const parsed = ProjectBoardPatchSchema.parse({ title: 'Renamed' })
    expect(parsed).toEqual({ title: 'Renamed' })
    expect('description' in parsed).toBe(false)
    expect('updatedCardProperties' in parsed).toBe(false)
  })

  it('bounds the property list at the stated ceiling', () => {
    const property = { id: newProjectId('property'), name: 'Status', type: 'select', options: [] }
    const tooMany = Array.from({ length: PROJECT_LIMITS.propertiesPerBoard + 1 }, () => property)
    expect(ProjectBoardPatchSchema.safeParse({ updatedCardProperties: tooMany }).success).toBe(false)
  })
})

describe('property input', () => {
  it('accepts both id spellings an imported archive carries', () => {
    const base = { name: 'Status', type: 'select', options: [] }
    expect(ProjectPropertySchema.safeParse({ ...base, id: newProjectId('property') }).success).toBe(true)
    expect(ProjectPropertySchema.safeParse({ ...base, id: 'd777ba3b-8728-40d1-87a6-59406bbbbfb0' }).success).toBe(true)
  })

  it('refuses a type the vocabulary does not name', () => {
    expect(ProjectPropertySchema.safeParse({
      id: newProjectId('property'), name: 'x', type: 'notAType', options: [],
    }).success).toBe(false)
  })
})

describe('filter groups', () => {
  it('reads a group nested inside a group, which is the shape the reference stores', () => {
    const parsed = ProjectFilterGroupSchema.parse({
      operation: 'or',
      filters: [
        { propertyId: 'p1', condition: 'includes', values: ['o1'] },
        { operation: 'and', filters: [{ propertyId: 'p2', condition: 'isSet', values: [] }] },
      ],
    })
    expect(parsed.operation).toBe('or')
    expect(parsed.filters).toHaveLength(2)
    expect((parsed.filters[1] as { operation: string }).operation).toBe('and')
  })

  it('refuses an operation or condition outside the vocabulary', () => {
    expect(ProjectFilterGroupSchema.safeParse({ operation: 'xor', filters: [] }).success).toBe(false)
    expect(ProjectFilterGroupSchema.safeParse({
      operation: 'and', filters: [{ propertyId: 'p', condition: 'matches', values: [] }],
    }).success).toBe(false)
  })

  it('takes an empty group, which is what a view with no filter stores', () => {
    expect(ProjectFilterGroupSchema.parse({ operation: 'and', filters: [] })).toEqual({ operation: 'and', filters: [] })
  })
})

describe('view fields', () => {
  it('accepts a partial set, because a new view names only what it differs on', () => {
    const parsed = ProjectViewFieldsSchema.partial().parse({ cardOrder: ['c1'], defaultTemplateId: '' })
    expect(parsed.cardOrder).toEqual(['c1'])
    expect(parsed.filter).toBeUndefined()
  })

  it('retains density/swimlane/WIP so those controls are not silently stripped (R2-1)', () => {
    const parsed = ProjectViewFieldsSchema.partial().parse({ cardSize: 'compact', swimlaneBy: 'p1', wipLimits: { o1: 3 } })
    expect(parsed.cardSize).toBe('compact')
    expect(parsed.swimlaneBy).toBe('p1')
    expect(parsed.wipLimits).toEqual({ o1: 3 })
    expect(ProjectViewFieldsSchema.partial().safeParse({ cardSize: 'gigantic' }).success).toBe(false)
    expect(ProjectViewFieldsSchema.partial().safeParse({ wipLimits: { o1: -1 } }).success).toBe(false)
  })

  it('refuses a column width that is not a sane pixel count', () => {
    expect(ProjectViewFieldsSchema.safeParse({ columnWidths: { p1: -1 } }).success).toBe(false)
    expect(ProjectViewFieldsSchema.safeParse({ columnWidths: { p1: 1e9 } }).success).toBe(false)
  })

  it('refuses a calculation the vocabulary does not name', () => {
    expect(ProjectViewFieldsSchema.safeParse({ columnCalculations: { p1: 'stddev' } }).success).toBe(false)
  })
})

describe('card patches, shares and batches', () => {
  it('lets a patch clear one property value with null and set another with text', () => {
    const id = newProjectId('property')
    const parsed = ProjectCardPatchSchema.parse({ values: { [id]: null } })
    expect(parsed.values?.[id]).toBeNull()
  })

  it('refuses a share password shorter than the minimum', () => {
    expect(ProjectSharePutSchema.safeParse({ password: 'abc' }).success).toBe(false)
    expect(ProjectSharePutSchema.safeParse({ password: null }).success).toBe(true)
    expect(ProjectSharePutSchema.safeParse({ expiresAt: -1 }).success).toBe(false)
  })

  it('bounds a batch, so one request cannot hold the database indefinitely', () => {
    const cards = Array.from({ length: PROJECT_LIMITS.batchOperations + 1 }, () => ({
      id: newProjectId('card'), patch: { title: 'x' },
    }))
    expect(ProjectBatchSchema.safeParse({ cards }).success).toBe(false)
    expect(ProjectBatchSchema.safeParse({ cards: cards.slice(0, 1) }).success).toBe(true)
  })
})