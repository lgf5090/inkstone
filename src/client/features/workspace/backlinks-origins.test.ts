// @vitest-environment jsdom
/**
 * The note's other half of its backlinks.
 *
 * A note the assistant wrote has no `[[links]]` pointing at it — what points at it is a conversation, and
 * the notes table has no way to say so. The panel therefore asks two questions, and this is the second
 * one: the threads that wrote this note, drawn under the note-to-note backlinks, each opening the
 * exchange it came from.
 *
 * The section is silent when the answer is empty, which is the honest state for the overwhelming majority
 * of notes: an empty "from a conversation" heading would be furniture.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { BacklinksPanel } from './BacklinksPanel'
import { useAssistant } from '../chat/assistant-store'

const { backlinks, noteWrites, conversations } = vi.hoisted(() => ({
  backlinks: vi.fn(async () => ({ backlinks: [], unlinked: [] })),
  noteWrites: vi.fn(async () => ({ conversations: [] as { id: string, title: string, updatedAt: number }[] })),
  // The threads started *from* the note are a different section's read; this file is about the ones that
  // wrote it, so the answer here is always "none" — and it has to exist, or the panel's request throws.
  conversations: vi.fn(async () => ({ conversations: [] as never[], nextCursor: null })),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    notes: { backlinks },
    assistant: { noteWrites, conversations },
  },
}))

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz11'
const notesOriginal = useNotes.getState()
const assistantOriginal = useAssistant.getState()
let root: Root
let host: HTMLElement

async function show(): Promise<void> {
  await act(async () => { root.render(createElement(BacklinksPanel, { noteId: NOTE_ID })) })
  // The panel debounces its reads so a note being typed in does not refetch per keystroke.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useNotes.setState({
    notes: { [NOTE_ID]: { id: NOTE_ID, title: 'A note', rev: 1 } as never },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useNotes.setState(notesOriginal, true)
  useAssistant.setState(assistantOriginal, true)
  // A row that was pressed leaves the address on /chat; the next case has to start from its own tab.
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

describe('a note a conversation wrote', () => {
  it('names the conversation that wrote it, and opens it', async () => {
    noteWrites.mockResolvedValueOnce({ conversations: [{ id: 'c1', title: 'Planning the quarter', updatedAt: Date.now() }] })
    const openConversation = vi.fn(async () => undefined)
    useAssistant.setState({ openConversation })
    await show()
    expect(document.body.textContent).toContain(t('workspace.from_conversations'))
    const row = [...document.body.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('Planning the quarter'))
    expect(row, 'the conversation is not listed').toBeTruthy()
    act(() => { row!.click() })
    // The chat app's own entry point takes the thread, so the row lands where a `![[chat:id]]` embed lands:
    // the conversation view, with no message named to focus on.
    expect(openConversation).toHaveBeenCalledWith('c1', undefined)
    expect(window.location.pathname).toBe('/chat')
  })

  it('says nothing at all when no conversation wrote it', async () => {
    noteWrites.mockResolvedValueOnce({ conversations: [] })
    await show()
    expect(document.body.textContent).not.toContain(t('workspace.from_conversations'))
  })

  it('keeps the note-to-note backlinks when the chat answer fails', async () => {
    noteWrites.mockRejectedValueOnce(new Error('offline'))
    await show()
    // The section the reader came for is still drawn, and the failed one is simply absent.
    expect(document.body.textContent).toContain(t('workspace.no_notes_link_here_yet_write'))
    expect(document.body.textContent).not.toContain(t('workspace.from_conversations'))
  })
})
