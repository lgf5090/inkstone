// @vitest-environment jsdom
/**
 * The chip that names the note a conversation was started from.
 *
 * It is the one door from a thread back to the page it was asked about, so what is pinned is where
 * pressing it goes: the notebook's own reveal — the address change plus the store's open — and not the
 * pointer on its own. Setting the active id does not load a body, and the reading pane holds a note it
 * never asked for spinning for ever.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { initI18n } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { ChatView } from './ChatView'

// The reveal is the whole subject, so it is the one thing this stands in for.
const { reveal } = vi.hoisted(() => ({ reveal: vi.fn() }))

vi.mock('./note-links', () => ({
  openNote: (id: string) => reveal(id),
  CHAT_NOTE_LINKS: { openNote: (id: string) => reveal(id), createNote: () => undefined },
}))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz11'
const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
let root: Root
let host: HTMLElement

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  reveal.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useNotes.setState({ notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Q3 review', deletedAt: null } as never } })
  useAssistant.setState({
    view: 'chat',
    activeId: 'c1',
    conversations: [{ id: 'c1', title: 'About the review', noteId: NOTE_ID } as never],
    messages: [],
    messagesReady: true,
    turn: null,
    remoteStreaming: false,
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, activeModelId: 'model-1' },
    loadMcpServers: vi.fn(async () => undefined),
  } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  window.history.replaceState(null, '', '/')
})

describe('the note a conversation came from', () => {
  it('reveals the note through the notebook’s own open', async () => {
    await act(async () => { root.render(createElement(ChatView)) })
    const chip = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.includes('Q3 review'))
    expect(chip, 'the chip is not drawn').toBeTruthy()
    await act(async () => { chip!.click() })
    expect(reveal).toHaveBeenCalledWith(NOTE_ID)
  })
})
