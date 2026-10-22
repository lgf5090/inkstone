// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../lib/test-render'
import { useAssistant } from './assistant-store'
import { useAssistantToolRefresh } from './tool-refresh'

const WRITE_TOOLS = new Set(['write_note'])
const original = useAssistant.getState()

function turn(patch: Record<string, unknown>) {
  return {
    conversationId: null,
    token: 1,
    done: false,
    text: '',
    tools: [],
    ...patch,
  } as never
}

function Probe({ refresh }: { refresh: () => void }) {
  useAssistantToolRefresh(WRITE_TOOLS, refresh)
  return null
}

afterEach(() => {
  useAssistant.setState(original, true)
})

describe('the assistant tool refresh', () => {
  it('refreshes once when a writing turn finishes, not on every delta', () => {
    const refresh = vi.fn()
    const view = renderElement(createElement(Probe, { refresh }))
    act(() => {
      useAssistant.setState({
        turn: turn({ done: false, tools: [{ name: 'write_note', status: 'success' }] }),
      })
    })
    expect(refresh).not.toHaveBeenCalled()

    act(() => {
      useAssistant.setState({
        turn: turn({ done: true, tools: [{ name: 'write_note', status: 'success' }] }),
      })
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    act(() => {
      useAssistant.setState({
        turn: turn({ done: true, tools: [{ name: 'write_note', status: 'success' }] }),
      })
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('leaves a read-only turn alone', () => {
    const refresh = vi.fn()
    const view = renderElement(createElement(Probe, { refresh }))
    act(() => {
      useAssistant.setState({
        turn: turn({ done: true, tools: [{ name: 'read_note', status: 'success' }] }),
      })
    })
    expect(refresh).not.toHaveBeenCalled()
    view.unmount()
  })
})
