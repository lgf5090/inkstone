// @vitest-environment jsdom
/**
 * What a turn's calls look like on screen, and what one of them can do afterwards.
 *
 * Two halves. The fold is the drive — a thread of twenty calls must not open as twenty dumps of JSON, the
 * group says how many there were, and a reader who wants one of them opens exactly that one. The replay
 * is the second half: a third-party call can be run again with the arguments it was given, and what comes
 * back belongs to that row rather than to the turn the model answered from.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ToolActivity } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { ToolCallList } from './MessageParts'
import { useAssistant } from './assistant-store'

const CALLS: ToolActivity[] = [
  {
    id: 't1',
    name: 'mcp_abc123_resolve-library-id',
    status: 'success',
    args: '{\n  "query": "react-query"\n}',
    result: 'the-library-id',
  },
  {
    id: 't2',
    name: 'search_notes',
    status: 'error',
    error: 'The index was busy.',
    args: '{\n  "query": "预算"\n}',
  },
]

const original = useAssistant.getState()
let root: Root
let host: HTMLElement
let replay: Mock<(conversationId: string, messageId: string, toolId: string) => Promise<{ ok: boolean, error: string, result: string }>>

const groups = () => [...document.body.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
const group = () => groups().find((node) => node.textContent?.includes(t('assistant.chat.tools_group')))
const rows = () => [...document.body.querySelectorAll<HTMLButtonElement>('button[data-tool-chip]')]
const row = (name: string) => document.body.querySelector<HTMLButtonElement>(`button[data-tool-chip="${name}"]`)
const pre = () => [...document.body.querySelectorAll('pre')].map((node) => node.textContent ?? '')
const click = (node: HTMLElement | null | undefined) => {
  expect(node, 'the control is not rendered').toBeTruthy()
  act(() => { node!.click() })
}
/** A press that lets the stored promise settle, which is what puts an answer on screen. */
async function press(node: HTMLElement | null | undefined) {
  expect(node, 'the control is not rendered').toBeTruthy()
  await act(async () => {
    node!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  replay = vi.fn(async () => ({ ok: true, error: '', result: 'the-library-id-again' }))
  // The conversation a replayed call is asked about, which the store holds while a thread is open.
  useAssistant.setState({ activeId: 'c1', replayMcpTool: replay })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(original, true)
  vi.clearAllMocks()
})

const render = (tools: ToolActivity[]) =>
  act(() => { root.render(createElement(ToolCallList, { tools, messageId: 'm1' })) })

describe('a turn’s calls', () => {
  beforeEach(() => render(CALLS))

  it('opens as one folded line that says how many there were', () => {
    expect(groups()).toHaveLength(1)
    expect(group()?.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.textContent).toContain('2')
    expect(rows()).toHaveLength(0)
    expect(pre()).toEqual([])
  })

  it('names each call, and opens one without opening its neighbour', () => {
    click(group())
    expect(rows()).toHaveLength(2)
    // The namespaced name is what the row keys on, and the server list the transcript loaded is what it
    // reads as; with no servers loaded the raw name is the honest fallback.
    expect(document.body.textContent).toContain('mcp_abc123_resolve-library-id')
    expect(row('search_notes')?.getAttribute('aria-expanded')).toBe('false')
    // The state of each call is on the row itself, so a folded group already answered "did it work".
    expect(document.body.textContent).toContain(t('assistant.chat.tool_done'))
    expect(document.body.textContent).toContain(t('assistant.chat.tool_failed'))

    click(row('mcp_abc123_resolve-library-id'))
    expect(row('mcp_abc123_resolve-library-id')?.getAttribute('aria-expanded')).toBe('true')
    expect(row('search_notes')?.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.textContent).toContain(t('assistant.chat.tool_args'))
    expect(document.body.textContent).toContain(t('assistant.chat.tool_result'))
    const shown = pre().join('\n')
    expect(shown).toContain('react-query')
    expect(shown).toContain('the-library-id')
    // The other call's arguments are still nowhere: opening one row must not leak the rest.
    expect(document.body.textContent).not.toContain('预算')
  })

  it('closes the row, and the group with it', () => {
    click(group())
    click(row('mcp_abc123_resolve-library-id'))
    click(row('mcp_abc123_resolve-library-id'))
    expect(pre()).toEqual([])
    click(group())
    expect(group()?.getAttribute('aria-expanded')).toBe('false')
    expect(rows()).toHaveLength(0)
  })

  it('shows a failure as the reason it failed, not as a missing answer', () => {
    click(group())
    click(row('search_notes'))
    expect(document.body.textContent).toContain('The index was busy.')
    // A call that threw still carried its arguments, and they are the half that explains what it tried.
    expect(pre().join('\n')).toContain('预算')
  })

  it('opens itself while a call is in flight, and folds once it settles', () => {
    render([{ ...CALLS[0]!, status: 'running', result: undefined }])
    expect(group()?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain(t('assistant.chat.tool_running'))
    render([CALLS[0]!])
    expect(group()?.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('running a call again', () => {
  beforeEach(() => render(CALLS))

  it('is offered on a call to a third party only, and shows its answer on the same row', async () => {
    click(group())
    click(row('mcp_abc123_resolve-library-id'))

    await press([...document.body.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(t('assistant.chat.replay'))))
    // The ids of the row, never its arguments: the worker reads those back out of the message.
    expect(replay).toHaveBeenCalledWith('c1', 'm1', 't1')
    expect(document.body.textContent).toContain(t('assistant.chat.replay_result'))
    expect(pre().join('\n')).toContain('the-library-id-again')
    // What the model was handed is untouched: the turn's own result is still the one it read.
    expect(pre().join('\n')).toContain('the-library-id')
  })

  it('says why a refused run refused, instead of showing an empty answer', async () => {
    replay.mockResolvedValueOnce({ ok: false, error: 'That server asks before every call.', result: '' })
    click(group())
    click(row('mcp_abc123_resolve-library-id'))
    await press([...document.body.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(t('assistant.chat.replay'))))
    expect(document.body.textContent).toContain('That server asks before every call.')
  })

  it('has nothing to run again on a built-in call', () => {
    click(group())
    click(row('search_notes'))
    expect(document.body.textContent).not.toContain(t('assistant.chat.replay'))
  })
})
