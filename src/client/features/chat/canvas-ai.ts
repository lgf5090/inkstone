/**
 * Asking the assistant about a passage in the canvas.
 *
 * The request is a chat turn like the note editor's: the selection rides in the prompt, the draft rides
 * in the turn's canvas context, and the answer comes back through the same stream, accounting and stop
 * button. Writing it back is the client's job, because only the client knows where the selection still
 * is; the anchor is checked against the text as it stands, and a moved passage is refused rather than
 * guessed at.
 */
import { MAX_ARTIFACT_CONTEXT_CHARS } from '@shared/assistant'
import { t, type MessageKey } from '../../lib/i18n'
import {
  resolveWriteTarget,
  sendForAnswerDetailed,
  writeEditorAiContent,
  type AnswerResult,
  type EditorAiAction,
  type WriteRange,
} from './editor-ai'

/** What one canvas write is acting on: the draft, the range, and the document around it. */
export interface CanvasWriteRequest extends WriteRange {
  artifactId: string
  version: number
  title: string
  /** The document the range was taken from, used to decide whether the model needs a tool to see it all. */
  whole: string
  /** Replace the selected range, or insert the answer after it. Continuations insert. */
  mode?: 'replace' | 'insert'
}

export interface CanvasAiRequest extends CanvasWriteRequest {
  action: Exclude<EditorAiAction, 'ask'>
}

/**
 * The most a selection may carry.
 *
 * The composer refuses messages past sixteen thousand characters, and the instructions need room. A
 * selection longer than this is a whole section, not a passage; the reader is asked to take it in parts
 * rather than have a rewrite land on text the model only saw the start of.
 */
export const MAX_CANVAS_AI_SOURCE = 8_000

const PROMPT_KEYS: Record<Exclude<EditorAiAction, 'ask'>, MessageKey> = {
  rewrite: 'assistant.canvas.prompt_rewrite',
  summarize: 'assistant.canvas.prompt_summarize',
  continue: 'assistant.canvas.prompt_continue',
  translate: 'assistant.canvas.prompt_translate',
  outline: 'assistant.canvas.prompt_outline',
  todo: 'assistant.canvas.prompt_todo',
}

export function canvasAiPrompt(action: Exclude<EditorAiAction, 'ask'>, text: string, title: string): string {
  return t(PROMPT_KEYS[action], { text, title: title || t('assistant.canvas.untitled') })
}

/** The request as a chat turn: the open draft is named so the canvas chip cannot switch it off. */
export async function runCanvasAi(
  request: CanvasAiRequest,
  options: { modelId?: string | null } = {},
): Promise<AnswerResult> {
  if (!request.source.trim()) return { status: 'empty' }
  if (request.source.length > MAX_CANVAS_AI_SOURCE) {
    return { status: 'failed', error: t('assistant.canvas.ai_too_long') }
  }
  return sendForAnswerDetailed(canvasAiPrompt(request.action, request.source, request.title), {
    activeArtifactId: request.artifactId,
    noTools: true,
    modelId: options.modelId ?? null,
  })
}

/**
 * A preset or a skill applied to the draft, or to the passage selected in it.
 *
 * A short document travels in the system prompt, so the turn needs no tools. A long one does: the prompt
 * carries only the head and tail, and the model reads the middle with `read_artifact` before rewriting.
 * A selection is always in the prompt itself, so it never needs the tool either.
 */
export async function runCanvasQuickAction(
  request: CanvasWriteRequest,
  action: { instructions: string, modelId?: string | null },
): Promise<AnswerResult> {
  const selection = request.source.trim()
  if (!selection && !request.whole.trim()) return { status: 'empty' }
  const title = request.title || t('assistant.canvas.untitled')
  const prompt = selection
    ? t('assistant.canvas.quick_selection_prompt', { title, instructions: action.instructions, text: selection })
    : t('assistant.canvas.quick_prompt', { title, instructions: action.instructions })
  return sendForAnswerDetailed(prompt, {
    activeArtifactId: request.artifactId,
    modelId: action.modelId ?? null,
    noTools: selection ? true : request.whole.length <= MAX_ARTIFACT_CONTEXT_CHARS,
  })
}

export type CanvasAiWrite =
  | { status: 'stale' }
  | { status: 'ok', content: string }

/**
 * The document as it would read with this answer replacing the selection.
 *
 * `resolveWriteTarget` is the same check the note editor uses: the passage's own words plus the words
 * around it, or a unique occurrence, or a refusal. A canvas is edited by the assistant too, so the
 * chance that the range moved while the model was thinking is higher here, not lower.
 */
export function applyCanvasAi(content: string, request: CanvasWriteRequest, answer: string): CanvasAiWrite {
  const target = resolveWriteTarget(content, request)
  if (target.status === 'stale') return { status: 'stale' }
  return { status: 'ok', content: writeEditorAiContent(content, target, request.mode ?? 'replace', answer.trim()) }
}
