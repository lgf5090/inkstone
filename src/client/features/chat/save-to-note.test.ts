// @vitest-environment jsdom
/**
 * Keeping a reply, or a whole conversation.
 *
 * The contract these cases pin is the round trip: a note made from a conversation says which thread it
 * came from, the whole thread comes out as one note with the questions still in it, and an answer can be
 * written into the note already open — at the caret when the editor is showing it, at the end otherwise.
 * A saved note that cannot name its thread is a paragraph with no way back, which is the gap this file
 * exists to keep closed.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantConversation, AssistantMessage } from '@shared/assistant'
import { api } from '../../lib/api'
import { setActiveEditorView } from '../../editor/commands'
import { initI18n, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import {
  conversationNoteTitle,
  conversationSourceBlock,
  insertReplyIntoNote,
  noteBodyFromTranscript,
  saveConversationAsNote,
  saveReplyAsNote,
  withConversationSource,
} from './save-to-note'

const NOTE_ID = '01hzzzzzzzzzzzzzzzzzzzzz01'
const CONVERSATION_ID = '01hzzzzzzzzzzzzzzzzzzzzz02'

// jsdom has no Range.getClientRects, which CodeMirror's measurement needs once a view is attached.
{
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList }
  if (!proto.getClientRects) proto.getClientRects = () => [] as unknown as DOMRectList
}

const assistantOriginal = useAssistant.getState()
const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
const createNote = vi.fn(async (_input: Record<string, unknown>): Promise<string | null> => NOTE_ID)
const editContent = vi.fn()

function message(role: AssistantMessage['role'], content: string): AssistantMessage {
  return {
    id: 'm-' + content.slice(0, 6),
    conversationId: CONVERSATION_ID,
    role,
    content,
    tools: [],
    status: 'complete',
    error: null,
    createdAt: Date.UTC(2026, 9, 17, 8, 0),
    source: 'chat',
  }
}

function detail(messages: AssistantMessage[], folderId: string | null = null) {
  const conversation: AssistantConversation = {
    id: CONVERSATION_ID,
    title: 'Hiring plan',
    pinned: false,
    starred: false,
    archived: false,
    ephemeral: false,
    folderId,
    createdAt: 0,
    updatedAt: 0,
    messageCount: messages.length,
  }
  return { conversation, messages, attachments: [], streaming: false }
}

function mountEditor(doc: string, cursor: number): EditorView {
  const host = document.createElement('div')
  document.body.append(host)
  const view = new EditorView({
    state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor) }),
    parent: host,
  })
  setActiveEditorView(view)
  return view
}

beforeEach(async () => {
  await initI18n()
  createNote.mockClear()
  createNote.mockResolvedValue(NOTE_ID)
  editContent.mockClear()
  useNotes.setState({
    createNote: createNote as never,
    editContent: editContent as never,
    notes: { [NOTE_ID]: { id: NOTE_ID, title: 'Open note' } as never },
    contents: { [NOTE_ID]: 'Intro\n\nSecond' },
    folders: [{ id: 'f1', name: 'Work' } as never],
  })
})

afterEach(() => {
  setActiveEditorView(null)
  document.body.replaceChildren()
  useAssistant.setState(assistantOriginal, true)
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  vi.restoreAllMocks()
})

describe('the pointer a saved note keeps', () => {
  it('is an embed of the conversation, and nothing for an id that is not one', () => {
    expect(conversationSourceBlock(CONVERSATION_ID)).toBe(`---\n\n![[chat:${CONVERSATION_ID}]]`)
    expect(conversationSourceBlock(null)).toBe('')
    expect(conversationSourceBlock('')).toBe('')
    expect(conversationSourceBlock('not a conversation id!')).toBe('')
  })

  it('is appended once and leaves a body that already names the thread alone', () => {
    expect(withConversationSource('Answer', CONVERSATION_ID)).toBe(`Answer\n\n---\n\n![[chat:${CONVERSATION_ID}]]`)
    const named = `Answer\n\n![[chat:${CONVERSATION_ID}]]`
    expect(withConversationSource(named, CONVERSATION_ID)).toBe(named)
    expect(withConversationSource('Answer  \n', null)).toBe('Answer  \n')
  })
})

describe('a transcript written into a note', () => {
  it('drops the title heading the downloaded file opens with, because the note has that title', () => {
    expect(noteBodyFromTranscript('# Hiring plan\n\n**You** · 08:00\n\nhi\n')).toBe('**You** · 08:00\n\nhi')
    expect(noteBodyFromTranscript('no heading here')).toBe('no heading here')
  })

  it('names an untitled thread after its opening question, and falls back when there is none', () => {
    const question = message('user', 'What did we decide about the roadmap?')
    expect(conversationNoteTitle('Hiring plan', [question])).toBe('Hiring plan')
    expect(conversationNoteTitle('  ', [question])).toBe('What did we decide about the roadmap?')
    expect(conversationNoteTitle('', [])).toBe(t('assistant.note.conversation_untitled'))
  })
})

describe('saving one reply', () => {
  it('points the note back at the conversation it was said in', async () => {
    useAssistant.setState({ activeId: CONVERSATION_ID })
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await saveReplyAsNote('# Decision\n\nWe ship on Friday.')).toBe(NOTE_ID)
    expect(createNote).toHaveBeenCalledWith({
      title: 'Decision',
      content: `# Decision\n\nWe ship on Friday.\n\n---\n\n![[chat:${CONVERSATION_ID}]]`,
      open: false,
    })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }))
  })

  it('saves the words on their own when there is no conversation to point at', async () => {
    useAssistant.setState({ activeId: null })
    await saveReplyAsNote('A bare answer')
    expect(createNote).toHaveBeenCalledWith({ title: 'A bare answer', content: 'A bare answer', open: false })
  })

  it('says so when the note could not be created', async () => {
    createNote.mockResolvedValueOnce(null)
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await saveReplyAsNote('Answer')).toBeNull()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }))
  })
})

describe('saving a whole conversation', () => {
  it('keeps every turn, points back at the thread and files the note where the thread is filed', async () => {
    const messages = [message('user', 'What did we decide?'), message('assistant', 'We ship on Friday.')]
    vi.spyOn(api.assistant, 'conversation').mockResolvedValue(detail(messages, 'f1') as never)
    const toast = vi.spyOn(useUi.getState(), 'toast')

    expect(await saveConversationAsNote(CONVERSATION_ID)).toBe(NOTE_ID)
    const saved = createNote.mock.calls.at(-1)?.[0] as unknown as { title: string, content: string, folderId?: string | null }
    expect(saved.title).toBe('Hiring plan')
    expect(saved.folderId).toBe('f1')
    expect(saved.content).toContain('What did we decide?')
    expect(saved.content).toContain('We ship on Friday.')
    expect(saved.content.endsWith(`![[chat:${CONVERSATION_ID}]]`)).toBe(true)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }))
  })

  it('leaves the note unfiled when the thread is unfiled', async () => {
    vi.spyOn(api.assistant, 'conversation').mockResolvedValue(detail([message('user', 'Hi')]) as never)
    await saveConversationAsNote(CONVERSATION_ID)
    const saved = createNote.mock.calls.at(-1)?.[0] as unknown as { folderId?: string | null }
    expect(saved).not.toHaveProperty('folderId')
  })

  it('writes nothing when the thread has no words in it, and says why', async () => {
    vi.spyOn(api.assistant, 'conversation').mockResolvedValue(detail([message('assistant', '   ')]) as never)
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await saveConversationAsNote(CONVERSATION_ID)).toBeNull()
    expect(createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.note.conversation_empty') }))
  })

  it('says so when the thread cannot be read', async () => {
    vi.spyOn(api.assistant, 'conversation').mockRejectedValue(new Error('offline'))
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(await saveConversationAsNote(CONVERSATION_ID)).toBeNull()
    expect(createNote).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.note.conversation_failed') }))
  })
})

describe('writing an answer into the open note', () => {
  it('lands at the caret of the editor showing that note, with the note spacing kept', () => {
    useUi.setState({ activeNoteId: NOTE_ID })
    const view = mountEditor('Intro\n\nSecond', 5)
    expect(insertReplyIntoNote('Answer')).toBe(true)
    expect(view.state.doc.toString()).toBe('Intro\n\nAnswer\n\nSecond')
    expect(view.state.selection.main.head).toBe('Intro\n\nAnswer'.length)
    expect(editContent).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.at(-1)?.tone).toBe('success')
  })

  it('goes to the end of the note when no editor is showing it', () => {
    useUi.setState({ activeNoteId: NOTE_ID })
    expect(insertReplyIntoNote('Answer')).toBe(true)
    expect(editContent).toHaveBeenCalledWith(NOTE_ID, 'Intro\n\nSecond\n\nAnswer')
  })

  it('ignores an editor that is no longer on screen', () => {
    useUi.setState({ activeNoteId: NOTE_ID })
    const view = mountEditor('Intro\n\nSecond', 0)
    view.destroy()
    expect(insertReplyIntoNote('Answer')).toBe(true)
    expect(editContent).toHaveBeenCalledWith(NOTE_ID, 'Intro\n\nSecond\n\nAnswer')
  })

  it('never writes at an offset taken from a different document', () => {
    useUi.setState({ activeNoteId: NOTE_ID })
    mountEditor('Some other note', 0)
    expect(insertReplyIntoNote('Answer')).toBe(true)
    expect(editContent).toHaveBeenCalledWith(NOTE_ID, 'Intro\n\nSecond\n\nAnswer')
  })

  it('says what is missing when there is no note open, or the note is gone', () => {
    useUi.setState({ activeNoteId: null })
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(insertReplyIntoNote('Answer')).toBe(false)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.note.insert_no_note') }))

    useUi.setState({ activeNoteId: '01hzzzzzzzzzzzzzzzzzzzzz99' })
    expect(insertReplyIntoNote('Answer')).toBe(false)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.edit.note_gone') }))
  })

  it('does nothing with an empty answer', () => {
    useUi.setState({ activeNoteId: NOTE_ID })
    expect(insertReplyIntoNote('   ')).toBe(false)
    expect(editContent).not.toHaveBeenCalled()
  })
})
