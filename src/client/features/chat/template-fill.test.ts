// @vitest-environment jsdom
/**
 * Filling a template's AI slots.
 *
 * The order is the whole point: each answer grows the note, so the slots are filled from the end of
 * the document backwards and the offsets recorded at render time stay true. If they were filled in
 * document order the second answer would land inside the first one's paragraph — which is a bug that
 * only shows up with two slots, so that is what the test uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { fillTemplateSlots } from './template-fill'

const { ask, answers } = vi.hoisted(() => ({
  ask: vi.fn(async (_noteId: string, instruction: string) => {
    const answer = answers.current[instruction]
    return answer ? `${answer} (${instruction})` : null
  }),
  answers: { current: {} as Record<string, string> },
}))

vi.mock('./note-ai', () => ({ askAboutNote: (noteId: string, instruction: string) => ask(noteId, instruction) }))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz02'
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()

beforeEach(async () => {
  await initI18n()
  answers.current = {}
  ask.mockClear()
  useNotes.setState({
    notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Week' } as never },
    // The two slots, with the content they were rendered from.
    contents: { [NOTE_ID]: 'Intro\n\nTail\n' },
    editContent: (id: string, content: string) => useNotes.setState((state) => ({ contents: { ...state.contents, [id]: content } })),
  })
})

afterEach(() => {
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
})

describe('filling template slots', () => {
  it('writes each answer where its slot was, last slot first', async () => {
    answers.current = { 'the opening': 'FIRST', 'the ending': 'SECOND' }
    const filled = await fillTemplateSlots(NOTE_ID, [
      { at: 'Intro\n\n'.length, instruction: 'the opening' },
      { at: 'Intro\n\nTail\n'.length, instruction: 'the ending' },
    ])
    expect(filled).toBe(2)
    expect(ask.mock.calls.map((call) => call[1])).toEqual(['the ending', 'the opening'])
    expect(useNotes.getState().contents[NOTE_ID]).toBe('Intro\n\nFIRST (the opening)\n\nTail\n\nSECOND (the ending)')
  })

  it('stops at the first slot that produces no answer, and says so', async () => {
    answers.current = {}
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await fillTemplateSlots(NOTE_ID, [{ at: 0, instruction: 'anything' }])).toBe(0)
    expect(useNotes.getState().contents[NOTE_ID]).toBe('Intro\n\nTail\n')
    expect(toast).toHaveBeenCalled()
  })
})
