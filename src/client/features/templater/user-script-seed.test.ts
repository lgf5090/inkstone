import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder, Note } from '@shared/types'

/** The row the stand-in server hands back, so the store believes the note it just asked for exists. */
const mocks = vi.hoisted(() => ({ created: null as Note | null }))

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

const { initI18n, t } = await import('../../lib/i18n')
const { useNotes } = await import('../../store/notes')
const { scanUserScript } = await import('../../lib/templater/host/user-script-scan')
const { createUserScript, nextScriptTitle } = await import('./user-script-seed')

const SCRIPTS_FOLDER = { id: 'f-scripts', name: 'Scripts', parentId: null } as Folder

function noteRow(id: string, title: string, folderId: string | null): Note {
  return {
    id, title, content: '', excerpt: '', folderId, tags: [], isPinned: false, isStarred: false,
    isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
  } as Note
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  useNotes.setState({ folders: [SCRIPTS_FOLDER], notes: {}, contents: {} })
  mocks.created = null
})

describe('nextScriptTitle', () => {
  it('takes the plain name when nothing is there yet', () => {
    expect(nextScriptTitle([])).toBe('my_script.js')
  })

  it('steps past a name the folder already holds', () => {
    expect(nextScriptTitle(['my_script.js'])).toBe('my_script_2.js')
    expect(nextScriptTitle(['my_script.js', 'my_script_2.js'])).toBe('my_script_3.js')
  })

  it('reserves a name spelled with another case, because the scan would answer to both', () => {
    expect(nextScriptTitle(['My_Script.JS'])).toBe('my_script_2.js')
  })

  it('leaves titles that are not scripts alone', () => {
    expect(nextScriptTitle(['my_script', 'meeting notes'])).toBe('my_script.js')
  })
})

describe('createUserScript', () => {
  it('creates a `.js` note in the chosen folder, opens it, and answers with the callable name', async () => {
    const asked: Array<Record<string, unknown>> = []
    const create = vi.fn(async (input: Record<string, unknown>) => {
      asked.push(input)
      const note = noteRow('n-new', String(input.title), String(input.folderId))
      mocks.created = note
      return note
    })
    useNotes.setState({ createNote: create } as never)

    await expect(createUserScript('f-scripts')).resolves.toBe('my_script')
    expect(create).toHaveBeenCalledTimes(1)
    expect(asked[0]).toMatchObject({ title: 'my_script.js', folderId: 'f-scripts', open: true })
  })

  it('starts from a body the scanner already reads as a callable export', async () => {
    const note = noteRow('n-new', 'my_script.js', 'f-scripts')
    useNotes.setState({ createNote: async () => note } as never)
    await createUserScript('f-scripts')
    expect(scanUserScript(t('templater.script.starter_body')).kind).toBe('function')
  })

  it('says nothing when the create did not happen, leaving the store the one voice', async () => {
    useNotes.setState({ createNote: async () => null } as never)
    await expect(createUserScript('f-scripts')).resolves.toBeNull()
  })
})
