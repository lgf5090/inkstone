// @vitest-environment jsdom
/**
 * A batch that only half answered.
 *
 * One request per row used to stop at the first refusal: the rows before it had already changed on the
 * server, but neither list was re-read and the whole selection stayed on the screen. The reader saw old
 * data and pressed the button again. What has to hold is that every row is attempted, both lists are
 * refreshed whatever happened, only the rows that refused stay picked, and the active thread is left
 * alone when its own delete was the one that failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { useAssistant } from './assistant-store'

const original = useAssistant.getState()
const loadConversations = vi.fn(async (): Promise<void> => undefined)
const loadFlagged = vi.fn(async (): Promise<void> => undefined)
const newConversation = vi.fn(() => undefined)

beforeEach(() => {
  loadConversations.mockClear()
  loadFlagged.mockClear()
  newConversation.mockClear()
  useAssistant.setState({
    conversationPicks: new Set(['a', 'b', 'c']),
    activeId: null,
    loadConversations,
    loadFlagged,
    newConversation,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  useAssistant.setState(original, true)
})

describe('archiving a selection', () => {
  it('attempts every row, refreshes both lists, and keeps only the refused rows picked', async () => {
    const archive = vi.spyOn(api.assistant, 'setConversationArchived')
      .mockImplementation(async (id: string) => {
        if (id === 'b') throw new Error('refused')
        return undefined as never
      })
    await useAssistant.getState().archivePickedConversations()
    expect(archive).toHaveBeenCalledTimes(3)
    expect(useAssistant.getState().conversationPicks).toEqual(new Set(['b']))
    expect(loadConversations).toHaveBeenCalledTimes(1)
    expect(loadFlagged).toHaveBeenCalledTimes(1)
  })

  it('clears the whole selection when nothing refused', async () => {
    vi.spyOn(api.assistant, 'setConversationArchived').mockResolvedValue({} as never)
    await useAssistant.getState().archivePickedConversations()
    expect(useAssistant.getState().conversationPicks).toBeNull()
  })
})

describe('deleting a selection', () => {
  it('stays in the active thread when its own delete was refused', async () => {
    vi.spyOn(api.assistant, 'deleteConversation')
      .mockImplementation(async (id: string) => {
        if (id === 'a') throw new Error('refused')
        return { deleted: true } as never
      })
    useAssistant.setState({ activeId: 'a' })
    await useAssistant.getState().deletePickedConversations()
    expect(newConversation).not.toHaveBeenCalled()
    expect(useAssistant.getState().conversationPicks).toEqual(new Set(['a']))
    expect(loadFlagged).toHaveBeenCalledTimes(1)
  })

  it('leaves the thread when its own delete succeeded', async () => {
    vi.spyOn(api.assistant, 'deleteConversation').mockResolvedValue({ deleted: true } as never)
    useAssistant.setState({ activeId: 'a' })
    await useAssistant.getState().deletePickedConversations()
    expect(newConversation).toHaveBeenCalledTimes(1)
  })
})

describe('deleting a single conversation', () => {
  it('refreshes the flagged shortlist too, so a starred row does not linger', async () => {
    vi.spyOn(api.assistant, 'deleteConversation').mockResolvedValue({ deleted: true } as never)
    await useAssistant.getState().deleteConversation('a')
    expect(loadConversations).toHaveBeenCalledTimes(1)
    expect(loadFlagged).toHaveBeenCalledTimes(1)
  })
})
