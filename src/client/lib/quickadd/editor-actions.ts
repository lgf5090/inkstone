/**
 * What an editor step does, worked out from text and offsets instead of a live CodeMirror view.
 *
 * The macro engine asks the app to move the reader's caret or change the selection; the app can only
 * honour that against the note actually on screen. Keeping the arithmetic here means every rule —
 * where a line begins, what counts as the link on it, what a cut leaves behind — is answerable in a
 * test, and the port that touches the view stays a few lines of dispatch.
 */
import type { QuickAddEditorAction } from '@shared/quickadd'

/** A wikilink or an embed sitting on one line. The app has no other link syntax to select. */
const LINK_ON_LINE = /!?\[\[[^\]\n]*\]\]/

export interface EditorActionPlan {
  /** The splice to apply, or null when the action only moves the caret. */
  replace: { from: number; to: number; insert: string } | null
  /** Where the selection ends up: equal offsets mean a caret, not a range. */
  selection: { anchor: number; head: number }
  /** Text the action hands to the clipboard, when it does. */
  copied: string | null
}

export interface EditorActionInput {
  /** The note as the editor holds it, unsaved typing included. */
  text: string
  from: number
  to: number
  action: QuickAddEditorAction
  /** What the clipboard holds. Only `paste` reads it, and null means the browser refused the read. */
  clipboard?: string | null
}

/** The line an offset sits on, without its trailing break. */
function lineAt(text: string, offset: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const found = text.indexOf('\n', start)
  return { start, end: found === -1 ? text.length : found }
}

function clamp(value: number, length: number): number {
  return Math.max(0, Math.min(value, length))
}

/**
 * The plan for one action, or null when it cannot be done here: a paste with nothing readable on the
 * clipboard, or a link the caret's line does not carry. A null is a named failure the run says out
 * loud — it is never a silent no-op, because a macro whose step quietly did nothing is worse than one
 * that stops and says which step.
 */
export function planEditorAction(input: EditorActionInput): EditorActionPlan | null {
  const length = input.text.length
  const from = clamp(Math.min(input.from, input.to), length)
  const to = clamp(Math.max(input.from, input.to), length)
  const line = lineAt(input.text, from)
  const selected = input.text.slice(from, to)

  switch (input.action) {
    case 'copy':
      return { replace: null, selection: { anchor: from, head: to }, copied: selected }
    case 'cut':
      return { replace: { from, to, insert: '' }, selection: { anchor: from, head: from }, copied: selected }
    case 'paste': {
      const pasted = input.clipboard
      if (typeof pasted !== 'string') return null
      return {
        replace: { from, to, insert: pasted },
        selection: { anchor: from + pasted.length, head: from + pasted.length },
        copied: null,
      }
    }
    case 'selectLine':
      return { replace: null, selection: { anchor: line.start, head: line.end }, copied: null }
    case 'selectLink': {
      const link = LINK_ON_LINE.exec(input.text.slice(line.start, line.end))
      if (!link) return null
      const start = line.start + link.index
      return { replace: null, selection: { anchor: start, head: start + link[0].length }, copied: null }
    }
    case 'lineStart':
      return { replace: null, selection: { anchor: line.start, head: line.start }, copied: null }
    case 'lineEnd':
      return { replace: null, selection: { anchor: line.end, head: line.end }, copied: null }
    case 'fileStart':
      return { replace: null, selection: { anchor: 0, head: 0 }, copied: null }
    default:
      return { replace: null, selection: { anchor: length, head: length }, copied: null }
  }
}
