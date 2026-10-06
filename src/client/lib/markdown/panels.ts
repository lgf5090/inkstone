import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import { colonMarks, isBlankRange, type ColonLineSource } from './colon-fence';
import { MAX_PANEL_COLUMNS } from './panel-options';
import type { AlignValue, ColsOptions } from './panel-options';

/**
 * The `:::` layout blocks: a block whose header says how its body is laid out, and whose body is
 * ordinary markdown.
 *
 * Both kinds read their structure out of the same `::` scan the settings toolbars use, so a block can
 * never be split one way on screen and another way when a toolbar rewrites its header.
 */

export interface LineRange {
  start: number;
  end: number;
}

export interface TabSegment extends LineRange {
  title: string;
  selected: boolean;
}

/**
 * The line ranges one column holds.
 *
 * A separator line is punctuation, so it belongs to no column: each range stops at the mark and the
 * next starts past it. A stated count folds the overflow into the last column, so `::: cols 2` keeps
 * two tracks however many `::` the note happens to carry — and it folds them as a *list* of ranges
 * rather than one wide span, because the separators between those ranges are still punctuation and
 * would otherwise reappear inside the column as text. A count above the body's own pads with empty
 * columns, which is what lets the toolbar's stepper show the column it has just opened.
 */
export function columnSegments(state: ColonLineSource, start: number, end: number, fixedCount: number | null): LineRange[][] {
  const separators = colonMarks(state, start, end).filter((mark) => mark.alone).map((mark) => mark.line);
  const starts = [start, ...separators.map((line) => line + 1)];
  const ranges: LineRange[][] = starts.map((from, index) => [{ start: from, end: separators[index] ?? end }]);
  while (ranges.length > 1 && isBlankRange(state, ranges[ranges.length - 1]![0]!.start, ranges[ranges.length - 1]![0]!.end)) ranges.pop();
  const count = Math.min(fixedCount ?? ranges.length, MAX_PANEL_COLUMNS);
  if (count < 1) return ranges.slice(0, 1);
  if (ranges.length > count) {
    const kept = ranges.slice(0, count - 1);
    kept.push(ranges.slice(count - 1).flat());
    return kept;
  }
  while (ranges.length < count) ranges.push([{ start: end, end }]);
  return ranges;
}

/** Tracks only describe a grid the stylesheet can draw when there is exactly one per column. */
function usableTracks(options: ColsOptions, columns: number): string | null {
  if (!options.tracks) return null;
  return options.tracks.split(' ').length === columns ? options.tracks : null;
}

export function renderAlignContainer(state: StateBlock, startLine: number, end: number, nextLine: number, align: AlignValue): void {
  const open = state.push('panel_align_open', 'div', 1);
  open.block = true;
  open.map = [startLine, nextLine];
  open.meta = { align };
  state.md.block.tokenize(state, startLine + 1, end);
  state.push('panel_align_close', 'div', -1).block = true;
}

export function renderColsContainer(state: StateBlock, startLine: number, end: number, nextLine: number, options: ColsOptions): void {
  const columns = columnSegments(state, startLine + 1, end, options.fixedCount);
  const open = state.push('panel_cols_open', 'div', 1);
  open.block = true;
  open.map = [startLine, nextLine];
  open.meta = { options, count: columns.length, tracks: usableTracks(options, columns.length) };
  columns.forEach((segments, index) => {
    const colOpen = state.push('panel_col_open', 'div', 1);
    colOpen.block = true;
    colOpen.meta = { index };
    segments.forEach((segment) => state.md.block.tokenize(state, segment.start, segment.end));
    state.push('panel_col_close', 'div', -1).block = true;
  });
  state.push('panel_cols_close', 'div', -1).block = true;
}

/** The `::` spelling of a tabs block, which reads the same panels as `@tab` does. */
export function findColonTabSegments(state: ColonLineSource, start: number, end: number): TabSegment[] {
  const marks = colonMarks(state, start, end);
  const segments: TabSegment[] = marks.map((mark, index) => ({
    title: mark.head,
    start: mark.line + 1,
    end: marks[index + 1]?.line ?? end,
    selected: false,
  }));
  // A `::` is a separator rather than an introducer, so what the author wrote above the first one is
  // the first panel — the same reading a column block gives the identical line.
  if (marks.length && marks[0]!.line > start && !isBlankRange(state, start, marks[0]!.line))
    segments.unshift({ title: '', start, end: marks[0]!.line, selected: false });
  return segments;
}
