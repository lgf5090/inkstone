import { describe, expect, it } from 'vitest'
import { ORGANIZER_COLORS } from './organizer-colors'
import { LIMITS } from './constants'
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
  return { id, name: `Category ${id}`, builtin, position: 0, createdAt: 1, icon: null, color: null }
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

  it('dresses every built-in category with an icon and its own palette colour', () => {
    for (const def of BUILTIN_TEMPLATE_CATEGORIES) {
      expect(def.icon, def.id).toBeTruthy()
      expect([...def.icon].length, def.id).toBeLessThanOrEqual(LIMITS.organizerIconMaxLength)
      expect(ORGANIZER_COLORS as readonly string[], def.id).toContain(def.color)
    }
    const colours = new Set(BUILTIN_TEMPLATE_CATEGORIES.map((def) => def.color))
    expect(colours.size).toBe(BUILTIN_TEMPLATE_CATEGORIES.length)
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
    const en = { ...EN_US_MESSAGES, ...EN_US_NOTE_TEMPLATE_CONTENT } as Record<string, string>
    const zh = { ...ZH_CN_MESSAGES, ...ZH_CN_NOTE_TEMPLATE_CONTENT } as Record<string, string>
    const keys = [
      ...Object.values(BUILTIN_TEMPLATE_TAG_LABELS),
      ...BUILTIN_TEMPLATE_CATEGORIES.map((def) => def.nameKey),
      ...BUILTIN_TEMPLATE_DEFS.flatMap((def) => [def.nameKey, def.descriptionKey, def.contentKey]),
    ] as MessageKey[]
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(en[key], key).toBeTruthy()
      expect(zh[key], key).toBeTruthy()
    }
    for (const def of BUILTIN_TEMPLATE_DEFS) {
      // The invariant is "a built-in note names its own title", not "every built-in spells it the same way":
      // the app's own templates interpolate `{{title}}`, while a Templater template asks the engine with
      // `tp.file.title`. A Templater body run through the create path is never pre-interpolated, so writing
      // `{{title}}` into one would leave those eight characters in the reader's note.
      expect(en[def.contentKey], def.contentKey).toMatch(/^---\r?\n/)
      const namesItsTitle = en[def.contentKey].includes('{{title}}') || en[def.contentKey].includes('tp.file.title')
      expect(namesItsTitle, def.contentKey).toBe(true)
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

  it('keeps pin and star flags for the account snapshot itself', () => {
    const parsed = parseTemplateLibraryExport(exportJson({
      templates: [template('tpl-1', { isPinned: true, isStarred: true })],
    }), { keepFlags: true })
    expect(parsed.data?.templates[0]).toMatchObject({ isPinned: true, isStarred: true })
  })

  it('carries a category icon and colour through the export round trip', () => {
    const parsed = parseTemplateLibraryExport(JSON.stringify(buildTemplateLibraryExport(
      [{ ...category('cat-1'), icon: '🎯', color: '#059669' }],
      [template('tpl-1')],
    )))
    expect(parsed.data?.categories[0]).toMatchObject({ icon: '🎯', color: '#059669' })
    expect(parsed.dropped).toBe(0)
  })

  it('treats an appearance it cannot recognise as nothing', () => {
    const oddColour = parseTemplateLibraryExport(exportJson({
      categories: [{ id: 'cat-1', name: 'One', builtin: false, position: 0, createdAt: 1, icon: '🎯', color: 'crimson' }],
    }))
    expect(oddColour.data?.categories[0]).toMatchObject({ icon: '🎯', color: null })
    const hugeIcon = parseTemplateLibraryExport(exportJson({
      categories: [{ id: 'cat-1', name: 'One', builtin: false, position: 0, createdAt: 1, icon: 'x'.repeat(200), color: '#059669' }],
    }))
    expect([...(hugeIcon.data?.categories[0]?.icon ?? '')].length).toBe(LIMITS.organizerIconMaxLength)
    expect(hugeIcon.data?.categories[0]?.color).toBe('#059669')
  })

  it('clamps an over-long name, description and body', () => {
    const parsed = parseTemplateLibraryExport(exportJson({
      templates: [template('tpl-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        name: 'n'.repeat(500),
        description: 'd'.repeat(500),
        content: 'c'.repeat(TEMPLATE_IMPORT_LIMITS.maxContentLength + 10),
        tags: ['t'.repeat(500)],
      })],
    }))
    const [only] = parsed.data!.templates
    expect(only.id).toHaveLength(36)
    expect(only.name).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxNameLength)
    expect(only.description).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxDescriptionLength)
    expect(only.content).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxContentLength)
    expect(only.tags[0]).toHaveLength(TEMPLATE_IMPORT_LIMITS.maxTagLength)
  })

  it('refuses an id that could only misbehave as an attribute or a selector', () => {
    for (const bad of ['x'.repeat(500), 'has space', 'UPPER', 'quote"id', 'line\nbreak', '']) {
      const parsed = parseTemplateLibraryExport(exportJson({ templates: [template(bad)] }))
      expect(parsed.data?.templates ?? [], bad).toHaveLength(0)
      expect(parsed.dropped, bad).toBe(1)
    }
  })

  it('refuses a category whose id breaks the charset, and its templates with it', () => {
    const parsed = parseTemplateLibraryExport(exportJson({
      categories: [{ id: 'bad id', name: 'Bad', builtin: false, position: 0, createdAt: 1 }],
      templates: [template('tpl-ok', { categoryId: 'bad id' })],
    }))
    expect(parsed.data?.categories ?? []).toHaveLength(0)
    expect(parsed.data?.templates ?? []).toHaveLength(1)
    expect(parsed.data?.templates[0]?.categoryId).toBe(null)
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

describe('the exported stamp', () => {
  function withExportedAt(exportedAt: unknown) {
    const base = parseTemplateLibraryExport(JSON.stringify({
      app: 'inkstone',
      kind: 'template-library',
      version: 1,
      exportedAt,
      categories: [],
      templates: [],
    }))
    return base.data?.exportedAt
  }

  it('keeps a sane stamp and clamps a wild one', () => {
    expect(withExportedAt(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(withExportedAt(1e18)).toBeLessThan(Date.UTC(2101, 0, 1))
    expect(withExportedAt(-9e15)).toBe(0)
    expect(withExportedAt('soon')).toBeGreaterThan(0)
    expect(withExportedAt(Number.NaN)).toBeGreaterThan(0)
  })
})

describe('the catalog keeps its shape', () => {
  function frontMatterTags(content: string): string[] {
    const closed = content.indexOf('\n---', 4)
    const head = closed < 0 ? '' : content.slice(0, closed)
    const line = /^tags: \[([^\]]*)\]$/m.exec(head)
    return line ? line[1].split(',').map((tag) => tag.trim()).filter(Boolean) : []
  }

  it('gives every category at least six templates', () => {
    const counts = new Map<string, number>()
    for (const def of BUILTIN_TEMPLATE_DEFS)
      counts.set(def.categoryId, (counts.get(def.categoryId) ?? 0) + 1)
    const thin = BUILTIN_TEMPLATE_CATEGORIES
      .map((category) => category.id)
      .filter((id) => (counts.get(id) ?? 0) < 6)
    expect(thin, `categories below the floor: ${thin.join(', ')}`).toEqual([])
  })

  it('never leaves a category without a template', () => {
    const used = new Set(BUILTIN_TEMPLATE_DEFS.map((def) => def.categoryId))
    for (const category of BUILTIN_TEMPLATE_CATEGORIES)
      expect(used.has(category.id), category.id).toBe(true)
  })

  it('names only tags the catalog carries a label for', () => {
    for (const def of BUILTIN_TEMPLATE_DEFS)
      for (const tag of def.tags)
        expect(BUILTIN_TEMPLATE_TAG_LABELS, `${def.id} ${tag}`).toHaveProperty(tag)
  })

  it('tags both languages of every body the same way', async () => {
    const { EN_US_NOTE_TEMPLATE_CONTENT } = await import('./locales/en-US-note-template-content')
    const { ZH_CN_NOTE_TEMPLATE_CONTENT } = await import('./locales/zh-CN-note-template-content')
    const en = EN_US_NOTE_TEMPLATE_CONTENT as Record<string, string>
    const zh = ZH_CN_NOTE_TEMPLATE_CONTENT as Record<string, string>
    for (const def of BUILTIN_TEMPLATE_DEFS) {
      const key = def.contentKey
      if (!(key in en) || !(key in zh)) continue
      expect(frontMatterTags(zh[key]).length, def.id)
        .toBe(frontMatterTags(en[key]).length)
    }
  })

  it('keeps English bodies free of Chinese and Chinese bodies carrying it', async () => {
    const { EN_US_NOTE_TEMPLATE_CONTENT } = await import('./locales/en-US-note-template-content')
    const han = /[\u4e00-\u9fff]/
    for (const [key, body] of Object.entries(EN_US_NOTE_TEMPLATE_CONTENT as Record<string, string>))
      expect(han.test(body), key).toBe(false)
  })
})

describe('the template library survives the Templater port (plan §7.3 group M)', () => {
  function roundTrip(categories: NoteTemplateCategory[], templates: NoteTemplate[]) {
    const written = JSON.stringify(buildTemplateLibraryExport(categories, templates))
    const parsed = parseTemplateLibraryExport(written, { keepFlags: true })
    return { data: parsed.data, dropped: parsed.dropped, truncated: parsed.truncated }
  }

  it('carries a Templater body through export and import byte for byte', () => {
    const body = [
      '---',
      'tags: [idea]',
      '---',
      '# <% tp.file.title %>',
      '',
      'On <%+ tp.date.now("YYYY-MM-DD") %> in [[Source#Section]] — <%* tR += "ran" %>',
      'And a literal brace: {{title}} stays the reader\'s own text.',
    ].join('\n')
    const { data, dropped, truncated } = roundTrip([], [template('tp-1', { content: body })])
    expect(dropped, JSON.stringify(truncated)).toBe(0)
    expect(data?.templates).toHaveLength(1)
    // Two separate failures would show up here: the exporter interpolating the old `{{…}}` syntax on the
    // way out, or a JSON round trip mangling the angle brackets and the backslash-free quotes.
    expect(data?.templates[0].content).toBe(body)
  })

  it('keeps the reader\'s own flags and tags, which is what favorites and the filter read', () => {
    const { data } = roundTrip(
      [category('cat-1')],
      [template('keep', { categoryId: 'cat-1', isStarred: true, isPinned: true, tags: ['templater', 'tp.user'] })],
    )
    const kept = data?.templates[0]
    expect(kept?.isStarred).toBe(true)
    expect(kept?.isPinned).toBe(true)
    expect(kept?.tags).toEqual(['templater', 'tp.user'])
    expect(data?.categories.map((one) => one.id)).toEqual(['cat-1'])
  })

  it('leaves the built-in Templater catalog out of the file and keeps a user template filed inside it', () => {
    const templaterCategory = BUILTIN_TEMPLATE_CATEGORIES.find((one) => one.id === 'templater')
    expect(templaterCategory, 'the built-in category the seed adds').toBeTruthy()
    const { data } = roundTrip(
      [category('templater', true), category('cat-mine')],
      [
        template('builtin-row', { categoryId: 'templater', builtin: true }),
        template('mine-in-templater', { categoryId: 'templater' }),
      ],
    )
    // Built-ins are re-seeded from the code, so exporting them would duplicate them on import; a *user*
    // template that happens to sit in that category is the reader's own and must survive.
    expect(data?.templates.map((one) => one.id)).toEqual(['mine-in-templater'])
    expect(data?.categories.map((one) => one.id)).toEqual(['cat-mine'])
  })

  it('says out loud when it clamps a body over the import ceiling', () => {
    const huge = `<%* const x = "${'y'.repeat(TEMPLATE_IMPORT_LIMITS.maxContentLength + 1)}" %>`
    const parsed = parseTemplateLibraryExport(
      JSON.stringify(buildTemplateLibraryExport([], [template('big', { content: huge })])),
      { keepFlags: true },
    )
    const kept = parsed.data?.templates.find((one) => one.id === 'big')
    expect(kept, 'the entry itself is within the store\'s reach once clamped').toBeTruthy()
    expect(kept?.content.length).toBeLessThanOrEqual(TEMPLATE_IMPORT_LIMITS.maxContentLength)
    // The clamp used to be invisible: a Templater body cut mid-command imports as a template that prints
    // `<% …` forever, and the dialog reported a clean import. `truncated` is the flag the import UI and the
    // save route already refuse on.
    expect(parsed.truncated).toBe(true)
  })
})
