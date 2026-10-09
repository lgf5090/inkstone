/**
 * The app-backed half of opening a note after a run: which pane receives it, whether that pane keeps the
 * reader's own display mode, and whether the focus moves. The engines only ever ask for these through
 * `NotePort.open`, so this is where a wrong answer would silently land a note in front of someone.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { initI18n } from '../../lib/i18n'

const fetched = vi.hoisted(() => vi.fn(async (id: string) => ({
  id,
  title: 'Alpha',
  content: 'body\n',
  rev: 2,
})))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return { ...actual, api: { ...actual.api, notes: { ...actual.api.notes, get: fetched } } }
})

import { notePort } from './runner'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

function summary(id: string, title: string): NoteSummary {
  return {
    id,
    title,
    excerpt: title,
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 1,
    charCount: 4,
    rev: 1,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
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
  useNotes.setState({
    notes: NOTES,
    contents: { nAlpha: 'body A\n', nBeta: 'body B\n' },
    folders: [],
    tags: [],
    hydrated: true,
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

describe('the pane a run lands its note in', () => {
  it('opens beside the note the reader is in, in reading mode, without taking the focus', async () => {
    await notePort.open('nBeta', { pane: 'other', layout: 'preview', focus: false })
    const ui = useUi.getState()
    expect(ui.workspaceSecondaryNoteId).toBe('nBeta')
    expect(ui.workspacePaneLayouts.secondary, 'the mode belongs to the pane that received the note').toBe('preview')
    expect(ui.activeWorkspacePane).toBe('primary')
    expect(ui.activeNoteId, 'the reader keeps what they were reading').toBe('nAlpha')
  })

  it('replaces what the reader is looking at when the choice says this pane', async () => {
    await notePort.open('nBeta', { pane: 'active', layout: 'split', focus: true })
    const ui = useUi.getState()
    expect(ui.activeNoteId).toBe('nBeta')
    expect(ui.workspacePaneLayouts.primary).toBe('split')
    expect(ui.workspaceSecondaryNoteId).toBeNull()
  })

  it('leaves the display mode alone when the choice only says where', async () => {
    await notePort.open('nBeta', { pane: 'other' })
    const ui = useUi.getState()
    expect(ui.workspaceSecondaryNoteId).toBe('nBeta')
    expect(ui.workspacePaneLayouts.secondary, 'inherit means the pane keeps its own mode').toBe('live')
  })

  it('keeps the old behaviour for a run that says nothing at all', async () => {
    await notePort.open('nBeta', {})
    const ui = useUi.getState()
    expect(ui.activeNoteId).toBe('nBeta')
    expect(ui.workspacePaneLayouts.primary).toBe('live')
  })
})
