import { isListLine, parseLine, type Doc, type TextChange } from 'md-dragger/domain'

/**
 * Repairs the two ways a carried block can leave the note messier than it arrived.
 *
 * The engine cuts a block's own line and inserts it, with a trailing newline, at the seam. That is
 * right by its own rules and wrong in two ways a reader notices: where the block was, the empty line
 * above and the empty line below are left touching, so the gap grows by one line every drag; and at
 * the destination the block lands directly on top of the line it was dropped before, which for an
 * ordered list means CommonMark no longer sees a list at all.
 *
 * Both repairs are made to the change set rather than to the document, so a drop stays one
 * transaction, one undo step, and never a whole-note rewrite.
 *
 * The engine's changes arrive in the order the move was planned — the insertion first, the cut after
 * — so the neighbour a cut may not reach past is found by sorting the starts, not by array order.
 */
export function tidyChanges(doc: Doc, changes: readonly TextChange[], tabSize: number): TextChange[] {
  const starts = changes.map((change) => change.from).sort((a, b) => a - b)
  return changes.map((change) => {
    const absorbed = absorbBlankLine(doc, change, nextStart(starts, change))
    return addSeparator(doc, absorbed, tabSize)
  })
}

function nextStart(starts: readonly number[], change: TextChange): number {
  for (const start of starts) if (start > change.to) return start
  return Number.MAX_SAFE_INTEGER
}

/**
 * A cut that starts and ends on line boundaries, with an empty line on each side, leaves two empty
 * lines touching. Eating the one below restores the single blank the note had before the block moved.
 * A cut at the very top of the note has no line above it, and the blank it would leave behind is the
 * one thing readers notice first, so it is eaten the same way.
 */
function absorbBlankLine(doc: Doc, change: TextChange, limit: number): TextChange {
  if (change.insert !== '' || change.to <= change.from) return change
  const cut = lineOf(doc, change.from)
  if (cut.from !== change.from) return change
  if (change.from !== 0) {
    const above = lineOf(doc, change.from - 1)
    if (above.from >= change.from || above.text.trim() !== '') return change
  }
  if (change.to >= doc.length) return change
  const below = lineOf(doc, change.to)
  if (below.from !== change.to || below.text.trim() !== '') return change
  const end = Math.min(below.to + 1, limit)
  return end > change.to ? { ...change, to: end } : change
}

/**
 * A block dropped onto a line has to be separated from it. The one drop that must stay glued is a
 * list item onto a list: the blank line would end the run and split one list into two.
 */
function addSeparator(doc: Doc, change: TextChange, tabSize: number): TextChange {
  if (change.insert === '' || !change.insert.endsWith('\n')) return change
  const at = change.to
  if (at >= doc.length) return change
  if (doc.sliceString(at, at + 1) === '\n') return change
  const movedFirst = change.insert.slice(0, change.insert.indexOf('\n'))
  const nextLine = lineOf(doc, at).text
  if (isListLine(parseLine(movedFirst, tabSize)) && isListLine(parseLine(nextLine, tabSize))) return change
  return { ...change, insert: `${change.insert}\n` }
}

/** The whole line a position sits on — the engine's `Doc` only names the line for a position. */
function lineOf(doc: Doc, position: number) {
  return doc.line(doc.lineAt(Math.min(position, doc.length)).number)
}
