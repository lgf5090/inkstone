// @vitest-environment jsdom
/**
 * Which pane a citation reveals its note in.
 *
 * The answer is read beside the page it was drawn from: the notebook can hold two, and the reader who
 * presses a citation is checking a claim, not asking to lose the page they were on. A card that lands in
 * the focused column replaces that page, and a single-pane workspace has nothing to preserve — so the note
 * takes the only column there is.
 *
 * The gone case is here too, because the helper owns it: a citation can name a note the reader has since
 * deleted, and a press that silently did nothing reads as a broken control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { openCitedNote } from './note-links'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: { notes: { get: vi.fn(async () => null) } },
}))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz11'
const OTHER_ID = '01hzzzzzzzzzzzzzzzzzzzzz22'
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
const openNote = vi.fn(async () => undefined)

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  openNote.mockClear()
  useNotes.setState({
    notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Cited note', deletedAt: null } as never },
    openNote,
  })
  useUi.setState({
    workspacePrimaryNoteId: OTHER_ID,
    workspaceSecondaryNoteId: null,
    activeWorkspacePane: 'primary',
    activeNoteId: OTHER_ID,
  })
})

afterEach(() => {
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  window.history.replaceState(null, '', '/')
})

describe('a citation pressed in the notebook', () => {
  it('reveals the note in the column behind the one being read', () => {
    useUi.setState({ workspaceSecondaryNoteId: '01hzzzzzzzzzzzzzzzzzzzzz33', activeWorkspacePane: 'primary' })
    openCitedNote(NOTE_ID)
    expect(openNote).toHaveBeenCalledWith(NOTE_ID, { pane: 'secondary', activate: false })
    expect(window.location.pathname).toBe('/notes')
  })

  it('leaves the reader’s page alone when they are reading the second column', () => {
    useUi.setState({ workspaceSecondaryNoteId: '01hzzzzzzzzzzzzzzzzzzzzz33', activeWorkspacePane: 'secondary' })
    openCitedNote(NOTE_ID)
    expect(openNote).toHaveBeenCalledWith(NOTE_ID, { pane: 'primary', activate: false })
  })

  it('takes the only column there is on a single-pane layout', () => {
    openCitedNote(NOTE_ID)
    expect(openNote).toHaveBeenCalledWith(NOTE_ID, { pane: 'primary', activate: true })
  })

  it('says so when the note the citation names is gone', () => {
    useNotes.setState({ notes: {} })
    openCitedNote(NOTE_ID)
    expect(openNote).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.at(-1)?.title).toBe(t('assistant.chat.note_gone'))
  })
})
