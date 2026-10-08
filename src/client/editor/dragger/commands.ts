import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  BlockType,
  detectBlock,
  locateDropPosition,
  moveTx,
  parseLine,
  planConvert,
  planDelete,
  planMove,
  selectOne,
  snapDrop,
  type Block,
  type ConvertTo,
  type Doc,
  type DocEdit,
  type DropPosition,
} from 'md-dragger/domain'
import { tidyChanges } from './move-tidy'

/**
 * The engine counts one nesting level as this many source columns.
 *
 * Inkstone indents a list by the editor's own `tabSize` — the same number the outliner's Tab and the
 * two-space notes are written with — so a level is never a different width in two features.
 */
export function draggerIndentUnit(view: EditorView): number {
  return Math.max(1, view.state.facet(EditorState.tabSize))
}

export function draggerBlockAt(view: EditorView, line: number): Block | null {
  return detectBlock(view.state.doc, line, { tabSize: draggerIndentUnit(view) })
}

/** Paint the edits the engine planned, as one undoable transaction, with the note's spacing kept. */
export function applyDocEdits(view: EditorView, edits: readonly DocEdit[], userEvent: string): boolean {
  const edit = edits.find((candidate) => candidate.doc === view.state.doc)
  if (!edit || edit.changes.length === 0) return false
  const changes = tidyChanges(view.state.doc, edit.changes, view.state.facet(EditorState.tabSize))
  view.dispatch({ changes, userEvent })
  return true
}

export function convertBlock(view: EditorView, line: number, to: ConvertTo): boolean {
  const block = draggerBlockAt(view, line)
  if (!block) return false
  const changes = planConvert({ doc: view.state.doc, block, to })
  if (changes.length === 0) return false
  view.dispatch({ changes, userEvent: 'convert.block' })
  return true
}

export function deleteBlock(view: EditorView, line: number): boolean {
  const block = draggerBlockAt(view, line)
  if (!block) return false
  return applyDocEdits(view, asEdits(planDelete({ doc: view.state.doc, selection: selectOne(block) })), 'delete.block')
}

export function blockText(view: EditorView, line: number): string | null {
  const block = draggerBlockAt(view, line)
  if (!block) return null
  return view.state.doc.sliceString(
    view.state.doc.line(block.lines.startLine).from,
    view.state.doc.line(block.lines.endLine).to,
  )
}

export async function copyBlock(view: EditorView, line: number): Promise<boolean> {
  const text = blockText(view, line)
  if (text === null) return false
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export async function cutBlock(view: EditorView, line: number): Promise<boolean> {
  return (await copyBlock(view, line)) && deleteBlock(view, line)
}

/**
 * A copy of the block right below the one the handle was used on.
 *
 * Everything but a list item needs a blank line to stay its own block: two paragraphs written on
 * adjacent lines are one paragraph with a line break, so the duplicate of a prose block is pushed
 * past the empty line that follows it, and a list item is kept inside its run.
 */
export function duplicateBlock(view: EditorView, line: number): boolean {
  const block = draggerBlockAt(view, line)
  if (!block) return false
  const doc = view.state.doc
  const from = doc.line(block.lines.startLine).from
  const to = doc.line(block.lines.endLine).to
  const text = doc.sliceString(from, to)
  const next = block.lines.endLine + 1
  let at = to
  let insert = `\n${text}`
  if (block.type !== BlockType.ListItem) {
    if (next > doc.lines) insert = `\n\n${text}`
    else if (doc.line(next).text.trim() === '') at = doc.line(next).to
    else insert = `\n\n${text}`
  }
  view.dispatch({ changes: [{ from: at, to: at, insert }], userEvent: 'duplicate.block' })
  return true
}

/**
 * Pull a drop seam out of a table's rows.
 *
 * The engine refuses to land a block inside a fence, inside a math block, or in front of a rule, but
 * it accepts a seam between a table's own lines — where it would split the header from its delimiter
 * row and leave the reader with two pieces of text that are no longer a table. Obsidian never shows
 * that seam, because it renders a table as one widget; this editor shows every row in split layout,
 * so the host moves the seam to whichever table edge the pointer was nearer.
 */
export function outsideTable(doc: Doc, position: DropPosition, tabSize: number): DropPosition {
  const line = Math.max(1, Math.min(position.line, doc.lines))
  const block = detectBlock(doc, line, { tabSize })
  if (!block || block.type !== BlockType.Table || position.line <= block.lines.startLine) return position
  const above = position.line - block.lines.startLine
  const below = block.lines.endLine + 1 - position.line
  return { ...position, line: above <= below ? block.lines.startLine : block.lines.endLine + 1, parent: null }
}

/**
 * Move the block one neighbour over, the keyboard's version of the drag.
 *
 * The seam is the neighbour's own outer edge, and the indent intent is the neighbour's indent, so a
 * nested item stays at its level and a top-level block does not get adopted by a list it passes.
 * A seam the rules reject (into a fence, next to a table) snaps to the nearest insertable one before
 * the move is planned, which is what the pointer path does while dragging.
 */
export function moveBlockOver(view: EditorView, line: number, direction: -1 | 1): boolean {
  const state = view.state
  const block = draggerBlockAt(view, line)
  if (!block) return false
  const neighbour = neighbourBlock(state.doc, block, direction, state.facet(EditorState.tabSize))
  if (!neighbour) return false
  const selection = selectOne(block)
  const tabSize = state.facet(EditorState.tabSize)
  const indentUnit = draggerIndentUnit(view)
  const sourceIndentWidth = parseLine(state.doc.line(block.lines.startLine).text, tabSize).indent.width
  const targetIndentWidth = parseLine(neighbour.linesStartText, tabSize).indent.width
  const raw = locateDropPosition({
    doc: state.doc,
    selection,
    hitLine: direction < 0 ? neighbour.firstLine : neighbour.lastLine,
    belowMid: direction > 0,
    sourceIndentWidth,
    targetIndentWidth,
    tabSize,
    indentUnit,
  })
  const edits = planAndCompile(state.doc, selection, raw, tabSize, indentUnit)
    ?? planAndCompile(state.doc, selection, snapDrop({
      raw,
      sourceDoc: state.doc,
      selection,
      sourceIndentWidth,
      targetIndentWidth,
      tabSize,
      indentUnit,
    }), tabSize, indentUnit)
  if (!edits) return false
  return applyDocEdits(view, edits, 'move.block')
}

function planAndCompile(
  doc: Doc,
  selection: ReturnType<typeof selectOne>,
  position: ReturnType<typeof locateDropPosition>,
  tabSize: number,
  indentUnit: number,
): DocEdit[] | null {
  const plan = planMove({ sourceDoc: doc, selection, position, tabSize, indentUnit })
  if (plan.type === 'reject') return null
  const result = moveTx({ sourceDoc: doc, plan: plan.value })
  return 'type' in result ? null : result
}

interface Neighbour {
  firstLine: number
  lastLine: number
  linesStartText: string
}

function neighbourBlock(doc: Doc, block: Block, direction: -1 | 1, tabSize: number): Neighbour | null {
  let line = direction < 0 ? block.lines.startLine - 1 : block.lines.endLine + 1
  while (line >= 1 && line <= doc.lines && doc.line(line).text.trim() === '') line += direction
  if (line < 1 || line > doc.lines) return null
  const neighbour = detectBlock(doc, line, { tabSize })
  if (!neighbour) return null
  return {
    firstLine: neighbour.lines.startLine,
    lastLine: neighbour.lines.endLine,
    linesStartText: doc.line(neighbour.lines.startLine).text,
  }
}

/** `planDelete` answers with either an edit or a rejection — the caller only wants edits. */
function asEdits(result: DocEdit | { type: 'reject'; reason: unknown }): DocEdit[] {
  return 'changes' in result ? [result] : []
}
