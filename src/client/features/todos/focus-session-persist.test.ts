// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { TodoTask } from '@shared/todos/model'
import { useTodos } from './store'
import { restoreFocusSession, useFocusSession } from './focus-session'

const KEY = 'inkstone.todos.focus.session.v1'
const TASK = { id: 'task-a', title: 'Write the report' } as TodoTask

function stored(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    taskId: TASK.id,
    strategy: 'pomodoro',
    screen: 'main',
    runState: 'running',
    visible: false,
    settingsOpen: false,
    blockMs: 25 * 60_000,
    breakMs: 0,
    round: 0,
    workedMs: 0,
    heldMs: 60_000,
    savedAt: Date.now() - 30_000,
    ...patch,
  })
}

describe('the focus session reload snapshot', () => {
  beforeEach(() => {
    localStorage.clear()
    useFocusSession.setState({ session: null })
    useTodos.setState({ tasks: [TASK], completed: [], status: 'ready' })
  })

  it('restores a running block and adds the time the page spent closed', () => {
    localStorage.setItem(KEY, stored())
    expect(restoreFocusSession()).toBe(true)
    const session = useFocusSession.getState().session
    expect(session?.taskId).toBe(TASK.id)
    expect(session?.runState).toBe('running')
    expect(session?.visible).toBe(false)
    // One minute held at save plus about thirty seconds closed.
    expect((session?.heldMs ?? 0) >= 90_000).toBe(true)
    expect(session?.anchorPerf).not.toBeNull()
  })

  it('does not add closed time to a paused block', () => {
    localStorage.setItem(KEY, stored({ runState: 'paused', heldMs: 60_000 }))
    expect(restoreFocusSession()).toBe(true)
    expect(useFocusSession.getState().session?.heldMs).toBe(60_000)
    expect(useFocusSession.getState().session?.anchorPerf).toBeNull()
  })

  it('drops a snapshot whose task is not on the page', () => {
    localStorage.setItem(KEY, stored({ taskId: 'missing' }))
    useTodos.setState({ tasks: [] })
    expect(restoreFocusSession()).toBe(false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(useFocusSession.getState().session).toBeNull()
  })

  it('removes the snapshot when the session ends', () => {
    localStorage.setItem(KEY, stored())
    restoreFocusSession()
    useFocusSession.getState().endSession()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(useFocusSession.getState().session).toBeNull()
  })
})
