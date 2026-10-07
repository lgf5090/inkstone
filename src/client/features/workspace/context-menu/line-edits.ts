import { joinLines, splitLines } from '../../../lib/markdown/fence-edit'
import { colonFenceMark, deindent, findColonClose } from '../../../lib/markdown/colon-fence'

/**
 * Line-level rewrites of the note's text.
 *
 * A heading or a task marker is one line's business, and both menus need to make that change from
 * the preview as well as from the source. Editing the text by line is what lets the two agree on
 * which line they mean: the block the pointer is on, not wherever the editor's cursor happens to be.
 */

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const HEADING_WITHOUT_BODY = /^ {0,3}(#{1,6})[ \t]*$/
const TASK = /^(\s*)(?:([-*+])|(\d+)([.)]))[ \t]+\[[ xX]\][ \t]/

/** The level a line is written at, or 0 when it is not a heading. */
export function headingLevelOf(line: string): number {
  return HEADING.exec(line)?.[1]?.length ?? (HEADING_WITHOUT_BODY.exec(line)?.[1]?.length ?? 0)
}

/** The line with its heading marker replaced or removed; the body is never touched. */
export function setHeadingLevel(line: string, level: number): string {
  const body = (HEADING.exec(line)?.[2] ?? HEADING_WITHOUT_BODY.exec(line)?.[1] ?? line).trim()
  const indent = /^ {0,3}/.exec(line)?.[0] ?? ''
  if (level <= 0) return body ? `${indent}${body}` : ''
  return `${indent}${'#'.repeat(level)} ${body}`
}

/**
 * The note with one line's heading level rewritten, or null when that line is no longer a heading
 * (or no longer there), which is the signal that something else edited it in the meantime.
 */
export function setHeadingLevelInText(content: string, line: number, level: number): string | null {
  const { lines, eol, trailingNewline } = splitLines(content)
  const current = lines[line]
  if (current === undefined) return null
  if (level > 0 && headingLevelOf(current) === 0 && current.trim()) return null
  lines[line] = setHeadingLevel(current, level)
  return joinLines(lines, eol, trailingNewline)
}

/** A task line stripped back to a plain bullet or numbered item, keeping its indentation. */
export function taskToBullet(line: string): string | null {
  const match = TASK.exec(line)
  if (!match) return null
  const marker = match[2] ?? `${match[3]}${match[4] ?? '.'}`
  return `${match[1]}${marker} ${line.slice(match[0].length)}`
}

/** {@link taskToBullet} applied to one line of the note, refusing when the line has moved on. */
export function taskToBulletInText(content: string, line: number): string | null {
  const { lines, eol, trailingNewline } = splitLines(content)
  const current = lines[line]
  if (current === undefined) return null
  const next = taskToBullet(current)
  if (next === null) return null
  lines[line] = next
  return joinLines(lines, eol, trailingNewline)
}

/** The note with a line inserted after `line`, keeping the file's own end-of-line style. */
export function insertLineAfter(content: string, line: number, text: string): string {
  const { lines, eol, trailingNewline } = splitLines(content)
  lines.splice(line + 1, 0, text)
  return joinLines(lines, eol, trailingNewline)
}

/**
 * The line span a `:::` container occupies, starting from the line the renderer stamped it with.
 * The block rules decide where it ends, so a menu and the renderer cannot disagree about the span,
 * and a container whose closer has been deleted reports nothing rather than eating the rest of the
 * note.
 */
export function containerRangeInText(content: string, startLine: number): { start: number; end: number } | null {
  const { lines } = splitLines(content)
  const text = deindent(lines[startLine] ?? '')
  const mark = colonFenceMark(text)
  if (!mark || !mark.opens) return null
  const found = findColonClose(lines, startLine + 1, lines.length, mark.length)
  if (found === -1) return null
  return { start: startLine, end: found }
}

/**
 * The schemes a note may send the browser to.
 *
 * The preview is safe to open from because the sanitizer already rewrote its anchors; the source
 * pane's menu reads the URL straight out of the note's text, where a `javascript:` target is just
 * characters. The row is disabled rather than hidden, so the note is not silently edited around.
 */
const SAFE_URL_SCHEMES = /^(?:https?:|mailto:|tel:|ftp:|#|\/|\.\/|\.\.\/)/i

export function isSafeExternalUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return false
  // A reference with no scheme at all resolves inside the app, which is what a note link means.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true
  return SAFE_URL_SCHEMES.test(trimmed)
}
