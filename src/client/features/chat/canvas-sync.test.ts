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

const { getNote, ApiError } = vi.hoisted(() => ({
  // The status is what separates the two answers below, so the double carries it the way the real
  // client error does.
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
      super(message)
      this.name = 'ApiError'
    }
  },
  getNote: vi.fn(async (_id: string) => ({ content: 'from the server' })),
}))

vi.mock('../../lib/api', () => ({ api: { notes: { get: getNote } }, ApiError, CLIENT_ERROR_CODES: {} }))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz09'
// One id per test: what the panel last saw is remembered per draft, and a shared id would carry a
// baseline from one case into the next.
const ARTIFACT_ID = '01hzzzzzzzzzzzzzzzzzzzzz10'
const OTHER_ARTIFACT_ID = '01hzzzzzzzzzzzzzzzzzzzzz11'
const THIRD_ARTIFACT_ID = '01hzzzzzzzzzzzzzzzzzzzzz12'
const FOURTH_ARTIFACT_ID = '01hzzzzzzzzzzzzzzzzzzzzz13'
const RELOADED_ARTIFACT_ID = '01hzzzzzzzzzzzzzzzzzzzzz14'
const notesOriginal = useNotes.getState()
const editContent = vi.fn()
const editRemoteContent = vi.fn()

beforeEach(() => {
  editContent.mockReset()
  editRemoteContent.mockReset()
  getNote.mockReset()
  getNote.mockImplementation(async () => ({ content: 'from the server' }))
  // What this browser remembers of a note outlives the panel that read it, so each case starts clean.
  localStorage.clear()
  useNotes.setState({ notes: {}, contents: {}, editContent, editRemoteContent })
})

afterEach(() => {
  useNotes.setState(notesOriginal, true)
})

describe('a note that is open in the notebook', () => {
  it('writes through the store, which is what re-renders both surfaces', async () => {
    useNotes.setState({ contents: { [NOTE_ID]: 'old' } })
    expect(await loadLinkedNote(ARTIFACT_ID, NOTE_ID)).toEqual({ status: 'ok', content: 'old' })
    expect(await pushToNote(ARTIFACT_ID, NOTE_ID, 'new')).toBe('ok')
    expect(editContent).toHaveBeenCalledWith(NOTE_ID, 'new')
    expect(editRemoteContent).not.toHaveBeenCalled()
  })
})

describe('a note that is closed', () => {
  it('reads the note and writes it back when nothing else touched it', async () => {
    editRemoteContent.mockResolvedValueOnce('written')
    expect(await loadLinkedNote(OTHER_ARTIFACT_ID, NOTE_ID)).toEqual({ status: 'ok', content: 'from the server' })
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

  /**
   * The two ways a read comes back empty, kept apart.
   *
   * Both leave the panel with no body, and they are two different sentences to the reader: one says the
   * document they linked is no longer in the notebook, the other says this request did not answer and
   * asking again is the fix. Reporting the second as the first tells a reader their note was deleted.
   */
  it('names a note the server says it does not have as gone', async () => {
    getNote.mockRejectedValue(new ApiError(404, 'not_found', 'Note not found'))
    expect(await loadLinkedNote(ARTIFACT_ID, NOTE_ID)).toEqual({ status: 'missing' })
    expect(await pullFromNote(ARTIFACT_ID, NOTE_ID)).toEqual({ status: 'missing' })
  })

  it('names a read that could not be made as a failure, not as a deleted note', async () => {
    getNote.mockRejectedValue(new ApiError(0, 'offline', 'The request did not reach the server'))
    expect(await loadLinkedNote(OTHER_ARTIFACT_ID, NOTE_ID)).toEqual({
      status: 'failed',
      reason: 'The request did not reach the server',
    })
    // A plain thrown error is the same answer: nothing here claims the note itself is missing.
    getNote.mockRejectedValue(new Error('Failed to fetch'))
    expect(await pullFromNote(THIRD_ARTIFACT_ID, NOTE_ID)).toEqual({ status: 'failed', reason: 'Failed to fetch' })
  })
})

/**
 * The baseline across a reload.
 *
 * Held only in the module, it died with the page: the first write after a refresh had nothing to be
 * checked against, so a note nobody had touched since was reported as a conflict — and the draft row
 * cannot stand in for it, because its body is the draft's own and a linked note routinely says something
 * newer than that.
 */
describe('the panel after a reload', () => {
  it('keeps what it last saw, so the first push is a write and not a conflict', async () => {
    editRemoteContent.mockResolvedValue('written')
    await loadLinkedNote(RELOADED_ARTIFACT_ID, NOTE_ID)
    expect(await pushToNote(RELOADED_ARTIFACT_ID, NOTE_ID, 'panel text')).toBe('ok')

    // A fresh module instance is the whole of what a refresh leaves behind: no map, only the browser.
    vi.resetModules()
    const [sync, notes] = await Promise.all([import('./canvas-sync'), import('../../store/notes')])
    const remote = vi.fn(async (_id: string, transform: (server: string) => string | null) =>
      (transform('panel text') === null ? 'conflict' : 'written'))
    notes.useNotes.setState({ notes: {}, contents: {}, editRemoteContent: remote })
    expect(await sync.pushToNote(RELOADED_ARTIFACT_ID, NOTE_ID, 'newer panel text')).toBe('ok')

    // And the remembered body is still a real guard: a note that moved elsewhere in the meantime is a
    // conflict, not a write that happens to have found a record.
    const moved = vi.fn(async (_id: string, transform: (server: string) => string | null) =>
      (transform('edited in the notebook') === null ? 'conflict' : 'written'))
    notes.useNotes.setState({ editRemoteContent: moved })
    expect(await sync.pushToNote(RELOADED_ARTIFACT_ID, NOTE_ID, 'too late')).toBe('conflict')
  })

  it('still refuses a draft that was never read, after a reload as well as before one', async () => {
    expect(await pushToNote('01hzzzzzzzzzzzzzzzzzzzzz15', NOTE_ID, 'panel text')).toBe('conflict')
    vi.resetModules()
    const [sync, notes] = await Promise.all([import('./canvas-sync'), import('../../store/notes')])
    notes.useNotes.setState({ notes: {}, contents: {}, editRemoteContent: vi.fn() })
    expect(await sync.pushToNote('01hzzzzzzzzzzzzzzzzzzzzz15', NOTE_ID, 'panel text')).toBe('conflict')
  })
})
