// @vitest-environment jsdom
/**
 * Two fusion items that both live where the notebook and the assistant meet.
 *
 * Item one: a note's checkbox can be copied out to the assistant's task list, one way. What is pinned is
 * the shape of that single direction — the task carries the note back-reference and any due date, and the
 * checkbox itself is not touched, because the note stays the authority for the box.
 *
 * Item two: the chat dock and a canvas draft are never supposed to appear on the same screen today,
 * because each is mounted by a different container. This asserts the two can be present at once — jsdom
 * lays nothing out, so the claim is structural (both surfaces in the document together), not about the
 * pixels beside the note; the real host that places them side by side is Workspace.
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, stubBreakpoint } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import {
  buildNoteTaskPayload,
  buildSelectionTaskPayload,
  createTaskFromNoteCheckbox,
  parseNoteTaskCheckbox,
} from './note-task-link'
import { CanvasPanel } from './CanvasPanel'
import { AssistantDock } from './AssistantDock'
import { useAssistant } from './assistant-store'

const { createTask, listTasks } = vi.hoisted(() => ({
  createTask: vi.fn(async (body: Record<string, unknown>) => ({ task: { id: 'task-1', status: 'todo', tags: [], stepTotal: 0, stepDone: 0, starred: false, ...body } })),
  listTasks: vi.fn(async () => ({ tasks: [], counts: {}, dayEnd: 0, timezone: 'UTC' })),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    todos: {
      create: createTask,
      list: listTasks,
    },
    assistant: {
      settings: vi.fn(async () => ({ settings: null, models: [] })),
      skills: vi.fn(async () => ({ skills: [] })),
      conversations: vi.fn(async () => ({ conversations: [] })),
      tasks: vi.fn(async () => ({ tasks: [] })),
      projects: vi.fn(async () => ({ projects: [] })),
    },
    notes: { get: vi.fn(async () => ({ content: '' })) },
    files: { upload: vi.fn(async () => ({ url: '', filename: '', mime: '' })) },
  },
}))

vi.mock('./ChatView', () => ({
  ChatComposer: () => createElement('div', { 'data-composer': '1' }),
  MessageRow: () => null,
  UserBubble: () => null,
}))

vi.mock('../../editor/CodeEditor', () => ({
  DeferredCodeEditor: ({ value }: { value: string }) => createElement('textarea', { value }),
}))

const NOTE = { noteId: '01hzzzzzzzzzzzzzzzzzzzzz20', noteTitle: 'Reading list' }

/** Same local end-of-day the module and the task list both compare against. */
function endOfDay(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
}

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  document.body.innerHTML = ''
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('a note selection kept as a task', () => {
  it('takes the first line as the title and the whole passage as the note', () => {
    expect(buildSelectionTaskPayload({ text: '## 交周报\n周五之前，附上数据', noteId: NOTE.noteId })).toEqual({
      title: '交周报',
      description: '交周报\n周五之前，附上数据',
      noteId: NOTE.noteId,
    })
  })

  it('makes no task of a selection with no words in it', () => {
    expect(buildSelectionTaskPayload({ text: '  \n\t ', noteId: NOTE.noteId })).toBeNull()
  })
})

describe('a note checkbox copied out to the task list', () => {
  it('reads the box’s own words without the marker', () => {
    expect(parseNoteTaskCheckbox('- [ ] Buy more paper')?.title).toBe('Buy more paper')
    expect(parseNoteTaskCheckbox('  * [x] done thing')?.title).toBe('done thing')
  })

  it('is not a task when the line is not a checkbox', () => {
    expect(parseNoteTaskCheckbox('just a paragraph')).toBeNull()
    expect(parseNoteTaskCheckbox('- a plain bullet')).toBeNull()
  })

  it('carries a due date written either way the vault spells it', () => {
    expect(parseNoteTaskCheckbox('- [ ] File the tax [due:: 2026-03-01]')?.dueAt).toBe(endOfDay(2026, 3, 1))
    expect(parseNoteTaskCheckbox('- [ ] Ship it 📅 2026-01-15')?.dueAt).toBe(endOfDay(2026, 1, 15))
    expect(parseNoteTaskCheckbox('- [ ] no date here')?.dueAt).toBeNull()
  })

  it('cuts the field markers out of the task’s title', () => {
    expect(parseNoteTaskCheckbox('- [ ] File the tax [due:: 2026-03-01]')?.title).toBe('File the tax')
  })

  it('builds a payload that carries the note by id and leaves the description empty', () => {
    const payload = buildNoteTaskPayload({ line: '- [ ] Buy more paper', ...NOTE })
    expect(payload).toEqual({ title: 'Buy more paper', dueAt: null, noteId: NOTE.noteId })
  })

  it('returns null for a line with nothing to make a task of', () => {
    expect(buildNoteTaskPayload({ line: 'not a checkbox', ...NOTE })).toBeNull()
    expect(buildNoteTaskPayload({ line: '- [ ]   ', ...NOTE })).toBeNull()
  })

  it('creates one task and leaves the checkbox alone', async () => {
    const editContent = vi.spyOn(useNotes.getState(), 'editContent').mockImplementation(() => undefined)
    const toast = vi.spyOn(useUi.getState(), 'toast').mockImplementation(() => 'toast-id')
    try {
      const made = await createTaskFromNoteCheckbox({ line: '- [ ] Buy more paper 📅 2026-01-15', ...NOTE })
      expect(made).toBe(true)
      expect(createTask).toHaveBeenCalledTimes(1)
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Buy more paper',
        dueAt: endOfDay(2026, 1, 15),
        noteId: NOTE.noteId,
      }))
      // One way: the note's box is never rewritten here — the note stays the authority for the checkbox.
      expect(editContent).not.toHaveBeenCalled()
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.task.made_from_note') }))
    } finally {
      editContent.mockRestore()
      toast.mockRestore()
    }
  })
})

/**
 * The two surfaces together.
 *
 * The historical blocker is not layout but mounting: the dock belongs to the notebook's frame and the
 * canvas to the chat container, so following a draft out of a thread costs the reader the note they are
 * writing it into. This renders the two real components in one tree and proves both are on screen at
 * once. Workspace is the notebook host that actually places them beside the note.
 */
describe('the dock and a canvas draft can both be present', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    stubBreakpoint(true)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('keeps the assistant dock and the open draft on the same screen', async () => {
    useAssistant.setState({
      ...assistantOriginal,
      loaded: true,
      activeId: 'c1',
      messages: [],
      messagesReady: true,
      turn: null,
      remoteStreaming: false,
      canvasOpen: true,
      artifacts: [],
      artifactsReady: true,
      activeArtifactId: null,
    })
    await act(async () => {
      root.render(createElement(Fragment, null,
        createElement(AssistantDock),
        createElement(CanvasPanel)))
    })
    expect(document.querySelector('[data-assistant-dock="1"]'), 'the dock is not present').toBeTruthy()
    const canvas = [...document.querySelectorAll<HTMLElement>('aside')]
      .find((node) => node.getAttribute('aria-label') === t('assistant.canvas.title') || node.className.includes('42vw'))
    expect(canvas, 'the canvas draft is not present').toBeTruthy()
  })
})
