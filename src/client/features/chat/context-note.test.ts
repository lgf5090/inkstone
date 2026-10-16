/**
 * The open note's way from a chip to the request.
 *
 * The notebook's pointer rides along with every turn so "summarise this" works without naming the note,
 * and a chip the reader can take off is the only thing that keeps that from being an invisible decision.
 * What is pinned here is the half-wire: taking the chip off really does leave the id out of the request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
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
const originalUi = useUi.getState()

const sentInput = () => vi.mocked(streamAssistantTurn).mock.calls.at(-1)?.[0]

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useAssistant.setState({
    ...original,
    turn: null,
    activeId: 'c1',
    pending: [],
    noteContextOn: true,
    folderContextOn: true,
    turnTools: [],
    turnScopes: [],
    // The after-turn refreshes are not this chip; they would reach for api methods the mock has none of.
    loadConversations: vi.fn(async () => undefined),
    refreshAfterTurn: vi.fn(async () => undefined),
  })
  useUi.setState({ ...originalUi, activeNoteId: 'note1', folderId: 'folder1' })
  vi.mocked(streamAssistantTurn).mockClear()
})

describe('the open note as turn context', () => {
  it('sends the open note and folder with the turn', async () => {
    await useAssistant.getState().send('summarise this')
    expect(sentInput()?.contextNoteId).toBe('note1')
    expect(sentInput()?.contextFolderId).toBe('folder1')
  })

  it('leaves the note out once its chip is taken off, and keeps the folder', async () => {
    useAssistant.getState().setNoteContext(false)
    await useAssistant.getState().send('summarise this')
    expect(sentInput()?.contextNoteId).toBeUndefined()
    expect(sentInput()?.contextFolderId).toBe('folder1')
  })

  it('leaves both out when both chips are taken off', async () => {
    useAssistant.getState().setNoteContext(false)
    useAssistant.getState().setFolderContext(false)
    await useAssistant.getState().send('summarise this')
    expect(sentInput()?.contextNoteId).toBeUndefined()
    expect(sentInput()?.contextFolderId).toBeUndefined()
  })

  it('starts the next thread from the pointer again', async () => {
    useAssistant.getState().setNoteContext(false)
    useAssistant.getState().newConversation()
    expect(useAssistant.getState().noteContextOn).toBe(true)
  })
})
