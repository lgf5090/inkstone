// @vitest-environment jsdom
/**
 * A research run that outlives the tab that started it.
 *
 * The run is up to six paid turns driven by the browser, so the two things worth pinning are the ones a
 * reader would notice missing: that a reload continues from the steps that already answered rather than
 * asking them again, and that a stopped step is visible with a way on that does not redo finished work.
 * The partial findings are checked in the record itself, because that is where they survive — and the
 * banner is checked for structure, roles and names only, since jsdom lays nothing out.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { renderElement } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { DeepResearchProgress } from './DeepResearchProgress'
import { researchSteps, resumeDeepResearch, startDeepResearch, useResearchRun } from './deep-research'

/** Same key the module writes; a run that is not in the browser is not a run that survives a reload. */
const STORAGE_KEY = 'inkstone:deep-research-run:v1'

const { recordNoteWrite } = vi.hoisted(() => ({ recordNoteWrite: vi.fn(async () => ({ ok: true })) }))

// Only the routes a step reaches for: the backlink report is best-effort, and this is not its test.
vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
      super(message)
      this.name = 'ApiError'
    }
  },
  CLIENT_ID: 'test-client',
  api: {
    assistant: { recordNoteWrite },
    notes: { get: vi.fn(async () => ({ content: '' })) },
  },
}))

interface Harness {
  /** Every prompt the run sent, in order. */
  asked: string[]
  /** The answers queued up; `null` is a turn the store refused to send. */
  replies: Array<string | null>
  /** The threads the run opened, which is how a resumed run gets back to its own evidence. */
  opened: string[]
}

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
let token = 0

/**
 * Patch one assistant-store instance into the shape a research run drives.
 *
 * `send` is what the real store does with the worker replaced: it answers with whether the turn went
 * out, and leaves the answer on `turn` for the caller to read.
 */
function wire(
  assistant: typeof useAssistant,
  notes: typeof useNotes,
  harness: Harness,
  noteId: string | null = 'note-1',
): void {
  token = 0
  assistant.setState({
    turn: null,
    activeId: 'c-research',
    webSearch: false,
    messages: [],
    setView: () => undefined,
    newConversation: async () => undefined,
    openConversation: async (id: string | null) => {
      if (id) harness.opened.push(id)
      assistant.setState({ activeId: id })
    },
    setWebSearch: () => undefined,
    send: async (text: string) => {
      harness.asked.push(text)
      const answer = harness.replies.shift()
      if (answer === undefined || answer === null) return false
      assistant.setState({ turn: { token: ++token, done: true, text: answer, error: null } as never })
      return true
    },
  } as never)
  notes.setState({
    contents: {},
    createNote: vi.fn(async () => noteId),
  } as never)
}

/** A whole module graph, freshly imported: the only thing a reload leaves behind is the browser's record. */
async function freshGraph(harness: Harness): Promise<{
  startDeepResearch: typeof startDeepResearch
  resumeDeepResearch: typeof resumeDeepResearch
  researchSteps: typeof researchSteps
  useResearchRun: typeof useResearchRun
  useAssistant: typeof useAssistant
  useNotes: typeof useNotes
}> {
  vi.resetModules()
  const [mod, assistantModule, notesModule, i18n] = await Promise.all([
    import('./deep-research'),
    import('./assistant-store'),
    import('../../store/notes'),
    import('../../lib/i18n'),
  ])
  await i18n.initI18n()
  wire(assistantModule.useAssistant, notesModule.useNotes, harness)
  return {
    startDeepResearch: mod.startDeepResearch,
    resumeDeepResearch: mod.resumeDeepResearch,
    researchSteps: mod.researchSteps,
    useResearchRun: mod.useResearchRun,
    useAssistant: assistantModule.useAssistant,
    useNotes: notesModule.useNotes,
  }
}

function newHarness(): Harness {
  return { asked: [], replies: [], opened: [] }
}

let harness: Harness

beforeEach(async () => {
  await initI18n()
  localStorage.clear()
  harness = newHarness()
  wire(useAssistant, useNotes, harness)
})

afterEach(() => {
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  vi.restoreAllMocks()
})

describe('a run that stopped', () => {
  it('keeps where it got to, with what the finished steps found', async () => {
    harness.replies = ['1. What shipped?\n2. What slipped?', '- shipped A', null]
    expect(await startDeepResearch('Q3 delivery')).toBeNull()

    const run = useResearchRun.getState().run
    expect(run, 'the record a reload reads').not.toBeNull()
    expect(run?.questions).toEqual(['What shipped?', 'What slipped?'])
    // The finding of the step that answered is in the record, not only in a thread the reader has to hunt.
    expect(run?.findings).toEqual(['- shipped A', ''])
    expect(run?.failedStep).toBe(2)

    // And it is the browser that holds it, which is the whole point of the record.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    expect(stored.findings[0]).toBe('- shipped A')
    expect(stored.questions).toHaveLength(2)
  })

  it('lists the steps with the one that stopped named, and a count that includes them all', () => {
    const run = {
      id: 'r1',
      topic: 'Q3 delivery',
      conversationId: 'c-research',
      questions: ['What shipped?', 'What slipped?'],
      findings: ['- shipped A', ''],
      report: '',
      noteId: null,
      failedStep: 2,
      error: null,
      updatedAt: 1,
    }
    const steps = researchSteps(run, false)
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'failed', 'pending', 'pending'])
    // The step it stopped on is the one that says so; a job nothing is doing never shows as running.
    expect(steps.filter((step) => step.state === 'running')).toHaveLength(0)
    expect(steps[2]?.label).toBe('What slipped?')
    expect(steps[2]?.output).toBe('')
    expect(steps[1]?.output).toBe('- shipped A')
  })

  it('marks the step it is asking for as the one running, and only that one', () => {
    const run = {
      id: 'r2',
      topic: 'Q3 delivery',
      conversationId: 'c-research',
      questions: ['What shipped?'],
      findings: [''],
      report: '',
      noteId: null,
      failedStep: null,
      error: null,
      updatedAt: 1,
    }
    const steps = researchSteps(run, true)
    expect(steps.map((step) => step.state)).toEqual(['done', 'running', 'pending', 'pending'])
  })
})

describe('the run banner', () => {
  /**
   * Structure, roles and names only: jsdom lays nothing out, so what can be proved here is that a reader
   * — including one using a screen reader — is told how far the run got and what is on offer.
   */
  it('says how far a stopped run got, keeps its findings reachable, and offers a way on', async () => {
    harness.replies = ['1. What shipped?\n2. What slipped?', '- shipped A', null]
    await startDeepResearch('Q3 delivery')

    const { container, unmount } = renderElement(createElement(DeepResearchProgress))
    const region = container.querySelector('section[role="status"]')
    expect(region).not.toBeNull()
    expect(region?.getAttribute('aria-label')).toContain('Q3 delivery')
    expect(region?.getAttribute('aria-live')).toBe('polite')

    const rows = container.querySelectorAll('ol > li')
    expect(rows).toHaveLength(5)
    const done = rows[1]?.textContent
    expect(done).toContain('What shipped?')
    // The finding is on the row it belongs to, so a run that stopped is not a run that said nothing.
    const found = rows[1]?.querySelector('details')
    expect(found?.textContent).toContain('- shipped A')
    expect(rows[2]?.textContent).toContain('What slipped?')
    expect(container.textContent).toContain('2 of 5 steps done')
    // Nothing is in flight, so nothing may claim to be.
    expect(container.querySelector('[aria-current="step"]')).toBeNull()

    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Continue the research'))
    expect(retry, 'a stopped run has to offer the way on').not.toBeUndefined()
    // What the two remaining turns answer with: the sub-question that stopped the run and the write-up.
    harness.replies = ['- slipped B', '# Report\n\nConclusion']
    const askedBefore = harness.asked.length
    await act(async () => {
      retry!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    // Continuing asks the question that is still empty and the write-up — never the one already answered.
    await act(async () => {
      await vi.waitFor(() => expect(useResearchRun.getState().run).toBeNull())
    })
    const resumed = harness.asked.slice(askedBefore)
    expect(resumed.filter((prompt) => prompt.includes('What shipped?'))).toHaveLength(0)
    expect(resumed.filter((prompt) => prompt.includes('What slipped?'))).toHaveLength(1)
    expect(resumed.at(-1)).toContain('research note about')
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    unmount()
  })

  it('puts the run away when the reader dismisses it', async () => {
    harness.replies = ['1. What shipped?', null]
    await startDeepResearch('Q3 delivery')
    const { container, unmount } = renderElement(createElement(DeepResearchProgress))
    expect(container.querySelectorAll('ol > li')).toHaveLength(4)

    const dismiss = container.querySelector('button[aria-label="Dismiss this research run"]')
    expect(dismiss).not.toBeNull()
    await act(async () => {
      dismiss!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(useResearchRun.getState().run).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    // A run the reader put away is not a run the banner keeps offering to continue.
    const { container: empty, unmount: unmountEmpty } = renderElement(createElement(DeepResearchProgress))
    expect(empty.textContent).toBe('')
    unmountEmpty()
    unmount()
  })
})

describe('a reload in the middle of a run', () => {
  it('carries on from the steps that answered, in the thread they were asked in', async () => {
    const first = newHarness()
    first.replies = ['1. What shipped?\n2. What slipped?', '- shipped A', null]
    const before = await freshGraph(first)
    expect(await before.startDeepResearch('Q3 delivery')).toBeNull()
    expect(before.useResearchRun.getState().run?.findings).toEqual(['- shipped A', ''])

    // The whole of what a refresh leaves behind: no module state, only what the browser kept.
    const after = newHarness()
    after.replies = ['- slipped B', '# Report\n\nConclusion']
    const reloaded = await freshGraph(after)
    expect(reloaded.useResearchRun.getState().run?.topic, 'the reloaded module read the record back').toBe('Q3 delivery')
    // A reload lands on whatever thread was last open, which is not the one the run's turns are in.
    reloaded.useAssistant.setState({ activeId: 'c-somewhere-else' } as never)

    expect(await reloaded.resumeDeepResearch()).toBe('note-1')
    // The plan is in the record, so it is not asked again; neither is the sub-question that answered.
    expect(after.asked).toHaveLength(2)
    expect(after.asked[0]).toContain('What slipped?')
    expect(after.asked[1]).toContain('research note about')
    // And it went back to the thread its earlier turns live in before asking anything.
    expect(after.opened).toEqual(['c-research'])
    expect(reloaded.useResearchRun.getState().run, 'a filed report has said all its record has to say').toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('refuses to resume when an answer is already being written', async () => {
    harness.replies = ['1. What shipped?', null]
    await startDeepResearch('Q3 delivery')
    useAssistant.setState({ turn: { token: 99, done: false, text: '', error: null } as never })
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await resumeDeepResearch()).toBeNull()
    expect(harness.asked).toHaveLength(2)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' }))
  })
})
