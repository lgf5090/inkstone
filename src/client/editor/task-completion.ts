import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'

/**
 * The task-field menu inside the editor.
 *
 * Kept apart from `completion.ts` because everything it knows lives behind `rrule`: the recurrence
 * rules it offers have to be parsed before they can be validated, and a note-taker who never writes a
 * `🔁` has no reason to download that library. So the synchronous part here asks only the cheap
 * question — is the caret past a checkbox on a task line — and the menu arrives a moment later.
 */

/** How many characters must be typed before the menu narrows itself to them. */
const MIN_MATCH = 0
/** The ceiling on the whole menu, shared with the other completion sources. */
const MAX_ITEMS = 6

/** A task line: optional indent or quote, a marker, a checkbox, and the space after it. */
const TASK_LINE = /^([\s\t>]*)?([-*+]|\d+[.)])[ \t]+\[(.)\][ \t]/u

function caretIsAfterTheCheckbox(text: string, cursor: number): boolean {
  const matched = TASK_LINE.exec(text)
  return matched !== null && cursor >= matched[0].length
}

export function taskFieldSource(context: CompletionContext): Promise<CompletionResult | null> | null {
  const line = context.state.doc.lineAt(context.pos)
  const cursorPos = context.pos - line.from
  if (!caretIsAfterTheCheckbox(line.text, cursorPos)) return null

  return import('../lib/tasks/suggest/suggestor').then(async ({ suggestFor, canSuggestForLine }) => {
    const { toggleSettings } = await import('../lib/tasks/service')
    const settings = toggleSettings()
    if (!canSuggestForLine(line.text, cursorPos, settings.registry, '')) return null
    const options = suggestFor({
      line: line.text,
      cursorPos,
      now: new Date(),
      // The menu offers the emoji spelling on every task line, including one already written as
      // `[due:: …]`: the reader's own format is a stamping choice, not a wall — both are read off the
      // same line — and the bracketed menu would need a second symbol table for its few characters of
      // gain.
      dataviewMode: false,
      settings: { autoSuggestMinMatch: MIN_MATCH, autoSuggestMaxItems: MAX_ITEMS, globalFilter: '' },
      existingIds: idsInDocument(context.state.doc.toString()),
    })
    if (options.length === 0) return null
    // One result set has one `from`, so each row replaces its own range in `apply`. The list is
    // already ranked by what the caret sits inside, so a descending boost keeps that order and
    // `filter: false` stops CodeMirror from re-sorting it by prefix.
    const from = line.from + Math.min(...options.map((item) => item.insertAt ?? cursorPos))
    return {
      from,
      options: options.map((item, index) => ({
        label: item.displayText,
        type: 'keyword',
        boost: options.length - index,
        apply: (view: EditorView) => {
          // `insertSkip` counts from `insertAt`, not from the caret: the row replaces the whole match
          // it was offered for, which is the symbol and whatever the reader had typed after it.
          const start = line.from + (item.insertAt ?? cursorPos)
          const end = item.insertSkip === undefined ? line.from + cursorPos : start + item.insertSkip
          view.dispatch({
            changes: { from: start, to: end, insert: item.appendText },
            selection: { anchor: start + item.appendText.length },
            userEvent: 'input.complete',
            scrollIntoView: true,
          })
        },
      })),
      filter: false,
    }
  })
}

/**
 * The ids already in this note.
 *
 * An id only has to be unique among the tasks that reference it, and a repeat inside the note being
 * written is the one the reader can see. Reading the whole vault would mean pulling the index into
 * every keystroke on a task line.
 */
function idsInDocument(source: string): string[] {
  const symbol = String.fromCodePoint(0x1F194)
  const out: string[] = []
  for (const matched of source.matchAll(new RegExp(`${symbol}\\s*([a-zA-Z0-9-_]+)`, 'ug'))) {
    if (matched[1] !== undefined) out.push(matched[1])
  }
  return out
}
