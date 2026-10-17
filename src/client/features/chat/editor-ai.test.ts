// @vitest-environment jsdom
/**
 * Selection to assistant, and back.
 *
 * The three parts that can go wrong are pinned here: how much of a note a request carries, where an
 * answer lands, and what happens when the note moved while the answer was being written. The last one is
 * the reason this file exists — a replace that trusts stale offsets writes over the reader's paragraph,
 * and nothing about the screen says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'
import type { EditorAiAction } from './editor-ai'
import {
  applyEditorAiResult,
  EDITOR_AI_SOURCE_CAP,
  editorAiAnchor,
  editorAiPrompt,
  editorAiSource,
  runEditorAi,
  useEditorAi,
} from './editor-ai'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  // The note store stamps every local write with this, so a module mock has to answer for it.
  CLIENT_ID: 'test-client',
  api: { assistant: { skills: vi.fn(async () => ({ skills: [] })) } },
}))

const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
const assistantOriginal = useAssistant.getState()

const NOTE_ID = 'n1'

function putNote(content: string): void {
  useNotes.setState({
    contents: { ...useNotes.getState().contents, [NOTE_ID]: content },
    notes: {
      ...useNotes.getState().notes,
      [NOTE_ID]: { id: NOTE_ID, title: 'A note' } as never,
    },
  })
}

/** A request as the editor files it: the range, the words it held, and the words around them. */
function begin(whole: string, action: EditorAiAction, from: number, to: number, source: string): void {
  useEditorAi.setState({
    request: { noteId: NOTE_ID, action, from, to, source, anchor: editorAiAnchor(whole, from, to) },
  })
}

beforeEach(async () => {
  await initI18n()
  useEditorAi.setState({ request: null })
})

afterEach(() => {
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  useAssistant.setState(assistantOriginal, true)
  useEditorAi.setState({ request: null })
  vi.clearAllMocks()
})

describe('the passage a request carries', () => {
  it('is the selection when there is one, and the note when there is not', () => {
    expect(editorAiSource('rewrite', 'a paragraph', 'the whole note')).toBe('a paragraph')
    expect(editorAiSource('rewrite', '  ', 'the whole note')).toBe('the whole note')
  })

  it('keeps the end of a long note for a continuation and the start for everything else', () => {
    const long = 'x'.repeat(EDITOR_AI_SOURCE_CAP) + 'TAIL'
    expect(editorAiSource('continue', '', long).endsWith('TAIL')).toBe(true)
    expect(editorAiSource('summarize', '', long).endsWith('TAIL')).toBe(false)
    expect(editorAiSource('summarize', '', long).length).toBe(EDITOR_AI_SOURCE_CAP)
  })
})

describe('the question', () => {
  it('names the note and carries the passage', () => {
    const prompt = editorAiPrompt('translate', 'bonjour', 'A note')
    expect(prompt).toContain('A note')
    expect(prompt).toContain('bonjour')
  })
})

describe('writing the answer back', () => {
  it('replaces exactly the range that was selected', () => {
    putNote('before the old words after')
    begin('before the old words after', 'rewrite', 7, 20, 'the old words')
    expect(applyEditorAiResult('NEW', 'replace')).toBe(true)
    expect(useNotes.getState().contents[NOTE_ID]).toBe('before NEW after')
  })

  it('refuses when the note moved underneath the answer', () => {
    putNote('the PASSAGE is gone')
    begin('the passage is gone', 'rewrite', 0, 11, 'the passage')
    expect(applyEditorAiResult('NEW', 'replace')).toBe(false)
    expect(useNotes.getState().contents[NOTE_ID]).toBe('the PASSAGE is gone')
  })

  it('inserts below the caret with one blank line between paragraphs', () => {
    putNote('a paragraph')
    begin('a paragraph', 'continue', 11, 11, '')
    expect(applyEditorAiResult('another', 'insert')).toBe(true)
    expect(useNotes.getState().contents[NOTE_ID]).toBe('a paragraph\n\nanother')
  })

  it('does not add a second blank line where one is already there', () => {
    putNote('a paragraph\n\n')
    begin('a paragraph\n\n', 'continue', 13, 13, '')
    expect(applyEditorAiResult('another', 'insert')).toBe(true)
    expect(useNotes.getState().contents[NOTE_ID]).toBe('a paragraph\n\nanother')
  })
})

describe('starting a request from the editor', () => {
  it('quotes the passage into the composer for a question, and sends nothing', () => {
    putNote('a paragraph worth asking about')
    const sent = vi.spyOn(useAssistant.getState(), 'send')
    const started = runEditorAi({
      action: 'ask',
      noteId: NOTE_ID,
      noteTitle: 'A note',
      selection: 'worth asking',
      whole: 'a paragraph worth asking about',
      from: 12,
      to: 24,
    })
    expect(started).toBe(true)
    expect(sent).not.toHaveBeenCalled()
    expect(useAssistant.getState().composerSeed).toBe('> worth asking\n\n')
    expect(useUi.getState().assistantDockOpen).toBe(true)
    // A question about a passage is a question about the note it came from.
    expect(useAssistant.getState().noteContextOn).toBe(true)
    expect(useEditorAi.getState().request).toBeNull()
  })

  it('says why nothing started when the note is empty', () => {
    putNote('   ')
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(runEditorAi({
      action: 'summarize',
      noteId: NOTE_ID,
      noteTitle: 'A note',
      selection: '',
      whole: '   ',
      from: 3,
      to: 3,
    })).toBe(false)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.edit.empty') }))
  })

  it('refuses to start a second turn while one is streaming', () => {
    putNote('a paragraph')
    useAssistant.setState({
      turn: {
        conversationId: null,
        userText: 'earlier',
        attachments: [],
        assistantId: null,
        text: 'half an answer',
        reasoning: '',
        tools: [],
        stage: 'generating',
        error: null,
        done: false,
      },
    })
    expect(runEditorAi({
      action: 'rewrite',
      noteId: NOTE_ID,
      noteTitle: 'A note',
      selection: 'a paragraph',
      whole: 'a paragraph',
      from: 0,
      to: 11,
    })).toBe(false)
    expect(useEditorAi.getState().request).toBeNull()
  })
})
