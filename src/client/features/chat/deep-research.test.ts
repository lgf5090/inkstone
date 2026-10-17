// @vitest-environment jsdom
/**
 * Deep research: several turns, one note.
 *
 * Two things are pinned. The plan parse, because the whole run is shaped by it — a bullet list has to
 * read the same as a numbered one, and a plan of nine questions must be cut down rather than obeyed. And
 * the run itself: one turn per sub-question, then the synthesis, and the note holds the synthesis rather
 * than the plan or the raw findings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { useAssistant } from './assistant-store'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { parseResearchPlan, startDeepResearch } from './deep-research'

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
const asked: string[] = []
let replies: string[] = []
let token = 0
const createNote = vi.fn(async () => 'note-1')

beforeEach(async () => {
  await initI18n()
  asked.length = 0
  replies = []
  token = 0
  createNote.mockClear()
  useAssistant.setState({
    turn: null,
    newConversation: async () => undefined,
    setView: () => undefined,
    setWebSearch: () => undefined,
    // The turn the run just waited out, in the shape the store really leaves it: `send` answers with
    // whether the worker took the request, and a step with no reply queued is a send it refused.
    send: async (text: string) => {
      asked.push(text)
      if (!replies.length) return false
      const answer = replies.shift() ?? ''
      useAssistant.setState({ turn: { token: ++token, done: true, text: answer, error: null } as never })
      return true
    },
  } as never)
  useNotes.setState({ createNote } as never)
})

afterEach(() => {
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
})

describe('reading the plan', () => {
  it('takes a numbered list and a bullet list the same way', () => {
    expect(parseResearchPlan('1. What did we ship?\n2. What slipped?')).toEqual(['What did we ship?', 'What slipped?'])
    expect(parseResearchPlan('- What did we ship?\n* What slipped?')).toEqual(['What did we ship?', 'What slipped?'])
  })

  it('strips emphasis, drops stray markers, and never repeats a question', () => {
    expect(parseResearchPlan('1. **What did we ship?**\n2. what did we ship?\n3. —\n4. `What slipped?`')).toEqual([
      'What did we ship?',
      'What slipped?',
    ])
  })

  it('cuts a plan down to what the run will actually pay for', () => {
    const plan = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter, index) => `${index + 1}. Question ${letter}?`).join('\n')
    expect(parseResearchPlan(plan)).toHaveLength(4)
  })
})

describe('running the research', () => {
  it('plans, investigates each part, and files the synthesis as a note', async () => {
    replies = ['1. What shipped?\n2. What slipped?', '- shipped A', '- slipped B', '# Report\n\nConclusion [[Note A]]']
    const id = await startDeepResearch('Q3 delivery')
    expect(id).toBe('note-1')
    expect(asked).toHaveLength(4)
    expect(asked[0]).toContain('Q3 delivery')
    expect(asked[1]).toContain('What shipped?')
    expect(asked[2]).toContain('What slipped?')
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Q3 delivery',
      content: '# Report\n\nConclusion [[Note A]]',
      open: true,
    }))
  })

  it('leaves the note pointing back at the thread the research ran in', async () => {
    useAssistant.setState({ activeId: 'c-research' } as never)
    replies = ['1. What shipped?', '- shipped A', '# Report\n\nConclusion']
    expect(await startDeepResearch('Q3 delivery')).toBe('note-1')
    // The thread is the evidence for the note, so the note names it rather than standing alone.
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('![[chat:c-research]]'),
    }))
  })

  it('stops at the first step that comes back empty and files nothing', async () => {
    replies = ['1. What shipped?', '']
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await startDeepResearch('Q3 delivery')).toBeNull()
    expect(createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalled()
  })

  it('files nothing when the synthesis turn was refused, rather than the last finding', async () => {
    // One question, so the run is plan → gather → synthesis. The synthesis is the turn the store refuses,
    // and the newest answer on the screen is then the finding it was written from — which is a note about
    // the wrong thing under the right title.
    replies = ['1. What shipped?', '- shipped A']
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await startDeepResearch('Q3 delivery')).toBeNull()
    expect(asked).toHaveLength(3)
    expect(createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.research.failed', { step: 3 }), tone: 'warning' }))
  })

  it('does nothing when the question does not split', async () => {
    replies = ['I am not sure what you mean.']
    expect(await startDeepResearch('Q3 delivery')).toBeNull()
    expect(createNote).not.toHaveBeenCalled()
  })
})
