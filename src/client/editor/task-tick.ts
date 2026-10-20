import { EditorView } from '@codemirror/view'

/**
 * Move the checkboxes a reader selected, through the one primitive every other surface uses.
 *
 * The writer knows status cycles, recurrence and sub-task cascades; this module only decides which
 * lines to hand it and how to put the result back into the document without rewriting the lines that
 * did not change. The task module is loaded on demand because a note that holds no recurring task has
 * no reason to download a recurrence library.
 */
export async function tickTaskLines(view: EditorView, lineIndexes: number[], userEvent: string): Promise<void> {
  const { toggleTaskLinesInSource } = await import('../lib/tasks/service')
  const source = view.state.doc.toString()
  const next = toggleTaskLinesInSource(source, lineIndexes)
  if (next === null) return
  const change = minimalLineChange(source, next)
  if (change === null) return
  view.dispatch({ changes: change, userEvent })
}

/**
 * Replace only the lines a rewrite actually changed.
 *
 * Dispatching the whole new document would touch every line the reader can see and coarsen the undo
 * granularity of a single tick. For a plain tick that is one line; for a recurring task, two.
 */
function minimalLineChange(before: string, after: string): { from: number, to: number, insert: string } | null {
  const eol = before.includes('\r\n') ? '\r\n' : '\n'
  const oldLines = before.split(/\r?\n/u)
  const newLines = after.split(/\r?\n/u)
  let first = 0
  while (first < oldLines.length && first < newLines.length && oldLines[first] === newLines[first]) first++
  if (first >= oldLines.length && first >= newLines.length) return null
  let tail = 0
  while (
    tail < oldLines.length - first
    && tail < newLines.length - first
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++
  const removed = oldLines.length - first - tail
  const from = lineOffset(oldLines, first, eol)
  const spanned = oldLines.slice(first, first + removed)
  const to = from + spanned.join(eol).length
  return { from, to, insert: newLines.slice(first, newLines.length - tail).join(eol) }
}

function lineOffset(lines: string[], index: number, eol: string): number {
  let offset = 0
  for (let i = 0; i < index; i++) offset += lines[i].length + eol.length
  return offset
}
