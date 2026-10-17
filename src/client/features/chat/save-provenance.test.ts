// @vitest-environment jsdom
/**
 * The trail a saved answer keeps.
 *
 * A note made from a reply is a copy of something that was read in a thread, and the thread showed two
 * things the copy used to drop: the pages and notes the answer said it had read, and the files a turn
 * carried. Both are the difference between a note the reader can check and a claim they have to take on
 * faith, so both are pinned here — one saved reply, one whole conversation, and an attachments-only
 * thread that must not become an empty note.
 *
 * The other half is the channel the notebook's own commands answer through: busy, failed and empty used
 * to arrive as the same `null`, which left each caller guessing what to tell the reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantConversation, AssistantMessage, ChatAttachment } from '@shared/assistant'
import { api } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { sendForAnswerDetailed } from './editor-ai'
import { askAboutNote } from './note-ai'
import { saveConversationAsNote, saveReplyAsNote } from './save-to-note'

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz01'
const CONVERSATION_ID = '01hzzzzzzzzzzzzzzzzzzzzz02'

vi.mock('./editor-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./editor-ai')>()
  return { ...actual, sendForAnswerDetailed: vi.fn(async () => ({ status: 'empty' }) as const) }
})

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
const createNote = vi.fn(async (_input: Record<string, unknown>): Promise<string | null> => NOTE_ID)

function message(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: over.id ?? 'm1',
    conversationId: CONVERSATION_ID,
    role: over.role ?? 'assistant',
    content: over.content ?? '',
    tools: [],
    status: 'complete',
    error: null,
    createdAt: Date.UTC(2026, 9, 17, 8, 0),
    source: 'chat',
    ...over,
  }
}

function attachment(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: over.id ?? 'a1',
    kind: over.kind ?? 'file',
    filename: over.filename ?? 'spec.pdf',
    mime: 'application/pdf',
    size: 1024,
    key: 'chat/files/u1/a1',
    createdAt: 1,
    ...over,
  }
}

function detail(messages: AssistantMessage[], attachments: ChatAttachment[] = [], title = 'Trip photos') {
  const conversation: AssistantConversation = {
    id: CONVERSATION_ID,
    title,
    pinned: false,
    starred: false,
    archived: false,
    ephemeral: false,
    folderId: null,
    createdAt: 0,
    updatedAt: 0,
    messageCount: messages.length,
  }
  return { conversation, messages, attachments, streaming: false }
}

function savedContent(): string {
  const input = createNote.mock.calls.at(-1)?.[0] as unknown as { content: string }
  return input.content
}

beforeEach(async () => {
  await initI18n()
  createNote.mockClear()
  createNote.mockResolvedValue(NOTE_ID)
  useNotes.setState({ createNote: createNote as never, folders: [] })
  useAssistant.setState({ activeId: CONVERSATION_ID, messages: [] })
})

afterEach(() => {
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  vi.restoreAllMocks()
})

describe('a saved reply and what it cited', () => {
  it('carries the source list its bubble was showing', async () => {
    useAssistant.setState({
      messages: [message({
        role: 'assistant',
        content: 'We ship on Friday.',
        sources: [
          { url: 'https://example.com/a', title: 'A page', cited: 'the hiring paragraph' },
          { url: '/n/n1', title: 'Quarterly plan', kind: 'note', id: 'n1' },
        ],
      })],
    })
    expect(await saveReplyAsNote('We ship on Friday.')).toBe(NOTE_ID)
    const content = savedContent()
    expect(content).toContain(t('assistant.chat.sources'))
    expect(content).toContain('[A page](https://example.com/a)')
    expect(content).toContain('[[Quarterly plan]]')
    expect(content).toContain('the hiring paragraph')
    // The pointer back at the thread is still the last thing in the note.
    expect(content.endsWith(`![[chat:${CONVERSATION_ID}]]`)).toBe(true)
  })

  it('says nothing about sources for words no stored row answers for', async () => {
    useAssistant.setState({
      messages: [message({ content: 'We ship on Friday.', sources: [{ url: 'https://example.com/a', title: 'A page' }] })],
    })
    await saveReplyAsNote('We ship on Monday, then.')
    expect(savedContent()).not.toContain(t('assistant.chat.sources'))
  })

  it('leaves an uncited answer exactly as worded, without an empty list', async () => {
    useAssistant.setState({ messages: [message({ content: 'We ship on Friday.' })] })
    await saveReplyAsNote('We ship on Friday.')
    expect(savedContent()).toBe(`We ship on Friday.\n\n---\n\n![[chat:${CONVERSATION_ID}]]`)
  })

  it('carries the same list for a whole conversation, under the answer that cited it', async () => {
    vi.spyOn(api.assistant, 'conversation').mockResolvedValue(detail([
      message({ id: 'm0', role: 'user', content: 'What did we decide?' }),
      message({ id: 'm1', content: 'We ship on Friday.', sources: [{ url: '/n/n1', title: 'Quarterly plan', kind: 'note', id: 'n1' }] }),
    ]) as never)
    expect(await saveConversationAsNote(CONVERSATION_ID)).toBe(NOTE_ID)
    const content = savedContent()
    expect(content).toContain('We ship on Friday.')
    expect(content).toContain(`${t('assistant.chat.sources')}:\n1. [[Quarterly plan]]`)
  })
})

describe('a conversation whose turns are files rather than words', () => {  it('names the files it carried instead of saving an empty note', async () => {
    vi.spyOn(api.assistant, 'conversation').mockResolvedValue(detail(
      [
        message({ id: 'm0', role: 'user', content: '', attachments: ['a1', 'a2'] }),
        message({ id: 'm1', role: 'assistant', content: '', attachments: ['a1'] }),
      ],
      [attachment({ id: 'a1', filename: 'diagram.png', kind: 'image', mime: 'image/png' }), attachment({ id: 'a2', filename: 'spec [v2].pdf' })],
    ) as never)
    const toast = vi.spyOn(useUi.getState(), 'toast')

    expect(await saveConversationAsNote(CONVERSATION_ID)).toBe(NOTE_ID)
    const content = savedContent()
    expect(content).toContain(t('assistant.chat.attachments'))
    expect(content).toContain('diagram.png')
    // A picture is embedded, anything else is linked — the same split the bubble makes.
    expect(content).toContain('![diagram.png](/api/assistant/files/a1)')
    expect(content).toContain('[spec v2.pdf](/api/assistant/files/a2)')
    expect(content.endsWith(`![[chat:${CONVERSATION_ID}]]`)).toBe(true)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }))
  })

  it('still refuses a thread with neither words nor files in it', async () => {
    vi.spyOn(api.assistant, 'conversation').mockResolvedValue(detail([message({ id: 'm1', content: '   ' })]) as never)
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await saveConversationAsNote(CONVERSATION_ID)).toBeNull()
    expect(createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.note.conversation_empty') }))
  })

  it('writes no file list when a turn has an id the thread cannot describe', async () => {
    vi.spyOn(api.assistant, 'conversation').mockResolvedValue(detail(
      [message({ id: 'm1', role: 'user', content: 'Look at this', attachments: ['gone'] })],
      [],
    ) as never)
    expect(await saveConversationAsNote(CONVERSATION_ID)).toBe(NOTE_ID)
    expect(savedContent()).toContain(t('assistant.attach.unavailable'))
  })
})

describe('the channel a note command answers through', () => {
  const detailed = sendForAnswerDetailed as unknown as ReturnType<typeof vi.fn>

  function idleAssistant() {
    const setNoteContext = vi.fn()
    // The note is already on screen, so the channel is not also asked to open it.
    useUi.setState({ activeNoteId: NOTE_ID })
    useAssistant.setState({ turn: null, activeId: CONVERSATION_ID, setNoteContext: setNoteContext as never })
    return setNoteContext
  }

  it('refuses to start a second question while an answer is being written, without sending', async () => {
    useAssistant.setState({ turn: { done: false, error: null, text: '' } as never })
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await askAboutNote(NOTE_ID, 'summarise this')).toEqual({ status: 'busy' })
    expect(detailed).not.toHaveBeenCalled()
    // The reason belongs to whoever asked; the transport saying it too is how one state got two messages.
    expect(toast).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'ok', text: 'an answer' } as const,
    { status: 'failed', error: 'upstream refused' } as const,
    { status: 'empty' } as const,
  ])('hands the caller a $status answer as that state, after putting the note in context', async (result) => {
    const setNoteContext = idleAssistant()
    detailed.mockResolvedValueOnce(result)
    expect(await askAboutNote(NOTE_ID, 'summarise this')).toEqual(result)
    expect(detailed).toHaveBeenCalledWith('summarise this')
    expect(setNoteContext).toHaveBeenCalledWith(true)
  })
})
