// @vitest-environment jsdom
/**
 * The change an answer would make, read before it is made.
 *
 * Two promises are pinned here. The first is that a write-back into a note is previewed: the reader sees
 * the words leaving and the words arriving, and only the press inside that preview edits the note — a
 * cancel leaves it untouched. The second is that the range an answer belongs to is found again by what
 * surrounds it, so a note the reader kept editing while the model was thinking still takes the answer
 * where it was asked for, and a passage that changed underneath the answer is still refused.
 *
 * The diff and the anchoring are pure functions and are called directly wherever the numbers are what
 * matters; the dock is mounted whole for the two things only a mount can prove — that the preview is on
 * screen before anything is written, and that Cancel writes nothing. jsdom has no layout engine, so
 * every assertion below reads structure: which rows exist, which words they carry, what the note holds
 * afterwards. Nothing here claims a pixel, a colour or a measured box.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { AssistantDock } from './AssistantDock'
import { useAssistant } from './assistant-store'
import {
  applyEditorAiResult,
  EDITOR_AI_LABELS,
  editorAiAnchor,
  locateAnchor,
  previewEditorAiWrite,
  resolveWriteTarget,
  useEditorAi,
  type EditorAiRequest,
  type EditorAiWriteMode,
} from './editor-ai'
import { buildWriteDiff, countWords, wordDiff } from './editor-ai-diff'

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  // The note store stamps every local write with this, so a module mock has to answer for it.
  CLIENT_ID: 'test-client',
  api: {
    assistant: {
      skills: vi.fn(async () => ({ skills: [] })),
      settings: vi.fn(async () => ({ settings: null, models: [] })),
      conversations: vi.fn(async () => ({ conversations: [] })),
    },
  },
}))

// jsdom ships no IndexedDB, and every write these tests make is queued for it on a 300ms debounce that
// can fire after the test that made it. The queue is not what is under test here — where the answer
// lands, and whether it lands at all, is — so the two calls that touch the disk answer immediately.
vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>()
  return {
    ...actual,
    localDb: {
      ...actual.localDb,
      setContentBatch: vi.fn(async () => undefined),
      enqueueOutboxBatch: vi.fn(async () => undefined),
    },
  }
})

vi.mock('./ChatView', () => ({
  ChatComposer: () => createElement('button', { type: 'button', 'data-composer': '1' }, 'composer'),
  MessageRow: ({ message }: { message: AssistantMessage }) => createElement('p', { 'data-row': message.id }, message.content),
  UserBubble: ({ text }: { text: string }) => createElement('p', { 'data-live-user': '1' }, text),
}))

const NOTE_ID = 'n1'
const ANSWER_TEXT = 'NEW'

const notesOriginal = useNotes.getState()
const uiOriginal = useUi.getState()
const assistantOriginal = useAssistant.getState()

let root: Root
let host: HTMLElement

function putNote(content: string): void {
  useNotes.setState({
    contents: { ...useNotes.getState().contents, [NOTE_ID]: content },
    notes: { ...useNotes.getState().notes, [NOTE_ID]: { id: NOTE_ID, title: 'A note' } as never },
  })
}

/** A request as the editor makes it: the range, the words it held, and the words around them. */
function rewriteRequest(whole: string, phrase: string): EditorAiRequest {
  const from = whole.indexOf(phrase)
  const to = from + phrase.length
  return {
    noteId: NOTE_ID,
    action: 'rewrite',
    from,
    to,
    source: phrase,
    anchor: editorAiAnchor(whole, from, to),
  }
}

/** The note as it would read if this answer were written back this way. */
function previewAfter(content: string, request: EditorAiRequest, answer: string, mode: EditorAiWriteMode): string {
  const preview = previewEditorAiWrite(content, request, answer, mode)
  return preview.status === 'ok' ? preview.after : content
}

/** The answer row is a turn that has finished, so this is the state the dock shows it in. */
const ANSWER: AssistantMessage = {
  id: 'm1',
  conversationId: 'c1',
  role: 'assistant',
  content: 'the answer',
  reasoning: '',
  tools: [],
  attachments: [],
  status: 'complete',
  error: null,
  source: 'chat',
  usage: null,
  durationMs: 10,
  modelLabel: 'test',
  feedback: undefined,
  sources: [],
  createdAt: 1,
}

function press(label: string): boolean {
  const button = [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)
  if (!button) return false
  act(() => { button.click() })
  return true
}

async function mountDock(): Promise<void> {
  useAssistant.setState({
    ...assistantOriginal,
    loaded: true,
    activeId: 'c1',
    messages: [ANSWER],
    messagesReady: true,
    turn: {
      conversationId: 'c1',
      userText: 'rewrite this',
      attachments: [],
      assistantId: 'm2',
      text: ANSWER_TEXT,
      reasoning: '',
      tools: [],
      stage: undefined,
      error: null,
      done: true,
    },
  })
  await act(async () => { root.render(createElement(AssistantDock)) })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useEditorAi.setState({ request: null })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useNotes.setState(notesOriginal, true)
  useUi.setState(uiOriginal, true)
  useAssistant.setState(assistantOriginal, true)
  useEditorAi.setState({ request: null })
  vi.clearAllMocks()
})

describe('the words a write-back changes', () => {
  it('names exactly the words leaving and the words arriving, with the context kept', () => {
    const diff = buildWriteDiff('The old paragraph is fine', 'The new paragraph is fine')
    const changes = diff.rows.filter((row) => row.kind === 'change')
    expect(changes.length, 'one change, not one per word').toBe(1)
    const change = changes[0]
    expect(change?.kind === 'change' ? change.removed.trim() : '').toBe('old')
    expect(change?.kind === 'change' ? change.added.trim() : '').toBe('new')
    expect(diff.removed).toBe(1)
    expect(diff.added).toBe(1)
    // The words either side are on screen too: a change with no context is not something to read.
    expect(diff.rows.some((row) => row.kind === 'context' && row.text.includes('paragraph'))).toBe(true)
  })

  it('reads a whole paragraph as one change', () => {
    const before = 'We walked down to the harbour and the fog came in off the water.'
    const after = 'The boats stayed tied up all morning while the rain fell sideways.'
    const diff = buildWriteDiff(before, after)
    expect(diff.rows.filter((row) => row.kind === 'change').length).toBeLessThanOrEqual(2)
    expect(diff.removed + diff.added).toBeGreaterThan(10)
    expect(diff.rows.length).toBeLessThanOrEqual(5)
  })

  it('folds an unchanged run rather than drawing all of it', () => {
    const filler = Array.from({ length: 600 }, (_, index) => `word${index}`).join(' ')
    const before = `${filler} TARGET ${filler}`
    const after = `${filler} REPLACED ${filler}`
    const diff = buildWriteDiff(before, after)
    const collapsed = diff.rows.filter((row) => row.kind === 'collapsed')
    expect(collapsed.length, 'the middle of a long note has to be folded').toBeGreaterThan(0)
    const hidden = collapsed.reduce((total, row) => total + (row.kind === 'collapsed' ? row.words : 0), 0)
    expect(hidden).toBeGreaterThan(1_000)
    // A 40k-character note is drawn as a handful of rows, never as a span per word.
    expect(diff.rows.length).toBeLessThan(12)
    expect(diff.rows.length).toBeLessThan(wordDiff(before, after).length)
  })

  it('counts the words a change carries, Chinese included', () => {
    expect(countWords('the quick brown fox')).toBe(4)
    expect(countWords('改写这一段文字')).toBe(7)
    expect(countWords('   \n ')).toBe(0)
  })

  it('says what was folded away when even the changes are too many to show', () => {
    const before = Array.from({ length: 200 }, (_, index) => `a${index}`).join(' ')
    const after = Array.from({ length: 200 }, (_, index) => `b${index}`).join(' ')
    const diff = buildWriteDiff(before, after)
    const truncated = diff.rows.filter((row) => row.kind === 'truncated')
    expect(truncated.length).toBe(1)
    expect(truncated[0]?.kind === 'truncated' ? truncated[0].words : 0).toBeGreaterThan(0)
    expect(diff.rows.length).toBeLessThanOrEqual(48)
  })
})

describe('the place an answer belongs after the note moved', () => {
  const WHOLE = 'Alpha one two three.\n\nThe old paragraph is here.\n\nBeta four five six.'
  const PHRASE = 'The old paragraph is here.'

  it('finds the passage by the words around it', () => {
    expect(locateAnchor('before the words after', 'the ', 'words', ' after')).toBe(11)
    expect(locateAnchor('nothing like it here', 'the ', 'words', ' after')).toBeNull()
  })

  it('refuses to choose between two places that match equally well', () => {
    // Both copies have the same words before them and the same words after, so nothing here says which
    // one the reader had selected — and a guess would write over the other.
    const note = '|x same words y|x same words y|'
    expect(locateAnchor(note, 'x ', 'same words', ' y')).toBeNull()
  })

  it('applies the answer through an edit made somewhere else in the note', () => {
    putNote('Alpha zero, one two three.\n\nThe old paragraph is here.\n\nBeta four five six.')
    useEditorAi.setState({ request: rewriteRequest(WHOLE, PHRASE) })
    expect(applyEditorAiResult('A new paragraph.', 'replace')).toBe(true)
    expect(useNotes.getState().contents[NOTE_ID]).toBe(
      'Alpha zero, one two three.\n\nA new paragraph.\n\nBeta four five six.',
    )
  })

  it('refuses when the passage itself was edited', () => {
    putNote('Alpha one two three.\n\nThe old paragraph WAS here.\n\nBeta four five six.')
    useEditorAi.setState({ request: rewriteRequest(WHOLE, PHRASE) })
    const toast = vi.spyOn(useUi.getState(), 'toast')
    expect(applyEditorAiResult('A new paragraph.', 'replace')).toBe(false)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t('assistant.edit.stale') }))
    expect(useNotes.getState().contents[NOTE_ID]).toBe(
      'Alpha one two three.\n\nThe old paragraph WAS here.\n\nBeta four five six.',
    )
  })

  it('keeps the offsets it was given when nothing around the range moved', () => {
    putNote(WHOLE)
    const request = rewriteRequest(WHOLE, PHRASE)
    expect(resolveWriteTarget(WHOLE, request)).toEqual({ status: 'ok', from: request.from, to: request.to })
  })

  it('places a caret by the words it was sitting between', () => {
    const before = 'first paragraph\n\nsecond paragraph'
    const at = before.length
    const caret: EditorAiRequest = {
      noteId: NOTE_ID,
      action: 'continue',
      from: at,
      to: at,
      source: '',
      anchor: editorAiAnchor(before, at, at),
    }
    // A heading added above the caret moves every offset in the note, and the seam the reader left the
    // caret at is still the end of the words they had written.
    putNote(`A heading\n\n${before}`)
    useEditorAi.setState({ request: caret })
    expect(applyEditorAiResult('a continuation', 'insert')).toBe(true)
    expect(useNotes.getState().contents[NOTE_ID]).toBe(`A heading\n\n${before}\n\na continuation`)
  })

  it('refuses a caret whose seam now matches in more than one place', () => {
    // Two copies of the words the caret was sitting after, and nothing after the caret to tell them
    // apart: which one the reader meant cannot be known, and the wrong one writes over the other.
    expect(locateAnchor('same words and same words', 'same words', '', '')).toBeNull()
  })
})

describe('the preview the reader confirms', () => {
  it('shows the change and writes only on the confirming press', async () => {
    const whole = 'before the old words after'
    putNote(whole)
    useEditorAi.setState({ request: rewriteRequest(whole, 'the old words') })
    await mountDock()
    expect(press(t('assistant.edit.replace')), 'the replace action is missing').toBe(true)
    // On screen, and nothing in the note yet.
    const removed = [...document.body.querySelectorAll('del')].map((node) => node.textContent ?? '')
    const added = [...document.body.querySelectorAll('ins')].map((node) => node.textContent ?? '')
    expect(removed.join('')).toContain('old words')
    expect(added.join('')).toContain(ANSWER_TEXT)
    expect(useNotes.getState().contents[NOTE_ID]).toBe(whole)
    expect(press(t('assistant.edit.apply')), 'the confirm action is missing').toBe(true)
    expect(useNotes.getState().contents[NOTE_ID]).toBe('before NEW after')
    // The row goes with the answer it was about: leaving it would offer to paste it again.
    expect(useEditorAi.getState().request).toBeNull()
  })

  it('writes nothing when the reader cancels', async () => {
    const whole = 'before the old words after'
    putNote(whole)
    useEditorAi.setState({ request: rewriteRequest(whole, 'the old words') })
    await mountDock()
    expect(press(t('assistant.edit.replace'))).toBe(true)
    expect(press(t('common.cancel')), 'the cancel action is missing').toBe(true)
    expect(useNotes.getState().contents[NOTE_ID]).toBe(whole)
    expect(document.querySelector('dialog, [role="dialog"]')).toBeNull()
    // Still offered: the answer is not spent just because the reader looked at it.
    expect(useEditorAi.getState().request).not.toBeNull()
    expect(press(t('assistant.edit.replace'))).toBe(true)
    expect(press(t('assistant.edit.apply'))).toBe(true)
    expect(useNotes.getState().contents[NOTE_ID]).toBe('before NEW after')
  })

  it('names the size of the change in the row, before anything is opened', async () => {
    const whole = 'before the old words after'
    const request = rewriteRequest(whole, 'the old words')
    putNote(whole)
    useEditorAi.setState({ request })
    await mountDock()
    const diff = buildWriteDiff(whole, previewAfter(whole, request, ANSWER_TEXT, 'replace'))
    expect(diff.removed + diff.added, 'rewriting a passage is not a change of nothing').toBeGreaterThan(0)
    const row = document.querySelector(`[role="group"][aria-label="${t('assistant.edit.result')}"]`)
    expect(row, 'the result row is missing').toBeTruthy()
    expect(row?.textContent).toContain(t(EDITOR_AI_LABELS.rewrite))
    expect(row?.textContent).toContain(t('assistant.edit.diff_summary', { removed: diff.removed, added: diff.added }))
  })

  it('says the note changed rather than offering to write into it', async () => {
    putNote('before the NEW words after')
    useEditorAi.setState({ request: rewriteRequest('before the old words after', 'the old words') })
    await mountDock()
    expect(document.body.textContent).toContain(t('assistant.edit.stale'))
    expect([...document.body.querySelectorAll('button')].some((node) => node.textContent?.trim() === t('assistant.edit.replace'))).toBe(false)
    expect(useNotes.getState().contents[NOTE_ID]).toBe('before the NEW words after')
  })

  it('refuses to preview a write into a note that is no longer open', async () => {
    useEditorAi.setState({ request: rewriteRequest('before the old words after', 'the old words') })
    await mountDock()
    expect(document.body.textContent).toContain(t('assistant.edit.note_gone'))
    expect([...document.body.querySelectorAll('button')].some((node) => node.textContent?.trim() === t('assistant.edit.apply'))).toBe(false)
  })
})

describe('the preview stays honest about the answer', () => {
  it('offers nothing to apply when the answer would not change the note', () => {
    const whole = 'before the old words after'
    const request = rewriteRequest(whole, 'the old words')
    const diff = buildWriteDiff(whole, previewAfter(whole, request, 'the old words', 'replace'))
    expect(diff.changed).toBe(false)
    expect(diff.rows.every((row) => row.kind === 'context')).toBe(true)
  })
})
