/**
 * The web-search switch's way from a click to the request.
 *
 * Two half-wires have to be pinned together: the toggle writing the store, and the store reaching the
 * stream input. A chip that looked switched on while the turn went out without the flag is the worst
 * kind of control, because it is believed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { streamAssistantTurn } from './stream'
import { useAssistant } from './assistant-store'

vi.mock('../../lib/api', () => ({
  api: { assistant: { conversation: vi.fn(async () => ({ messages: [], streaming: false })) } },
}))

vi.mock('./stream', () => ({
  streamAssistantTurn: vi.fn(async (_input: unknown, onEvent: (event: { type: string }) => void) => {
    onEvent({ type: 'done' })
  }),
}))

const original = useAssistant.getState()

const sentInput = () => vi.mocked(streamAssistantTurn).mock.calls.at(-1)?.[0]

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useAssistant.setState({
    ...original,
    turn: null,
    activeId: 'c1',
    pending: [],
    webSearch: false,
    turnTools: [],
    turnScopes: [],
    // The after-turn refreshes are not this switch; they would reach for api methods the mock has none of.
    loadConversations: vi.fn(async () => undefined),
    refreshAfterTurn: vi.fn(async () => undefined),
  })
  vi.mocked(streamAssistantTurn).mockClear()
})

describe('the web-search switch on the way out', () => {
  it('carries the switch to the request when the reader asked for a live search', async () => {
    useAssistant.getState().setWebSearch(true)
    expect(useAssistant.getState().webSearch).toBe(true)
    await useAssistant.getState().send('What happened today?')
    expect(sentInput()?.webSearch).toBe(true)
  })

  it('sends the switch as off when the reader switched it back', async () => {
    useAssistant.getState().setWebSearch(true)
    useAssistant.getState().setWebSearch(false)
    await useAssistant.getState().send('What happened today?')
    expect(sentInput()?.webSearch).toBe(false)
  })

  it('keeps the switch set between turns, like the other composer settings', async () => {
    useAssistant.getState().setWebSearch(true)
    await useAssistant.getState().send('first')
    await useAssistant.getState().send('second')
    expect(useAssistant.getState().webSearch, 'the turn cleared a setting nobody switched off').toBe(true)
    expect(sentInput()?.webSearch).toBe(true)
  })
})
