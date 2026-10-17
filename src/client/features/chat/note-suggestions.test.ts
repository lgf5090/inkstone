// @vitest-environment jsdom
/**
 * Tags and properties, from the assistant's answer to the note's front matter.
 *
 * Two halves are worth pinning. The parse is the trust boundary: the model answers with prose around
 * a JSON object, and what comes out has to be a shape this module can write — flat scalars, usable
 * tag names, no second writer for `tags`. The write is the other half: the note's own tags are merged
 * rather than replaced, and nothing is written when the reader says no.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { parseNoteSuggestion, applyNoteSuggestion, suggestNoteMeta } from './note-suggestions'

const { asked, answer } = vi.hoisted(() => ({
  asked: vi.fn(async (_options: { title?: string }) => true),
  answer: { current: '' },
}))

vi.mock('../../components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/overlay')>()
  return { ...actual, confirm: (options: { title?: string }) => asked(options) }
})

vi.mock('./note-ai', () => ({ askAboutNote: async () => answer.current }))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz01'
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
const editContent = vi.fn()

beforeEach(async () => {
  await initI18n()
  editContent.mockReset()
  asked.mockClear()
  answer.current = ''
  useNotes.setState({
    notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Q3 review' } as never },
    contents: { [NOTE_ID]: '---\ntags: [work]\n---\n\nThe review went well.\n' },
    editContent,
  })
})

afterEach(() => {
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
})

describe('reading a suggestion', () => {
  it('reads the JSON out of a fenced answer', () => {
    expect(parseNoteSuggestion('Here you go:\n```json\n{"tags": ["q3", "work"], "properties": {"status": "done"}}\n```\n')).toEqual({
      tags: ['q3', 'work'],
      properties: { status: 'done' },
    })
  })

  it('drops what cannot be written: unusable tags, nested values, and a second writer for tags', () => {
    const parsed = parseNoteSuggestion(JSON.stringify({
      tags: ['#q3', 'two words', 'ok', 'OK', ''],
      properties: { status: 'done', nested: { a: 1 }, list: ['x'], tags: ['nope'], 'bad:key': 'v', count: 3 },
    }))
    expect(parsed?.tags).toEqual(['q3', 'ok'])
    expect(parsed?.properties).toEqual({ status: 'done', count: '3' })
  })

  it('answers nothing for an answer with no object in it', () => {
    expect(parseNoteSuggestion('I think this note is about a review.')).toBeNull()
    expect(parseNoteSuggestion('{"tags": []}')).toBeNull()
    expect(parseNoteSuggestion('{"tags": [')).toBeNull()
  })
})

describe('writing a suggestion', () => {
  it('merges tags into the ones the note already has, and writes the properties', () => {
    expect(applyNoteSuggestion(NOTE_ID, { tags: ['work', 'q3'], properties: { status: 'done' } })).toBe(true)
    const written = editContent.mock.calls[0]![1] as string
    expect(written).toContain('status: done')
    expect(written).toContain('q3')
    // The note's own tag is still there, and the duplicate the model suggested was not added twice.
    expect(written.match(/work/g)).toHaveLength(1)
  })

  it('creates front matter for a note that has none', () => {
    useNotes.setState({ contents: { [NOTE_ID]: 'Just a body.\n' } })
    expect(applyNoteSuggestion(NOTE_ID, { tags: ['q3'], properties: {} })).toBe(true)
    expect(editContent.mock.calls[0]![1]).toBe('---\ntags:\n  - q3\n---\nJust a body.\n')
  })

  it('writes nothing when the note is not open any more', () => {
    useNotes.setState({ contents: {} })
    expect(applyNoteSuggestion(NOTE_ID, { tags: ['q3'], properties: {} })).toBe(false)
    expect(editContent).not.toHaveBeenCalled()
  })
})

describe('asking for suggestions', () => {
  it('shows the proposal, then writes it', async () => {
    answer.current = '{"tags": ["q3"], "properties": {"status": "done"}}'
    const suggestion = await suggestNoteMeta(NOTE_ID)
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('q3') }))
    expect(suggestion).toEqual({ tags: ['q3'], properties: { status: 'done' } })
    expect(editContent).toHaveBeenCalledTimes(1)
  })

  it('leaves the note alone when the reader declines', async () => {
    asked.mockResolvedValueOnce(false)
    answer.current = '{"tags": ["q3"]}'
    expect(await suggestNoteMeta(NOTE_ID)).toBeNull()
    expect(editContent).not.toHaveBeenCalled()
  })

  it('says so when the answer could not be read', async () => {
    answer.current = 'This note is about the Q3 review.'
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await suggestNoteMeta(NOTE_ID)).toBeNull()
    expect(toast).toHaveBeenCalled()
    expect(editContent).not.toHaveBeenCalled()
  })
})
