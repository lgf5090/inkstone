/**
 * The checkbox grammar a note's task lines are read with, shared by the notebook and the worker.
 *
 * The notebook offers one checkbox at a time from its context menu; the assistant reads a whole note
 * and turns every box into a task. Both must agree on what a box is and what its words are, or the
 * same line becomes two different tasks depending on which surface was used. The parser therefore
 * lives here, in shared code, and both callers map its answer onto their own shape: the client to a
 * local end-of-day timestamp, the worker to the account's zone.
 *
 * It reads only the conventions the vault already writes — a list marker, `[ ]`/`[x]`, the Dataview
 * `[due:: YYYY-MM-DD]` field and the Tasks-plugin emoji dates. Inline fields are scanned positionally
 * rather than by one regex because a field body may hold nested brackets and escaped characters, and
 * the task's own words must not keep the markers they were parsed from.
 */

/** One checkbox line, with its words and whatever date the line carries. */
export interface NoteCheckbox {
  /** The box's own words, with the marker and every inline date field stripped. */
  title: string
  /** The due day as written, `YYYY-MM-DD`, or null. The caller decides which zone that day means. */
  due: string | null
  /** Whether the box is ticked. A batch keeps this so a checked line can become a finished task. */
  done: boolean
}

/** A checkbox with the line it was found on. */
export interface NoteCheckboxLine extends NoteCheckbox {
  /** 1-based line number in the note body. */
  line: number
}

/** A task checkbox line: optional blockquote/list marker, a `[ ]`/`[x]` box, then the text. */
const TASK_MARKER = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/

/** A Tasks-plugin due date: a calendar emoji and its day. */
const EMOJI_DUE = /[📅📆🗓]️?\s*(\d{4}-\d{2}-\d{2})/

/**
 * Every Tasks-plugin emoji date on a line, as whole tokens.
 *
 * The `u` flag keeps each surrogate pair one token, so cutting these out of a title cannot leave half
 * of an emoji behind. Only the due emoji is read as a date; the rest are words the reader did not
 * write and are removed from the title with it.
 */
const EMOJI_DATE = /[⌛⌚🛫✕✅📅📆🗓]️?\s*\d{4}-\d{2}-\d{2}/gu

const WRAPPERS: Record<string, string> = { '[': ']', '(': ')' }

interface InlineField {
  key: string
  value: string
  start: number
  end: number
  /** The opening character of the wrapper, or null for a hit that is not a bracketed field. */
  wrapping: string | null
}

/**
 * One checkbox line, or null when the line is not a task.
 *
 * A box with no words is still a box — the caller decides whether an empty box is worth a task, which
 * keeps this function's answer a faithful reading of the line rather than a policy about tasks.
 */
export function parseNoteCheckbox(line: string): NoteCheckbox | null {
  const marker = TASK_MARKER.exec(line)
  if (!marker) return null
  const markerEnd = marker[0].length
  const content = line.slice(markerEnd)

  const fields = inlineFields(line)
  const due = dueDay(fields, line)
  let title = content
  for (const hit of fields
    .filter((entry) => entry.wrapping !== null)
    .sort((left, right) => right.start - left.start)) {
    // Only fields that live inside the text after the box, so nothing negative is spliced at.
    if (hit.start < markerEnd || hit.end <= markerEnd) continue
    title = `${title.slice(0, hit.start - markerEnd)}${title.slice(hit.end - markerEnd)}`
  }
  title = title.replace(EMOJI_DATE, ' ').replace(/\s+/g, ' ').trim()
  return { title, due, done: marker[2] !== ' ' }
}

/**
 * Every checkbox in a note body, in the order the reader wrote them.
 *
 * Fenced code is skipped: a checkbox inside a code block is the code being shown, not a task the
 * reader meant to keep. Front matter is not special-cased because a `- [ ]` line cannot be YAML.
 */
export function parseNoteCheckboxes(content: string): NoteCheckboxLine[] {
  const boxes: NoteCheckboxLine[] = []
  let fence: { char: string, length: number } | null = null
  content.split(/\r?\n/).forEach((line, index) => {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      const run = marker[1]!
      if (!fence) fence = { char: run[0]!, length: run.length }
      else if (run[0] === fence.char && run.length >= fence.length) fence = null
      return
    }
    if (fence) return
    const box = parseNoteCheckbox(line)
    if (box) boxes.push({ ...box, line: index + 1 })
  })
  return boxes
}

/**
 * The day the line names, from a `due` field or the calendar emoji, whichever comes first.
 *
 * `YYYY-MM-DD` is the only shape this accepts: the assistant turns that day into the account's zone,
 * and a string it could only half read would land the task on a day the reader never wrote.
 */
function dueDay(fields: InlineField[], line: string): string | null {
  const hits: Array<{ start: number, value: string }> = fields
    .filter((field) => field.key.toLowerCase() === 'due')
    .map((field) => ({ start: field.start, value: field.value }))
  const emoji = EMOJI_DUE.exec(line)
  if (emoji) hits.push({ start: emoji.index, value: emoji[1]! })
  hits.sort((left, right) => left.start - right.start)
  for (const hit of hits) {
    const day = isoDay(hit.value)
    if (day) return day
  }
  return null
}

/** The first `YYYY-MM-DD` in the text, when it is a real calendar day. */
function isoDay(text: string): string | null {
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return `${match[1]}-${match[2]}-${match[3]}`
}

/**
 * The bracketed `[key:: value]` and `(key:: value)` fields on the line, in reading order.
 *
 * The notebook's Dataview engine reads a wider grammar than a task line needs; this scanner is the
 * slice both task surfaces depend on, kept here because the worker cannot import the client's engine.
 */
function inlineFields(line: string): InlineField[] {
  const found: InlineField[] = []
  for (const open of Object.keys(WRAPPERS)) {
    let cursor = line.indexOf(open)
    while (cursor >= 0) {
      const hit = readWrappedField(line, cursor, open)
      if (!hit) {
        cursor = line.indexOf(open, cursor + 1)
        continue
      }
      found.push(hit)
      cursor = line.indexOf(open, hit.end)
    }
  }
  found.sort((left, right) => left.start - right.start)
  const kept: InlineField[] = []
  for (const hit of found) {
    if (!kept.length || kept[kept.length - 1]!.end < hit.start) kept.push(hit)
  }
  return kept
}

function readWrappedField(line: string, start: number, open: string): InlineField | null {
  const close = WRAPPERS[open]!
  const separator = line.indexOf('::', start + 1)
  if (separator < 0) return null
  const key = line.slice(start + 1, separator).trim()
  for (const char of Object.keys(WRAPPERS).concat(Object.values(WRAPPERS))) {
    if (key.includes(char)) return null
  }
  let nesting = 0
  let escaped = false
  for (let index = separator + 2; index < line.length; index++) {
    const char = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === open) nesting += 1
    else if (char === close) {
      nesting -= 1
      if (nesting < 0) {
        return { key, value: line.slice(separator + 2, index).trim(), start, end: index + 1, wrapping: open }
      }
    }
  }
  return null
}
