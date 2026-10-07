import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_TEMPLATE_DEFS, TEMPLATE_SEED_VERSION, buildTemplateLibraryExport } from '@shared/note-templates'
import { DEFAULT_NEW_NOTE_TEMPLATE } from '@shared/constants'
import type { NoteTemplate } from '@shared/types'
import { initI18n, t } from '../lib/i18n'
import { CLIENT_ID } from '../lib/api'
import { compareTemplates, templateOrderValue, useNoteTemplates } from './note-templates'
import type { TemplateLibraryData } from '../lib/db'

const stored = vi.hoisted((): { value: TemplateLibraryData | null } => ({ value: null }))
const bus = vi.hoisted(() => ({
  saves: 0,
  loads: 0,
  published: [] as Array<{ type: string; clientId: string }>,
  listeners: [] as Array<(payload: { type: string; clientId: string }) => void>,
  remote: { savedAt: 0, library: null as unknown },
  pushes: [] as string[],
  pushFails: false,
}))

vi.mock('../lib/api', () => ({
  CLIENT_ID: 'this-tab',
  api: {
    templateLibrary: {
      load: async () => ({ savedAt: bus.remote.savedAt, library: bus.remote.library }),
      save: async (library: string) => {
        if (bus.pushFails) throw new Error('offline')
        bus.pushes.push(library)
        return { savedAt: 5000 + bus.pushes.length }
      },
    },
  },
}))

vi.mock('../lib/db', () => ({
  localDb: {
    loadTemplateLibrary: async () => {
      bus.loads += 1
      return stored.value
    },
    saveTemplateLibrary: async (data: TemplateLibraryData) => {
      bus.saves += 1
      stored.value = JSON.parse(JSON.stringify(data)) as TemplateLibraryData
    },
  },
  publishBroadcast: (payload: { type: string; clientId: string }) => {
    bus.published.push(payload)
  },
  createBroadcast: (onMessage: (payload: { type: string; clientId: string }) => void) => {
    bus.listeners.push(onMessage)
    return { post: () => {}, close: () => {} }
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
  bus.saves = 0
  bus.loads = 0
  bus.published = []
  bus.remote = { savedAt: 0, library: null }
  bus.pushes = []
  bus.pushFails = false
  useNoteTemplates.setState({ categories: [], templates: [], hydrated: false, owner: '' })
  await fresh().hydrate('user-a')
})

describe('template library hydration', () => {
  it('seeds the whole built-in catalog and writes it once', () => {
    const state = fresh()
    expect(state.templates).toHaveLength(BUILTIN_TEMPLATE_DEFS.length)
    const diary = state.templates.find((item) => item.id === 'diary')!
    expect(diary.content.startsWith('---')).toBe(true)
    expect(diary.content).toContain('{{title}}')
    expect(diary.content).not.toBe('template.diary.content')
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

    stored.value = { categories: [], templates: [template({ id: 'b-1', name: 'Account B' })], seedVersion: TEMPLATE_SEED_VERSION, syncedAt: 0, pendingPush: false }
    useNoteTemplates.setState({ hydrated: false })
    await fresh().hydrate('user-b')

    expect(fresh().owner).toBe('user-b')
    expect(fresh().templates.some((item) => item.name === 'Account A only')).toBe(false)
    expect(fresh().templates.find((item) => item.id === 'b-1')?.name).toBe('Account B')
  })

  it('keeps a hydrated library for the same account without re-reading', async () => {
    const before = fresh().templates
    stored.value = { categories: [], templates: [], seedVersion: TEMPLATE_SEED_VERSION, syncedAt: 0, pendingPush: false }
    await fresh().hydrate('user-a')
    expect(fresh().templates).toBe(before)
  })

  it('tops up an older seed without discarding the user’s own entries', async () => {
    stored.value = {
      categories: [],
      templates: [template({ id: 'mine', name: 'Mine' })],
      seedVersion: 0,
      syncedAt: 0,
      pendingPush: false,
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
      syncedAt: 0,
      pendingPush: false,
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
      syncedAt: 0,
      pendingPush: false,
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

describe('batch primitives', () => {
  function makeMany(count: number) {
    const ids: string[] = []
    for (let index = 0; index < count; index += 1)
      ids.push(fresh().createTemplate({ name: `t${index}`, content: 'body' })!)
    return ids
  }

  it('writes the library once for a whole batch', () => {
    const ids = makeMany(200)
    bus.saves = 0
    expect(fresh().applyBatch(ids, () => ({ isStarred: true }))).toBe(200)
    expect(bus.saves).toBe(1)
    expect(fresh().templates.filter((item) => item.isStarred)).toHaveLength(200)
  })

  it('counts only the templates a patch actually changed', () => {
    const ids = makeMany(3)
    bus.saves = 0
    expect(fresh().applyBatch(ids, (item) => (item.name === 't1' ? null : { isPinned: true }))).toBe(2)
    expect(bus.saves).toBe(1)
    expect(fresh().templates.find((item) => item.id === ids[1])?.isPinned).toBe(false)
  })

  it('does not write at all when nothing in the batch changed', () => {
    const ids = makeMany(2)
    bus.saves = 0
    expect(fresh().applyBatch(ids, () => null)).toBe(0)
    expect(bus.saves).toBe(0)
  })

  it('removes a whole selection in one write and refuses built-ins', () => {
    const ids = makeMany(5)
    const builtin = fresh().templates.find((item) => item.builtin)!.id
    bus.saves = 0
    expect(fresh().removeTemplates([...ids, builtin])).toBe(5)
    expect(bus.saves).toBe(1)
    expect(fresh().templates.some((item) => ids.includes(item.id))).toBe(false)
    expect(fresh().templates.some((item) => item.id === builtin)).toBe(true)
  })

  it('leaves an unknown id alone instead of throwing', () => {
    const ids = makeMany(1)
    expect(fresh().applyBatch([...ids, 'tpl-missing'], () => ({ isStarred: true }))).toBe(1)
    expect(fresh().removeTemplates(['tpl-missing'])).toBe(0)
  })
})

describe('cross-tab library coherence', () => {
  function receive(clientId: string) {
    const listener = bus.listeners.at(-1)
    expect(listener).toBeTypeOf('function')
    listener!({ type: 'template-library-changed', clientId })
  }

  function foreignTemplate(): NoteTemplate {
    return {
      ...template({ id: 'tpl-other-tab', name: 'From the other tab', content: 'other' }),
    }
  }

  it('announces a library change once per mutation', () => {
    fresh().createTemplate({ name: 'announced', content: 'x' })
    expect(bus.published.filter((item) => item.type === 'template-library-changed')).toHaveLength(1)
  })

  it('takes in a template another tab wrote instead of overwriting it', async () => {
    const before = fresh().templates.length
    stored.value = {
      ...library(),
      templates: [...library().templates, foreignTemplate()],
    }
    receive('other-client')
    await vi.waitFor(() => {
      expect(fresh().templates).toHaveLength(before + 1)
    })
    expect(fresh().templates.some((item) => item.id === 'tpl-other-tab')).toBe(true)
  })

  it('does not answer a remote change with a write of its own', async () => {
    stored.value = { ...library(), templates: [...library().templates, foreignTemplate()], seedVersion: 0 }
    bus.saves = 0
    bus.published = []
    receive('other-client')
    await vi.waitFor(() => {
      expect(fresh().templates.some((item) => item.id === 'tpl-other-tab')).toBe(true)
    })
    expect(bus.published).toHaveLength(0)
    expect(bus.saves).toBeGreaterThan(0)
  })

  it('ignores its own announcement', async () => {
    const loads = bus.loads
    const before = fresh().templates.length
    stored.value = { ...library(), templates: [...library().templates, foreignTemplate()] }
    receive(CLIENT_ID)
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    expect(bus.loads).toBe(loads)
    expect(fresh().templates).toHaveLength(before)
    expect(fresh().owner).toBe('user-a')
  })

  it('refuses to re-read for an account that is not signed in', async () => {
    const before = fresh().templates.length
    const loads = bus.loads
    useNoteTemplates.setState({ owner: '', hydrated: false })
    stored.value = { ...library(), templates: [...library().templates, foreignTemplate()] }
    bus.saves = 0
    receive('other-client')
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    expect(bus.loads).toBe(loads)
    expect(fresh().templates).toHaveLength(before)
    expect(fresh().templates.some((item) => item.id === 'tpl-other-tab')).toBe(false)
    expect(bus.saves).toBe(0)
  })
})

describe('account sync of the template library', () => {
  function remoteLibrary(extra: NoteTemplate[]) {
    return buildTemplateLibraryExport(library().categories, [...library().templates, ...extra])
  }

  it('takes the newer copy from the account when nothing is pending locally', async () => {
    const fromAnotherDevice = template({ id: 'tpl-device-2', name: 'From my laptop', content: 'laptop' })
    bus.remote = { savedAt: 9000, library: remoteLibrary([fromAnotherDevice]) }
    useNoteTemplates.setState({ hydrated: false, owner: '' })
    await fresh().hydrate('user-a')
    expect(fresh().templates.some((item) => item.id === 'tpl-device-2')).toBe(true)
    expect(library().syncedAt).toBe(9000)
    expect(library().pendingPush).toBe(false)
    expect(bus.pushes).toHaveLength(0)
  })

  it('keeps a local edit that never reached the account', async () => {
    const accountCopy = remoteLibrary([])
    fresh().createTemplate({ name: 'Unsynced', content: 'x' })
    useNoteTemplates.setState({ hydrated: false })
    bus.remote = { savedAt: 99000, library: accountCopy }
    await fresh().hydrate('user-a')
    expect(fresh().templates.some((item) => item.name === 'Unsynced')).toBe(true)
  })

  it('pushes a burst of changes once', async () => {
    vi.useFakeTimers()
    try {
      for (let index = 0; index < 5; index += 1)
        fresh().createTemplate({ name: `n${index}`, content: 'x' })
      await vi.advanceTimersByTimeAsync(1500)
    } finally {
      vi.useRealTimers()
    }
    expect(bus.pushes).toHaveLength(1)
    const pushed = JSON.parse(bus.pushes[0]!) as { templates: Array<{ name: string }> }
    expect(pushed.templates.filter((item) => item.name.startsWith('n'))).toHaveLength(5)
    expect(library().pendingPush).toBe(false)
    expect(library().syncedAt).toBe(5001)
  })

  it('leaves the change pending when the push fails and retries on the next hydrate', async () => {
    vi.useFakeTimers()
    bus.pushFails = true
    try {
      fresh().createTemplate({ name: 'will-retry', content: 'x' })
      await vi.advanceTimersByTimeAsync(1500)
    } finally {
      bus.pushFails = false
      vi.useRealTimers()
    }
    expect(bus.pushes).toHaveLength(0)
    expect(library().pendingPush).toBe(true)
    useNoteTemplates.setState({ hydrated: false })
    await fresh().hydrate('user-a')
    await vi.waitFor(() => {
      expect(bus.pushes).toHaveLength(1)
    }, { timeout: 4000 })
    expect(library().pendingPush).toBe(false)
  })

  it('does not push a library that belongs to a signed-out tab', async () => {
    vi.useFakeTimers()
    try {
      fresh().createTemplate({ name: 'orphan', content: 'x' })
      useNoteTemplates.setState({ owner: '' })
      await vi.advanceTimersByTimeAsync(1500)
    } finally {
      vi.useRealTimers()
    }
    expect(bus.pushes).toHaveLength(0)
  })
})

describe('undoing a destructive action', () => {
  function makeNamed(names: string[], categoryId: string | null = null) {
    return names.map((name) => fresh().createTemplate({ name, content: `body of ${name}`, categoryId })!)
  }

  it('gives a deleted template back with its identity and position', () => {
    const [gone] = makeNamed(['doomed'])
    const before = library().templates.find((item) => item.id === gone)!
    expect(fresh().deleteTemplate(gone)).toBe(true)
    expect(fresh().templates.some((item) => item.id === gone)).toBe(false)
    expect(fresh().undoable?.templates.some((item) => item.id === gone)).toBe(true)
    expect(fresh().restoreUndoable()).toBe(true)
    const back = fresh().templates.find((item) => item.id === gone)!
    expect(back).toMatchObject({ name: 'doomed', content: 'body of doomed', position: before.position })
    expect(fresh().undoable).toBe(null)
  })

  it('gives a whole batch back in one write', () => {
    const ids = makeNamed(['a', 'b', 'c', 'd'])
    const savesBefore = bus.saves
    expect(fresh().removeTemplates(ids)).toBe(4)
    bus.saves = 0
    expect(fresh().restoreUndoable()).toBe(true)
    expect(bus.saves).toBe(1)
    expect(ids.every((id) => fresh().templates.some((item) => item.id === id))).toBe(true)
    expect(savesBefore).toBeGreaterThan(0)
  })

  it('restores a deleted category together with the templates it held', () => {
    const category = fresh().createCategory('Field notes')!
    const [kept] = makeNamed(['resident'], category)
    expect(fresh().deleteCategory(category)).toBe(true)
    expect(fresh().templates.find((item) => item.id === kept)?.categoryId).toBe(null)
    expect(fresh().restoreUndoable()).toBe(true)
    expect(fresh().categories.some((item) => item.id === category)).toBe(true)
    expect(fresh().templates.find((item) => item.id === kept)?.categoryId).toBe(category)
  })

  it('leaves a template the user already moved somewhere else where they put it', () => {
    const field = fresh().createCategory('Field notes')!
    const archive = fresh().createCategory('Archive')!
    const [resident] = makeNamed(['resident'], field)
    fresh().deleteCategory(field)
    fresh().updateTemplate(resident, { categoryId: archive })
    expect(fresh().restoreUndoable()).toBe(true)
    expect(fresh().categories.some((item) => item.id === field)).toBe(true)
    expect(fresh().templates.find((item) => item.id === resident)?.categoryId).toBe(archive)
  })

  it('has nothing to undo before the first destructive action', () => {
    expect(fresh().undoable).toBe(null)
    expect(fresh().restoreUndoable()).toBe(false)
    bus.saves = 0
    expect(bus.saves).toBe(0)
  })

  it('refuses to undo a built-in that was never really deleted', () => {
    const builtin = fresh().templates.find((item) => item.builtin)!
    expect(fresh().removeTemplates([builtin.id])).toBe(0)
    expect(fresh().undoable).toBe(null)
    bus.saves = 0
    expect(fresh().restoreUndoable()).toBe(false)
    expect(bus.saves).toBe(0)
  })

  it('keeps only the newest step, which is what a single undo button means', () => {
    const first = makeNamed(['first'])
    const second = makeNamed(['second'])
    fresh().deleteTemplate(first[0]!)
    fresh().deleteTemplate(second[0]!)
    expect(fresh().restoreUndoable()).toBe(true)
    expect(fresh().templates.some((item) => item.id === second[0])).toBe(true)
    expect(fresh().templates.some((item) => item.id === first[0])).toBe(false)
  })

  it('brings the deleted entry back without undoing an unrelated edit', () => {
    const [gone] = makeNamed(['doomed'])
    const [stays] = makeNamed(['stays'])
    const before = fresh().templates.length
    fresh().deleteTemplate(gone)
    fresh().updateTemplate(stays, { name: 'renamed after the delete' })
    expect(fresh().restoreUndoable()).toBe(true)
    expect(fresh().templates.find((item) => item.id === stays)?.name).toBe('renamed after the delete')
    expect(fresh().templates.some((item) => item.id === gone)).toBe(true)
    const ids = fresh().templates.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(fresh().templates).toHaveLength(before)
  })
})

describe('language switch refreshes the pristine built-ins', () => {
  it('renames and re-bodies the untouched built-ins, and never a customized copy', async () => {
    const { setLocaleAsync, getLocale } = await import('../lib/i18n')
    const starting = getLocale()
    const bullet = BUILTIN_TEMPLATE_DEFS[0]
    const pristine = fresh().templates.find((item) => item.id === bullet.id)!
    const customized = fresh().createTemplate({ name: 'Mine', content: 'x' })!
    useNoteTemplates.getState().updateTemplate(customized, { name: 'My own words' })
    useNoteTemplates.getState().toggleTemplateStar(pristine.id)

    await setLocaleAsync(starting === 'zh-CN' ? 'en-US' : 'zh-CN', false)
    try {
      useNoteTemplates.setState({ hydrated: false })
      await fresh().hydrate('user-a')
      const renamed = fresh().templates.find((item) => item.id === bullet.id)!
      const other = t(BUILTIN_TEMPLATE_DEFS[0].nameKey)
      expect(renamed.name).toBe(other)
      expect(renamed.isStarred).toBe(true)
      expect(renamed.content).not.toBe('')
      expect(fresh().templates.find((item) => item.id === customized)?.name).toBe('My own words')
    } finally {
      await setLocaleAsync(starting, false)
    }
  })
})

describe('a catalog that grew since the account last opened it', () => {
  it('tops up the new built-ins for a library seeded at the previous version', async () => {
    const keptId = fresh().createTemplate({ name: 'Written by hand', content: 'keep me' })!
    const keptTemplate = library().templates.find((item) => item.id === keptId)!
    const stale = library().templates.filter((item) => item.builtin).slice(0, 38)
    stored.value = {
      categories: library().categories,
      templates: [...stale, keptTemplate],
      seedVersion: 1,
      syncedAt: 0,
      pendingPush: false,
    }
    useNoteTemplates.setState({ hydrated: false })
    await fresh().hydrate('user-a')
    const ids = new Set(fresh().templates.map((item) => item.id))
    for (const def of BUILTIN_TEMPLATE_DEFS)
      expect(ids.has(def.id), def.id).toBe(true)
    expect(fresh().templates.find((item) => item.id === keptId)?.name).toBe('Written by hand')
    expect(library().seedVersion).toBe(TEMPLATE_SEED_VERSION)
  })

})
