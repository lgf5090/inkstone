import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULT_NEW_NOTE_TEMPLATE, LIMITS } from '@shared/constants'
import { parseFrontMatter } from '@shared/markdown-utils'
import type { Folder, Note, UserSettings } from '@shared/types'
import { initI18n, t } from '../lib/i18n'
import { useSession } from './session'
import { useUi } from './ui'
import { buildNewNoteContent, pendingEditorCursors, rememberPendingEditorCursor, takePendingEditorCursor } from './new-note'
import { useNotes } from './notes'

const mocks = vi.hoisted(() => ({ queue: [] as unknown[], create: vi.fn() }))

vi.mock('../lib/db', () => ({
  localDb: {
    scheduleShellSave: vi.fn(),
    setContent: vi.fn(async () => {}),
    setContentBatch: vi.fn(async () => {}),
    dropContent: vi.fn(async () => {}),
    getOutbox: async () => mocks.queue,
    enqueueOutbox: async () => {},
  },
  publishBroadcast: vi.fn(),
}))

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, api: { ...actual.api, notes: { ...actual.api.notes, create: mocks.create } } }
})

function settingsWith(notes: Partial<UserSettings['notes']>): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    notes: { ...DEFAULT_SETTINGS.notes, ...notes },
  }
}

function apply(notes: Partial<UserSettings['notes']>): void {
  useSession.setState({ settings: settingsWith(notes) })
}

const folder: Folder = {
  id: 'f-1', name: 'Journal', parentId: null, icon: null, color: null,
  position: 0, createdAt: 1, updatedAt: 1,
}

function created(id: string, title: string, content: string): Note {
  const now = Date.now()
  return {
    id, title, content, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
    isArchived: false, wordCount: 0, charCount: content.length, rev: 1, position: now,
    createdAt: now, updatedAt: now, deletedAt: null,
  }
}

beforeEach(async () => {
  await initI18n()
  mocks.queue = []
  mocks.create.mockReset()
  mocks.create.mockImplementation(async ({ id, title, content }: { id: string, title: string, content: string }) =>
    created(id, title, content))
  useNotes.setState({ notes: {}, contents: {}, folders: [folder], tags: [] })
  useUi.setState({ view: 'all', folderId: null, tags: [] })
  apply({ newNoteTemplate: DEFAULT_NEW_NOTE_TEMPLATE })
})

afterEach(() => {
  useNotes.setState({ notes: {}, contents: {} })
})

describe('buildNewNoteContent', () => {
  it('expands the configured template for a fresh note', () => {
    const { content } = buildNewNoteContent('Groceries', [], null, [folder])
    expect(content.startsWith('---\n')).toBe(true)
    expect(content).toContain('title: Groceries')
    expect(content).toContain('createdAt: 20')
  })

  it('names an untitled note after the localized default', () => {
    const { content } = buildNewNoteContent('', [], null, [])
    expect(content).toContain(`title: ${t('common.new_note')}`)
  })

  it('fills the folder placeholder from the folder the note lands in', () => {
    apply({ newNoteTemplate: '---\nfolder: {{folder}}\n---\n' })
    expect(buildNewNoteContent('x', [], 'f-1', [folder]).content).toContain('folder: Journal')
    expect(buildNewNoteContent('x', [], null, [folder]).content).toContain('folder: ')
  })

  it('ignores a virtual calendar folder', () => {
    apply({ newNoteTemplate: '---\nfolder: [{{folder}}]\n---\n' })
    expect(buildNewNoteContent('x', [], 'cal:2026', [folder]).content).toContain('folder: []')
  })

  it('yields a blank note when the template is blank', () => {
    apply({ newNoteTemplate: '   \n  ' })
    expect(buildNewNoteContent('Anything', ['work'], 'f-1', [folder]))
      .toEqual({ content: '', cursor: null, tagsUnapplied: ['work'] })
  })

  it('merges the creating tags into the front matter list', () => {
    const { content, tagsUnapplied } = buildNewNoteContent('Reading', ['#每日', ' work '], null, [])
    expect(tagsUnapplied).toEqual([])
    expect(parseFrontMatter(content).data.tags).toEqual(['每日', 'work'])
  })

  it('reports tags it had nowhere to put', () => {
    apply({ newNoteTemplate: '# {{title}}\n\n' })
    const built = buildNewNoteContent('Plain', ['work'], null, [])
    expect(built.content).toBe('# Plain\n\n')
    expect(built.tagsUnapplied).toEqual(['work'])
  })
})

describe('createNote with a template', () => {
  it('builds content from the template when the caller supplies none', async () => {
    const id = await useNotes.getState().createNote({ title: 'Idea', open: false })
    expect(id).toBeTruthy()
    const content = useNotes.getState().contents[id!]
    expect(content).toContain('title: Idea')
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Idea', content }))
  })

  it('leaves an explicit body alone', async () => {
    const id = await useNotes.getState().createNote({ title: 'Pasted', content: 'just this', open: false })
    expect(useNotes.getState().contents[id!]).toBe('just this')
  })

  it('hands the caret position to the editor only when the template asked for one', async () => {
    apply({ newNoteTemplate: '---\ntitle: {{title}}\n---\nbody {{cursor}}' })
    const withCursor = await useNotes.getState().createNote({ title: 'Caret', open: false })
    expect(useNotes.getState().contents[withCursor!]).toBe('---\ntitle: Caret\n---\nbody ')
    expect(takePendingEditorCursor(withCursor!)).toBe(26)
    expect(takePendingEditorCursor(withCursor!)).toBe(null)

    apply({ newNoteTemplate: DEFAULT_NEW_NOTE_TEMPLATE })
    const plain = await useNotes.getState().createNote({ title: 'NoCaret', open: false })
    expect(takePendingEditorCursor(plain!)).toBe(null)
  })

  it('falls back to a body tag when the template has no front matter', async () => {
    apply({ newNoteTemplate: '# {{title}}\n' })
    const id = await useNotes.getState().createNote({ title: 'Tagged', tags: ['work'], open: false })
    expect(useNotes.getState().contents[id!]).toBe('#work\n\n# Tagged\n')
  })

  it('keeps an explicit cursor for a caller that rendered its own content', async () => {
    const id = await useNotes.getState().createNote({ title: 'From gallery', content: 'ab|cd', cursor: 2, open: false })
    expect(takePendingEditorCursor(id!)).toBe(2)
  })
})

describe('the caret hand-off', () => {
  it('keeps only the most recent pending cursors', () => {
    pendingEditorCursors.clear()
    for (let index = 0; index < 200; index++) rememberPendingEditorCursor(`n-${index}`, index)
    expect(pendingEditorCursors.size).toBe(64)
    expect(takePendingEditorCursor('n-0')).toBe(null)
    expect(takePendingEditorCursor('n-199')).toBe(199)
    pendingEditorCursors.clear()
  })

  it('gives each note its cursor exactly once', async () => {
    apply({ newNoteTemplate: 'body {{cursor}}tail' })
    const id = await useNotes.getState().createNote({ title: 'Once', open: false })
    expect(takePendingEditorCursor(id!)).toBe(5)
    expect(takePendingEditorCursor(id!)).toBe(null)
    apply({ newNoteTemplate: DEFAULT_NEW_NOTE_TEMPLATE })
  })
})

describe('title and front matter stay in step', () => {
  function seed(id: string, title: string, content: string): void {
    useNotes.setState({
      notes: { [id]: { ...created(id, title, content), excerpt: '', wordCount: 1 } },
      contents: { [id]: content },
    })
  }

  it('rewrites an existing front matter title when the note is renamed', () => {
    seed('n-1', 'Old', '---\ntitle: Old\n---\nbody')
    useNotes.getState().editTitle('n-1', 'New')
    expect(useNotes.getState().contents['n-1']).toContain('title: New')
  })

  it('never bolts a front matter block onto a plain note', () => {
    seed('n-2', 'Old', 'just a body')
    useNotes.getState().editTitle('n-2', 'New')
    expect(useNotes.getState().contents['n-2']).toBe('just a body')
  })

  it('stops rewriting the property when the switch is off', () => {
    apply({ syncTitleToFrontMatter: false })
    seed('n-3', 'Old', '---\ntitle: Old\n---\nbody')
    useNotes.getState().editTitle('n-3', 'New')
    expect(useNotes.getState().contents['n-3']).toContain('title: Old')
  })

  it('adopts a front matter title the reader edited in the body', () => {
    seed('n-4', 'Old', '---\ntitle: Old\n---\nbody')
    useNotes.getState().editContent('n-4', '---\ntitle: Renamed here\n---\nbody')
    expect(useNotes.getState().notes['n-4'].title).toBe('Renamed here')
  })

  it('does not snap the note title back on an unrelated body edit', () => {
    seed('n-5', 'Renamed', '---\ntitle: Old\n---\nbody')
    useNotes.getState().editContent('n-5', '---\ntitle: Old\n---\nbody edited')
    expect(useNotes.getState().notes['n-5'].title).toBe('Renamed')
  })

  it('stops adopting the property when that switch is off', () => {
    apply({ syncFrontMatterTitle: false })
    seed('n-6', 'Old', '---\ntitle: Old\n---\nbody')
    useNotes.getState().editContent('n-6', '---\ntitle: Elsewhere\n---\nbody')
    expect(useNotes.getState().notes['n-6'].title).toBe('Old')
  })

  it('clamps an over-long front matter title', () => {
    const long = 'x'.repeat(LIMITS.titleMaxLength + 50)
    seed('n-7', 'Old', '---\ntitle: Old\n---\nbody')
    useNotes.getState().editContent('n-7', `---\ntitle: ${long}\n---\nbody`)
    expect(useNotes.getState().notes['n-7'].title).toHaveLength(LIMITS.titleMaxLength)
  })
})
