import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants'
import type { Folder, Note, NoteTemplate, PublicUser } from '@shared/types'

/** What the stand-in run shell was asked to apply, and what the stand-in server handed back. */
const mocks = vi.hoisted(() => ({
  applied: [] as Array<{ templateId: string; noteId: string }>,
  created: null as Note | null,
}))

vi.mock('./run-shell', () => ({
  async applyTemplateToCreatedNote(template: NoteTemplate, note: Note) {
    mocks.applied.push({ templateId: template.id, noteId: note.id })
    return true
  },
}))

vi.mock('../../lib/db', () => ({
  localDb: {
    setContent: async () => {},
    dropContent: async () => {},
    getOutbox: async () => [],
    enqueueOutbox: async () => {},
    completeOutboxItem: async () => {},
    withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => { await task(); return true },
    scheduleShellSave: () => {},
  },
  flushLocalDbWrites: async () => {},
  replayOutbox: async () => {},
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/api')
  const api = (actual as { api: Record<string, unknown> }).api
  return {
    ...actual,
    api: {
      ...api,
      notes: {
        ...(api.notes as Record<string, unknown>),
        create: async () => mocks.created,
      },
    },
  }
})

const { initI18n } = await import('../../lib/i18n')
const { setTemplaterDevicePrefs } = await import('../../lib/templater/device-prefs')
const { useNotes } = await import('../../store/notes')
const { useNoteTemplates } = await import('../../store/note-templates')
const { useSession } = await import('../../store/session')
const { installTemplaterCreationTrigger } = await import('./creation-trigger')

const USER: PublicUser = {
  id: 'u-trigger', login: 't', name: 'T', avatarUrl: '', role: 'owner', createdAt: 0, username: 't',
}

const JOURNAL: Folder = { id: 'f-journal', name: 'Journal', parentId: null } as Folder
const YEAR: Folder = { id: 'f-year', name: '2026', parentId: 'f-journal' } as Folder

function noteRow(id: string, title: string, folderId: string | null): Note {
  return {
    id, title, content: '', excerpt: '', folderId, tags: [], isPinned: false, isStarred: false,
    isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
  } as Note
}

function template(id: string): NoteTemplate {
  return {
    id, name: id, categoryId: null, description: '', content: '<% tp.date.now() %>', tags: [],
    builtin: false, isPinned: false, isStarred: false, createdAt: 1, updatedAt: 1,
  } as NoteTemplate
}

function configure(templater: Record<string, unknown>, library: NoteTemplate[] = []): void {
  useSession.setState({
    status: 'authed',
    user: USER,
    settings: mergeSettings({ ...DEFAULT_SETTINGS, templater: { ...DEFAULT_SETTINGS.templater, ...templater } }),
  })
  useNotes.setState({ folders: [JOURNAL, YEAR], notes: {}, contents: {} })
  useNoteTemplates.setState({ templates: library, hydrated: true })
}

/** Create a note the way the app does, and let the trigger's async work land. */
async function create(title: string, folderId: string | null, fromTemplateRun = false): Promise<void> {
  const id = `n-${title}`
  mocks.created = noteRow(id, title, folderId)
  await useNotes.getState().createNote({ id: undefined, title, content: '', folderId, open: false, fromTemplateRun })
  for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeAll(async () => {
  await initI18n()
  installTemplaterCreationTrigger()
})

beforeEach(() => {
  mocks.applied.length = 0
  setTemplaterDevicePrefs(USER.id, { triggerOnFileCreation: true })
})

describe('the file-creation trigger', () => {
  const folderRule = { fileCreationMode: 'folder', folderTemplates: [{ folderId: 'f-journal', templateId: 'tpl-journal' }] }

  it('applies the folder’s template to a note created inside it', async () => {
    configure(folderRule, [template('tpl-journal')])
    await create('Entry', 'f-journal')
    expect(mocks.applied).toEqual([{ templateId: 'tpl-journal', noteId: expect.any(String) }])
  })

  it('applies an ancestor folder’s rule to a note one level deeper', async () => {
    configure(folderRule, [template('tpl-journal')])
    await create('Today', 'f-year')
    expect(mocks.applied).toHaveLength(1)
    expect(mocks.applied[0]!.templateId).toBe('tpl-journal')
  })

  it('does not run when the device switch is off', async () => {
    setTemplaterDevicePrefs(USER.id, { triggerOnFileCreation: false })
    configure(folderRule, [template('tpl-journal')])
    await create('Entry', 'f-journal')
    expect(mocks.applied).toEqual([])
  })

  it('does not run when the reader turned the mode off', async () => {
    configure({ fileCreationMode: 'none', folderTemplates: folderRule.folderTemplates }, [template('tpl-journal')])
    await create('Entry', 'f-journal')
    expect(mocks.applied).toEqual([])
  })

  it('does not run over a note a template itself created', async () => {
    configure(folderRule, [template('tpl-journal')])
    await create('Entry', 'f-journal', true)
    expect(mocks.applied).toEqual([])
  })

  it('obeys the ignored folder even when a rule matches above it', async () => {
    configure({ ...folderRule, ignoreFoldersOnCreation: ['f-year'] }, [template('tpl-journal')])
    await create('Today', 'f-year')
    expect(mocks.applied).toEqual([])
  })

  it('matches the pattern list against the path the index uses', async () => {
    configure({ fileCreationMode: 'regex', fileTemplates: [{ regex: '^Journal/2026/', templateId: 'tpl-year' }] }, [template('tpl-year')])
    await create('Today', 'f-year')
    expect(mocks.applied.map((call) => call.templateId)).toEqual(['tpl-year'])
  })

  it('says nothing and writes nothing when the rule names a template the library lost', async () => {
    configure({ fileCreationMode: 'folder', folderTemplates: [{ folderId: 'f-journal', templateId: 'tpl-gone' }] }, [template('tpl-other')])
    await create('Entry', 'f-journal')
    expect(mocks.applied).toEqual([])
  })

  it('leaves a note created at the root alone when no root rule exists', async () => {
    configure({ fileCreationMode: 'folder', folderTemplates: [{ folderId: 'f-journal', templateId: 'tpl-journal' }] }, [template('tpl-journal')])
    await create('Loose', null)
    expect(mocks.applied).toEqual([])
  })
})
