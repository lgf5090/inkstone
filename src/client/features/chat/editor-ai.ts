/**
 * A passage of a note, and what the reader wants done with it.
 *
 * The editor's AI entries are one act with three parts: the text that was selected, the question the
 * assistant is asked about it, and the place the answer goes back to. All three have to survive the
 * round trip through the conversation — which takes seconds and leaves the editor entirely — so the
 * range is kept here rather than in a closure that would die with the menu.
 *
 * The range is stored as offsets, and offsets are only true of the document they were taken from. Rather
 * than trust them, the request carries the text they held: applying the answer refuses when the passage
 * no longer says what it said, because a silently shifted replace writes the model's paragraph over the
 * reader's. What comes back is a note that changed while they were waiting — a real thing they can see —
 * instead of a corrupted one they cannot.
 */
import { create } from 'zustand'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'

export type EditorAiAction = 'ask' | 'rewrite' | 'summarize' | 'continue' | 'translate'

export interface EditorAiRequest {
  noteId: string
  action: EditorAiAction
  /** The range the answer replaces. `from === to` means "nothing was selected, put it at the caret". */
  from: number
  to: number
  /** What that range said when the request was made. */
  source: string
}

interface EditorAiState {
  request: EditorAiRequest | null
  begin: (request: EditorAiRequest) => void
  clear: () => void
}

export const useEditorAi = create<EditorAiState>((set) => ({
  request: null,
  begin: (request) => set({ request }),
  clear: () => set({ request: null }),
}))

/**
 * How much of the note a single request may carry.
 *
 * The composer refuses messages past 16k characters, and the prompt is not the only thing in the
 * message — so an excerpt of 8k leaves room for the instructions and for the reader to add a word of
 * their own. A selection is nearly always far shorter; this is the ceiling for "the whole note".
 */
export const EDITOR_AI_SOURCE_CAP = 8_000

/** What each action is called in the menu and in the result row. */
export const EDITOR_AI_LABELS: Record<EditorAiAction, MessageKey> = {
  ask: 'assistant.edit.ask',
  rewrite: 'assistant.edit.rewrite',
  summarize: 'assistant.edit.summarize',
  continue: 'assistant.edit.continue',
  translate: 'assistant.edit.translate',
}

const PROMPT_KEYS: Record<Exclude<EditorAiAction, 'ask'>, MessageKey> = {
  rewrite: 'assistant.edit.prompt_rewrite',
  summarize: 'assistant.edit.prompt_summarize',
  continue: 'assistant.edit.prompt_continue',
  translate: 'assistant.edit.prompt_translate',
}

/**
 * The passage a request carries: the selection, or the note itself when nothing was selected.
 *
 * A continuation reads the end of the passage and everything else reads the beginning, because that is
 * the half each of them needs: "continue from where this stops" is a question about the last paragraph,
 * and a summary of an eight-thousand-character note is a summary of its opening.
 */
export function editorAiSource(action: EditorAiAction, selection: string, whole: string): string {
  const text = selection.trim() ? selection : whole
  if (text.length <= EDITOR_AI_SOURCE_CAP) return text
  return action === 'continue' ? text.slice(-EDITOR_AI_SOURCE_CAP) : text.slice(0, EDITOR_AI_SOURCE_CAP)
}

/** The question the assistant is asked about the passage. `ask` has no question — the reader writes it. */
export function editorAiPrompt(
  action: Exclude<EditorAiAction, 'ask'>,
  source: string,
  noteTitle: string,
): string {
  return t(PROMPT_KEYS[action], { text: source, title: noteTitle || t('common.untitled_note') })
}

/**
 * Put a block of text into a document at an offset, keeping the note's own spacing.
 *
 * One blank line between paragraphs, and none where the text already sits against a blank line or
 * the edge of the document. Shared with everything else that writes an answer into a note, because
 * two spacing rules would be two ways for the same paragraph to land.
 */
export function insertBlockAt(content: string, at: number, body: string): string {
  const before = content.slice(0, at)
  const after = content.slice(at)
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const trail = after === '' || after.startsWith('\n') ? '' : '\n\n'
  return `${before}${lead}${body}${trail}${after}`
}

/**
 * Write an answer back into the note the request came from.
 *
 * The write goes through the note store rather than through the editor's view: the reader may have moved
 * to another note while the answer was being written, and the paragraph still belongs where they selected
 * it. The store is what the editor re-renders from, so the change lands in the document — and as one
 * transaction, which is what makes it one press of undo.
 *
 * Returns whether the note took the text, so the caller can keep the request open when it did not.
 */
export function applyEditorAiResult(text: string, mode: 'replace' | 'insert'): boolean {
  const request = useEditorAi.getState().request
  if (!request) return false
  const state = useNotes.getState()
  const content = state.contents[request.noteId]
  const toast = useUi.getState().toast
  if (content === undefined) {
    toast({ title: t('assistant.edit.note_gone'), tone: 'danger' })
    return false
  }
  if (content.slice(request.from, request.to) !== request.source) {
    toast({ title: t('assistant.edit.stale'), tone: 'warning' })
    return false
  }
  const body = text.trim()
  if (!body) return false
  if (mode === 'replace') {
    state.editContent(request.noteId, `${content.slice(0, request.from)}${body}${content.slice(request.to)}`)
    return true
  }
  state.editContent(request.noteId, insertBlockAt(content, request.to, body))
  return true
}

/**
 * The answer the assistant last finished, which is what the result row offers to keep.
 *
 * A turn that has finished but has not been adopted into the thread yet is still the newest answer, so
 * it is read first; the stored rows answer the case where the reader has since opened another
 * conversation and the live turn is gone.
 */
export function lastAnswerText(): string {
  const state = useAssistant.getState()
  if (state.turn && state.turn.done && state.turn.text.trim()) return state.turn.text
  const last = state.messages.at(-1)
  return last && last.role === 'assistant' ? last.content : ''
}

/** How much of a selection rides in the composer as a quote, which the reader then asks about. */
const QUOTE_CAP = 2_000

export interface EditorAiInput {
  action: EditorAiAction
  noteId: string
  noteTitle: string
  /** The selected text, empty when the caret is a caret. */
  selection: string
  /** The whole document, which is what an unselected request is about. */
  whole: string
  from: number
  to: number
}

/**
 * Ask, or ask-and-replace, from the editor.
 *
 * `ask` only puts the passage in the composer: the reader's own question is the half of the request the
 * editor cannot write for them, and a menu entry that sent something they did not read would be a
 * surprise in a box they own. The four actions that do send are the ones whose question is entirely
 * "this passage, rewritten/summarised/continued/translated" — the passage is the question.
 *
 * Returns whether anything was started, so the caller can leave the menu closed either way and the
 * reader gets a reason when nothing happened.
 */
export function runEditorAi(input: EditorAiInput): boolean {
  const { action, noteId, noteTitle, selection, whole, from, to } = input
  const source = editorAiSource(action, selection, whole)
  const toast = useUi.getState().toast
  if (!source.trim()) {
    toast({ title: t('assistant.edit.empty'), tone: 'warning' })
    return false
  }
  useAssistant.getState().setNoteContext(true)
  useUi.getState().setAssistantDock(true)
  if (action === 'ask') {
    useAssistant.getState().seedComposer(quotePassage(selection.trim() ? selection : source))
    return true
  }
  const turn = useAssistant.getState().turn
  if (turn && !turn.done) {
    // The store refuses a second turn while one is streaming, and a refusal the reader cannot see would
    // look like the menu having done nothing at all.
    toast({ title: t('assistant.edit.busy'), tone: 'warning' })
    return false
  }
  useEditorAi.getState().begin({ noteId, action, from, to, source: selection })
  void useAssistant.getState().send(editorAiPrompt(action, source, noteTitle))
  return true
}

/** A passage as a Markdown block quote, which is how a question about it stays a question about it. */
function quotePassage(text: string): string {
  const body = text.length > QUOTE_CAP ? `${text.slice(0, QUOTE_CAP)}…` : text
  const quoted = body.split('\n').map((line) => `> ${line}`).join('\n')
  return `${quoted}\n\n`
}


