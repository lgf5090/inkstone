// @vitest-environment jsdom
/**
 * A draft that is also a note.
 *
 * The interesting case is the closed note: the panel is the only surface holding that document, so the
 * write has to be checked against what the panel last saw. A note that changed in the notebook meanwhile
 * is a conflict, and the test insists that the reader's text is kept and the note is left alone — the
 * one outcome this module exists to prevent is a silent overwrite in either direction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotes } from '../../store/notes'
import { loadLinkedNote, pullFromNote, pushToNote } from './canvas-sync'

const { getNote } = vi.hoisted(() => ({ getNote: vi.fn(async (_id: string) => ({ content: 'from the server' })) }))

vi.mock('../../lib/api', () => ({ api: { notes: { get: getNote } }, CLIENT_ERROR_CODES: {} }))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz09'
// One id per test: what the panel last saw is remembered per draft, and a shared id would carry a
// baseline from one case into the next.
const ARTIFACT_ID = '01hzzzzzzzzzzzzzzzzzzzzz10'
const OTHER_ARTIFACT_ID = '01hzzzzzzzzzzzzzzzzzzzzz11'
const THIRD_ARTIFACT_ID = '01hzzzzzzzzzzzzzzzzzzzzz12'
const FOURTH_ARTIFACT_ID = '01hzzzzzzzzzzzzzzzzzzzzz13'
const notesOriginal = useNotes.getState()
const editContent = vi.fn()
const editRemoteContent = vi.fn()

beforeEach(() => {
  editContent.mockReset()
  editRemoteContent.mockReset()
  getNote.mockReset()
  getNote.mockImplementation(async () => ({ content: 'from the server' }))
  useNotes.setState({ notes: {}, contents: {}, editContent, editRemoteContent })
})

afterEach(() => {
  useNotes.setState(notesOriginal, true)
})

describe('a note that is open in the notebook', () => {
  it('writes through the store, which is what re-renders both surfaces', async () => {
    useNotes.setState({ contents: { [NOTE_ID]: 'old' } })
    expect(await loadLinkedNote(ARTIFACT_ID, NOTE_ID)).toBe('old')
    expect(await pushToNote(ARTIFACT_ID, NOTE_ID, 'new')).toBe('ok')
    expect(editContent).toHaveBeenCalledWith(NOTE_ID, 'new')
    expect(editRemoteContent).not.toHaveBeenCalled()
  })
})

describe('a note that is closed', () => {
  it('reads the note and writes it back when nothing else touched it', async () => {
    editRemoteContent.mockResolvedValueOnce('written')
    expect(await loadLinkedNote(OTHER_ARTIFACT_ID, NOTE_ID)).toBe('from the server')
    expect(await pushToNote(OTHER_ARTIFACT_ID, NOTE_ID, 'panel text')).toBe('ok')
    const transform = editRemoteContent.mock.calls[0]![1] as (content: string) => string | null
    expect(transform('from the server')).toBe('panel text')
    expect(transform('edited elsewhere')).toBeNull()
  })

  it('refuses to write a draft that has never been read', async () => {
    expect(await pushToNote(THIRD_ARTIFACT_ID, NOTE_ID, 'panel text')).toBe('conflict')
    expect(editRemoteContent).not.toHaveBeenCalled()
  })

  it('reports a conflict and keeps the note as it was', async () => {
    editRemoteContent.mockResolvedValueOnce('conflict')
    await loadLinkedNote(FOURTH_ARTIFACT_ID, NOTE_ID)
    expect(await pushToNote(FOURTH_ARTIFACT_ID, NOTE_ID, 'panel text')).toBe('conflict')
  })

  it('reports a note that is gone', async () => {
    getNote.mockRejectedValue(new Error('404'))
    expect(await loadLinkedNote(ARTIFACT_ID, NOTE_ID)).toBeNull()
    expect(await pullFromNote(ARTIFACT_ID, NOTE_ID)).toBeNull()
  })
})
