/**
 * A passage of a note, and what the reader wants done with it.
 *
 * The editor's AI entries are one act with three parts: the text that was selected, the question the
 * assistant is asked about it, and the place the answer goes back to. All three have to survive the
 * round trip through the conversation — which takes seconds and leaves the editor entirely — so the
 * range is kept here rather than in a closure that would die with the menu.
 *
 * A range is a pair of offsets, and offsets are only true of the document they were taken from. So the
 * request carries what surrounded the passage as well: the answer is applied where those words say the
 * passage still is, which lets an unrelated edit elsewhere in the note happen while the model is
 * thinking. What it cannot do is guess. When the passage itself moved, changed or now sits in two
 * equally-matching places, the write refuses and says the note changed — because a replace that lands a
 * paragraph off by one word overwrites something the reader wrote, and nothing on screen would say so.
 */
import { create } from 'zustand'
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'

export type EditorAiAction = 'ask' | 'rewrite' | 'summarize' | 'continue' | 'translate' | 'outline' | 'todo'

/** The words either side of a selection, kept so the range can be found again after the note moved. */
export interface EditorAiAnchor {
  lead: string
  trail: string
}

export interface EditorAiRequest {
  noteId: string
  action: EditorAiAction
  /** The range the answer replaces. `from === to` means "nothing was selected, put it at the caret". */
  from: number
  to: number
  /** What that range said when the request was made. */
  source: string
  anchor: EditorAiAnchor
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
  outline: 'assistant.edit.outline',
  todo: 'assistant.edit.todo',
}

const PROMPT_KEYS: Record<Exclude<EditorAiAction, 'ask'>, MessageKey> = {
  rewrite: 'assistant.edit.prompt_rewrite',
  summarize: 'assistant.edit.prompt_summarize',
  continue: 'assistant.edit.prompt_continue',
  translate: 'assistant.edit.prompt_translate',
  outline: 'assistant.edit.prompt_outline',
  todo: 'assistant.edit.prompt_todo',
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
 * How much of the note either side of a selection rides in the request.
 *
 * Long enough to place the passage again in a note the reader kept typing in, short enough that a
 * request stays a request rather than a second copy of the note.
 */
export const EDITOR_AI_ANCHOR_CONTEXT = 200

/** The ceiling on places one anchor text turns up, so a repeated fragment cannot be walked over and over. */
const ANCHOR_CANDIDATES = 64

/** What surrounded the range when it was read, in the words needed to find it again later. */
export function editorAiAnchor(whole: string, from: number, to: number): EditorAiAnchor {
  return {
    lead: whole.slice(Math.max(0, from - EDITOR_AI_ANCHOR_CONTEXT), from),
    trail: whole.slice(to, to + EDITOR_AI_ANCHOR_CONTEXT),
  }
}

/** Where an answer goes in the note as it stands now, or `stale` when the range cannot be found. */
export type EditorAiTarget = { status: 'ok'; from: number; to: number } | { status: 'stale' }

/**
 * The offset a passage starts at, found by what sits around it.
 *
 * The readings are tried in order of how much they say. The passage together with the words on either
 * side of it is the strongest claim, and one match is enough. Weaker but still decisive: the passage on
 * its own, found in exactly one place — the note around it may have been edited, but those words are
 * still only said once. Anything else is refused, because a second place that fits as well as the first
 * is a guess, and a guessed replace writes the model's paragraph over a reader's.
 *
 * A caret is a passage of no length at all, so its anchor is the seam: first the words either side of it
 * together, then the words it was sitting after, then the words it was sitting before. A caret read at the
 * start of an empty note has none of those, and that one belongs only in an empty document.
 */
export function locateAnchor(content: string, lead: string, body: string, trail: string): number | null {
  const withContext = occurrences(content, `${lead}${body}${trail}`).map((at) => at + lead.length)
  if (withContext.length === 1) return withContext[0]!
  if (body) {
    const only = occurrences(content, body)
    return only.length === 1 ? only[0]! : null
  }
  const afterLead = occurrences(content, lead)
  if (afterLead.length === 1) return afterLead[0]! + lead.length
  const beforeTrail = occurrences(content, trail)
  return beforeTrail.length === 1 ? beforeTrail[0]! : null
}

/** Every offset a text starts at, capped so a passage repeated through a long note is refused rather than walked. */
function occurrences(content: string, needle: string): number[] {
  const found: number[] = []
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + 1)) {
    found.push(at)
    if (found.length >= ANCHOR_CANDIDATES) break
  }
  return found
}

/**
 * Where this request's answer belongs in the note as it is now.
 *
 * Two readings. First the offsets themselves: if the passage is still where it was put down and the words
 * on either side of it are still those words, nothing that mattered has moved and the range is used as
 * given. Otherwise the anchor goes looking, which is what lets an edit made in another part of the note
 * land without losing the answer waiting for it. Both readings end the same way when they fail: `stale`.
 */
export function resolveWriteTarget(content: string, request: EditorAiRequest): EditorAiTarget {
  const { lead, trail } = request.anchor
  const exact = content.slice(request.from, request.to) === request.source
    && content.slice(request.from - lead.length, request.from) === lead
    && content.startsWith(trail, request.to)
  if (exact) return { status: 'ok', from: request.from, to: request.to }
  const at = locateAnchor(content, lead, request.source, trail)
  return at === null ? { status: 'stale' } : { status: 'ok', from: at, to: at + request.source.length }
}

/** What one write-back would do to the note: the text as it stands, and as it would come out. */
export type EditorAiPreview =
  | { status: 'stale' }
  | { status: 'ok'; before: string; after: string }

export type EditorAiWriteMode = 'replace' | 'insert'

/** How the note would read with this answer written into it at this place, one way or the other. */
export function writeEditorAiContent(content: string, target: { from: number; to: number }, mode: EditorAiWriteMode, body: string): string {
  return mode === 'replace'
    ? `${content.slice(0, target.from)}${body}${content.slice(target.to)}`
    : insertBlockAt(content, target.to, body)
}

/**
 * The change the reader is being asked to confirm.
 *
 * Read from the note store rather than from the editor's view because the note on screen may not be the
 * note the request was made in, and because the answer has to be shown against the document it would
 * actually land in. Nothing here writes: it is the same {@link resolveWriteTarget} the commit uses, run
 * one keystroke earlier.
 */
export function previewEditorAiWrite(content: string, request: EditorAiRequest, answer: string, mode: EditorAiWriteMode): EditorAiPreview {
  const target = resolveWriteTarget(content, request)
  if (target.status === 'stale') return { status: 'stale' }
  const body = answer.trim()
  if (!body) return { status: 'ok', before: content, after: content }
  return { status: 'ok', before: content, after: writeEditorAiContent(content, target, mode, body) }
}

/**
 * Write an answer back into the note the request came from.
 *
 * The write goes through the note store rather than through the editor's view: the reader may have moved
 * to another note while the answer was being written, and the paragraph still belongs where they selected
 * it. The store is what the editor re-renders from, so the change lands in the document — and as one
 * transaction, which is what makes it one press of undo.
 *
 * The range is resolved again here rather than trusted from the preview: the note can move between the
 * two, and a change made while the dialog was open is exactly the change this refuses.
 *
 * Returns whether the note took the text, so the caller can keep the request open when it did not.
 */
export function applyEditorAiResult(text: string, mode: EditorAiWriteMode): boolean {
  const request = useEditorAi.getState().request
  if (!request) return false
  const state = useNotes.getState()
  const content = state.contents[request.noteId]
  const toast = useUi.getState().toast
  if (content === undefined) {
    toast({ title: t('assistant.edit.note_gone'), tone: 'danger' })
    return false
  }
  const target = resolveWriteTarget(content, request)
  if (target.status === 'stale') {
    toast({ title: t('assistant.edit.stale'), tone: 'warning' })
    return false
  }
  const body = text.trim()
  if (!body) return false
  state.editContent(request.noteId, writeEditorAiContent(content, target, mode, body))
  return true
}

/**
 * The answer the assistant last finished, which is what the result row offers to keep.
 *
 * A turn that has finished but has not been adopted into the thread yet is still the newest answer, so
 * it is read first; the stored rows answer the case where the reader has since opened another
 * conversation and the live turn is gone.
 *
 * Read-only on purpose, and only for a surface that shows what is on the screen. Anything that *writes*
 * an answer out uses `sendForAnswer`: the newest answer here is not necessarily the one it asked for.
 */
export function lastAnswerText(): string {
  const state = useAssistant.getState()
  if (state.turn && state.turn.done && state.turn.text.trim()) return state.turn.text
  const last = state.messages.at(-1)
  return last && last.role === 'assistant' ? last.content : ''
}

/** The fields of a live turn this reads. `assistant-store` keeps its own turn record to itself. */
interface TurnAnswer {
  token?: number
  assistantId: string | null
  text: string
  error: string | null
  done: boolean
}

/**
 * What one send produced, named as the state that actually happened.
 *
 * `null` for everything that is not an answer is what made callers guess: a turn already in flight, a run
 * the worker never took, and a reply with no words in it are three different things to say to the reader,
 * and a message about "nothing coming back" while the assistant is still writing is a lie about the state
 * they are in. `failed` carries what the turn reported when it reported anything.
 */
export type AnswerResult =
  | { status: 'ok', text: string }
  | { status: 'busy' }
  | { status: 'failed', error: string | null }
  | { status: 'empty' }

/**
 * Send one prompt, and hand back the answer *that send* wrote — or the reason it did not.
 *
 * `lastAnswerText` reads the newest answer on the screen, which is the wrong thing for a command that
 * files an answer under a title of its own. When the store refuses the send because a turn is already
 * streaming, when the worker never takes the request, or when the reader stops it, the newest answer is
 * the one from whatever thread was already open — and that is what lands in a note named "summary of
 * something else". So this holds on to the turn the send started, which is the one whose object is not
 * the one already on screen, and reads only that.
 *
 * The watch is a subscription rather than a read at the end, because `send` adopts the thread in its own
 * `finally` and drops the live turn before it resolves: by then the only copy of what this turn said is
 * the snapshot taken while it was on screen.
 *
 * Says `busy` without sending when a turn is already running, so a caller can tell the reader to wait
 * rather than queue a second question behind their back.
 */
export async function sendForAnswerDetailed(prompt: string): Promise<AnswerResult> {
  const assistant = useAssistant.getState()
  if (assistant.turn && !assistant.turn.done) return { status: 'busy' }
  const previous = assistant.turn
  // A box rather than a variable: the write happens inside the subscription below, and the reader of it
  // is a different stretch of code than the writer.
  const started: { turn: TurnAnswer | null } = { turn: null }
  const watch = useAssistant.subscribe((state) => {
    const turn = state.turn
    if (!turn || turn === previous) return
    // Once this send has a turn of its own, a later one — the reader asked something else — is not it.
    if (started.turn && turn.token !== undefined && started.turn.token !== undefined && turn.token !== started.turn.token) return
    started.turn = turn
  })
  const accepted = await useAssistant.getState().send(prompt)
  watch()
  const turn = started.turn
  if (!accepted) return { status: 'failed', error: null }
  if (!turn) return { status: 'failed', error: null }
  if (!turn.done) return { status: 'failed', error: turn.error }
  if (turn.error) return { status: 'failed', error: turn.error }
  // The stored row is the only place a stopped answer says so: the live turn simply ends, with its
  // words still on the way.
  const row = turn.assistantId
    ? useAssistant.getState().messages.find((message) => message.id === turn.assistantId)
    : undefined
  if (row && row.status !== 'complete') return { status: 'failed', error: row.error }
  if (!turn.text.trim()) return { status: 'empty' }
  return { status: 'ok', text: turn.text }
}

/**
 * The same send, answered with the text or nothing.
 *
 * For a caller that has one use for every non-answer — a surface that writes a file or stops. Anything
 * that has to *say* what happened takes {@link sendForAnswerDetailed}.
 */
export async function sendForAnswer(prompt: string): Promise<string | null> {
  const result = await sendForAnswerDetailed(prompt)
  return result.status === 'ok' ? result.text : null
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
  useEditorAi.getState().begin({
    noteId,
    action,
    from,
    to,
    source: selection,
    anchor: editorAiAnchor(whole, from, to),
  })
  void useAssistant.getState().send(editorAiPrompt(action, source, noteTitle))
  return true
}

/** A passage as a Markdown block quote, which is how a question about it stays a question about it. */
export function quotePassage(text: string): string {
  const body = text.length > QUOTE_CAP ? `${text.slice(0, QUOTE_CAP)}…` : text
  const quoted = body.split('\n').map((line) => `> ${line}`).join('\n')
  return `${quoted}\n\n`
}


