import { describe, expect, it } from 'vitest'
import { EN_US_MESSAGES } from './locales/en-US'
import { ZH_CN_MESSAGES } from './locales/zh-CN'
import { EN_US_NOTE_TEMPLATE_CONTENT } from './locales/en-US-note-template-content'
import { ZH_CN_NOTE_TEMPLATE_CONTENT } from './locales/zh-CN-note-template-content'
import type { MessageKey } from './locales/en-US'
import {
  BUILTIN_TEMPLATE_CATEGORIES,
  BUILTIN_TEMPLATE_DEFS,
  BUILTIN_TEMPLATE_TAG_LABELS,
  TEMPLATE_IMPORT_LIMITS,
  TEMPLATE_SEED_VERSION,
  buildTemplateLibraryExport,
  parseTemplateLibraryExport,
} from './note-templates'
import type { NoteTemplate, NoteTemplateCategory } from './types'

function category(id: string, builtin = false): NoteTemplateCategory {
  return { id, name: `Category ${id}`, builtin, position: 0, createdAt: 1 }
}

function template(id: string, overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id,
    categoryId: null,
    name: `Template ${id}`,
    description: '',
    content: '# Body',
    builtin: false,
    isPinned: false,
    isStarred: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function exportJson(payload: Record<string, unknown>): string {
  return JSON.stringify({ app: 'inkstone', kind: 'template-library', version: 1, exportedAt: 1, ...payload })
}

describe('built-in template catalog', () => {
  it('has a unique id and a known category for every entry', () => {
    const ids = new Set(BUILTIN_TEMPLATE_DEFS.map((def) => def.id))
    expect(ids.size).toBe(BUILTIN_TEMPLATE_DEFS.length)
    const categories = new Set(BUILTIN_TEMPLATE_CATEGORIES.map((def) => def.id))
    for (const def of BUILTIN_TEMPLATE_DEFS) {
      expect(categories.has(def.categoryId), def.id).toBe(true)
      expect(def.tags.length, def.id).toBeGreaterThan(0)
    }
  })

  it('names every category once and numbers the positions without gaps', () => {
    const ids = new Set(BUILTIN_TEMPLATE_CATEGORIES.map((def) => def.id))
    expect(ids.size).toBe(BUILTIN_TEMPLATE_CATEGORIES.length)
    expect(BUILTIN_TEMPLATE_CATEGORIES.map((def) => def.position)).toEqual(
      BUILTIN_TEMPLATE_CATEGORIES.map((_, index) => index),
    )
  })

  it('keys each tag label after a tag the catalog actually uses', () => {
    const used = new Set(BUILTIN_TEMPLATE_DEFS.flatMap((def) => def.tags))
    const declared = new Set(Object.keys(BUILTIN_TEMPLATE_TAG_LABELS))
    for (const tag of used) expect(declared.has(tag), tag).toBe(true)
  })

  it('derives each message key from the entry id so the locale files can be scanned', () => {
    for (const def of BUILTIN_TEMPLATE_DEFS) {
      const slug = def.id.replaceAll('-', '_')
      expect(def.nameKey, def.id).toBe(`template.${slug}.name`)
      expect(def.descriptionKey, def.id).toBe(`template.${slug}.description`)
      expect(def.contentKey, def.id).toBe(`template.${slug}.content`)
    }
  })

  it('carries a seed version so an already-seeded library can be topped up', () => {
    expect(TEMPLATE_SEED_VERSION).toBeGreaterThanOrEqual(1)
  })

  it('resolves every message key the catalog names in both locale files', () => {
    const en = { ...EN_US_MESSAGES, ...EN_US_NOTE_TEMPLATE_CONTENT }
    const zh = { ...ZH_CN_MESSAGES, ...ZH_CN_NOTE_TEMPLATE_CONTENT }
    const keys: MessageKey[] = [
      ...Object.values(BUILTIN_TEMPLATE_TAG_LABELS),
      ...BUILTIN_TEMPLATE_CATEGORIES.map((def) => def.nameKey),
      ...BUILTIN_TEMPLATE_DEFS.flatMap((def) => [def.nameKey, def.descriptionKey, def.contentKey]),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(en[key], key).toBeTruthy()
      expect(zh[key], key).toBeTruthy()
    }
    for (const def of BUILTIN_TEMPLATE_DEFS) {
      expect(en[def.contentKey], def.contentKey).toContain('{{title}}')
      expect(en[def.contentKey], def.contentKey).toMatch(/^---\r?\n/)
    }
  })
})

describe('buildTemplateLibraryExport', () => {
  it('exports only what the user made', () => {
    const data = buildTemplateLibraryExport(
      [category('productivity', true), category('cat-1')],
      [template('okr', { builtin: true }), template('tpl-1')],
    )
    expect(data.categories.map((item) => item.id)).toEqual(['cat-1'])
    expect(data.templates.map((item) => item.id)).toEqual(['tpl-1'])
    expect(data.version).toBe(1)
  })
})

describe('parseTemplateLibraryExport', () => {
  it('round-trips a library the app exported', () => {
    const source = buildTemplateLibraryExport([category('cat-1')], [template('tpl-1', { categoryId: 'cat-1' })])
    const parsed = parseTemplateLibraryExport(JSON.stringify(source))
    expect(parsed.data).toEqual(source)
    expect(parsed.dropped).toBe(0)
    expect(parsed.truncated).toBe(false)
  })

  it('rejects anything that is not this file format', () => {
    for (const text of ['', 'not json', '[]', 'null', '"text"', JSON.stringify({ kind: 'template-library' })])
      expect(parseTemplateLibraryExport(text).data, text).toBe(null)
  })

  it('drops a malformed entry without discarding the rest of the file', () => {
    const parsed = parseTemplateLibraryExport(exportJson({
      categories: [category('cat-1'), { id: 'cat-2' }],
      templates: [template('tpl-1'), { id: 'tpl-2', name: 42 }, 'nope'],
    }))
    expect(parsed.data?.categories.map((item) => item.id)).toEqual(['cat-1'])
    expect(parsed.data?.templates.map((item) => item.id)).toEqual(['tpl-1'])
    expect(parsed.dropped).toBe(3)
  })

  it('refuses to import an entry claiming to be built-in', () => {
    const parsed = parseTemplateLibraryExport(exportJson({
      templates: [template('okr', { builtin: true }), template('tpl-1')],
    }))
    expect(parsed.data?.templates.map((item) => item.id)).toEqual(['tpl-1'])
  })

  it('clears pin and star flags so an import cannot pre-pin the gallery', () => {
    const parsed = parseTemplateLibraryExport(exportJson({
      templates: [template('tpl-1', { isPinned: true, isStarred: true })],
    }))
    expect(parsed.data?.templates[0]).toMatchObject({ isPinned: false, isStarred: false })
  })

  it('clamps an over-long name, description, id and body', () => {
    const parsed = parseTemplateLibraryExport(exportJson({
      templates: [template('x'.repeat(500), {
        name: 'n'.repeat(500),
        description: 'd'.repeat(500),
        content: 'c'.repeat(TEMPLATE_IMPORT_LIMITS.maxContentLength + 10),
        tags: ['t'.repeat(500)],
      })],
    }))
    const [only] = parsed.data!.templates
    expect(only.id).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxIdLength)
    expect(only.name).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxNameLength)
    expect(only.description).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxDescriptionLength)
    expect(only.content).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxContentLength)
    expect(only.tags[0]).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxTagLength)
  })

  it('truncates the entry counts and says so', () => {
    const parsed = parseTemplateLibraryExport(exportJson({
      templates: Array.from({ length: TEMPLATE_IMPORT_LIMITS.maxTemplates + 5 }, (_, index) => template(`t${index}`)),
    }))
    expect(parsed.data!.templates).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxTemplates)
    expect(parsed.truncated).toBe(true)
  })

  it('drops a duplicate category id and a template with nothing in it', () => {
    const parsed = parseTemplateLibraryExport(exportJson({
      categories: [category('cat-1'), category('cat-1')],
      templates: [template('tpl-1', { content: '' })],
    }))
    expect(parsed.data!.categories).toHaveLength(1)
    expect(parsed.data!.templates).toEqual([])
    expect(parsed.dropped).toBe(2)
  })

  it('stops importing once the combined body budget is spent', () => {
    const full = 'a'.repeat(TEMPLATE_IMPORT_LIMITS.maxContentLength)
    const many = Array.from({ length: 100 }, (_, index) => template(`big-${index}`, { content: full }))
    const parsed = parseTemplateLibraryExport(exportJson({ templates: many }))
    const total = parsed.data!.templates.reduce((sum, item) => sum + item.content.length, 0)
    expect(total).toBeLessThanOrEqual(TEMPLATE_IMPORT_LIMITS.maxTotalContentLength)
    expect(parsed.data!.templates.length).toBeLessThan(many.length)
    expect(parsed.truncated).toBe(true)
  })

  it('refuses a payload past the text ceiling before parsing it', () => {
    const huge = `${'x'.repeat(TEMPLATE_IMPORT_LIMITS.maxTextLength)}"`
    expect(parseTemplateLibraryExport(huge).data).toBe(null)
  })
})
