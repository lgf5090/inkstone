// @vitest-environment jsdom
/**
 * One folder, summarised into a note.
 *
 * The contract is the three things the reader gets out of one menu press: a thread about the folder, the
 * assistant's answer, and that answer filed as a note *inside* the folder it describes. The third is the
 * part worth pinning — `create_note` has no folder argument, so a model-written summary would land unfiled,
 * which is why the note is made here from the answer.
 *
 * The empty answer is the other half: a thread with nothing in it must leave the vault alone and say why,
 * rather than filing an empty note under a name that looks like a summary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import { summarizeFolder } from './folder-summary'

const { createNote, openNote, answer, sent } = vi.hoisted(() => ({
  createNote: vi.fn(async (body: Record<string, unknown>) => ({ id: '01hzzzzzzzzzzzzzzzzzzzzz77', title: body.title, content: body.content })),
  openNote: vi.fn(async () => undefined),
  answer: { current: '# Work\n\nThree threads: hiring, the roadmap, and the Q3 review.' },
  // What the turn was asked with. The store drops the chips once the turn ends, so the request on the
  // wire is the only record of the scope it ran under.
  sent: { scopes: [] as unknown[] },
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  CLIENT_ID: 'test-client',
  api: {
    notes: { create: createNote },
    assistant: {
      // The turn is read back from the server once it ends, so the answer the note is made from is the
      // stored row — the same path the chat surface uses.
      conversation: vi.fn(async () => ({
        conversation: { id: 'c1' },
        messages: [{ id: 'm1', role: 'assistant', content: answer.current, status: 'complete', tools: [], attachments: [], sources: [] }],
        attachments: [],
        streaming: false,
      })),
    },
  },
}))

// The stream is the transport, not the subject: this stands in for a turn that answers and ends.
vi.mock('./stream', () => ({
  streamAssistantTurn: async (input: Record<string, unknown>, apply: (event: Record<string, unknown>) => void) => {
    sent.scopes = (input.scopes as unknown[]) ?? []
    apply({ type: 'start', conversationId: 'c1', assistantMessageId: 'm1' })
    apply({ type: 'text', delta: answer.current })
    apply({ type: 'done' })
  },
}))

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()

beforeEach(async () => {
  await initI18n()
  sent.scopes = []
  useNotes.setState({
    folders: [{ id: 'f1', name: 'Work' } as never],
    notes: {},
    openNote,
  })
})

afterEach(() => {
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  vi.clearAllMocks()
})

describe('summarising a folder', () => {
  it('asks about the folder and files the answer inside it', async () => {
    const id = await summarizeFolder('f1')
    expect(id).toBe('01hzzzzzzzzzzzzzzzzzzzzz77')
    // The thread it ran in is about this folder, which is what lets the note tools read it.
    expect(sent.scopes).toEqual([{ kind: 'folder', id: 'f1', name: 'Work' }])
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({
      title: t('assistant.folder_summary.title', { name: 'Work' }),
      // The thread is named in the note, so the summary can be read against what was actually said.
      content: `${answer.current}\n\n---\n\n![[chat:c1]]`,
      folderId: 'f1',
    }))
    expect(openNote).toHaveBeenCalledWith('01hzzzzzzzzzzzzzzzzzzzzz77')
  })

  it('files nothing when the answer is empty, and says so', async () => {
    answer.current = '   '
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await summarizeFolder('f1')).toBeNull()
    expect(createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.folder_summary.empty', { name: 'Work' }) }))
  })

  it('does nothing for a folder that is gone', async () => {
    expect(await summarizeFolder('nope')).toBeNull()
    expect(createNote).not.toHaveBeenCalled()
  })
})
