/**
 * Cursor markers: where a finished template asks the editor to put the caret.
 *
 * `tp.file.cursor(order)` does not move a caret while the template runs — the note it is writing has no
 * caret yet, and the run may be creating that note. It returns the text `<% tp.file.cursor(1) %>` and lets
 * that travel into the output, so the marker is placed by the template's *text* rather than by the code that
 * produced it, which is what makes a marker inside an included template or a loop land where the reader put
 * it. Someone then has to find those markers again, group them, delete the group the reader is on and say
 * where the carets go. That is this file: plain data in, plain data out, no editor and no DOM, because the
 * same rules have to be testable without one and the worker has to be able to count markers too.
 *
 * The rules are pinned by upstream: `src/editor/CursorJumper.ts` and the `tp.file.cursor` block of
 * `test/specs/internal-modules/file.e2e.ts` (both AGPL-3.0-only, whose behaviour this repo was relicensed to
 * carry). Three of them are easy to get wrong and are stated here rather than left to the code:
 * - Orders are numbers, not strings, so `1` and `1.0` are the same jump, and `-1` sorts before `0`.
 * - A marker written with no argument is its own group and never joins `tp.file.cursor(0)`, even though
 *   both count as order `0`; a jump that starts on the bare form takes only the first one of them, top to
 *   bottom, which is what a reader who wrote three bare markers expects.
 * - Deleting markers changes the offsets of everything after them, and the caller cannot know that, so the
 *   jump reports the carets and the surviving markers already measured in the text it hands back.
 */
import type { CursorGroup, CursorMarker } from '../protocol'

/**
 * One marker as it appears in the output.
 *
 * Written the way upstream matches it — the literal command text, with any amount of whitespace inside the
 * tags — because that is the string `tp.file.cursor` returns, and a note someone edited by hand may not
 * have the spacing the function emits. The order accepts a sign and a decimal part and nothing else: a
 * marker whose argument is a variable is not a marker, and guessing would place a caret somewhere the
 * template did not ask for.
 */
const CURSOR_MARKER = /<%\s*tp\.file\.cursor\((?<order>(?:-?[0-9]+(?:\.[0-9]+)?)?)\)\s*%>/g

/** An editor position, counted the way CodeMirror counts: both halves 0-based, measured from the line start. */
export interface CursorPosition {
  line: number
  ch: number
}

/** What one cursor jump does to the rendered text. */
export interface CursorJump {
  /** The order the reader is now on; `null` for the bare form. */
  order: number | null
  /** The markers this jump consumed, at the offsets they had in the text that was given. */
  markers: CursorMarker[]
  /** Where each deleted marker leaves its caret, measured in `text`, in the order the markers appear. */
  positions: CursorPosition[]
  /** The same text with this group's markers removed. */
  text: string
  /** The markers still present in `text`, with their offsets already adjusted for what was removed. */
  remaining: CursorMarker[]
}

/** A marker, plus what the jump rule needs and the offsets alone cannot say. */
interface Occurrence extends CursorMarker {
  /** The matched text, which is what has to come out of the note and by how much. */
  raw: string
}

/** Every marker in the text, in the order they appear in it. */
export function findCursorMarkers(output: string): CursorMarker[] {
  return occurrences(output).map(strip)
}

/**
 * Every marker, in the order a reader jumping through the note meets them: by number, ascending, and in
 * source order within one number. `-1` comes first, then the bare form, then `0`, then `1` and `1.0`
 * together — the bare form in its own group, because upstream puts it there on purpose.
 */
export function groupCursorMarkers(output: string): CursorGroup[] {
  const groups: CursorGroup[] = []
  for (const occurrence of orderedOccurrences(output)) {
    const last = groups[groups.length - 1]
    // `null` must not equal `0` here; `sameOrder` is why this is not a bare `===`.
    if (last && sameOrder(last.order, occurrence.order)) last.markers.push(strip(occurrence))
    else groups.push({ order: occurrence.order, markers: [strip(occurrence)] })
  }
  return groups
}

/**
 * The group the next jump consumes, with the removal already applied.
 *
 * `null` when the text holds no marker, which is the normal case and not an error: the caller has nothing to
 * jump to and says so.
 */
export function jumpToNextCursor(output: string): CursorJump | null {
  const ordered = orderedOccurrences(output)
  if (ordered.length === 0) return null
  const first = ordered[0]
  // The bare form: one marker, the first in the note, however many of them there are.
  const taken = first.order === null ? [first] : ordered.filter((candidate) => sameOrder(candidate.order, first.order))
  const text = removeMarkers(output, taken)
  // The only thing a stale offset needs to become valid again is how many characters above it disappeared.
  const removedAbove = (offset: number): number =>
    taken.filter((marker) => marker.start < offset).reduce((length, marker) => length + marker.raw.length, 0)
  return {
    order: first.order,
    markers: taken.map(strip),
    positions: taken.map((marker) => editorPositionAt(text, marker.start - removedAbove(marker.start))),
    text,
    remaining: ordered
      .filter((marker) => !taken.includes(marker))
      .map((marker) => {
        const shift = removedAbove(marker.start)
        return { order: marker.order, start: marker.start - shift, end: marker.end - shift }
      }),
  }
}

/** Whether two markers belong to one jump. Both `null` is the same group; `null` and `0` are not. */
function sameOrder(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right
  // `1` and `1.0` are the same number, so they are the same group however the template spelled them.
  return left === right
}

function orderedOccurrences(output: string): Occurrence[] {
  // Stable by construction: the scan is in source order, and sorting moves whole groups. Bare markers
  // sort as `0` because upstream sorts them there too (`Number('' || 0)`), and they stay their own group.
  return occurrences(output).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function occurrences(output: string): Occurrence[] {
  const found: Occurrence[] = []
  for (const match of output.matchAll(CURSOR_MARKER)) {
    const written = match.groups?.order ?? ''
    const start = match.index ?? 0
    found.push({
      // An omitted argument is `null`, not `0`: the two are different jump groups upstream.
      order: written === '' ? null : Number(written),
      start,
      end: start + match[0].length,
      raw: match[0],
    })
  }
  return found
}

/**
 * Delete these markers, taking them out from the end so the offsets before each one stay valid while the
 * string shrinks. A caller that wants the same thing from its own list of offsets gets it from `remaining`,
 * which is why no half-measure is exported here.
 */
function removeMarkers(output: string, taken: Occurrence[]): string {
  let text = output
  for (let index = taken.length - 1; index >= 0; index -= 1) {
    text = `${text.slice(0, taken[index].start)}${text.slice(taken[index].end)}`
  }
  return text
}

function strip(occurrence: Occurrence): CursorMarker {
  return { order: occurrence.order, start: occurrence.start, end: occurrence.end }
}

/** Line and column of an offset in `text`, both 0-based, counting the newlines before it. */
function editorPositionAt(text: string, offset: number): CursorPosition {
  const before = text.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  return { line: countNewlines(before), ch: offset - lineStart }
}

function countNewlines(text: string): number {
  let count = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1
  return count
}
