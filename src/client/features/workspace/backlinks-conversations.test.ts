// @vitest-environment jsdom
/**
 * The conversations started from this note.
 *
 * The panel answers two questions about a note and a chat: which threads wrote it — the half the previous
 * file covers — and which threads were *asked about* it. The second is the one a reader standing on the page
 * wants: "what did I talk about here?" It is one filtered list away, and until now the note said nothing
 * about it.
 *
 * Three things are load-bearing here. The read names this note, so the list cannot be the whole library.
 * A row is a door, and it goes through the chat app's own entry point rather than a second copy of the
 * navigation. And a refused read says it failed: an empty list would tell the reader this note started no
 * conversations, which is a fact the request never established.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantConversation } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useNotes } from '../../store/notes'
import { useAssistant } from '../chat/assistant-store'
import { BacklinksPanel } from './BacklinksPanel'

const { backlinks, noteWrites, conversations } = vi.hoisted(() => ({
  backlinks: vi.fn(async () => ({ backlinks: [], unlinked: [] })),
  noteWrites: vi.fn(async () => ({ conversations: [] as { id: string, title: string, updatedAt: number }[] })),
  conversations: vi.fn(async (_params: { noteId: string, limit: string }, _signal?: AbortSignal) => ({
    conversations: [] as AssistantConversation[],
    nextCursor: null,
  })),
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

/** One row of the answer, shaped the way the route returns it. */
function thread(id: string, title: string, updatedAt: number, extra: Partial<AssistantConversation> = {}): AssistantConversation {
  return {
    id,
    title,
    pinned: false,
    starred: false,
    archived: false,
    ephemeral: false,
    parentId: null,
    folderId: null,
    noteId: NOTE_ID,
    createdAt: updatedAt - 10,
    updatedAt,
    messageCount: 1,
    tags: [],
    summary: null,
    summaryUpto: null,
    ...extra,
  }
}

/** The panel debounces the note's own backlinks, so every case pays for the same wait. */
async function show(): Promise<void> {
  await act(async () => { root.render(createElement(BacklinksPanel, { noteId: NOTE_ID })) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })
}

function buttonWith(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.includes(text))
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  useNotes.setState({ notes: { [NOTE_ID]: { id: NOTE_ID, title: 'A note', rev: 1 } as never } })
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
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

describe('the threads started from a note', () => {
  it('asks for this note alone, and lists the threads newest first', async () => {
    // Deliberately out of order, and with the oldest one pinned: the list screen's pinned shortcut is not
    // what a note's own backlink section is for.
    conversations.mockResolvedValueOnce({
      conversations: [thread('c-old', 'The older one', 1_000, { pinned: true }), thread('c-new', 'The newer one', 9_000)],
      nextCursor: null,
    })
    await show()
    expect(conversations).toHaveBeenCalledWith({ noteId: NOTE_ID, limit: '20' }, expect.any(AbortSignal))
    expect(document.body.textContent).toContain(t('workspace.conversations_about'))
    const newer = buttonWith('The newer one')
    const older = buttonWith('The older one')
    expect(newer && older, 'a thread is missing from the panel').toBeTruthy()
    expect(newer!.compareDocumentPosition(older!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the older thread leads').toBeTruthy()
  })

  it('opens the thread it names, through the chat app’s own door', async () => {
    const openConversation = vi.fn(async () => undefined)
    useAssistant.setState({ openConversation })
    conversations.mockResolvedValueOnce({ conversations: [thread('c7', 'What did we decide', 9_000)], nextCursor: null })
    await show()
    const row = buttonWith('What did we decide')
    expect(row, 'the conversation is not listed').toBeTruthy()
    act(() => { row!.click() })
    expect(openConversation).toHaveBeenCalledWith('c7', undefined)
    expect(window.location.pathname).toBe('/chat')
    expect(useAssistant.getState().view).toBe('chat')
  })

  it('says the read failed, and asks again when the reader presses retry', async () => {
    conversations.mockRejectedValueOnce(new Error('offline'))
    await show()
    expect(document.body.textContent).toContain(t('workspace.could_not_load_conversations'))
    // Refused is not empty: no heading, and no claim that the note started nothing.
    expect(document.body.textContent).not.toContain(t('workspace.conversations_about'))
    conversations.mockResolvedValueOnce({ conversations: [thread('c8', 'Back again', 9_000)], nextCursor: null })
    const retry = buttonWith(t('common.retry'))
    expect(retry, 'the failure offers no retry').toBeTruthy()
    await act(async () => { retry!.click() })
    expect(conversations).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Back again')
    expect(document.body.textContent).not.toContain(t('workspace.could_not_load_conversations'))
  })

  it('says nothing at all when the note started no conversation', async () => {
    conversations.mockResolvedValueOnce({ conversations: [], nextCursor: null })
    await show()
    expect(document.body.textContent).not.toContain(t('workspace.conversations_about'))
    expect(document.body.textContent).not.toContain(t('workspace.could_not_load_conversations'))
  })
})
