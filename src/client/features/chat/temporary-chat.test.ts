/**
 * The temporary thread's way from a click to the request.
 *
 * The promise is made once, at creation, so the two halves that have to meet are the reader's intent and
 * the turn that carries it: a button that lit up while the conversation went out unflagged would produce a
 * thread that looks temporary and is not, which is worse than not offering the button. The other direction
 * matters just as much — a flag sent on a later turn of an ordinary conversation would mean nothing,
 * because the server reads it only where it makes the conversation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { streamAssistantTurn } from './stream'
import { useAssistant } from './assistant-store'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    assistant: {
      conversation: vi.fn(async () => ({
        conversation: { id: 'c1', ephemeral: true },
        messages: [],
        attachments: [],
        streaming: false,
      })),
      conversationArtifacts: vi.fn(async () => ({ artifacts: [] })),
    },
  },
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
    activeId: null,
    ephemeral: false,
    pending: [],
    turnTools: [],
    turnScopes: [],
    // The after-turn refreshes are not this flag; they would reach for api methods the mock has none of.
    loadConversations: vi.fn(async () => undefined),
    refreshAfterTurn: vi.fn(async () => undefined),
  })
  vi.mocked(streamAssistantTurn).mockClear()
})

describe('starting a temporary chat', () => {
  it('carries the flag on the turn that makes the conversation', async () => {
    useAssistant.getState().startTemporaryConversation()
    expect(useAssistant.getState().ephemeral).toBe(true)
    expect(useAssistant.getState().activeId).toBeNull()
    await useAssistant.getState().send('something private')
    expect(sentInput()?.ephemeral).toBe(true)
  })

  it('does not send it once the conversation exists', async () => {
    useAssistant.getState().startTemporaryConversation()
    useAssistant.setState({ activeId: 'c1' })
    await useAssistant.getState().send('a second question')
    // The server reads the flag only where it creates the conversation, so sending it here would be a
    // claim about a row that already exists.
    expect(sentInput()?.ephemeral).toBeUndefined()
  })

  it('is not sent by an ordinary new conversation', async () => {
    useAssistant.getState().newConversation()
    expect(useAssistant.getState().ephemeral).toBe(false)
    await useAssistant.getState().send('a normal question')
    expect(sentInput()?.ephemeral).toBeUndefined()
  })

  it('is read back off the row when the thread is opened', async () => {
    await useAssistant.getState().openConversation('c1')
    // The list never carries a temporary conversation, so the row itself is the only place this can come
    // from — and the header's chip is drawn from it.
    expect(useAssistant.getState().ephemeral).toBe(true)
  })

  it('goes back to ordinary when the reader starts a new chat', () => {
    useAssistant.getState().startTemporaryConversation()
    useAssistant.getState().newConversation()
    expect(useAssistant.getState().ephemeral).toBe(false)
  })
})
