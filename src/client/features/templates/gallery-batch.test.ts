import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteTemplate } from '@shared/types'
import { initI18n } from '../../lib/i18n'
import { useNoteTemplates } from '../../store/note-templates'
import type { TemplateLibraryData } from '../../lib/db'
import { runBatchDelete, runBatchMove, runBatchStar } from './gallery-actions'

const stored = vi.hoisted((): { value: TemplateLibraryData | null } => ({ value: null }))
const writes = vi.hoisted(() => ({ saves: 0, broadcasts: 0 }))

vi.mock('../../lib/db', () => ({
  localDb: {
    loadTemplateLibrary: async () => stored.value,
    saveTemplateLibrary: async (data: TemplateLibraryData) => {
      writes.saves += 1
      stored.value = JSON.parse(JSON.stringify(data)) as TemplateLibraryData
    },
  },
  publishBroadcast: () => {
    writes.broadcasts += 1
  },
  createBroadcast: () => ({ post: () => {}, close: () => {} }),
}))

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
  writes.saves = 0
  writes.broadcasts = 0
  useNoteTemplates.setState({ categories: [], templates: [], hydrated: false, owner: '' })
  await useNoteTemplates.getState().hydrate('user-a')
})

function makeMany(count: number): NoteTemplate[] {
  const state = useNoteTemplates.getState()
  const created: NoteTemplate[] = []
  for (let index = 0; index < count; index += 1) {
    const id = state.createTemplate({ name: `t${index}`, content: 'body' })!
    created.push(useNoteTemplates.getState().templates.find((item) => item.id === id)!)
  }
  return created
}

async function seedMany(count: number): Promise<NoteTemplate[]> {
  const current = useNoteTemplates.getState()
  const extra: NoteTemplate[] = []
  for (let index = 0; index < count; index += 1) {
    extra.push(template({
      id: `tpl-bulk-${index}`,
      name: `t${index}`,
      position: current.templates.length + index,
    }))
  }
  const seeded = [...current.templates, ...extra]
  stored.value = { ...stored.value!, templates: seeded }
  useNoteTemplates.setState({ hydrated: false })
  await useNoteTemplates.getState().hydrate('user-a')
  return seeded.filter((item) => item.id.startsWith('tpl-bulk-'))
}

describe('gallery batch actions', () => {
  it('star a 2000-template selection in one library write', { timeout: 30000 }, async () => {
    const many = await seedMany(2000)
    writes.saves = 0
    writes.broadcasts = 0
    const started = performance.now()
    expect(runBatchStar(many, true)).toBe(2000)
    const elapsed = performance.now() - started
    expect(writes.saves).toBe(1)
    expect(writes.broadcasts).toBe(1)
    expect(elapsed).toBeLessThan(2000)
    expect(useNoteTemplates.getState().templates.filter((item) => item.isStarred)).toHaveLength(2000)
  })

  it('unstar only the ones that were starred and report that count', () => {
    const many = makeMany(10)
    useNoteTemplates.getState().toggleTemplateStar(many[0]!.id)
    writes.saves = 0
    expect(runBatchStar(useNoteTemplates.getState().templates.filter((item) => !item.builtin), false)).toBe(1)
    expect(writes.saves).toBe(1)
  })

  it('move a selection in one write and keep built-ins built-in', () => {
    const many = makeMany(5)
    const builtin = useNoteTemplates.getState().templates.find((item) => item.builtin)!
    const category = useNoteTemplates.getState().createCategory('Archive')!
    writes.saves = 0
    expect(runBatchMove([...many, builtin], category)).toBe(6)
    expect(writes.saves).toBe(1)
    const moved = useNoteTemplates.getState().templates.find((item) => item.id === builtin.id)!
    expect(moved.categoryId).toBe(category)
    expect(moved.builtin).toBe(true)
  })

  it('delete a selection in one write and refuse built-ins', () => {
    const many = makeMany(5)
    const builtin = useNoteTemplates.getState().templates.find((item) => item.builtin)!.id
    const before = useNoteTemplates.getState().templates.length
    writes.saves = 0
    expect(runBatchDelete([...many, template({ id: builtin })])).toBe(5)
    expect(writes.saves).toBe(1)
    expect(useNoteTemplates.getState().templates).toHaveLength(before - 5)
    expect(useNoteTemplates.getState().templates.some((item) => item.id === builtin)).toBe(true)
  })

  it('skip the write when the selection already matches', () => {
    const many = makeMany(3)
    runBatchStar(many, true)
    writes.saves = 0
    writes.broadcasts = 0
    expect(runBatchStar(many, true)).toBe(0)
    expect(writes.saves).toBe(0)
    expect(writes.broadcasts).toBe(0)
  })
})
