/**
 * The line diff the compare tool draws, and the patch it exports.
 *
 * The algorithm is `diff` (jsdiff) rather than a hand-written LCS: it is the package the ecosystem
 * has used for a decade, it accepts a time budget, and it answers line changes in the shape this
 * screen needs. What is here is only the part jsdiff does not do for us:
 *
 *  - the options a comparison is asked to honour — whitespace, case, line endings, a regular
 *    expression, and a pair of line ranges — are applied to a *key* per line, so the stored lines
 *    are untouched and only the judgement of "equal" changes;
 *  - the result is turned into aligned rows (both sides' line numbers, paired changed lines), hunks
 *    for navigation, and character ranges in the original documents, which is what
 *    `@codemirror/merge` needs to draw its own gutters and inline marks;
 *  - the unified patch is formatted from those rows rather than from a second diff, so what the
 *    reader copies is exactly the change they were looking at.
 *
 * Lines outside the selected ranges are deliberately paired by position and never reported: the
 * reader asked for a part of the file, and a change outside it is not part of the answer.
 */
import { diffArrays, type ArrayChange } from 'diff'
import {
  TEXT_LIMITS,
  type CharChange,
  type DiffHunk,
  type DiffRow,
  type DiffStats,
  type LineRange,
  type TextCompareOptions,
  type TextDiffResult,
} from './types'

export class CompareOptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompareOptionError'
  }
}

/** Why an ignore pattern cannot be used, or null when it can. */
export function regexProblem(source: string): string | null {
  if (!source.trim()) return null
  try {
    new RegExp(source, 'gu')
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid regular expression'
  }
}

function compileRegex(source: string): RegExp | null {
  if (!source.trim()) return null
  try {
    return new RegExp(source, 'gu')
  } catch (error) {
    throw new CompareOptionError(error instanceof Error ? error.message : 'Invalid regular expression')
  }
}

interface LineScan {
  starts: number[]
  contentEnds: number[]
}

/** Line starts and content ends, where "content" stops before the separator the file actually uses. */
function scanLines(text: string, ignoreLineEndings: boolean): LineScan {
  const starts = [0]
  const contentEnds: number[] = []
  const separator = ignoreLineEndings ? /\r\n|\r|\n/g : /\n/g
  for (const match of text.matchAll(separator)) {
    contentEnds.push(match.index)
    starts.push(match.index + match[0].length)
  }
  contentEnds.push(text.length)
  return { starts, contentEnds }
}

/** The file split into lines, keeping a `\r` at the end when line endings are being compared. */
export function splitLines(text: string, ignoreLineEndings: boolean): string[] {
  const scan = scanLines(text, ignoreLineEndings)
  return scan.starts.map((start, index) => text.slice(start, scan.contentEnds[index]))
}

interface Slice {
  /** 0-based index in the full line array where this slice begins. */
  start: number
  /** Exclusive end index in the full line array. */
  end: number
}

function sliceForRange(total: number, range: LineRange | null): Slice {
  if (!range) return { start: 0, end: total }
  const start = Math.min(total, Math.max(0, range.from - 1))
  const end = Math.min(total, Math.max(start, range.to))
  return { start, end }
}

/** The key two lines are compared by: the line with the options applied to it. */
function lineKey(line: string, options: TextCompareOptions, regex: RegExp | null): string {
  let value = line
  if (regex) value = value.replace(regex, '')
  if (options.ignoreWhitespace) value = value.replace(/\s+/g, ' ').trim()
  if (options.ignoreCase) value = value.toLowerCase()
  return value
}

type ChangeBlock =
  | { kind: 'same'; left: number; right: number; count: number }
  | { kind: 'change'; left: number; right: number; removed: number; added: number }
  | { kind: 'remove'; left: number; right: number; removed: number; added: number }
  | { kind: 'add'; left: number; right: number; removed: number; added: number }

function blockChanges(leftKeys: string[], rightKeys: string[]): { blocks: ChangeBlock[]; coarse: boolean } {
  let changes: ArrayChange<string>[] | undefined
  let coarse = false
  try {
    changes = diffArrays(leftKeys, rightKeys, { timeout: TEXT_LIMITS.diffTimeoutMs })
  } catch {
    changes = undefined
  }
  if (!changes) {
    coarse = true
    changes = coarseBlocks(leftKeys, rightKeys)
  }

  const blocks: ChangeBlock[] = []
  let left = 0
  let right = 0
  let index = 0
  while (index < changes.length) {
    const change = changes[index]!
    if (!change.added && !change.removed) {
      blocks.push({ kind: 'same', left, right, count: change.count })
      left += change.count
      right += change.count
      index++
      continue
    }
    if (change.removed) {
      const next = changes[index + 1]
      if (next?.added) {
        blocks.push({ kind: 'change', left, right, removed: change.count, added: next.count })
        left += change.count
        right += next.count
        index += 2
        continue
      }
      blocks.push({ kind: 'remove', left, right, removed: change.count, added: 0 })
      left += change.count
      index++
      continue
    }
    blocks.push({ kind: 'add', left, right, removed: 0, added: change.count })
    right += change.count
    index++
  }
  return { blocks, coarse }
}

/** The one-block answer a timed-out diff falls back to, after trimming what both sides share. */
function coarseBlocks(leftKeys: string[], rightKeys: string[]): ArrayChange<string>[] {
  let prefix = 0
  while (prefix < leftKeys.length && prefix < rightKeys.length && leftKeys[prefix] === rightKeys[prefix]) prefix++
  let suffix = 0
  while (
    suffix < leftKeys.length - prefix
    && suffix < rightKeys.length - prefix
    && leftKeys[leftKeys.length - 1 - suffix] === rightKeys[rightKeys.length - 1 - suffix]
  ) suffix++

  const changes: ArrayChange<string>[] = []
  if (prefix > 0) changes.push({ value: leftKeys.slice(0, prefix), added: false, removed: false, count: prefix })
  const removed = leftKeys.slice(prefix, leftKeys.length - suffix)
  const added = rightKeys.slice(prefix, rightKeys.length - suffix)
  if (removed.length) changes.push({ value: removed, added: false, removed: true, count: removed.length })
  if (added.length) changes.push({ value: added, added: true, removed: false, count: added.length })
  if (suffix > 0) changes.push({ value: leftKeys.slice(leftKeys.length - suffix), added: false, removed: false, count: suffix })
  return changes
}

/** Pairs the parts of both files outside the compared ranges, in order, and reports them unchanged. */
function outsideRows(
  leftLines: string[],
  rightLines: string[],
  leftSlice: Slice,
  rightSlice: Slice,
): DiffRow[] {
  const rows: DiffRow[] = []
  const before = Math.max(leftSlice.start, rightSlice.start)
  for (let index = 0; index < before; index++) {
    const hasLeft = index < leftSlice.start
    const hasRight = index < rightSlice.start
    rows.push({
      kind: 'same',
      leftNo: hasLeft ? index + 1 : null,
      rightNo: hasRight ? index + 1 : null,
      leftText: hasLeft ? leftLines[index] ?? '' : '',
      rightText: hasRight ? rightLines[index] ?? '' : '',
    })
  }
  const after = Math.max(leftLines.length - leftSlice.end, rightLines.length - rightSlice.end)
  for (let offset = 0; offset < after; offset++) {
    const leftIndex = leftSlice.end + offset
    const rightIndex = rightSlice.end + offset
    const hasLeft = leftIndex < leftLines.length
    const hasRight = rightIndex < rightLines.length
    if (!hasLeft && !hasRight) break
    rows.push({
      kind: 'same',
      leftNo: hasLeft ? leftIndex + 1 : null,
      rightNo: hasRight ? rightIndex + 1 : null,
      leftText: hasLeft ? leftLines[leftIndex] ?? '' : '',
      rightText: hasRight ? rightLines[rightIndex] ?? '' : '',
    })
  }
  return rows
}

function insideRows(
  blocks: readonly ChangeBlock[],
  leftLines: string[],
  rightLines: string[],
  leftSlice: Slice,
  rightSlice: Slice,
): DiffRow[] {
  const rows: DiffRow[] = []
  for (const block of blocks) {
    if (block.kind === 'same') {
      for (let offset = 0; offset < block.count; offset++) {
        const leftIndex = leftSlice.start + block.left + offset
        const rightIndex = rightSlice.start + block.right + offset
        rows.push({
          kind: 'same',
          leftNo: leftIndex + 1,
          rightNo: rightIndex + 1,
          leftText: leftLines[leftIndex] ?? '',
          rightText: rightLines[rightIndex] ?? '',
        })
      }
      continue
    }
    const paired = Math.min(block.removed, block.added)
    for (let offset = 0; offset < paired; offset++) {
      const leftIndex = leftSlice.start + block.left + offset
      const rightIndex = rightSlice.start + block.right + offset
      rows.push({
        kind: 'changed',
        leftNo: leftIndex + 1,
        rightNo: rightIndex + 1,
        leftText: leftLines[leftIndex] ?? '',
        rightText: rightLines[rightIndex] ?? '',
      })
    }
    for (let offset = paired; offset < block.removed; offset++) {
      const leftIndex = leftSlice.start + block.left + offset
      rows.push({
        kind: 'removed',
        leftNo: leftIndex + 1,
        rightNo: null,
        leftText: leftLines[leftIndex] ?? '',
        rightText: '',
      })
    }
    for (let offset = paired; offset < block.added; offset++) {
      const rightIndex = rightSlice.start + block.right + offset
      rows.push({
        kind: 'added',
        leftNo: null,
        rightNo: rightIndex + 1,
        leftText: '',
        rightText: rightLines[rightIndex] ?? '',
      })
    }
  }
  return rows
}

function emptyStats(): DiffStats {
  return { added: 0, removed: 0, changed: 0, changedBlocks: 0, same: 0 }
}

function countStats(rows: readonly DiffRow[]): DiffStats {
  const stats = emptyStats()
  let inside = false
  for (const row of rows) {
    if (row.kind === 'same') {
      stats.same++
      inside = false
      continue
    }
    if (!inside) {
      stats.changedBlocks++
      inside = true
    }
    if (row.kind === 'added') stats.added++
    else if (row.kind === 'removed') stats.removed++
    else stats.changed++
  }
  return stats
}

/** The changed ranges, in character offsets of the original documents. */
function charChanges(
  rows: readonly DiffRow[],
  leftText: string,
  rightText: string,
  leftScan: LineScan,
  rightScan: LineScan,
  leftStart: number,
  rightStart: number,
): CharChange[] {
  const changes: CharChange[] = []
  let current: CharChange | null = null
  let leftCursor = leftStart + 1
  let rightCursor = rightStart + 1
  const leftOffset = (line: number): number => line - 1 < leftScan.starts.length ? leftScan.starts[line - 1]! : leftText.length
  const rightOffset = (line: number): number => line - 1 < rightScan.starts.length ? rightScan.starts[line - 1]! : rightText.length
  const leftEnd = (line: number): number => line - 1 < leftScan.contentEnds.length ? leftScan.contentEnds[line - 1]! : leftText.length
  const rightEnd = (line: number): number => line - 1 < rightScan.contentEnds.length ? rightScan.contentEnds[line - 1]! : rightText.length

  for (const row of rows) {
    if (row.kind === 'same') {
      if (current) changes.push(current)
      current = null
      leftCursor = (row.leftNo ?? leftCursor) + 1
      rightCursor = (row.rightNo ?? rightCursor) + 1
      continue
    }
    const rowLeft = row.leftNo
    const rowRight = row.rightNo
    if (!current) {
      current = {
        fromA: rowLeft === null ? leftOffset(leftCursor) : leftOffset(rowLeft),
        toA: rowLeft === null ? leftOffset(leftCursor) : leftEnd(rowLeft),
        fromB: rowRight === null ? rightOffset(rightCursor) : rightOffset(rowRight),
        toB: rowRight === null ? rightOffset(rightCursor) : rightEnd(rowRight),
      }
    } else {
      current.toA = rowLeft === null ? current.toA : leftEnd(rowLeft)
      current.toB = rowRight === null ? current.toB : rightEnd(rowRight)
    }
    if (rowLeft !== null) leftCursor = rowLeft + 1
    if (rowRight !== null) rightCursor = rowRight + 1
  }
  if (current) changes.push(current)
  return changes
}

/** Groups non-equal rows into hunks, with a few unchanged rows either side as context. */
export function buildHunks(rows: readonly DiffRow[], margin = 3): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let index = 0
  while (index < rows.length) {
    while (index < rows.length && rows[index]!.kind === 'same') index++
    if (index >= rows.length) break
    const start = index
    let end = index
    while (end < rows.length) {
      if (rows[end]!.kind !== 'same') {
        end++
        continue
      }
      // A gap this wide ends the hunk; a narrower one is worth showing as context between changes.
      let next = end
      while (next < rows.length && rows[next]!.kind === 'same') next++
      if (next >= rows.length || next - end > margin * 2) break
      end = next
    }
    const from = Math.max(0, start - margin)
    const to = Math.min(rows.length, end + margin)
    const slice = rows.slice(from, to)
    let added = 0
    let removed = 0
    for (const row of slice) {
      if (row.kind === 'added') added++
      else if (row.kind === 'removed') removed++
    }
    const changed = slice.filter((row) => row.kind !== 'same')
    const first = changed[0]
    const last = changed[changed.length - 1]
    hunks.push({
      index: hunks.length,
      leftStart: first?.leftNo ?? (slice[0]?.leftNo ?? 0),
      leftEnd: last?.leftNo ?? (slice[slice.length - 1]?.leftNo ?? 0),
      rightStart: first?.rightNo ?? (slice[0]?.rightNo ?? 0),
      rightEnd: last?.rightNo ?? (slice[slice.length - 1]?.rightNo ?? 0),
      rows: slice,
      added,
      removed,
    })
    index = to
  }
  return hunks
}

/**
 * Both texts compared.
 *
 * `options.ignoreLineEndings` decides how the text is split before anything else: with it on, a
 * CRLF file and an LF file are the same document; with it off, the `\r` stays at the end of every
 * line and shows up as a change, which is what the option is for.
 */
export function computeTextDiff(
  leftText: string,
  rightText: string,
  options: TextCompareOptions,
): TextDiffResult {
  const leftLines = splitLines(leftText, options.ignoreLineEndings)
  const rightLines = splitLines(rightText, options.ignoreLineEndings)
  const leftSlice = sliceForRange(leftLines.length, options.leftRange)
  const rightSlice = sliceForRange(rightLines.length, options.rightRange)
  const regex = compileRegex(options.ignoreRegex)
  const leftKeys = leftLines.slice(leftSlice.start, leftSlice.end).map((line) => lineKey(line, options, regex))
  const rightKeys = rightLines.slice(rightSlice.start, rightSlice.end).map((line) => lineKey(line, options, regex))
  const { blocks, coarse } = blockChanges(leftKeys, rightKeys)

  const compared = insideRows(blocks, leftLines, rightLines, leftSlice, rightSlice)
  const rows = [...outsideRows(leftLines, rightLines, leftSlice, rightSlice), ...compared]

  const leftScan = scanLines(leftText, options.ignoreLineEndings)
  const rightScan = scanLines(rightText, options.ignoreLineEndings)
  const changes = charChanges(
    compared,
    leftText,
    rightText,
    leftScan,
    rightScan,
    leftSlice.start,
    rightSlice.start,
  )

  return {
    rows,
    hunks: buildHunks(rows),
    stats: countStats(rows),
    leftLines,
    rightLines,
    changes,
    coarse,
  }
}

/** A unified diff made from the rows the reader was shown, not from a second, unrelated diff. */
export function formatUnifiedPatch(
  result: Pick<TextDiffResult, 'hunks'>,
  leftLabel: string,
  rightLabel: string,
): string {
  if (!result.hunks.length) return ''
  const lines = [`--- ${leftLabel}`, `+++ ${rightLabel}`]
  for (const hunk of result.hunks) {
    // The header names the whole hunk — context included — while `leftStart` is where the change
    // itself begins, which is what navigation needs. A pure insertion has no left lines, so its
    // header falls back to the change's own position.
    const leftNumbers = hunk.rows.flatMap((row) => (row.leftNo === null ? [] : [row.leftNo]))
    const rightNumbers = hunk.rows.flatMap((row) => (row.rightNo === null ? [] : [row.rightNo]))
    const leftStart = leftNumbers[0] ?? hunk.leftStart
    const rightStart = rightNumbers[0] ?? hunk.rightStart
    lines.push(`@@ -${leftStart},${leftNumbers.length} +${rightStart},${rightNumbers.length} @@`)
    for (const row of hunk.rows) {
      if (row.kind === 'same') lines.push(` ${row.leftText}`)
      else if (row.kind === 'removed') lines.push(`-${row.leftText}`)
      else if (row.kind === 'added') lines.push(`+${row.rightText}`)
      else {
        lines.push(`-${row.leftText}`)
        lines.push(`+${row.rightText}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/** The one-line answer an export header prints. */
export function diffSummaryLine(stats: DiffStats): string {
  return `${stats.added} added, ${stats.removed} removed, ${stats.changed} changed`
}
