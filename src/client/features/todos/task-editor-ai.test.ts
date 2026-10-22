// @vitest-environment jsdom
/**
 * The task editor's inline question: what it puts in front of the model, and what it shows back.
 *
 * The question is answered by the assistant's own transport, so the four endings it can produce are
 * asserted where the reader sees them — a spinner while the turn runs, the answer in place, a refusal,
 * and an answer with no words in it. The prompt case is the one that keeps the window from becoming a
 * chat box with no context: the title, the id, the note and the steps all have to ride along.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'

// The export helpers inline KaTeX's stylesheet through this checkout's symlinked `node_modules`;
// nothing here exports a note or renders math.
vi.mock('../../lib/export-note', () => ({
  downloadTextFile: vi.fn(),
  downloadBlob: vi.fn(),
  safeFileName: (name: string) => name,
  exportNoteAsHtml: vi.fn(),
  exportNoteAsMarkdown: vi.fn(),
  exportNoteAsPdf: vi.fn(),
}))
vi.mock('katex/dist/katex.min.css?inline', () => ({ default: '' }))

const ask = vi.hoisted(() => vi.fn())
vi.mock('../chat/editor-ai', () => ({ sendForAnswerDetailed: ask }))

// The editor reads the task's steps once it opens. A real request is not part of this contract.
const loadedSteps = vi.hoisted(() => [
  { id: 'step-1', taskId: 'task-1', text: 'Write the release notes', done: false, position: 0, createdAt: 1 },
  { id: 'step-2', taskId: 'task-1', text: 'Tell the team', done: false, position: 1, createdAt: 2 },
])
vi.mock('../../lib/api', () => ({
  api: { todos: { get: async () => ({ steps: loadedSteps }) } },
}))

import type { TodoTask } from '@shared/todos/model'
import { useTodos } from './store'
import { TaskEditor } from './TaskEditor'

const TASK: TodoTask = {
  id: 'task-1',
  title: 'Ship the release',
  description: 'Draft the notes and tell the team',
  status: 'todo',
  priority: 'medium',
  dueAt: null,
  projectId: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
  listId: null,
  tags: [],
  starred: false,
  repeat: null,
  remindAt: null,
  remindedAt: null,
  plannedFor: null,
  noteId: null,
  conversationId: null,
  stepTotal: 2,
  stepDone: 0,
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  ask.mockReset()
  useTodos.setState(original, true)
  useTodos.setState({
    editorOpen: true,
    draft: { id: TASK.id },
    lists: [],
    tags: [],
    tasks: [TASK],
    completed: [],
    timezone: 'UTC',
    saving: false,
  })
})

afterEach(() => {
  if (view) act(() => { view!.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

async function mount(): Promise<void> {
  view = renderElement(createElement(TaskEditor))
  await settle()
}

function askInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.task.ai_placeholder')}"]`)
  if (!input) throw new Error('the editor offers no inline question field')
  return input
}

function askButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.task.ai_send')}"]`)
  if (!button) throw new Error('the editor offers no inline ask button')
  return button
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function send(question: string): Promise<void> {
  type(askInput(), question)
  act(() => { askButton().click() })
  await settle()
}

function answerRegion(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="region"][aria-label="${t('todo.task.ai_answer')}"]`)
}

describe('the task editor inline question', () => {
  it('puts the task title, id, note and steps in front of the model', async () => {
    ask.mockResolvedValueOnce({ status: 'ok', text: 'Start with the notes.' })
    await mount()

    await send('What should I do first?')

    expect(ask).toHaveBeenCalledTimes(1)
    const prompt = String(ask.mock.calls[0]![0])
    expect(prompt).toContain(TASK.title)
    expect(prompt).toContain(TASK.id)
    expect(prompt).toContain(TASK.description)
    expect(prompt).toContain('Write the release notes')
    expect(prompt).toContain('Tell the team')
    expect(prompt).toContain(t('todo.task.steps_label'))
    expect(prompt).toContain('What should I do first?')
  })

  it('shows the turn running, then the answer in place', async () => {
    let resolve: ((result: unknown) => void) | null = null
    ask.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    await mount()

    await send('What should I do first?')

    expect(document.body.textContent).toContain(t('todo.task.ai_thinking'))
    // While the turn runs, the button says so and cannot send a second question.
    expect(askButton().disabled).toBe(true)
    expect(askButton().getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      resolve!({ status: 'ok', text: 'Start with the notes.' })
      await Promise.resolve()
    })

    const region = answerRegion()
    expect(region?.textContent).toContain('Start with the notes.')
    expect(document.body.textContent).not.toContain(t('todo.task.ai_thinking'))
    // Every control in the window has a name, including the one that clears the answer.
    expect(askInput().getAttribute('aria-label')).toBe(t('todo.task.ai_placeholder'))
    expect(askButton().getAttribute('aria-label')).toBe(t('todo.task.ai_send'))
    const clear = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.task.ai_clear')}"]`)
    expect(clear).toBeTruthy()
  })

  it('says so when the turn was refused', async () => {
    ask.mockResolvedValueOnce({ status: 'failed', error: 'No model is configured.' })
    await mount()

    await send('What should I do first?')

    expect(answerRegion()).toBeNull()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('No model is configured.')
  })

  it('says so when the assistant answered with nothing', async () => {
    ask.mockResolvedValueOnce({ status: 'empty' })
    await mount()

    await send('What should I do first?')

    expect(document.body.textContent).toContain(t('todo.task.ai_empty'))
    expect(answerRegion()).toBeNull()
  })

  it('names a turn that was already running rather than queueing behind it', async () => {
    ask.mockResolvedValueOnce({ status: 'busy' })
    await mount()

    await send('What should I do first?')

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('assistant.edit.busy'))
  })
})
