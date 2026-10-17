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
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import type { AnswerResult } from './editor-ai'
import { fillTemplateSlots } from './template-fill'

const { ask, answers, stuck } = vi.hoisted(() => ({
  // The channel is what tells the four states apart, so the cases below drive it directly.
  ask: vi.fn(async (_noteId: string, instruction: string): Promise<AnswerResult> => {
    if (stuck.current === 'busy') return { status: 'busy' }
    if (stuck.current === 'failed') return { status: 'failed', error: 'upstream refused' }
    if (stuck.current === 'empty') return { status: 'empty' }
    const answer = answers.current[instruction]
    return answer ? { status: 'ok', text: `${answer} (${instruction})` } : { status: 'empty' }
  }),
  answers: { current: {} as Record<string, string> },
  stuck: { current: '' as '' | 'busy' | 'failed' | 'empty' },
}))

vi.mock('./note-ai', () => ({ askAboutNote: (noteId: string, instruction: string) => ask(noteId, instruction) }))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz02'
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()

beforeEach(async () => {
  await initI18n()
  answers.current = {}
  stuck.current = ''
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

  it('stops at the first slot that produces no answer, and says the reason it was empty', async () => {
    answers.current = {}
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await fillTemplateSlots(NOTE_ID, [{ at: 0, instruction: 'anything' }])).toBe(0)
    expect(useNotes.getState().contents[NOTE_ID]).toBe('Intro\n\nTail\n')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.note.answer_empty') }))
  })

  // Three states the old `string | null` channel could not tell apart, so the reader heard one message
  // for all of them: a run that is still going is not a failure, and neither is an answer with no words.
  it.each([
    ['busy', 'assistant.edit.busy'],
    ['failed', 'assistant.note.answer_failed'],
    ['empty', 'assistant.note.answer_empty'],
  ] as const)('names a %s slot as itself, and does not also say the template failed', async (state, key) => {
    stuck.current = state
    answers.current = { 'the ending': 'SECOND' }
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await fillTemplateSlots(NOTE_ID, [
      { at: 'Intro\n\nTail\n'.length, instruction: 'the ending' },
      { at: 'Intro\n\n'.length, instruction: 'the opening' },
    ])).toBe(0)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t(key) }))
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.template.failed') }))
  })
})
