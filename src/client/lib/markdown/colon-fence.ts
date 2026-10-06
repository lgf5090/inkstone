/**
 * The one reading of `:::` fences that both halves of the family have to agree on.
 *
 * The renderer scans markdown-it's line index while a settings toolbar scans the note's raw text, and
 * the two fail identically if each keeps its own copy of the rule: a line inside a ``` fence is text,
 * a `::: word` opens a container however the author spaced it, and a bare `::` separates columns only
 * when it is not inside a container that owns it. Every one of those judgements lives here and is
 * reached through a line reader, so a container can never be split one way on screen and another way
 * when a toolbar edits its header.
 */

export type CodeFence = { char: string; length: number } | null;

/** The slice of a markdown-it block state this module needs; kept structural so tests can fake it. */
export interface ColonLineSource {
  src: string;
  bMarks: number[];
  tShift: number[];
  eMarks: number[];
}

/** A line of a container body, and the nesting and colon fence it carries into the scan. */
export interface ScannedLine {
  line: number;
  text: string;
  /** How many containers opened inside this one still hold the line. */
  depth: number;
  /** The container fence on the line itself, which is never a separator. */
  fence: { length: number; opens: boolean } | null;
}

type LineReader = (line: number) => string;

/** The line's text with its leading indentation removed, which is how a block rule reads markers. */
export function blockLine(state: ColonLineSource, line: number): string {
  const from = state.bMarks[line]! + state.tShift[line]!;
  return state.src.slice(from, state.eMarks[line]!);
}

/** markdown-it strips up to three leading spaces from a block start, so the source edits match. */
export function lineIndent(line: string): string {
  return /^ {0,3}/.exec(line)![0];
}

export function deindent(line: string): string {
  return line.slice(lineIndent(line).length);
}

/** Whether a line is fenced out of container syntax, and what fence state it leaves behind. */
function advanceCodeFence(fence: CodeFence, text: string): { fence: CodeFence; inside: boolean } {
  const match = /^(`{3,}|~{3,})/.exec(text);
  if (!match) return { fence, inside: fence !== null };
  const marker = match[1]!;
  if (!fence) return { fence: { char: marker[0]!, length: marker.length }, inside: true };
  if (marker[0] === fence.char && marker.length >= fence.length) return { fence: null, inside: true };
  return { fence, inside: true };
}

// A directive the block rules claim, spelled as a known `{name}` group or as a bare word. An unknown
// `::: whatever` still has to hold its own closer, or a directive nobody recognises would steal its
// parent's; the word form is what makes `:::cols` and `::: cols` the same line to this scanner.
const COLON_DIRECTIVE = /^[ \t]*(?:\{(?:tab-set|tab-item)\}|(?:details|tabs|tab-item)\b)/;
const COLON_WORD = /^[ \t]*[A-Za-z][-\w]{0,31}/;

/** The colon run opening or closing a container on this line, and which of the two it is. */
export function colonFenceMark(text: string): { length: number; opens: boolean } | null {
  const run = /^:{3,}/.exec(text);
  if (!run) return null;
  const rest = text.slice(run[0].length);
  if (!rest.trim()) return { length: run[0]!.length, opens: false };
  if (COLON_DIRECTIVE.test(rest) || COLON_WORD.test(rest)) return { length: run[0]!.length, opens: true };
  return null;
}

/** Every line of a container body outside a code fence, with the nesting it sits at. */
function scanBody(read: LineReader, start: number, end: number): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let depth = 0;
  let fence: CodeFence = null;
  for (let line = start; line < end; line++) {
    const text = read(line);
    const step = advanceCodeFence(fence, text);
    fence = step.fence;
    if (step.inside) continue;
    const mark = colonFenceMark(text);
    lines.push({ line, text, depth, fence: mark });
    if (!mark) continue;
    if (mark.opens) depth++;
    else if (depth > 0) depth--;
  }
  return lines;
}

function scanClose(read: LineReader, start: number, end: number, markerLength: number): number {
  const open: number[] = [markerLength];
  let fence: CodeFence = null;
  for (let line = start; line < end; line++) {
    const text = read(line);
    const step = advanceCodeFence(fence, text);
    fence = step.fence;
    if (step.inside) continue;
    const mark = colonFenceMark(text);
    if (!mark) continue;
    if (mark.opens) {
      open.push(mark.length);
      continue;
    }
    // One closer line closes the innermost container it can serve, so a `:::` inside a `::::` set
    // ends that inner block instead of truncating its parent.
    for (let depth = open.length - 1; depth >= 0; depth--) {
      if (open[depth]! > mark.length) continue;
      open.length = depth;
      if (!open.length) return line;
      break;
    }
  }
  return -1;
}

/** The line that closes a container opened at `start`, or -1 when the note leaves it open. */
export function findColonFenceEnd(state: ColonLineSource, start: number, end: number, markerLength: number): number {
  return scanClose((line) => blockLine(state, line), start, end, markerLength);
}

export function findColonClose(lines: string[], start: number, end: number, markerLength: number): number {
  return scanClose((line) => deindent(lines[line] ?? ''), start, end, markerLength);
}

export interface ColonMark {
  line: number;
  /** Everything the author wrote after the `::`, trimmed; empty for a bare separator. */
  head: string;
  /** Whether the mark carries no title, which is what makes it a column separator. */
  alone: boolean;
}

// The lookahead keeps a `:::` fence out of the separator spelling: this scanner tests the two-colon
// mark before it knows whether the run continues.
const SEPARATOR = /^::(?!:)[ \t]*(.*)$/;

function markOf(line: number, text: string): ColonMark | null {
  const separator = SEPARATOR.exec(text);
  if (!separator) return null;
  const head = separator[1]!.trim();
  return { line, head, alone: head === '' };
}

/**
 * The `::` marks a container's own body carries.
 *
 * A nested container owns the separators inside it, so a column block holding a callout never reads
 * that callout's own `::` rows as its own.
 */
function bodySeparators(scanned: ScannedLine[]): ColonMark[] {
  const marks: ColonMark[] = [];
  for (const entry of scanned) {
    if (entry.depth > 0 || entry.fence) continue;
    const mark = markOf(entry.line, entry.text);
    if (mark) marks.push(mark);
  }
  return marks;
}

export function colonMarks(state: ColonLineSource, start: number, end: number): ColonMark[] {
  return bodySeparators(scanBody((line) => blockLine(state, line), start, end));
}

export function sourceColonMarks(lines: string[], start: number, end: number): ColonMark[] {
  return bodySeparators(scanBody((line) => deindent(lines[line] ?? ''), start, end));
}

/** The lines of a rendered container body that its own rules may claim, at the nesting they sit at. */
export function scanRenderBody(state: ColonLineSource, start: number, end: number): ScannedLine[] {
  return scanBody((line) => blockLine(state, line), start, end);
}

/** The same reading of the body as the note's raw text holds it. */
export function scanSourceBody(lines: string[], start: number, end: number): ScannedLine[] {
  return scanBody((line) => deindent(lines[line] ?? ''), start, end);
}

export function isBlankRange(state: ColonLineSource, start: number, end: number): boolean {
  for (let line = start; line < end; line++) {
    if (blockLine(state, line).trim()) return false;
  }
  return true;
}
