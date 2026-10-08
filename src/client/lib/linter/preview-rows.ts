/**
 * The lines a run would change, as rows a dialog can draw.
 *
 * The engine already knows what it changed — `getEditsBetween` answers with the ranges between the
 * two texts — so the preview shows exactly those, with a few unchanged lines around each so a reader
 * can see where they sit. Nothing here renders or measures a document: the rows are plain data, which
 * is what lets the dialog stay out of the first paint while this runs behind the same dynamic import
 * as the rules themselves.
 */
import { getEditsBetween } from './engine/text-edits';

export type PreviewRow = {
  kind: 'context' | 'removed' | 'added';
  /** The line as it reads, without a marker. */
  text: string;
  /** The 1-based line number in the text this row came from. */
  line: number;
  /**
   * The characters inside the line that the run changed, when the change is one line turning into
   * another. Without it a trimmed paragraph shows as two rows that look exactly alike.
   */
  changed?: { start: number, end: number };
};

export type PreviewDiff = {
  rows: PreviewRow[];
  /** Lines that were left out because they sit between two changed blocks. */
  hidden: number;
  /** The diff stopped being drawn; the reader can ask for the rest. */
  truncated: boolean;
  linesAdded: number;
  linesRemoved: number;
  charsAdded: number;
  charsRemoved: number;
};

const CONTEXT_LINES = 3;
const MAX_ROWS = 240;

/** A half-open range of lines. An insertion or a deletion leaves one of the two empty. */
type LineRange = { start: number, end: number }

/** One edit, as the lines it took out and the lines it put in. */
type Change = { before: LineRange, after: LineRange }

/** The changes close enough to share their context lines, drawn as one block. */
type Block = { changes: Change[], before: LineRange }

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }

  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }

  return low;
}

function linesTouched(starts: number[], from: number, to: number): LineRange {
  if (to <= from) {
    const line = lineAt(starts, from);

    return { start: line, end: line };
  }

  return { start: lineAt(starts, from), end: lineAt(starts, to - 1) + 1 };
}

/** True when the span is a whole line taken out or put in, newline included. */
function wholeLineSpan(starts: number[], from: number, to: number, text: string): boolean {
  return to > from && text.endsWith('\n') && starts[lineAt(starts, from)] === from;
}

/**
 * Drop the lines that only *look* changed because the diff aligned the edit around them. Deleting one
 * line out of three is reported as "these two lines become that one", and the line that merely moved
 * up would be drawn on both sides — as if the reader had to review a line the run left alone.
 */
function trimEqualLines(change: Change, beforeLines: string[], afterLines: string[]): void {
  while (change.before.start < change.before.end && change.after.start < change.after.end
    && beforeLines[change.before.start] === afterLines[change.after.start]) {
    change.before.start++;
    change.after.start++;
  }
  while (change.before.start < change.before.end && change.after.start < change.after.end
    && beforeLines[change.before.end - 1] === afterLines[change.after.end - 1]) {
    change.before.end--;
    change.after.end--;
  }
}

/**
 * The edits, as line ranges in each text. Every offset in an edit refers to the text that was handed
 * over, so the position of the same point in the answer is carried along by hand.
 *
 * A change inside one line leaves the other text with no line to show for it, because nothing was
 * added or removed at the line level. That line is borrowed from the other side, so a trimmed
 * paragraph reads as "this line becomes this" instead of "this line goes away" — the difference the
 * reader is deciding on. A whole line that was deleted is not borrowed back: the line waiting at
 * that offset only moved up, and drawing it would claim it changed.
 */
function changesOf(before: string, after: string): Change[] {
  const beforeStarts = lineStarts(before);
  const afterStarts = lineStarts(after);
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const changes: Change[] = [];
  let shift = 0;
  for (const edit of getEditsBetween(before, after)) {
    const removed = before.slice(edit.startIndex, edit.endIndex);
    const afterFrom = edit.startIndex + shift;
    const inserted = edit.value;
    const beforeRange = linesTouched(beforeStarts, edit.startIndex, edit.endIndex);
    const afterRange = linesTouched(afterStarts, afterFrom, afterFrom + inserted.length);
    const change: Change = {
      before: beforeRange.end === beforeRange.start
        && !wholeLineSpan(afterStarts, afterFrom, afterFrom + inserted.length, inserted)
        ? { start: beforeRange.start, end: beforeRange.start + 1 }
        : { ...beforeRange },
      after: afterRange.end === afterRange.start
        && !wholeLineSpan(beforeStarts, edit.startIndex, edit.endIndex, removed)
        ? { start: afterRange.start, end: afterRange.start + 1 }
        : { ...afterRange },
    };
    trimEqualLines(change, beforeLines, afterLines);
    const previous = changes[changes.length - 1];
    if (previous && change.before.start < previous.before.end) {
      previous.before.end = Math.max(previous.before.end, change.before.end);
      previous.after.end = Math.max(previous.after.end, change.after.end);
    }
    else if (change.before.end > change.before.start || change.after.end > change.after.start) {
      changes.push(change);
    }
    shift += inserted.length - (edit.endIndex - edit.startIndex);
  }

  return changes;
}

function blocksOf(changes: Change[]): Block[] {
  const blocks: Block[] = [];
  for (const change of changes) {
    const previous = blocks[blocks.length - 1];
    if (previous && change.before.start - previous.before.end <= CONTEXT_LINES * 2) {
      previous.changes.push(change);
      previous.before.end = change.before.end;
      continue;
    }

    blocks.push({ changes: [change], before: { ...change.before } });
  }

  return blocks;
}

/** The span each side disagrees about, counted from the front of its own line. */
function changedSpans(from: string, to: string): [{ start: number, end: number }, { start: number, end: number }] {
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;
  let suffix = 0;
  while (suffix < from.length - start && suffix < to.length - start
    && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]) suffix++;

  return [{ start, end: from.length - suffix }, { start, end: to.length - suffix }];
}

/**
 * The rows of a diff, capped so a note with a change at each end does not print the whole of it.
 * `full` is what the dialog passes when the reader asks for the rest.
 *
 * A block is the span between the first and the last change that are close enough to show together,
 * so it holds lines the run left alone. Those are drawn as context: a line that only moved because
 * its neighbour was deleted is not a line the reader has to review twice.
 */
export function buildPreviewDiff(before: string, after: string, full: boolean = false): PreviewDiff {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const blocks = blocksOf(changesOf(before, after));
  const rows: PreviewRow[] = [];
  let hidden = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let truncated = false;
  const limit = full ? Number.POSITIVE_INFINITY : MAX_ROWS;
  const push = (kind: PreviewRow['kind'], lines: string[], start: number, changed?: { start: number, end: number }): void => {
    for (let index = 0; index < lines.length; index++) {
      if (rows.length >= limit) {
        truncated = true;
        return;
      }
      rows.push({ kind, text: lines[index], line: start + index + 1, ...(changed && changed.end > changed.start ? { changed } : {}) });
    }
  };

  let cursor = 0;
  for (const block of blocks) {
    const contextBefore = Math.max(0, block.before.start - CONTEXT_LINES);
    if (contextBefore > cursor) hidden += contextBefore - cursor;
    push('context', beforeLines.slice(contextBefore, block.before.start), contextBefore);

    let beforeCursor = block.before.start;
    for (const change of block.changes) {
      push('context', beforeLines.slice(beforeCursor, change.before.start), beforeCursor);
      const removed = beforeLines.slice(change.before.start, change.before.end);
      const added = afterLines.slice(change.after.start, change.after.end);
      if (removed.length === 1 && added.length === 1) {
        const [fromSpan, toSpan] = changedSpans(removed[0], added[0]);
        push('removed', removed, change.before.start, fromSpan);
        push('added', added, change.after.start, toSpan);
      }
      else {
        push('removed', removed, change.before.start);
        push('added', added, change.after.start);
      }
      linesRemoved += removed.length;
      linesAdded += added.length;
      beforeCursor = change.before.end;
    }
    push('context', beforeLines.slice(beforeCursor, block.before.end), beforeCursor);
    cursor = block.before.end;
  }

  if (truncated && cursor < beforeLines.length) {
    hidden += beforeLines.length - cursor;
  }

  if (!blocks.length) {
    // No line changed, but the size of the change is still the reader's to see: a note that only
    // lost its final newline has nothing to draw and one character to report.
    return {
      rows,
      hidden,
      truncated: false,
      linesAdded,
      linesRemoved,
      charsAdded: Math.max(0, after.length - before.length),
      charsRemoved: Math.max(0, before.length - after.length),
    };
  }

  const trailing = Math.min(CONTEXT_LINES, Math.max(0, beforeLines.length - cursor));
  push('context', beforeLines.slice(cursor, cursor + trailing), cursor);

  return {
    rows,
    hidden,
    truncated,
    linesAdded,
    linesRemoved,
    charsAdded: Math.max(0, after.length - before.length),
    charsRemoved: Math.max(0, before.length - after.length),
  };
}
