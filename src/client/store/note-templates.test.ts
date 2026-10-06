import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_TEMPLATE_DEFS, TEMPLATE_SEED_VERSION } from '@shared/note-templates'
import { DEFAULT_NEW_NOTE_TEMPLATE } from '@shared/constants'
import type { NoteTemplate } from '@shared/types'
import { initI18n, t } from '../lib/i18n'
import { compareTemplates, templateOrderValue, useNoteTemplates } from './note-templates'
import type { TemplateLibraryData } from '../lib/db'

const stored = vi.hoisted((): { value: TemplateLibraryData | null } => ({ value: null }))

vi.mock('../lib/db', () => ({
  localDb: {
    loadTemplateLibrary: async () => stored.value,
    saveTemplateLibrary: async (data: TemplateLibraryData) => {
      stored.value = JSON.parse(JSON.stringify(data)) as TemplateLibraryData
    },
  },
}))

function library(): TemplateLibraryData {
  return stored.value!
}

function fresh() {
  return useNoteTemplates.getState()
}

function template(overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'tpl-1',
    categoryId: null,
    name: 'My template',
    description: '',
    content: '# Body',
    builtin: false,
    isPinned: false,
    isStarred: false,
    tags: [],
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  stored.value = null
  useNoteTemplates.setState({ categories: [], templates: [], hydrated: false, owner: '' })
  await fresh().hydrate('user-a')
})

describe('template library hydration', () => {
  it('seeds the whole built-in catalog and writes it once', () => {
    const state = fresh()
    expect(state.templates).toHaveLength(BUILTIN_TEMPLATE_DEFS.length)
    expect(state.categories.map((item) => item.id)).toEqual([
      'productivity', 'tasks', 'learning', 'work', 'life', 'health', 'writing', 'industry',
    ])
    expect(library().seedVersion).toBe(TEMPLATE_SEED_VERSION)
    expect(state.hydrated).toBe(true)
  })

  it('labels the built-ins in the active language rather than by key', () => {
    const okr = fresh().templates.find((item) => item.id === 'okr')
    expect(okr?.name).toBe(t('template.okr.name'))
    expect(okr?.name).not.toBe('template.okr.name')
    expect(okr?.tags.length).toBeGreaterThan(0)
    expect(okr?.tags).not.toContain('template.tag.goal')
  })

  it('re-reads when the account changes instead of showing the previous library', async () => {
    const firstTemplates = fresh().templates
    fresh().createTemplate({ name: 'Account A only', content: 'secret body' })
    expect(fresh().templates).toHaveLength(firstTemplates.length + 1)

    stored.value = { categories: [], templates: [template({ id: 'b-1', name: 'Account B' })], seedVersion: TEMPLATE_SEED_VERSION }
    useNoteTemplates.setState({ hydrated: false })
    await fresh().hydrate('user-b')

    expect(fresh().owner).toBe('user-b')
    expect(fresh().templates.some((item) => item.name === 'Account A only')).toBe(false)
    expect(fresh().templates.find((item) => item.id === 'b-1')?.name).toBe('Account B')
  })

  it('keeps a hydrated library for the same account without re-reading', async () => {
    const before = fresh().templates
    stored.value = { categories: [], templates: [], seedVersion: TEMPLATE_SEED_VERSION }
    await fresh().hydrate('user-a')
    expect(fresh().templates).toBe(before)
  })

  it('tops up an older seed without discarding the user’s own entries', async () => {
    stored.value = {
      categories: [],
      templates: [template({ id: 'mine', name: 'Mine' })],
      seedVersion: 0,
    }
    useNoteTemplates.setState({ hydrated: false, owner: '' })
    await fresh().hydrate('user-a')
    const names = fresh().templates.map((item) => item.id)
    expect(names).toContain('mine')
    expect(names).toHaveLength(BUILTIN_TEMPLATE_DEFS.length + 1)
  })

  it('refreshes a pristine built-in from the catalog but never a customized copy', async () => {
    const bullet = BUILTIN_TEMPLATE_DEFS[0]
    stored.value = {
      categories: [],
      templates: [
        template({ id: bullet.id, name: 'stale name', builtin: true }),
        template({ id: 'okr', name: 'My OKR', builtin: false }),
      ],
      seedVersion: TEMPLATE_SEED_VERSION,
    }
    useNoteTemplates.setState({ hydrated: false, owner: '' })
    await fresh().hydrate('user-a')
    expect(fresh().templates.find((item) => item.id === bullet.id)?.name).toBe(t(bullet.nameKey))
    expect(fresh().templates.find((item) => item.id === 'okr')?.name).toBe('My OKR')
  })

  it('orders built-in categories ahead of the user’s own', async () => {
    stored.value = {
      categories: [
        { id: 'cat-old', name: 'Oldest', builtin: false, position: 0, createdAt: 1 },
        { id: 'tasks', name: 'Tasks', builtin: true, position: 1, createdAt: 2 },
      ],
      templates: [template({ id: 'good' })],
      seedVersion: TEMPLATE_SEED_VERSION,
    }
    useNoteTemplates.setState({ hydrated: false, owner: '' })
    await fresh().hydrate('user-a')
    expect(fresh().categories.map((item) => item.id)).toEqual(['tasks', 'cat-old'])
  })
})

describe('categories', () => {
  it('creates a user category after the built-ins', () => {
    const id = fresh().createCategory('  Recipes  ')
    expect(id).toBeTruthy()
    const categories = fresh().categories
    expect(categories.at(-1)).toMatchObject({ id, name: 'Recipes', builtin: false })
    expect(categories.slice(0, 8).every((item) => item.builtin)).toBe(true)
  })

  it('refuses a blank name and touching a built-in category', () => {
    expect(fresh().createCategory('   ')).toBe(null)
    expect(fresh().renameCategory('tasks', 'Nope')).toBe(false)
    expect(fresh().deleteCategory('tasks')).toBe(false)
    expect(fresh().categories.find((item) => item.id === 'tasks')?.name).toBe(t('template.category.tasks'))
  })

  it('moves an orphaned template to uncategorized when its category goes', () => {
    const categoryId = fresh().createCategory('Temp')!
    const templateId = fresh().createTemplate({ name: 'Kept', content: 'body', categoryId })!
    expect(fresh().templates.find((item) => item.id === templateId)?.categoryId).toBe(categoryId)
    expect(fresh().deleteCategory(categoryId)).toBe(true)
    expect(fresh().templates.find((item) => item.id === templateId)?.categoryId).toBe(null)
  })
})

describe('templates', () => {
  it('rejects an unnamed or empty-bodied template', () => {
    expect(fresh().createTemplate({ name: '  ', content: 'x' })).toBe(null)
    expect(fresh().createTemplate({ name: 'Ok', content: '' })).toBe(null)
  })

  it('caps tags at eight distinct, trimmed entries', () => {
    const id = fresh().createTemplate({
      name: 'Tagged',
      content: 'body',
      tags: [' a ', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'x'.repeat(80)],
    })!
    const tags = fresh().templates.find((item) => item.id === id)!.tags
    expect(tags).toHaveLength(8)
    expect(tags[0]).toBe('a')
    expect(tags.every((tag) => tag.length <= 30)).toBe(true)
  })

  it('hands ownership of an edited built-in to the user', () => {
    expect(fresh().updateTemplate('okr', { name: 'My OKR' })).toBe(true)
    const okr = fresh().templates.find((item) => item.id === 'okr')!
    expect(okr.builtin).toBe(false)
    expect(okr.name).toBe('My OKR')
    expect(fresh().deleteTemplate('okr')).toBe(true)
  })

  it('keeps a built-in undeletable and refuses an empty rename', () => {
    expect(fresh().deleteTemplate('okr')).toBe(false)
    expect(fresh().updateTemplate('okr', { name: '   ' })).toBe(false)
  })

  it('copies a built-in as an independent, unstarred template', () => {
    fresh().toggleTemplateStar('okr')
    const copyId = fresh().duplicateTemplate('okr')!
    const copy = fresh().templates.find((item) => item.id === copyId)!
    expect(copy.builtin).toBe(false)
    expect(copy.isStarred).toBe(false)
    expect(copy.isPinned).toBe(false)
    expect(copy.content).toBe(fresh().templates.find((item) => item.id === 'okr')!.content)
    expect(copy.name).toContain(t('common.copy'))
  })

  it('persists every mutation to the stored library', () => {
    fresh().createTemplate({ name: 'Persisted', content: 'body' })
    expect(library().templates.some((item) => item.name === 'Persisted')).toBe(true)
    fresh().toggleTemplateStar('okr')
    expect(library().templates.find((item) => item.id === 'okr')?.isStarred).toBe(true)
  })
})

describe('ordering', () => {
  it('places a new template after its siblings in the same category', () => {
    const categoryId = fresh().createCategory('Order')!
    const first = fresh().createTemplate({ name: 'First', content: 'a', categoryId })!
    const second = fresh().createTemplate({ name: 'Second', content: 'b', categoryId })!
    const positionOf = (id: string) => fresh().templates.find((item) => item.id === id)!.position!
    expect(positionOf(second)).toBeGreaterThan(positionOf(first))
  })

  it('reorders inside one category without disturbing another', () => {
    const a = fresh().createCategory('A')!
    const b = fresh().createCategory('B')!
    const a1 = fresh().createTemplate({ name: 'a1', content: '1', categoryId: a })!
    const a2 = fresh().createTemplate({ name: 'a2', content: '2', categoryId: a })!
    const b1 = fresh().createTemplate({ name: 'b1', content: '3', categoryId: b })!
    expect(fresh().placeTemplate(a2, a, 0)).toBe(true)
    const order = fresh().templates
      .filter((item) => item.categoryId === a)
      .sort((x, y) => templateOrderValue(x) - templateOrderValue(y))
      .map((item) => item.id)
    expect(order).toEqual([a2, a1])
    expect(fresh().templates.find((item) => item.id === b1)?.categoryId).toBe(b)
  })

  it('moves across categories when the drop target is a different one', () => {
    const a = fresh().createCategory('A')!
    const b = fresh().createCategory('B')!
    const moved = fresh().createTemplate({ name: 'm', content: 'x', categoryId: a })!
    fresh().placeTemplate(moved, b, 0)
    expect(fresh().templates.find((item) => item.id === moved)?.categoryId).toBe(b)
  })

  it('sorts pinned first, then starred, then by position', () => {
    const plain = template({ id: 'plain', position: 0 })
    const starred = template({ id: 'starred', position: 1, isStarred: true })
    const pinned = template({ id: 'pinned', position: 9, isPinned: true })
    expect([plain, starred, pinned].sort(compareTemplates).map((item) => item.id)).toEqual([
      'pinned', 'starred', 'plain',
    ])
  })

  it('falls back to recency for a template nobody positioned', () => {
    const old = template({ id: 'old', position: undefined, updatedAt: 100 })
    const freshOne = template({ id: 'new', position: undefined, updatedAt: 1_000_000 })
    expect(templateOrderValue(old)).toBeGreaterThan(templateOrderValue(freshOne))
  })
})

describe('import', () => {
  function payload(overrides: Record<string, unknown> = {}) {
    return {
      app: 'inkstone' as const,
      kind: 'template-library' as const,
      version: 1 as const,
      exportedAt: 1,
      categories: [],
      templates: [],
      ...overrides,
    }
  }

  it('imports a custom category and the template that points at it', () => {
    const result = fresh().importTemplates(payload({
      categories: [{ id: 'cat-x', name: 'Imported', builtin: false, position: 0, createdAt: 5 }],
      templates: [template({ id: 't-x', categoryId: 'cat-x' })],
    }))
    expect(result).toEqual({ imported: 1, skipped: 0 })
    expect(fresh().categories.some((item) => item.id === 'cat-x')).toBe(true)
    expect(fresh().templates.find((item) => item.id === 't-x')?.categoryId).toBe('cat-x')
  })

  it('drops a dangling category id instead of stranding the template', () => {
    fresh().importTemplates(payload({ templates: [template({ id: 't-y', categoryId: 'nope' })] }))
    expect(fresh().templates.find((item) => item.id === 't-y')?.categoryId).toBe(null)
  })

  it('cannot overwrite a built-in through an import', () => {
    const okr = fresh().templates.find((item) => item.id === 'okr')!
    const result = fresh().importTemplates(payload({
      templates: [template({ id: 'okr', name: 'Squatter', content: 'squatted' })],
    }))
    expect(result).toEqual({ imported: 0, skipped: 1 })
    expect(fresh().templates.find((item) => item.id === 'okr')).toBe(okr)
  })

  it('clears pin and star flags on the way in', () => {
    fresh().importTemplates(payload({
      templates: [template({ id: 't-z', isPinned: true, isStarred: true })],
    }))
    const imported = fresh().templates.find((item) => item.id === 't-z')!
    expect(imported).toMatchObject({ isPinned: false, isStarred: false })
  })
})

describe('the shipped default template', () => {
  it('is what a fresh account starts with', () => {
    expect(DEFAULT_NEW_NOTE_TEMPLATE.startsWith('---\n')).toBe(true)
    expect(DEFAULT_NEW_NOTE_TEMPLATE).toContain('{{title}}')
  })
})
