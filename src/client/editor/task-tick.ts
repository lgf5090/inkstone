import { EditorView } from '@codemirror/view'
import { t } from '../lib/i18n'
import { useUi } from '../store/ui'

/**
 * Move the checkboxes a reader selected, through the one primitive every other surface uses.
 *
 * The writer knows status cycles, recurrence and sub-task cascades; this module only decides which
 * lines to hand it and how to put the result back into the document without rewriting the lines that
 * did not change. The task module is loaded on demand because a note that holds no recurring task has
 * no reason to download a recurrence library.
 *
 * False means nothing was written, which is the moment a caller has to put a box back the way it was.
 */
export async function tickTaskLines(view: EditorView, lineIndexes: number[], userEvent: string): Promise<boolean> {
  const { toggleTaskLinesInSource } = await import('../lib/tasks/service')
  const source = view.state.doc.toString()
  const next = toggleTaskLinesInSource(source, lineIndexes)
  const change = next === null ? null : minimalLineChange(source, next)
  if (change === null) {
    // The box was drawn from a line that parsed, so the only way to get nothing back is a note that
    // moved underneath the render. A silent no-op is what makes a checkbox look broken.
    useUi.getState().toast({ title: t('editor.task_line_changed'), tone: 'warning' })
    return false
  }
  view.dispatch({ changes: change, userEvent })
  return true
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
