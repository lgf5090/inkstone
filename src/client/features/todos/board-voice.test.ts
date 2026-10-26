// @vitest-environment jsdom
/**
 * The board's voice button.
 *
 * Web Speech is not in jsdom and is absent from some real browsers too, so the cases here pin the
 * honest half first: with no API the button is disabled and says why, rather than offering a press
 * that does nothing. When the API is there, the recognised words go into the same inline field the
 * reader types into, which means the existing quick-add parser still decides what the line means —
 * the assertion at the API boundary is the parsed due date, not a second parser invented for voice.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'
import type { TaskListEntry } from '../../lib/api'

const service = vi.hoisted(() => ({
  creates: [] as Record<string, unknown>[],
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      create: async (body: Record<string, unknown>) => {
        service.creates.push(body)
        return { task: row(String(body.title), body.listId as string | null) }
      },
      list: async () => ({
        tasks: [], total: 0, counts: counts(), dayEnd: Date.now() + 3_600_000, timezone: 'Asia/Shanghai',
      }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async () => ({ task: null, steps: [] }),
    },
  },
}))

import { BoardView } from './BoardView'
import { useTodos } from './store'

/** 01:30 on Tuesday 2026-10-20 in Shanghai, which is still Monday in London. */
const NOW = Date.parse('2026-10-19T17:30:00Z')

type RecognitionResultEvent = { results: { 0: { 0: { transcript: string } } } }

/** The browser half of Web Speech, small enough to drive from a case. */
class FakeRecognition {
  static last: FakeRecognition | null = null
  lang = ''
  interimResults = true
  continuous = true
  maxAlternatives = 0
  started = 0
  stopped = 0
  onresult: ((event: RecognitionResultEvent) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null

  constructor() {
    FakeRecognition.last = this
  }

  start(): void {
    this.started += 1
  }

  stop(): void {
    this.stopped += 1
  }

  abort(): void {
    this.stopped += 1
  }

  speak(transcript: string): void {
    this.onresult?.({ results: { 0: { 0: { transcript } } } })
  }
}

function counts(): TaskCounts {
  return {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0,
    byList: { L1: { open: 0, done: 0 } }, byTag: {},
  }
}

function row(title: string, listId: string | null): TodoTask {
  return {
    id: 'created', title, description: '', status: 'todo', priority: 'medium',
    dueAt: null, remindAt: null, completedAt: null, createdAt: 0, updatedAt: 0,
    listId, tags: [], dependsOn: [], blocks: [], starred: false, repeat: null, remindedAt: null,
    plannedFor: null, noteId: null, conversationId: null, projectId: null,
    stepTotal: 0, stepDone: 0,
  }
}

function list(id: string, name: string): TaskListEntry {
  return { id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0, archivedAt: null, parentId: null }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

function card(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`section[aria-label="${name}"]`)
  if (!found) throw new Error(`no card named ${name}`)
  return found
}

function openAdd(section: HTMLElement): HTMLInputElement {
  const button = [...section.querySelectorAll('button')]
    .find((node) => (node.textContent ?? '').includes(t('todo.action.add_task')))
  if (!button) throw new Error('the card offers no add row')
  act(() => { button.click() })
  const input = section.querySelector<HTMLInputElement>(`input[aria-label="${t('todo.action.add_task')}"]`)
  if (!input) throw new Error('the add row has no field')
  return input
}

function voiceButton(section: HTMLElement): HTMLButtonElement {
  const button = section.querySelector<HTMLButtonElement>('button[data-todo-voice]')
  if (!button) throw new Error('the add row offers no voice button')
  return button
}

function installSpeech(): void {
  ;(window as unknown as { webkitSpeechRecognition: typeof FakeRecognition }).webkitSpeechRecognition = FakeRecognition
}

function removeSpeech(): void {
  delete (window as unknown as { webkitSpeechRecognition?: typeof FakeRecognition }).webkitSpeechRecognition
  delete (window as unknown as { SpeechRecognition?: typeof FakeRecognition }).SpeechRecognition
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.creates.length = 0
  FakeRecognition.last = null
  removeSpeech()
  useTodos.setState(original, true)
  useTodos.setState({
    status: 'ready',
    tasks: [],
    completed: [],
    lists: [list('L1', '工作')],
    tags: [],
    counts: counts(),
    dayEnd: NOW + 86_400_000,
    timezone: 'Asia/Shanghai',
  })
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  view = renderElement(createElement(BoardView, { onOpenList: () => {} }))
})

afterEach(() => {
  vi.restoreAllMocks()
  act(() => { view?.unmount() })
  view = null
  removeSpeech()
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

describe('the board\u2019s voice quick add', () => {
  it('is disabled with a reason when the browser has no Web Speech API', () => {
    const section = card(view!.container, '工作')
    openAdd(section)
    const button = voiceButton(section)

    expect(button.disabled, 'a press that cannot listen must not be offered').toBe(true)
    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const reason = document.getElementById(describedBy!)
    expect(reason?.textContent).toBe(t('todo.voice.unsupported'))
    expect(section.textContent).toContain(t('todo.voice.unsupported'))
  })

  it('listens, puts the words in the field, and lets quick add parse them', async () => {
    installSpeech()
    act(() => { view!.rerender(createElement(BoardView, { onOpenList: () => {} })) })
    const section = card(view!.container, '工作')
    const input = openAdd(section)
    const button = voiceButton(section)
    expect(button.disabled).toBe(false)

    act(() => { button.click() })
    expect(FakeRecognition.last?.started).toBe(1)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(section.textContent).toContain(t('todo.voice.listening'))

    act(() => { FakeRecognition.last!.speak('明天下午3点 交周报') })
    await settle()
    expect(input.value).toBe('明天下午3点 交周报')
    const preview = section.querySelector<HTMLElement>('[data-todo-quickadd-chips]')
    expect(preview, 'the recognised line did not go through the quick-add preview').not.toBeNull()
    expect(preview!.textContent).toContain('15:00')

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await settle()
    expect(service.creates).toHaveLength(1)
    expect(service.creates[0]!.title).toBe('交周报')
    // 15:00 on 2026-10-21 in Shanghai, exactly what the typed line would have produced.
    expect(service.creates[0]!.dueAt).toBe(Date.UTC(2026, 9, 21, 7, 0))
  })

  it('reports a refused microphone instead of pretending it listened', async () => {
    installSpeech()
    act(() => { view!.rerender(createElement(BoardView, { onOpenList: () => {} })) })
    const section = card(view!.container, '工作')
    openAdd(section)
    const button = voiceButton(section)

    act(() => { button.click() })
    act(() => { FakeRecognition.last!.onerror?.({ error: 'not-allowed' }) })
    await settle()

    expect(button.getAttribute('aria-pressed')).toBe('false')
    const status = section.querySelector('[role="status"]')
    expect(status?.textContent).toBe(t('todo.voice.denied'))
  })

  it('stops a running recognition when the button is pressed again', async () => {
    installSpeech()
    act(() => { view!.rerender(createElement(BoardView, { onOpenList: () => {} })) })
    const section = card(view!.container, '工作')
    openAdd(section)
    const button = voiceButton(section)

    act(() => { button.click() })
    act(() => { button.click() })
    expect(FakeRecognition.last?.stopped).toBe(1)
    act(() => { FakeRecognition.last!.onend?.() })
    await settle()
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })
})
