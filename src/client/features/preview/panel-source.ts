import { deindent, findColonClose, lineIndent, sourceColonMarks } from '../../lib/markdown/colon-fence'
import {
  MAX_PANEL_COLUMNS,
  formatAlignHeader,
  formatColsHeader,
  matchPanelHeader,
} from '../../lib/markdown/panel-options'
import type { AlignValue, ColsOptions, PanelHeaderMatch } from '../../lib/markdown/panel-options'
import { joinLines, splitLines } from '../../lib/markdown/fence-edit'

/**
 * The source edits behind a layout block's settings toolbar.
 *
 * A block keeps its whole configuration on one header line, so most edits are a rewrite of that line
 * with the content below left byte-identical. Changing the column count is the one edit that also has
 * to touch the body: the number of columns a note holds is the number of `::` separators it carries,
 * and a header that disagrees with its own body is a block the reader cannot fix by looking at it.
 */

interface LocatedPanel {
  lines: string[]
  eol: string
  trailingNewline: boolean
  indent: string
  markerLength: number
  options: ColsOptions
  closeLine: number
  separators: number[]
}

function readHeader(lines: string[], sourceLine: number): { raw: string, panel: PanelHeaderMatch } | null {
  const raw = lines[sourceLine]
  if (raw === undefined) return null
  const panel = matchPanelHeader(deindent(raw))
  return panel ? { raw, panel } : null
}

/** The block, its body's extent and its separators — or null when the line is not a column block. */
function locateCols(source: string, sourceLine: number): LocatedPanel | null {
  const doc = splitLines(source)
  const head = readHeader(doc.lines, sourceLine)
  if (!head || head.panel.kind !== 'cols') return null
  const closeLine = findColonClose(doc.lines, sourceLine + 1, doc.lines.length, head.panel.markerLength)
  if (closeLine < 0) return null
  return {
    ...doc,
    indent: lineIndent(head.raw),
    markerLength: head.panel.markerLength,
    options: head.panel.cols,
    closeLine,
    separators: sourceColonMarks(doc.lines, sourceLine + 1, closeLine).filter((mark) => mark.alone).map((mark) => mark.line),
  }
}

function commit(doc: Pick<LocatedPanel, 'lines' | 'eol' | 'trailingNewline'>): string {
  return joinLines(doc.lines, doc.eol, doc.trailingNewline)
}

/** Rewrites an alignment block to the given alignment. */
export function updateAlignHeader(source: string, sourceLine: number, align: AlignValue): string | null {
  const doc = splitLines(source)
  const head = readHeader(doc.lines, sourceLine)
  if (!head || head.panel.kind !== 'align') return null
  doc.lines[sourceLine] = `${lineIndent(head.raw)}${formatAlignHeader(align, head.panel.markerLength)}`
  return commit(doc)
}

export function updateColsHeader(
  source: string,
  sourceLine: number,
  update: (current: ColsOptions) => ColsOptions,
): string | null {
  const located = locateCols(source, sourceLine)
  if (!located) return null
  located.lines[sourceLine] = `${located.indent}${formatColsHeader(update(located.options), located.markerLength)}`
  return commit(located)
}

/** How many columns the body currently says it holds, which is one per separator plus the first. */
export function countColumns(source: string, sourceLine: number): number | null {
  const located = locateCols(source, sourceLine)
  return located ? located.separators.length + 1 : null
}

/**
 * Sets the count in both places that state it, and the widths with it.
 *
 * Growing writes the new separators just above the closer, so the column the reader has not filled yet
 * is the one they see last. Shrinking deletes a separator but never silently fuses the paragraphs it was
 * dividing: where neither neighbour already leaves a blank line, the separator becomes one.
 */
export function setColumnCount(source: string, sourceLine: number, count: number, tracks: string | null = null): string | null {
  const located = locateCols(source, sourceLine)
  if (!located) return null
  const { lines, indent, markerLength, closeLine } = located
  const wanted = Math.min(Math.max(Math.trunc(count), 1), MAX_PANEL_COLUMNS) - 1
  let held = located.separators.length
  while (held > wanted) {
    const mark = located.separators[held - 1]!
    const keepsApart = Boolean(lines[mark - 1]?.trim()) && Boolean(lines[mark + 1]?.trim())
    if (keepsApart) lines.splice(mark, 1, indent)
    else lines.splice(mark, 1)
    held--
  }
  while (held < wanted) {
    lines.splice(closeLine, 0, indent, `${indent}::`, indent)
    held++
  }
  const options: ColsOptions = { ...located.options, fixedCount: wanted + 1, tracks }
  lines[sourceLine] = `${indent}${formatColsHeader(options, markerLength)}`
  return commit(located)
}

/**
 * Sets the column widths, leaving the separators alone.
 *
 * The caller has already checked that the list has one part per column: a width edit that changed the
 * count would fold columns the reader can see, which is the stepper's job and not this one.
 */
export function setColumnTracks(source: string, sourceLine: number, tracks: string | null): string | null {
  return updateColsHeader(source, sourceLine, (current) => ({
    ...current,
    tracks,
    fixedCount: tracks ? tracks.split(' ').length : current.fixedCount,
  }))
}
