// @vitest-environment jsdom
/**
 * One folder, summarised into a note.
 *
 * The contract is the three things the reader gets out of one menu press: a thread about the folder, the
 * assistant's answer, and that answer filed as a note *inside* the folder it describes. The two halves
 * these cases exist to keep honest are the ones that were broken. The note has to be the answer *this*
 * send wrote: a read that falls back to the newest row on screen files an older thread's sentence under a
 * "Summary of Work" title. And the note has to be a row the notebook itself carries, because `openNote`
 * refuses a note it has never seen — a summary the store does not know is a note the reader cannot reach.
 *
 * So the real notes store and the real assistant store run here against a fake wire: mocking the create
 * away is exactly what hid the first defect, and mocking `openNote` what hid the second.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, ChatStreamEvent } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { summarizeFolder } from './folder-summary'

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz77'
/** The answer of a turn that had already finished in the open thread — the text that must never become
 * the summary. */
const PREVIOUS_ANSWER = 'Something the assistant said a minute ago, about another subject.'

const { wire, stream, sent } = vi.hoisted(() => ({
  wire: {
    createNote: vi.fn(),
    getNote: vi.fn(),
    recordNoteWrite: vi.fn(),
    conversation: vi.fn(),
    conversations: vi.fn(),
  },
  // What the fake transport does: the text it streams, the status the row is filed with, and whether it
  // reaches the worker at all.
  stream: {
    text: '# Work\n\nThree threads: hiring, the roadmap, and the Q3 review.',
    finalStatus: 'complete' as AssistantMessage['status'],
    refused: false,
  },
  sent: { scopes: [] as unknown[] },
}))

// The notes store's own cache; the row it adopts is what the note has to become.
vi.mock('../../lib/db', () => ({
  localDb: {
    scheduleShellSave: vi.fn(),
    setContent: vi.fn(async () => {}),
    setContentBatch: vi.fn(async () => {}),
    getContent: vi.fn(async () => null),
    dropContent: vi.fn(async () => {}),
    getOutbox: async () => [],
    enqueueOutbox: async () => {},
    withOutboxReplayLock: async (_owner: string, task: () => Promise<void>) => {
      await task()
      return true
    },
  },
  publishBroadcast: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    notes: { create: wire.createNote, get: wire.getNote },
    assistant: {
      // The turn is read back from the server once it ends, so the row the thread shows is the stored one.
      conversation: wire.conversation,
      conversations: wire.conversations,
      recordNoteWrite: wire.recordNoteWrite,
    },
  },
}))

// The stream is the transport, not the subject: this stands in for a turn that answers and ends.
vi.mock('./stream', () => ({
  streamAssistantTurn: async (input: Record<string, unknown>, apply: (event: ChatStreamEvent) => void) => {
    sent.scopes = (input.scopes as unknown[]) ?? []
    if (stream.refused) return
    apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm1' })
    apply({ type: 'text', delta: stream.text })
    apply({ type: 'done' })
  },
}))

function row(content: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content,
    tools: [],
    status: 'complete',
    error: null,
    createdAt: 1,
    source: 'chat',
    ...overrides,
  } as AssistantMessage
}

/** A thread with a finished answer, and a second turn the reader is still waiting for. */
function midConversation(): void {
  useAssistant.setState({
    activeId: 'c1',
    messages: [
      row('What is in my Work folder?', { id: 'm-question', role: 'user' }),
      row(PREVIOUS_ANSWER, { id: 'm-previous' }),
    ],
    turn: {
      token: 7,
      conversationId: 'c1',
      userText: 'And what is still open?',
      attachments: [],
      assistantId: 'm-running',
      text: 'An answer the reader is still watching',
      reasoning: '',
      tools: [],
      stage: undefined,
      error: null,
      done: false,
    } as never,
  })
}

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()

beforeEach(async () => {
  await initI18n()
  sent.scopes = []
  stream.text = '# Work\n\nThree threads: hiring, the roadmap, and the Q3 review.'
  stream.finalStatus = 'complete'
  stream.refused = false
  const served = new Map<string, unknown>()
  wire.createNote.mockImplementation(async (body: { id?: string, title: string, content: string, folderId?: string | null }) => {
    const now = Date.now()
    const note = {
      id: body.id ?? NOTE_ID,
      title: body.title,
      content: body.content,
      excerpt: '',
      folderId: body.folderId ?? null,
      tags: [],
      isPinned: false,
      isStarred: false,
      isArchived: false,
      wordCount: 0,
      charCount: body.content.length,
      rev: 1,
      position: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    served.set(note.id, note)
    return note
  })
  // The store revalidates a note it has just opened; the copy it gets back is the one it created.
  wire.getNote.mockImplementation(async (id: string) => served.get(id) ?? null)
  wire.recordNoteWrite.mockResolvedValue({})
  wire.conversations.mockResolvedValue({ conversations: [], nextCursor: null })
  wire.conversation.mockImplementation(async () => ({
    conversation: { id: 'c1' },
    messages: [row(stream.text, { status: stream.finalStatus })],
    attachments: [],
    streaming: false,
  }))
  useNotes.setState({
    folders: [{ id: 'f1', name: 'Work' } as never],
    notes: {},
    contents: {},
  })
  useAssistant.setState({ activeId: null, messages: [], turn: null, turnScopes: [], pending: [] } as never)
})

afterEach(() => {
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

describe('summarising a folder', () => {
  it('asks about the folder and files the answer inside it', async () => {
    const id = await summarizeFolder('f1')
    expect(id).toBeTruthy()
    // The thread it ran in is about this folder, which is what lets the note tools read it.
    expect(sent.scopes).toEqual([{ kind: 'folder', id: 'f1', name: 'Work' }])
    const notes = useNotes.getState()
    expect(notes.notes[id!]?.title).toBe(t('assistant.folder_summary.title', { name: 'Work' }))
    expect(notes.notes[id!]?.folderId).toBe('f1')
    // The thread is named in the note, so the summary can be read against what was actually said.
    expect(notes.contents[id!]).toBe(`${stream.text}\n\n---\n\n![[chat:c1]]`)
  })

  it('opens the note it made, and keeps the way back to it on the toast', async () => {
    const id = await summarizeFolder('f1')
    expect(id).toBeTruthy()
    // Setting the id is not opening a note: the body is read by `openNote`, which refuses a note the
    // store does not carry. The summary has to arrive on screen, not only on the server.
    expect(window.location.pathname).toBe('/notes')
    expect(useUi.getState().activeNoteId).toBe(id)
    const saved = useUi.getState().toasts.find((entry) => entry.action)
    expect(saved?.title).toBe(t('assistant.folder_summary.done', { title: t('assistant.folder_summary.title', { name: 'Work' }) }))
    expect(saved?.action?.label).toBe(t('assistant.chat.saved_note_open'))
    useUi.setState({ activeNoteId: null })
    saved?.action?.run()
    expect(useUi.getState().activeNoteId).toBe(id)
  })

  it('refuses while an answer is still being written, and files nothing', async () => {
    midConversation()
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await summarizeFolder('f1')).toBeNull()
    // The thread's own last row is not this command's answer: filing it would name somebody else's
    // sentence after the folder.
    expect(wire.createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.edit.busy'), tone: 'warning' }))
    // The reader's turn is left running, and their thread is left with its own chips.
    expect(useAssistant.getState().turn?.done).toBe(false)
    expect(useAssistant.getState().turnScopes).toEqual([])
  })

  it('files nothing when the reader stopped the answer, and says so', async () => {
    stream.finalStatus = 'cancelled'
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await summarizeFolder('f1')).toBeNull()
    expect(wire.createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.folder_summary.empty', { name: 'Work' }) }))
  })

  it('files nothing when the answer came back empty, and says so', async () => {
    stream.text = '   '
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await summarizeFolder('f1')).toBeNull()
    expect(wire.createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.folder_summary.empty', { name: 'Work' }) }))
  })

  it('files nothing when the worker never took the request, and says so', async () => {
    stream.refused = true
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await summarizeFolder('f1')).toBeNull()
    expect(wire.createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' }))
  })

  it('says so when the note cannot report the conversation it came from', async () => {
    wire.recordNoteWrite.mockRejectedValue(new Error('offline'))
    const toast = vi.spyOn(useUi.getState(), 'toast')
    const id = await summarizeFolder('f1')
    expect(id).toBeTruthy()
    expect(wire.recordNoteWrite).toHaveBeenCalledWith(id, 'c1')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: t('assistant.folder_summary.backlink_failed'),
      tone: 'warning',
    }))
  })

  it('does nothing for a folder that is gone', async () => {
    expect(await summarizeFolder('nope')).toBeNull()
    expect(wire.createNote).not.toHaveBeenCalled()
  })
})
