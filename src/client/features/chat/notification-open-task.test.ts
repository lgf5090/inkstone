// @vitest-environment jsdom
/**
 * Pressing a notice that names a task goes to that task.
 *
 * The column exists (`tests/notification-link.test.ts` pins that it ships, survives a backup and reads
 * back), and the worker has its own copy of the grammar. What could still have broken silently was the
 * row itself: a notice carrying a pointer that the drawer ignores looks exactly like a notice with no
 * pointer, so the reader presses it, the row expands, and the last step of a reminder is missing with
 * every test green. These cases press the row and ask which of the two gestures happened.
 *
 * A pointer this app cannot read — another app's prefix, a tail with a slash in it, nothing at all — is
 * deliberately the expand case rather than an error: the notice is still a message worth reading, and a
 * press that goes nowhere would be the app claiming it knows where the task lives.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantNotification } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { NotificationCenter } from './NotificationCenter'

const TASK_ID = '0123456789abcdefghjkmnpqrs'

const harness = vi.hoisted(() => ({ opened: [] as string[] }))

vi.mock('../todos/open-task', () => ({
  openTaskInTodo: async (taskId: string) => { harness.opened.push(taskId) },
}))

function notice(over: Partial<AssistantNotification> = {}): AssistantNotification {
  return {
    id: 'notice-1',
    title: 'Water the plants',
    body: 'The ones by the window.',
    automationId: null,
    subscriptionId: null,
    readAt: null,
    createdAt: Date.parse('2026-10-20T09:00:00Z'),
    ...over,
    link: over.link === undefined ? `todo:${TASK_ID}` : over.link,
  }
}

let root: Root
let host: HTMLElement
let onClose: () => void
let original: ReturnType<typeof useAssistant.getState>

function mount(notifications: AssistantNotification[]): void {
  useAssistant.setState({
    notifications,
    unread: notifications.filter((each) => each.readAt === null).length,
    loadNotifications: async () => undefined,
    markRead: async () => undefined,
    removeNotification: async () => undefined,
  })
  act(() => { root.render(createElement(NotificationCenter, { open: true, onClose })) })
}

/**
 * The row's own press target, which is the whole width of the row rather than a button beside it.
 *
 * The drawer mounts through a portal on `document.body`, so `host` never holds any of it — asking the
 * document is the only way to see what the reader was actually handed.
 */
function rowButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[type="button"].min-w-0.flex-1')
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.opened.length = 0
  original = useAssistant.getState()
  onClose = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original)
})

describe('pressing a notification', () => {
  it('opens the task the pointer names and puts the drawer away', () => {
    mount([notice()])

    const button = rowButton()
    expect(button, 'the notice never reached the screen').toBeTruthy()
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(harness.opened).toEqual([TASK_ID])
    expect(onClose, 'the drawer stayed up over the screen it just asked for').toHaveBeenCalled()
    expect(button!.hasAttribute('aria-expanded'), 'a row that navigates must not pretend to expand').toBe(false)
    expect(document.body.textContent).toContain(t('assistant.notifications.open_task'))
  })

  it('reads the rest of a notice that names no task, in place', () => {
    mount([notice({ link: null })])

    const button = rowButton()
    expect(button!.getAttribute('aria-expanded')).toBe('false')
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(harness.opened, 'a notice without a destination took the reader somewhere').toEqual([])
    expect(button!.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).not.toContain(t('assistant.notifications.open_task'))
  })

  it('treats a pointer it cannot read as no pointer at all', () => {
    // Each of these is a string the writer could have stored: another app's prefix, a tail that is not
    // one id, an id with a path in it. None of them may be opened as a task.
    for (const link of ['notes:123456', 'todo:', 'todo:' + TASK_ID + '/edit', 'todo:' + TASK_ID + '?x=1']) {
      harness.opened.length = 0
      // A fresh tree per case: the row toggles, so reusing the mounted one would fold the previous
      // iteration's expansion and answer a question nobody asked.
      act(() => root.unmount())
      root = createRoot(host)
      mount([notice({ link })])
      const button = rowButton()
      act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(harness.opened, `${link} was read as a task`).toEqual([])
      expect(button!.getAttribute('aria-expanded'), `${link} was treated as a destination`).toBe('true')
    }
  })

  it('marks the notice read whichever way the row goes', () => {
    const seen: string[] = []
    mount([notice()])
    act(() => { useAssistant.setState({ markRead: async () => { seen.push('read') } }) })
    const button = rowButton()
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(seen).toEqual(['read'])
    expect(harness.opened).toEqual([TASK_ID])
  })
})
