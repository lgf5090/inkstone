export interface FenceTarget {
  line: number;
  body: string;
}

export interface FencePatch {
  body?: string;
  info?: string;
}

interface FenceOpening {
  indent: string;
  marker: string;
  length: number;
  info: string;
}

interface FenceLocation {
  line: number;
  closing: number;
  opening: FenceOpening;
}

export function splitLines(content: string): { lines: string[]; eol: string; trailingNewline: boolean } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(content);
  const lines = content.split(/\r?\n/);
  if (trailingNewline && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol, trailingNewline };
}

export function joinLines(lines: string[], eol: string, trailingNewline: boolean): string {
  return `${lines.join(eol)}${trailingNewline && lines.length > 0 ? eol : ''}`;
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function isRecordedLanguage(info: string, languages: readonly string[]): boolean {
  const language = /^([A-Za-z0-9_-]+)/.exec(info.trim())?.[1]?.toLowerCase() ?? '';
  return languages.includes(language);
}

function parseFenceOpening(line: string, languages: readonly string[]): FenceOpening | null {
  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*)$/.exec(line);
  if (!match) return null;
  const info = match[3]!;
  if (languages.length > 0 && !isRecordedLanguage(info, languages)) return null;
  return { indent: match[1]!, marker: match[2]!.charAt(0), length: match[2]!.length, info };
}

function isClosingFence(line: string, marker: string, minLength: number): boolean {
  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!match) return false;
  return match[2]!.charAt(0) === marker && match[2]!.length >= minLength;
}

function findClosingLine(lines: string[], line: number, opening: FenceOpening): number {
  for (let index = line + 1; index < lines.length; index++) {
    if (isClosingFence(lines[index]!, opening.marker, opening.length)) return index;
  }
  return -1;
}

function fenceBody(lines: string[], line: number, closing: number): string {
  return normalizeEol(lines.slice(line + 1, closing === -1 ? lines.length : closing).join('\n'));
}

function widestBodyFenceRun(body: string, marker: string): number {
  let widest = 0;
  for (const line of body.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (match && match[1]!.charAt(0) === marker) widest = Math.max(widest, match[1]!.length);
  }
  return widest;
}

function buildFenceLines(opening: FenceOpening, lines: string[], closing: number, nextBody: string): string[] {
  const length = Math.max(opening.length, widestBodyFenceRun(nextBody, opening.marker) + 1);
  const marker = opening.marker.repeat(length);
  const head = `${opening.indent}${marker}${opening.info}`;
  const keepClosing = closing !== -1 && lines[closing]!.length >= length && isClosingFence(lines[closing]!, opening.marker, length);
  const tail = keepClosing ? lines[closing]! : `${opening.indent}${marker}`;
  return [head, ...(nextBody.length > 0 ? nextBody.split('\n') : []), tail];
}

function locateFence(lines: string[], target: FenceTarget, languages: readonly string[]): FenceLocation | null {
  const expectedBody = normalizeEol(target.body);
  const matchAt = (line: number): FenceLocation | null => {
    const opening = parseFenceOpening(lines[line] ?? '', languages);
    if (!opening) return null;
    const closing = findClosingLine(lines, line, opening);
    return fenceBody(lines, line, closing) === expectedBody ? { line, closing, opening } : null;
  };
  const direct = matchAt(target.line);
  if (direct) return direct;
  const moved: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (matchAt(index)) moved.push(index);
  }
  return moved.length === 1 ? matchAt(moved[0]!) : null;
}

export function fenceAt(content: string, line: number, languages: readonly string[]): { info: string; body: string } | null {
  const { lines } = splitLines(content);
  const opening = parseFenceOpening(lines[line] ?? '', languages);
  if (!opening) return null;
  return { info: opening.info, body: fenceBody(lines, line, findClosingLine(lines, line, opening)) };
}

export function applyFencePatchAtSource(
  content: string,
  target: FenceTarget,
  patch: FencePatch,
  languages: readonly string[],
): string | null {
  const { lines, eol, trailingNewline } = splitLines(content);
  const at = locateFence(lines, target, languages);
  if (!at) return null;
  const opening = patch.info === undefined ? at.opening : { ...at.opening, info: patch.info };
  const body = patch.body === undefined ? normalizeEol(target.body) : normalizeEol(patch.body);
  const replaced = buildFenceLines(opening, lines, at.closing, body);
  const next = at.closing === -1
    ? [...lines.slice(0, at.line), ...replaced]
    : [...lines.slice(0, at.line), ...replaced, ...lines.slice(at.closing + 1)];
  return joinLines(next, eol, trailingNewline);
}
