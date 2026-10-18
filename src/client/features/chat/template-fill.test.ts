// @vitest-environment jsdom
/**
 * Filling a template's AI passages.
 *
 * Two properties are under test here, and both were missing before:
 *
 *  - a note is written once, at the end. A run that stopped on the second of two passages used to leave
 *    the first one's paragraph sitting in the note beside the hole the rest had left, so the reader had a
 *    document that looked finished in places and was not. These cases read the note *between* the answers.
 *  - the order of the writes is the order of the offsets. Each answer grows the note, so the passages are
 *    laid down from the end of the document backwards and the offsets recorded at render time stay true —
 *    a bug that only shows up with two slots, which is why two slots are what this file uses.
 *
 * The turns are driven by the channel that answers them, one promise per instruction, so a test can look
 * at the note and at the job in the middle of a run rather than only after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import type { AnswerResult } from './editor-ai'
import { discardTemplateSlotFill, retryTemplateSlot, startTemplateSlotFill } from './template-fill'
import { canRetryTemplateSlot, peekTemplateSlotJob } from './template-slot-job'

const { asks } = vi.hoisted(() => ({
  /** Every turn the run has opened, in the order it opened them, still waiting to be answered. */
  asks: [] as { instruction: string, answer: (result: AnswerResult) => void }[],
}))

vi.mock('./note-ai', () => ({
  askAboutNote: (_noteId: string, instruction: string) => new Promise<AnswerResult>((resolve) => {
    asks.push({ instruction, answer: resolve })
  }),
}))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz02'
const SKELETON = 'Intro\n\nTail\n'
const OPENING = { at: 'Intro\n\n'.length, instruction: 'the opening' }
const ENDING = { at: SKELETON.length, instruction: 'the ending' }
/** What the two passages land as: each one is spaced off the text it was put next to. */
const FINISHED = 'Intro\n\nFIRST\n\nTail\n\nSECOND'
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
const writes: string[] = []

/** Lets the run's own awaits land: a turn is answered by a promise the test resolves by hand. */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function answer(instruction: string, result: AnswerResult): void {
  const open = asks.find((entry) => entry.instruction === instruction)
  if (!open) throw new Error(`no turn was opened for ${instruction}`)
  open.answer(result)
}

function asked(): string[] {
  return asks.map((entry) => entry.instruction)
}

function noteSays(): string | undefined {
  return useNotes.getState().contents[NOTE_ID]
}

function dropTheNote(): void {
  useNotes.setState((state) => ({ contents: { ...state.contents, [NOTE_ID]: undefined } as never }))
}

beforeEach(async () => {
  await initI18n()
  asks.length = 0
  writes.length = 0
  useNotes.setState({
    notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Week' } as never },
    contents: { [NOTE_ID]: SKELETON },
    editContent: (id: string, content: string) => {
      writes.push(content)
      useNotes.setState((state) => ({ contents: { ...state.contents, [id]: content } }))
    },
  })
})

afterEach(() => {
  // The job is module state: a run left standing would decide the next test's answer to "is a run
  // already going", and one test would fail only because the test before it ran.
  if (peekTemplateSlotJob()) discardTemplateSlotFill()
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
})

describe('a run that is going', () => {
  it('keeps every passage out of the note until the last one has come back', async () => {
    startTemplateSlotFill(NOTE_ID, [OPENING, ENDING])
    await settle()
    expect(asked()).toEqual(['the opening'])
    expect(writes).toEqual([])
    expect(noteSays()).toBe(SKELETON)

    answer('the opening', { status: 'ok', text: 'FIRST' })
    await settle()
    expect(asked()).toEqual(['the opening', 'the ending'])
    // The first answer is held by the job and still not in the note: that is the whole difference.
    expect(peekTemplateSlotJob()?.slots[0]?.answer).toBe('FIRST')
    expect(writes).toEqual([])

    answer('the ending', { status: 'ok', text: 'SECOND' })
    await settle()
    expect(writes).toEqual([FINISHED])
    expect(noteSays()).toBe(FINISHED)
    expect(peekTemplateSlotJob()).toBeNull()
  })

  it('names the passage it is on and counts from the top of the template', async () => {
    startTemplateSlotFill(NOTE_ID, [OPENING, ENDING, { at: 0, instruction: 'the top' }])
    await settle()
    expect(asked()).toEqual(['the opening'])
    expect(peekTemplateSlotJob()?.slots.map((slot) => slot.state)).toEqual(['running', 'pending', 'pending'])
  })
})

describe('a passage that does not come back', () => {
  it('leaves the note as the template wrote it and stops on the passage that failed', async () => {
    const toast = vi.spyOn(useUi.getState(), 'toast')
    startTemplateSlotFill(NOTE_ID, [OPENING, ENDING])
    await settle()
    answer('the opening', { status: 'ok', text: 'FIRST' })
    await settle()
    answer('the ending', { status: 'failed', error: 'upstream refused' })
    await settle()

    expect(writes).toEqual([])
    expect(noteSays()).toBe(SKELETON)
    const job = peekTemplateSlotJob()
    expect(job?.status).toBe('stopped')
    expect(job?.stoppedAt).toBe(1)
    expect(job?.slots.map((slot) => slot.state)).toEqual(['filled', 'failed'])
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: t('assistant.template.stopped', { current: 2, total: 2 }),
      description: 'upstream refused',
      tone: 'danger',
    }))
    expect(canRetryTemplateSlot(1)).toBe(true)
  })

  it.each([
    ['busy', 'assistant.edit.busy'],
    ['empty', 'assistant.note.answer_empty'],
  ] as const)('says a %s passage is itself, and not a failure the assistant never reported', async (state, key) => {
    const toast = vi.spyOn(useUi.getState(), 'toast')
    startTemplateSlotFill(NOTE_ID, [OPENING])
    await settle()
    answer('the opening', state === 'busy' ? { status: 'busy' } : { status: 'empty' })
    await settle()
    expect(peekTemplateSlotJob()?.slots[0]?.failure).toBe(state)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: t(key) }))
    expect(noteSays()).toBe(SKELETON)
    expect(writes).toEqual([])
  })

  it('stops on the next passage when the note goes away mid-run, and offers no retry', async () => {
    startTemplateSlotFill(NOTE_ID, [OPENING, ENDING, { at: 0, instruction: 'the top' }])
    await settle()
    answer('the opening', { status: 'ok', text: 'FIRST' })
    await settle()
    // The note is deleted while the second passage is being asked, so the third is never asked at all:
    // there is no document left to ask it about.
    dropTheNote()
    answer('the ending', { status: 'ok', text: 'SECOND' })
    await settle()

    const job = peekTemplateSlotJob()
    expect(job?.stoppedAt).toBe(2)
    expect(job?.slots[2]?.failure).toBe('gone')
    expect(asked()).toEqual(['the opening', 'the ending'])
    expect(canRetryTemplateSlot(2)).toBe(false)
    expect(writes).toEqual([])
  })

  it('names no passage when the note goes away between the last answer and the write', async () => {
    const toast = vi.spyOn(useUi.getState(), 'toast')
    startTemplateSlotFill(NOTE_ID, [OPENING])
    await settle()
    dropTheNote()
    answer('the opening', { status: 'ok', text: 'FIRST' })
    await settle()

    const job = peekTemplateSlotJob()
    expect(job?.status).toBe('stopped')
    expect(job?.stoppedAt).toBeNull()
    expect(writes).toEqual([])
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.template.note_gone') }))
  })
})

describe('retrying', () => {
  it('asks the one passage that failed and writes the answers it already had', async () => {
    startTemplateSlotFill(NOTE_ID, [OPENING, ENDING])
    await settle()
    answer('the opening', { status: 'ok', text: 'FIRST' })
    await settle()
    answer('the ending', { status: 'empty' })
    await settle()
    asks.length = 0

    retryTemplateSlot(1)
    await settle()
    expect(asked()).toEqual(['the ending'])
    answer('the ending', { status: 'ok', text: 'SECOND' })
    await settle()

    expect(writes).toEqual([FINISHED])
    expect(noteSays()).toBe(FINISHED)
  })

  it('carries on with the passages that were never started', async () => {
    startTemplateSlotFill(NOTE_ID, [OPENING, ENDING, { at: 0, instruction: 'the top' }])
    await settle()
    answer('the opening', { status: 'ok', text: 'FIRST' })
    await settle()
    answer('the ending', { status: 'empty' })
    await settle()
    asks.length = 0

    retryTemplateSlot(1)
    await settle()
    expect(asked()).toEqual(['the ending'])
    answer('the ending', { status: 'ok', text: 'SECOND' })
    await settle()
    expect(asked()).toEqual(['the ending', 'the top'])
    answer('the top', { status: 'ok', text: 'THIRD' })
    await settle()

    expect(writes).toHaveLength(1)
    expect(peekTemplateSlotJob()).toBeNull()
  })
})

describe('a second template while one is running', () => {
  it('is refused out loud rather than queued behind the reader’s back', async () => {
    const toast = vi.spyOn(useUi.getState(), 'toast')
    startTemplateSlotFill(NOTE_ID, [OPENING])
    await settle()
    startTemplateSlotFill(NOTE_ID, [ENDING])
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.template.in_flight') }))
    expect(asked()).toEqual(['the opening'])
  })
})
