/**
 * Where a capture lands in a note.
 *
 * Every function here is pure text in, text out: no store, no editor, no prompts. That is what makes
 * the awkward cases testable — a heading inside a code fence is not a heading, a multi-line anchor
 * must match verbatim or not at all, a task captured above a blank line must not leave the blank
 * behind, and a note whose last line has no newline still needs one before the appended text.
 *
 * The reference plugin keeps this logic in five modules with twenty call-site comments describing each
 * regression it fixed. The rules are reproduced here; the numbering in the test file names which
 * behaviour each rule protects.
 */
import { parseFrontMatter } from '@shared/markdown-utils'
import { parseDatePattern } from './date-pattern'

export interface HeadingLine {
  /** 0-based line where the heading text starts. */
  line: number
  level: number
  text: string
}

export type BlankLineMode = 'auto' | 'skip' | 'none'

export interface PlacedCapture {
  content: string
  /** Offset for the editor caret inside `content`, or null when the capture does not place one. */
  cursor: number | null
  /** False when the placement changed nothing, so the caller can say so instead of claiming a write. */
  changed: boolean
}

const ATX_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)[ \t]*$/
const LIST_ITEM_RE = /^ {0,3}([-*+]|\d{1,9}[.)])[ \t]/

export function splitLines(text: string): string[] {
  return text.split('\n')
}

/** Join what `splitLines` broke. A trailing `\r` that a CRLF note leaves on each line is preserved. */
export function joinLines(lines: string[]): string {
  return lines.join('\n')
}

function bare(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * The lines that cannot hold a heading: YAML front matter (only when it opens on line 0 and closes),
 * a fenced code block, a `%%` comment block, a `$$` math block. Delimiters count as blocked.
 */
export function nonHeadingBlockLines(lines: string[]): boolean[] {
  const blocked = lines.map(() => false)
  const text = lines.map(bare)
  let index = 0

  if (text.length > 0 && /^---[ \t]*$/.test(text[0]!)) {
    let close = 1
    while (close < text.length && !/^(?:---|\.\.\.)[ \t]*$/.test(text[close]!)) close += 1
    if (close < text.length) {
      for (let at = 0; at <= close; at += 1) blocked[at] = true
      index = close + 1
    }
  }

  let fence: { char: string; length: number } | null = null
  let block: '%%' | '$$' | null = null
  for (; index < text.length; index += 1) {
    const line = text[index]!
    if (block) {
      blocked[index] = true
      if (block === '%%' ? line.includes('%%') : line.trimEnd().endsWith('$$')) block = null
      continue
    }
    if (fence) {
      blocked[index] = true
      const close = FENCE_CLOSE_RE.exec(line)
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null
      continue
    }
    const open = FENCE_OPEN_RE.exec(line)
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      blocked[index] = true
      fence = { char: open[1]![0]!, length: open[1]!.length }
      continue
    }
    const marker = /^ {0,3}(%%|\$\$)(.*)$/.exec(line)
    const continuesListItem = index > 0 && LIST_ITEM_RE.test(text[index - 1]!)
    if (marker && !(marker[1] === '$$' && continuesListItem)) {
      const kind = marker[1] as '%%' | '$$'
      const rest = marker[2]!
      const closedOnLine = kind === '%%'
        ? rest.includes('%%')
        : rest.trim().length >= 2 && rest.trimEnd().endsWith('$$')
      if (!closedOnLine) {
        blocked[index] = true
        block = kind
      }
    }
  }
  return blocked
}

function isSetextContentLine(line: string): boolean {
  const text = bare(line)
  if (text.trim() === '') return false
  if (/^( {4,}|\t)/.test(text)) return false
  if (ATX_HEADING_RE.test(text)) return false
  if (/^ {0,3}(`{3,}|~{3,})/.test(text)) return false
  if (/^ {0,3}>/.test(text)) return false
  if (LIST_ITEM_RE.test(text)) return false
  if (SETEXT_UNDERLINE_RE.test(text)) return false
  if (/^ {0,3}([*_-])([ \t]*\1){2,}[ \t]*$/.test(text)) return false
  return true
}

/** ATX and setext headings, in document order, with the fence and front matter rules applied. */
export function extractHeadings(lines: string[]): HeadingLine[] {
  const headings: HeadingLine[] = []
  const blocked = nonHeadingBlockLines(lines)
  for (let index = 0; index < lines.length; index += 1) {
    if (blocked[index]) continue
    const line = bare(lines[index]!)
    const atx = ATX_HEADING_RE.exec(line)
    if (atx) {
      headings.push({ line: index, level: atx[1]!.length, text: atx[2]! })
      continue
    }
    const underline = SETEXT_UNDERLINE_RE.exec(line)
    if (underline && index > 0) {
      const previous = lines[index - 1]!
      const previousIsHeading = headings.length > 0 && headings[headings.length - 1]!.line === index - 1
      const paragraphIsSingleLine = index < 2 || blocked[index - 2] || !isSetextContentLine(lines[index - 2]!)
      if (!previousIsHeading && !blocked[index - 1] && paragraphIsSingleLine && isSetextContentLine(previous))
        headings.push({ line: index - 1, level: underline[1]![0] === '=' ? 1 : 2, text: previous.trim() })
      continue
    }
  }
  return headings
}

/** The last line a heading occupies: its underline when setext, its own line when ATX. */
export function headingEndLine(lines: string[], heading: HeadingLine): number {
  return bare(lines[heading.line] ?? '').trim() === heading.text ? heading.line + 1 : heading.line
}

/**
 * The index of the line a section ends on. A heading's section runs to the next heading — or, with
 * `considerSubsections`, to the next heading of the same or a higher level — and ends on its last
 * non-blank line. A plain line's block ends at the next blank or heading.
 */
export function sectionEndLine(lines: string[], target: number, considerSubsections = false): number | null {
  const headings = extractHeadings(lines)
  const heading = headings.find((entry) => entry.line === target)
  if (!heading) {
    if (considerSubsections) return null
    const nextHeading = headings.find((entry) => entry.line > target)?.line ?? null
    let nextBlank = -1
    for (let index = target + 1; index < lines.length; index += 1) {
      if (bare(lines[index]!).trim() === '') {
        nextBlank = index
        break
      }
    }
    const stops = [nextHeading, nextBlank === -1 ? null : nextBlank].filter((value): value is number => value !== null)
    return stops.length > 0 ? Math.min(...stops) - 1 : lines.length - 1
  }

  const next = headings.find((entry) =>
    entry.line > heading.line && (!considerSubsections || entry.level <= heading.level))
  const sectionEnd = next?.line ?? lines.length
  const anchorEnd = headingEndLine(lines, heading)
  let end = sectionEnd - 1
  while (end > anchorEnd && bare(lines[end] ?? '').trim() === '') end -= 1
  if (end === 0 && bare(lines[1] ?? '').trim() === '') return 1
  return Math.max(end, anchorEnd)
}

/** Whether `considerSubsections` may be honoured: only a heading line has a section to include. */
export function anchorAllowsSubsections(
  considerSubsections: boolean,
  lines: string[],
  anchorLine: number,
): boolean {
  if (!considerSubsections) return false
  return extractHeadings(lines).some((heading) => heading.line === anchorLine)
}

/** Trailing blank anchor lines come from a `\n` the author typed at the end and are not part of it. */
export function toTargetLines(target: string): string[] {
  const lines = target.split('\n')
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines
}

export function isBlankTarget(lines: string[]): boolean {
  return lines.length === 0 || (lines.length === 1 && lines[0]!.trim() === '')
}

/**
 * The line an anchor matches. A single-line anchor takes an exact line first, then a line that is the
 * anchor plus trailing whitespace, then a line that *ends* with the anchor (so `| --- |` finds a
 * table separator); a multi-line anchor only matches a consecutive verbatim run.
 */
export function findTargetRange(lines: string[], targetLines: string[]): { start: number; end: number } {
  if (targetLines.length <= 1) {
    const start = findSingleLine(lines, targetLines[0] ?? '')
    return { start, end: start }
  }
  const wanted = targetLines.map((line) => line.trimEnd())
  for (let index = 0; index + wanted.length <= lines.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < wanted.length; offset += 1) {
      // Leading indentation is part of the anchor: `  - Parent` must not match a flat `- Parent`,
      // because the create path would write the indented line back and split the list.
      if (bare(lines[index + offset] ?? '').trimEnd() !== wanted[offset]) {
        matched = false
        break
      }
    }
    if (matched) return { start: index, end: index + wanted.length - 1 }
  }
  return { start: -1, end: -1 }
}

function findSingleLine(lines: string[], rawTarget: string): number {
  const target = rawTarget.trimEnd()
  if (target === '') return -1
  let partial = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = bare(lines[index]!).trimStart()
    if (line === target) return index
    if (line.startsWith(target)) {
      if (/^\s*$/.test(line.slice(target.length))) return index
      if (partial === -1) partial = index
      continue
    }
    const at = line.indexOf(target)
    if (at !== -1) {
      if (/^\s*$/.test(line.slice(at + target.length))) return index
      if (partial === -1) partial = index
      continue
    }
    if (line.endsWith(target) && partial === -1) partial = index
  }
  return partial
}

/** Headings only: a picked heading must never match a same-text line in front matter or a fence. */
export function onlyHeadingLines(lines: string[]): string[] {
  const headings = new Set(extractHeadings(lines.map(bare)).map((heading) => heading.line))
  return lines.map((line, index) => (headings.has(index) ? line : ''))
}

function skipBlankLines(mode: BlankLineMode, line: string): boolean {
  if (mode === 'skip') return true
  if (mode === 'none') return false
  return /^\s{0,3}#{1,6}[ \t]+\S/.test(line)
}

/** The line to splice after: the match, or the run of blank lines beneath it that `mode` allows. */
export function positionAfterMatch(
  lines: string[],
  matchIndex: number,
  body: string,
  mode: BlankLineMode,
): number {
  if (matchIndex < 0 || matchIndex >= lines.length) return matchIndex
  if (!skipBlankLines(mode, bare(lines[matchIndex] ?? ''))) return matchIndex
  const limit = body.endsWith('\n') ? Math.max(lines.length - 1, 0) : lines.length
  let position = matchIndex
  for (let index = matchIndex + 1; index < limit; index += 1) {
    if (bare(lines[index]!).trim() === '') {
      position = index
      continue
    }
    break
  }
  return position
}

/** At the end of a section: after its trailing blanks, unless that would eat the capture's own newline. */
export function positionAtSectionEnd(
  lines: string[],
  sectionEnd: number,
  fileContent: string,
  inserted: string,
): number {
  if (sectionEnd < 0) return sectionEnd
  let position = sectionEnd
  let index = sectionEnd + 1
  while (index < lines.length && bare(lines[index]!).trim() === '') {
    position = index
    index += 1
  }
  if (position === sectionEnd || index !== lines.length) return sectionEnd
  if (!inserted.endsWith('\n')) return sectionEnd
  if (fileContent.endsWith('\n')) return Math.max(sectionEnd, position - 1)
  return position
}

/** Where a note's body starts: after the front matter, in lines. */
export function bodyStartLine(content: string): number {
  const parsed = parseFrontMatter(content)
  return parsed.lineOffset || 0
}

export function insertAfterLine(body: string, line: number, text: string, options: {
  task?: boolean
  /** Offset inside `text` for the caret; omit it to get the offset just past the inserted text. */
  cursor?: number
} = {}): PlacedCapture {
  const lines = splitLines(body)
  const pre = lines.slice(0, line + 1).join('\n')
  const post = lines.slice(line + 1).join('\n')
  const below = bare(lines[line + 1] ?? '')
  const atEndOfFile = body.endsWith('\n') && line + 1 === lines.length - 1
  const blankBelow = line + 1 < lines.length && !atEndOfFile && below.trim() === ''
  const payload = options.task && text.endsWith('\n') && blankBelow ? text.slice(0, -1) : text
  const separator = !text.endsWith('\n') && post.length > 0 ? '\n' : ''
  const content = `${pre}\n${payload}${separator}${post}`
  return {
    content,
    cursor: pre.length + 1 + Math.min(
      Math.max(options.cursor ?? payload.length, 0),
      payload.length,
    ),
    changed: content !== body,
  }
}

export function insertBeforeLine(body: string, line: number, text: string, cursor?: number): PlacedCapture {
  const separator = body.length > 0 && !text.endsWith('\n') ? '\n' : ''
  const offset = Math.max(0, Math.min(cursor ?? text.length, text.length))
  if (line <= 0) {
    return { content: `${text}${separator}${body}`, cursor: offset, changed: text !== '' }
  }
  const lines = splitLines(body)
  const pre = lines.slice(0, line).join('\n')
  const post = lines.slice(line).join('\n')
  const content = `${pre}\n${text}${separator}${post}`
  return { content, cursor: pre.length + 1 + offset, changed: content !== body }
}

/** A blockquote needs a blank line between two `>` runs or the second one is lazy-continued. */
const BLOCKQUOTE_LINE = /^ {0,3}>/

/** Two `>` lines touching each other are one quote, because Markdown continues a lazy block. */
export function blockquoteSeparator(before: string, next: string): string {
  const lastAbove = before.replace(/\n$/, '').split('\n').pop() ?? ''
  const firstBelow = next.split('\n', 1)[0] ?? ''
  return BLOCKQUOTE_LINE.test(lastAbove) && BLOCKQUOTE_LINE.test(firstBelow) ? '\n' : ''
}

export function appendAtBottom(body: string, text: string, cursor?: number): PlacedCapture {
  // The gap is judged on the note as it stands, then the newline that ends its last line is added:
  // appending first would hide the `>` that made the gap necessary.
  const separator = blockquoteSeparator(body, text)
  const lead = body.length > 0 && !body.endsWith('\n') ? '\n' : ''
  const content = `${body}${separator}${lead}${text}`
  const start = body.length + separator.length + lead.length
  const offset = cursor ?? text.length
  return { content, cursor: start + Math.min(Math.max(offset, 0), text.length), changed: content !== body }
}

export function prependAtBodyStart(body: string, text: string, cursor?: number): PlacedCapture {
  const start = bodyStartLine(body)
  const lines = splitLines(body)
  const head = lines.slice(0, start).join('\n')
  const rest = lines.slice(start).join('\n')
  const separator = rest.length > 0 && !text.endsWith('\n') ? '\n' : ''
  const block = `${text}${separator}${rest}`
  const content = head.length > 0 ? `${head}\n${block}` : block
  const insertAt = head.length > 0 ? head.length + 1 : 0
  const offset = cursor ?? text.length
  return { content, cursor: insertAt + Math.min(Math.max(offset, 0), text.length), changed: content !== body }
}

export interface OrderedSlot {
  mode: 'before' | 'after' | 'bodyStart'
  /** Ignored by `bodyStart`: that slot is measured against the note's own properties. */
  line: number
}

export interface OrderRule {
  by: 'lexical' | 'date' | 'numeric' | 'semver' | 'insertion'
  direction: 'asc' | 'desc'
  dateFormat: string
  /** Where the siblings whose key cannot be read belong. Omitted means `bottom`. */
  unparseable?: 'top' | 'bottom'
}

/** `## [1.10.0] - 2026-06-16` and `v1.10` are both a version a changelog heading can be sorted by. */
function semverKey(text: string): number | null {
  const match = /^\[?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/i.exec(text.trim())
  if (!match) return null
  const segment = (value: string | undefined): number => Math.min(Number(value ?? '0'), 999_999)
  return segment(match[1]) * 1e12 + segment(match[2]) * 1e6 + segment(match[3])
}

/** `2026-06-14 (Friday)` names a day; `Friday the 14th` does not, on this reading. */
function isoStampOfLeading(text: string): number | null {
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(text)
  const stamp = Date.parse(iso ? iso[0] : text)
  return Number.isFinite(stamp) ? stamp : null
}

/**
 * The slot a missing anchor heading belongs in, among the sibling headings of the same level. It
 * positions the new section and never re-sorts what is already there.
 *
 * Three rules carry the rest: a heading the rule cannot read sinks to the end of the band (so a
 * `## someday` never holds up a dated one), an unparseable *new* key is appended at the end of the
 * band, and a band ends where the last sibling's whole section ends — not at its heading line, which
 * would splice the new day between a heading and its own text.
 */
export function orderedSlotFor(
  lines: string[],
  targetHeading: string,
  rule: OrderRule,
  locale: string,
): OrderedSlot {
  const wanted = ATX_HEADING_RE.exec(targetHeading.trim())
  const level = wanted?.[1].length ?? 1
  const headings = extractHeadings(lines)
  const bodyStart = bodyStartLine(joinLines(lines))
  const siblings = headings.filter((heading) => heading.level === level && heading.line >= bodyStart)
  const lastOfBand = (): OrderedSlot => {
    const last = siblings[siblings.length - 1]
    if (!last) return { mode: 'bodyStart', line: 0 }
    // The whole section, subsections included: the new sibling goes after everything it owns.
    return { mode: 'after', line: sectionEndLine(lines, last.line, true) ?? last.line }
  }

  if (siblings.length === 0) {
    // No siblings: the new section goes inside its nearest parent's section, so a `##` under an `#`
    // title with a blurb does not land above the blurb.
    const ancestor = [...headings].reverse().find((heading) => heading.level < level && heading.line >= bodyStart)
    if (ancestor) return { mode: 'after', line: sectionEndLine(lines, ancestor.line, true) ?? ancestor.line }
    return { mode: 'bodyStart', line: 0 }
  }

  if (rule.by === 'insertion')
    return rule.direction === 'desc' ? { mode: 'before', line: siblings[0]!.line } : lastOfBand()

  const keyOf = (text: string): number | string | null => {
    if (rule.by === 'numeric') {
      const match = /^-?\d+(?:\.\d+)?/.exec(text.trim())
      return match ? Number(match[0]) : null
    }
    if (rule.by === 'semver') return semverKey(text)
    if (rule.by === 'date') {
      // With a format the reader chose, the format is the only honest reading of the heading. Without
      // one, a leading ISO date still names a day, and trailing decoration (`2026-06-14 (Friday)`)
      // must not make the whole heading unreadable.
      const trimmed = text.trim()
      return rule.dateFormat ? parseDatePattern(trimmed, rule.dateFormat, locale) : isoStampOfLeading(trimmed)
    }
    return text.trim().toLocaleLowerCase(locale)
  }
  const target = keyOf(wanted?.[2] ?? '')
  const unreadableFirst = rule.unparseable === 'top'
  if (target === null)
    return unreadableFirst ? { mode: 'before', line: siblings[0]!.line } : lastOfBand()
  const descending = rule.direction === 'desc'
  const ranked = unreadableFirst ? siblings.filter((heading) => keyOf(heading.text) !== null) : siblings

  for (const heading of ranked) {
    const key = keyOf(heading.text)
    // An unparseable sibling has sunk to the end of the band: anything readable belongs above it.
    if (key === null) return { mode: 'before', line: heading.line }
    const precedes = typeof key === 'number' && typeof target === 'number'
      ? descending ? target > key : target < key
      : descending ? String(target) > String(key) : String(target) < String(key)
    if (precedes) return { mode: 'before', line: heading.line }
  }
  const tail = ranked[ranked.length - 1]
  // With the unreadable ones floated up, the new sibling joins the readable run rather than the
  // physical end of the band, which the floated headings now own.
  if (unreadableFirst && tail)
    return { mode: 'after', line: sectionEndLine(lines, tail.line, true) ?? tail.line }
  return lastOfBand()
}

/** Splice a created heading block in at its sorted slot, padding it off its neighbours. */
export function spliceAtSlot(
  body: string,
  slot: OrderedSlot,
  block: string,
): PlacedCapture {
  const lines = splitLines(body)
  const index = slot.mode === 'before'
    ? slot.line
    : slot.mode === 'bodyStart'
      ? bodyStartLine(body)
      : slot.line + 1
  let offset = 0
  for (let at = 0; at < index && at < lines.length; at += 1) offset += lines[at]!.length + 1
  if (offset > body.length) offset = body.length
  const before = body.slice(0, offset)
  const after = body.slice(offset)
  const previous = index > 0 ? bare(lines[index - 1] ?? '') : ''
  const next = index < lines.length ? bare(lines[index] ?? '') : ''
  const blockLines = block.split('\n').map(bare)
  if (blockLines.length > 1 && blockLines[blockLines.length - 1] === '') blockLines.pop()
  const padded = [...blockLines]
  if (index > 0 && previous.trim() !== '') padded.unshift('')
  if (index < lines.length && next.trim() !== '') padded.push('')
  const lead = before.length > 0 && !before.endsWith('\n') ? '\n' : ''
  const trail = after.length > 0 || body.endsWith('\n') ? '\n' : ''
  const text = padded.join('\n')
  const content = `${before}${lead}${text}${trail}${after}`
  return { content, cursor: before.length + lead.length + text.length, changed: content !== body }
}

/** The offset of the line break at or after `from`, or the end of the text when the line is last. */
function endOfLineOffset(body: string, from: number): number {
  const at = body.indexOf('\n', from)
  return at === -1 ? body.length : at
}

/**
 * Insert after a piece of text *inside* a line rather than after the whole line.
 *
 * The anchor is the first literal occurrence in the note, and the capture is glued to it with no
 * newline of its own — that is the point of inline mode: `{{VALUE}}` lands after a word on the same
 * line. `replaceRestOfLine` drops everything from the anchor to that line's end, the way the
 * reference's "replace existing" does it, and the line break itself survives.
 */
export function insertAfterInline(
  body: string,
  needle: string,
  text: string,
  replaceRestOfLine = false,
  cursor?: number,
): { matched: boolean; result: PlacedCapture } {
  const at = needle === '' ? -1 : body.indexOf(needle)
  if (at === -1) return { matched: false, result: { content: body, cursor: null, changed: false } }
  const matchEnd = at + needle.length
  const end = replaceRestOfLine ? endOfLineOffset(body, matchEnd) : matchEnd
  const content = `${body.slice(0, matchEnd)}${text}${body.slice(end)}`
  const offset = cursor ?? text.length
  return {
    matched: true,
    result: { content, cursor: matchEnd + Math.min(Math.max(offset, 0), text.length), changed: content !== body },
  }
}

/** Does this line hold a heading? Used to keep a picked anchor off the body's other text. */
export function isHeadingLine(line: string): boolean {
  return ATX_HEADING_RE.test(bare(line))
}

export function isWithinFrontMatter(content: string, line: number): boolean {
  const parsed = parseFrontMatter(content)
  return parsed.lineOffset > 0 && line < parsed.lineOffset
}
