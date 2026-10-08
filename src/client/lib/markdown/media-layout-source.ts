import { deindent, findColonClose, lineIndent } from './colon-fence';
import {
  MEDIA_MAX_CELLS_PER_ROW,
  clampRowHeight,
  clampWidth,
  formatMediaHeader,
  formatMediaRowGroup,
  formatMediaRowLine,
  parseMediaOptions,
  parseMediaRow,
  stripMediaRowGroup,
} from './media-layout';
import type { MediaBlockOptions, MediaRowOptions } from './media-layout';
import { joinLines, splitLines } from './fence-edit';

/**
 * Every source edit a layout block can make, as a line range and the lines that replace it.
 *
 * A layout keeps its configuration on the header line and on each row's own line, so nearly every
 * gesture rewrites one or two lines and leaves the rest of the note byte for byte as it was. Returning a
 * *range* rather than a new document is what lets the live editor apply the same edit as a single
 * CodeMirror change — one undo, selection kept — while a surface that only has the saved text replaces
 * those lines in the document it committed.
 *
 * Each function re-reads the block from the note it is given and returns null when the block is not
 * there any more: a preview that has not caught up, or a header the author edited in the meantime, must
 * not have stale geometry written onto whatever line now sits at that number.
 */

export interface MediaEdit {
  /** 0-based, inclusive. */
  start: number;
  end: number;
  lines: string[];
}

export interface LocatedMediaBlock {
  headerLine: number;
  closeLine: number;
  options: MediaBlockOptions;
  /** Every body line that parses as a picture row, in order. Empty for a text frame. */
  rowLines: number[];
  /** A body of prose rather than pictures: the block floats its own Markdown, and has no rows to size. */
  isTextFrame: boolean;
  indent: string;
  marker: string;
}

// Group 1 is the marker run and group 2 the configuration beside it; both are needed to rewrite the line
// without losing the length of the fence the author chose.
const HEADER = /^[ \t]{0,3}(:{3,})[ \t]*media\b(?:[ \t]([^\n]*))?$/;

/** The block a header line opens, or null when that line is not a layout block any more. */
export function locateMediaBlock(source: string, headerLine: number): LocatedMediaBlock | null {
  const doc = splitLines(source);
  const raw = doc.lines[headerLine];
  if (raw === undefined) return null;
  const match = HEADER.exec(raw);
  if (!match) return null;
  const closeLine = findColonClose(doc.lines, headerLine + 1, doc.lines.length, match[1]!.length);
  if (closeLine < 0) return null;
  const rowLines: number[] = [];
  let textLines = 0;
  for (let line = headerLine + 1; line < closeLine; line++) {
    const text = deindent(doc.lines[line] ?? '');
    if (!text.trim()) continue;
    if (parseMediaRow(text)) rowLines.push(line);
    else textLines++;
  }
  // The same rule the renderer applies, so a source edit can never be written into a block that the
  // page is not drawing as a layout.
  if (rowLines.length && textLines) return null;
  return {
    headerLine,
    closeLine,
    options: parseMediaOptions((match[2] ?? '').trim()),
    rowLines,
    isTextFrame: rowLines.length === 0,
    indent: lineIndent(raw),
    marker: match[1]!,
  };
}

const HEADER_SCAN_LIMIT = 240;

/**
 * The layout block a line sits inside, or null when the line is ordinary prose.
 *
 * A right-click knows a line, not a block, and the header may be several picture rows above it. Each
 * candidate is confirmed by `locateMediaBlock`, which reads the block's own closer, so a line that merely
 * follows a `::: media` someone left unclosed is not claimed as its row.
 */
export function findMediaBlockAt(source: string, line: number): LocatedMediaBlock | null {
  const doc = splitLines(source);
  if (doc.lines[line] === undefined) return null;
  for (let candidate = line; candidate >= 0 && line - candidate <= HEADER_SCAN_LIMIT; candidate--) {
    const raw = doc.lines[candidate];
    if (raw === undefined || !HEADER.test(raw)) continue;
    const block = locateMediaBlock(source, candidate);
    if (block && candidate <= line && line <= block.closeLine) return block;
  }
  return null;
}

/** Rewrite the header line with one option changed. */
export function editBlockOptions(
  source: string,
  headerLine: number,
  update: (current: MediaBlockOptions) => MediaBlockOptions,
): MediaEdit | null {
  const block = locateMediaBlock(source, headerLine);
  if (!block) return null;
  const next = `${block.indent}${formatMediaHeader(update(block.options), block.marker.length)}`;
  return { start: headerLine, end: headerLine, lines: [next] };
}

/** Rewrite one row's own line, addressed by the source line the rendered row came from. */
export function editRowOptions(
  source: string,
  headerLine: number,
  rowLine: number,
  update: (current: MediaRowOptions, cells: number) => MediaRowOptions,
): MediaEdit | null {
  const block = locateMediaBlock(source, headerLine);
  if (!block || !block.rowLines.includes(rowLine)) return null;
  const doc = splitLines(source);
  const raw = doc.lines[rowLine] ?? '';
  const row = parseMediaRow(deindent(raw));
  if (!row) return null;
  const next = update(row.options, row.cells.length);
  const written = formatMediaRowLine(deindent(raw), next);
  return { start: rowLine, end: rowLine, lines: [`${lineIndent(raw)}${written}`] };
}

/** The block's width as a share of the text column; null hands the whole line back to the text. */
export function editBlockWidth(source: string, headerLine: number, width: number | null): MediaEdit | null {
  return editBlockOptions(source, headerLine, (current) => ({
    ...current,
    width: width === null ? null : clampWidth(width),
  }));
}

/**
 * The block's width and its rows' heights, as one edit.
 *
 * A frame's corner changes both at once, and two writes would be two undo steps for one gesture. Either
 * half may be left out: a `width` of null means "give the line back to the text", while an absent half
 * leaves those lines exactly as they were.
 */
export function editBlockGeometry(
  source: string,
  headerLine: number,
  changes: { width?: number | null, heights?: ReadonlyArray<{ line: number, height: number }> },
): MediaEdit | null {
  const block = locateMediaBlock(source, headerLine);
  if (!block) return null;
  const doc = splitLines(source);
  const written = new Map<number, string>();
  if (changes.width !== undefined) {
    const width = changes.width === null ? null : clampWidth(changes.width);
    written.set(headerLine, `${block.indent}${formatMediaHeader({ ...block.options, width }, block.marker.length)}`);
  }
  for (const entry of changes.heights ?? []) {
    if (!block.rowLines.includes(entry.line)) return null;
    const raw = doc.lines[entry.line] ?? '';
    const row = parseMediaRow(deindent(raw));
    if (!row) return null;
    const next = formatMediaRowLine(deindent(raw), { ...row.options, height: clampRowHeight(entry.height) });
    written.set(entry.line, `${lineIndent(raw)}${next}`);
  }
  if (!written.size) return null;
  const end = block.rowLines.length ? Math.max(...block.rowLines) : headerLine;
  return { start: headerLine, end, lines: rangeLines(doc.lines, headerLine, end, written) };
}

/**
 * Put a picture somewhere else in the note.
 *
 * The moved embed travels verbatim, and the row it leaves keeps a width list trimmed to the pictures that
 * stay, so a row that said `1:2` with one picture left is not still claiming two tracks.
 */
export function editMoveCell(
  source: string,
  headerLine: number,
  from: { line: number, index: number },
  to: { line: number, index: number },
): MediaEdit | null {
  const block = locateMediaBlock(source, headerLine);
  if (!block || !block.rowLines.includes(from.line)) return null;
  const sameRow = from.line === to.line;
  if (!sameRow && !block.rowLines.includes(to.line)) return null;
  const doc = splitLines(source);
  const moved = cellText(doc.lines[from.line] ?? '', from.index);
  if (moved === null) return null;
  if (sameRow) {
    const permuted = permuteRowCells(doc.lines[from.line] ?? '', from.index, to.index);
    if (permuted === null) return null;
    return { start: from.line, end: from.line, lines: [permuted] };
  }
  const afterLeave = stripCell(doc.lines[from.line] ?? '', from.index);
  if (afterLeave === null) return null;
  const afterJoin = insertCell(doc.lines[to.line] ?? '', to.index, moved);
  if (afterJoin === null) return null;
  const written = new Map<number, string>();
  written.set(from.line, afterLeave);
  written.set(to.line, afterJoin);
  return { start: Math.min(from.line, to.line), end: Math.max(from.line, to.line), lines: rangeLines(doc.lines, Math.min(from.line, to.line), Math.max(from.line, to.line), written) };
}

/**
 * The row line with two of its pictures traded places.
 *
 * A width list travels with the pictures it was written for, because `w=1:2` is a statement about those
 * two pictures and not about the first and second slot: swapping them has to swap the numbers with them,
 * or the wide picture the reader moved would quietly become the narrow one.
 */
function permuteRowCells(raw: string, from: number, to: number): string | null {
  const row = parseMediaRow(deindent(raw));
  if (!row || from < 0 || from >= row.cells.length || to < 0 || to >= row.cells.length) return null;
  const parts = row.cells.map((cell) => cell.raw);
  const weights = row.options.weights.length === parts.length ? [...row.options.weights] : [];
  if (from === to) return `${deindent(raw)}`;
  const [taken] = parts.splice(from, 1);
  const [takenWeight] = weights.length ? weights.splice(from, 1) : [];
  if (taken === undefined) return null;
  parts.splice(to, 0, taken);
  if (weights.length && takenWeight !== undefined) weights.splice(to, 0, takenWeight);
  const group = formatMediaRowGroup({
    weights: parts.length > 1 ? weights : [],
    height: row.options.height,
    align: row.options.align,
  });
  return `${lineIndent(raw)}${parts.join(' ')}${group ? ` ${group}` : ''}`;
}

/** Take one picture out of the block, leaving everything else where it was. */
export function editTakeCellOut(source: string, headerLine: number, line: number, index: number): MediaEdit | null {
  const block = locateMediaBlock(source, headerLine);
  if (!block || !block.rowLines.includes(line)) return null;
  const doc = splitLines(source);
  const raw = doc.lines[line] ?? '';
  const cells = cellTexts(raw);
  if (cells === null || index < 0 || index >= cells.length) return null;
  if (cells.length > 1) {
    const kept = stripCell(raw, index);
    if (kept === null) return null;
    return { start: line, end: line, lines: [kept] };
  }
  // The row's only picture: the line becomes that picture, and the block loses a row.
  return { start: line, end: line, lines: [`${lineIndent(raw)}${cells[index]}`] };
}

/** Add an empty row below `rowLine`, which is where the reader drops or pastes the next picture. */
export function editAddRow(source: string, headerLine: number, rowLine: number): MediaEdit | null {
  const block = locateMediaBlock(source, headerLine);
  if (!block) return null;
  const at = block.rowLines.includes(rowLine) ? rowLine + 1 : block.closeLine;
  return { start: at, end: at - 1, lines: [''] };
}

/** Drop a row's line, pictures and all. Refused for the last row, which would empty the block. */
export function editRemoveRow(source: string, headerLine: number, rowLine: number): MediaEdit | null {
  const block = locateMediaBlock(source, headerLine);
  if (!block || block.rowLines.length < 2 || !block.rowLines.includes(rowLine)) return null;
  return { start: rowLine, end: rowLine, lines: [] };
}

/**
 * The block undone: its header, its closer and its row groups removed.
 *
 * The pictures are what the author wrote, so they come back exactly as they went in, in the order they
 * were on the page. A reader who decides the layout was not worth the chrome gets the note they had, not
 * a reconstruction of it.
 */
export function editUnwrapBlock(source: string, headerLine: number): MediaEdit | null {
  const block = locateMediaBlock(source, headerLine);
  if (!block) return null;
  const doc = splitLines(source);
  const body: string[] = [];
  for (let line = headerLine + 1; line < block.closeLine; line++) {
    const raw = doc.lines[line] ?? '';
    body.push(raw.trim() ? `${lineIndent(raw)}${stripMediaRowGroup(deindent(raw))}` : raw);
  }
  return { start: headerLine, end: block.closeLine, lines: body };
}

/**
 * Wrap whole lines into a new layout block.
 *
 * Refused unless every non-blank line in the range is a picture row: a selection that holds prose would
 * make the block give up its layout the moment it was written, and the reader would see their paragraph
 * swallowed by an empty frame rather than the block they asked for.
 */
export function editWrapLines(
  source: string,
  startLine: number,
  endLine: number,
  options: MediaBlockOptions,
): MediaEdit | null {
  const doc = splitLines(source);
  const lines: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    const raw = doc.lines[line];
    if (raw === undefined) return null;
    const text = deindent(raw);
    if (text.trim() && !parseMediaRow(text)) return null;
    lines.push(raw);
  }
  if (!lines.length) return null;
  const indent = lineIndent(doc.lines[startLine] ?? '');
  const alreadyWrapped = lines.every((line) => !line.trim());
  if (alreadyWrapped) return null;
  return {
    start: startLine,
    end: endLine,
    lines: [`${indent}${formatMediaHeader(options, 3)}`, ...lines, `${indent}:::`],
  };
}

/** The three lines a starter block is made of, with the caret left on the middle one. */
export function mediaBlockSkeleton(options: MediaBlockOptions): string[] {
  return [formatMediaHeader(options, 3), '', ':::'];
}

/** Every line from `start` to `end`, with the rewritten ones substituted and the rest kept verbatim. */
function rangeLines(doc: string[], start: number, end: number, written: Map<number, string>): string[] {
  const lines: string[] = [];
  for (let line = start; line <= end; line++) {
    lines.push(written.get(line) ?? doc[line] ?? '');
  }
  return lines;
}

function cellTexts(raw: string): string[] | null {
  const row = parseMediaRow(deindent(raw));
  if (!row) return null;
  return row.cells.map((cell) => cell.raw);
}

function cellText(raw: string, index: number): string | null {
  const cells = cellTexts(raw);
  if (!cells) return null;
  return cells[index] ?? null;
}

/**
 * The row line with one embed taken out, indentation kept and its width list trimmed beside it.
 *
 * The empty string means the row was left with nothing on it, which the block then reads as a blank line.
 */
function stripCell(raw: string, index: number): string | null {
  const line = deindent(raw);
  const row = parseMediaRow(line);
  if (!row || index < 0 || index >= row.cells.length) return null;
  if (row.cells.length === 1) return '';
  const kept = row.cells.filter((_, at) => at !== index);
  const weights = row.options.weights.length > 1 ? row.options.weights.filter((_, at) => at !== index) : [];
  const group = formatMediaRowGroup({ weights, height: row.options.height, align: row.options.align });
  return `${lineIndent(raw)}${kept.map((cell) => cell.raw).join(' ')}${group ? ` ${group}` : ''}`;
}

/** The row line with `embed` put in at `index`, or null when the row would exceed the cap. */
function insertCell(raw: string, index: number, embed: string): string | null {
  const row = parseMediaRow(deindent(raw));
  if (!row) return null;
  const parts = row.cells.map((cell) => cell.raw);
  const at = Math.max(0, Math.min(index, parts.length));
  parts.splice(at, 0, embed);
  if (parts.length > MEDIA_MAX_CELLS_PER_ROW) return null;
  const weights = row.options.weights.length > 1 ? [...row.options.weights] : [];
  if (weights.length) weights.splice(at, 0, weights[Math.max(0, at - 1)] ?? 1);
  const group = formatMediaRowGroup({
    weights: parts.length > 1 ? weights : [],
    height: row.options.height,
    align: row.options.align,
  });
  return `${lineIndent(raw)}${parts.join(' ')}${group ? ` ${group}` : ''}`;
}

/** Apply an edit to a whole document, for a surface that has nothing but the saved text. */
export function applyMediaEdit(source: string, edit: MediaEdit): string {
  // `splitLines` reads the note's own ending rather than normalizing it first, or a CRLF note would come
  // back with every line it did not touch rewritten.
  const doc = splitLines(source);
  const lines = [...doc.lines];
  const start = Math.max(0, Math.min(edit.start, lines.length));
  const end = Math.max(start - 1, Math.min(edit.end, lines.length - 1));
  lines.splice(start, end - start + 1, ...edit.lines);
  return joinLines(lines, doc.eol, doc.trailingNewline);
}
