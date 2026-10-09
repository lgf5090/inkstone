/**
 * The app-backed half of writing a run's result into a note: a capture has to refuse rather than
 * overwrite text the reader typed a moment ago, and a note that is not on screen is written against
 * what the server holds now, not against the revision the run happened to read.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { initI18n } from '../../lib/i18n'

const shelves = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../../lib/db', () => ({
  localDb: {
    scheduleShellSave: vi.fn(),
    saveShell: vi.fn(async () => {}),
    loadShell: async () => null,
    bindUser: async () => {},
    setContent: async (id: string, content: string) => { shelves.set(id, content) },
    setContentBatch: async (entries: Record<string, string>) => {
      for (const [id, content] of Object.entries(entries)) shelves.set(id, content)
    },
    getContent: async (id: string) => shelves.get(id),
    dropContent: async (id: string) => { shelves.delete(id) },
    getOutbox: async () => [],
    enqueueOutbox: async () => {},
    enqueueOutboxBatch: async () => {},
    completeOutboxItem: async () => {},
    markOutboxFailure: async () => {},
    updateOutboxRevision: async () => {},
    advanceOutboxDependents: async () => {},
    setOutboxRecoveryId: async () => {},
    withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => {
      await task()
      return true
    },
  },
  publishBroadcast: vi.fn(),
}))

const server = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, notes: { ...actual.api.notes, get: server.get, patch: server.patch } },
  }
})

import { notePort } from './runner'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

function summary(id: string, title: string): NoteSummary {
  return {
    id, title, excerpt: title, folderId: null, tags: [], isPinned: false, isStarred: false,
    isArchived: false, wordCount: 2, charCount: 8, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null,
  }
}

const NOTES = { nAlpha: summary('nAlpha', 'Alpha'), nBeta: summary('nBeta', 'Beta') }

beforeAll(async () => {
  await initI18n()
})

let notesWere: unknown
let uiWere: unknown

beforeEach(() => {
  notesWere = useNotes.getState()
  uiWere = useUi.getState()
  server.get.mockReset()
  server.patch.mockReset()
  useNotes.setState({
    notes: NOTES,
    contents: { nAlpha: 'body A\n', nBeta: 'body B\n' },
    folders: [],
    tags: [],
    hydrated: true,
    pull: vi.fn(async () => {}),
  } as never)
  useUi.setState({
    view: 'note',
    activeNoteId: 'nAlpha',
    workspacePrimaryNoteId: 'nAlpha',
    workspaceSecondaryNoteId: null,
    activeWorkspacePane: 'primary',
    workspacePaneLayouts: { primary: 'live', secondary: 'live' },
    mobilePane: 'edit',
  } as never)
})

afterEach(() => {
  useNotes.setState(notesWere as never)
  useUi.setState(uiWere as never)
})

describe('the write a run performs', () => {
  it('refuses to overwrite what the reader typed since the run read the note', async () => {
    useNotes.setState({ contents: { nAlpha: 'half-typed sentence\n', nBeta: 'body B\n' } })
    const accepted = await notePort.write('nAlpha', 'body A\ncaptured\n', 'body A\n')
    expect(accepted, 'the note on screen moved under the run').toBe(false)
    expect(useNotes.getState().contents.nAlpha).toBe('half-typed sentence\n')
  })

  it('writes through the store while nothing has moved', async () => {
    const accepted = await notePort.write('nAlpha', 'body A\ncaptured\n', 'body A\n')
    expect(accepted).toBe(true)
    expect(useNotes.getState().contents.nAlpha).toBe('body A\ncaptured\n')
    expect(server.patch, 'the note on screen is saved by the store, not by a second write').not.toHaveBeenCalled()
  })

  it('writes a note that is not on screen against the revision the server holds', async () => {
    useUi.setState({ activeNoteId: 'nBeta', workspacePrimaryNoteId: 'nBeta' })
    server.get.mockResolvedValue({ id: 'nAlpha', title: 'Alpha', content: 'body A\n', rev: 7 })
    server.patch.mockResolvedValue(NOTES.nAlpha)
    const accepted = await notePort.write('nAlpha', 'body A\ncaptured\n', 'body A\n')
    expect(accepted).toBe(true)
    expect(server.patch).toHaveBeenCalledWith('nAlpha', { content: 'body A\ncaptured\n', rev: 7 })
  })

  it('refuses that write when the server already holds different text', async () => {
    useUi.setState({ activeNoteId: 'nBeta', workspacePrimaryNoteId: 'nBeta' })
    server.get.mockResolvedValue({ id: 'nAlpha', title: 'Alpha', content: 'edited elsewhere\n', rev: 7 })
    const accepted = await notePort.write('nAlpha', 'body A\ncaptured\n', 'body A\n')
    expect(accepted).toBe(false)
    expect(server.patch).not.toHaveBeenCalled()
  })
})
