import { parseFrontMatter } from '@shared/markdown-utils'

// A rule may be written as three or more of `-`, `*` or `_`, with spaces between the marks. The
// renderer accepts every one of those spellings, so the deck divides on every one of them too; a
// pager that knew only `---` kept a note the author meant to divide as a single slide.
const RULE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/
// A run of dashes or equals under a paragraph is not a rule: the renderer folds the paragraph into
// a setext heading, so the deck sees a heading of that level and the underline divides nothing.
// Only a contiguous run folds — spaces between the marks make it a rule instead.
const SETEXT_DASH = /^-+[ \t]*$/
const SETEXT_EQUAL = /^=+[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX_HEADING = /^(#{1,6})(?:[ \t]|$)/
const QUOTE = /^>/
const TABLE_ROW = /^\|/
// A block-level tag, or a line holding nothing but one tag, opens an HTML block that runs to the
// next blank line and swallows everything inside it, separator spellings included. The names
// mirror the tags the renderer treats as block-level.
const HTML_BLOCK_TAG = /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|section|select|style|summary|table|tbody|td|tfoot|th|thead|title|tr|track|textarea|ul)(?=[ \t/>]|$)/i
const HTML_LONE_TAG = /^<\/?[a-z][a-z0-9-]*(?:[ \t][^<]*)?>[ \t]*$/i
const COMMENT_LINE = /^<!--(?:.*-->)?[ \t]*$/
const LIST_MARKER = /^ {0,3}([-*+]|\d{1,9}[.)])([ \t]+)/
const LINE_PARTS = /(\r?\n)/
const SLIDE_LEVEL_KEY = 'slide-level'
// `none` is the author saying "the headings are prose structure, not slide starts" — the one reading
// of a `slide-level` value that is not a level. YAML hands it over as a plain string.
const SLIDE_LEVEL_NONE = 'none'
type DeclaredSlideLevel = 1 | 2 | typeof SLIDE_LEVEL_NONE
const NOTE_OPEN = /^ {0,3}<!--[ \t]*(?:note|speaker):[ \t]*/i
const NOTE_END = '-->'
const LAYOUT_LINE = /^ {0,3}<!--[ \t]*layout[ \t]*:[ \t]*([a-z][a-z0-9_-]*)[ \t]*-->$/i
const STEP_LINE = /^ {0,3}<!--[ \t]*steps[ \t]*-->$/i

/** How a slide is laid out on the projector, as its source asks for it. */
export type SlideLayout = 'cover' | 'split'

// `two-columns` is the name the review gives the split layout, and an author who reaches for it
// means the same screen; a value nobody knows stays prose rather than silently becoming a switch.
const LAYOUT_VALUES: Record<string, SlideLayout> = { cover: 'cover', split: 'split', 'two-columns': 'split' }

/** What the line after a setext underline folds into: the paragraph the renderer turned into a
 * heading, whose first line is where that slide starts. */
interface Paragraph {
  line: number
  offset: number
  /** The column the container keeps its text at: a list item sits further in than the prose a rule
   * is written under, and only a line at or past that column continues it. */
  column: number
}

interface BlockState {
  fence: FenceMarker | null
  paragraph: Paragraph | null
  /** An open HTML block runs to the next blank line and swallows whatever is inside it, rules
   * included, which is the one reading the renderer gives that a line-by-line pager tends to miss. */
  html: boolean
}

interface LineRead extends BlockState {
  kind: 'fence' | 'divider' | 'heading' | 'text'
  level: number
  anchor: Paragraph | null
}

interface FenceMarker {
  char: string
  length: number
}

interface Line {
  text: string
  offset: number
}

interface Boundary {
  line: number
  offset: number
  level: number
}

interface Deck {
  slides: string[]
  starts: number[]
  notes: string[]
}

interface NoteMark {
  line: number
  text: string
}

type NoteState = { kind: 'out' } | { kind: 'open'; line: number; parts: string[] }

const NO_BLOCK: BlockState = { fence: null, paragraph: null, html: false }

function isClosingFence(match: RegExpExecArray | null, marker: FenceMarker): boolean {
  const mark = match?.[1]
  if (!mark || mark[0] !== marker.char || mark.length < marker.length) return false
  return match![2]!.trim() === ''
}

function nextFence(text: string, fence: FenceMarker | null): FenceMarker | null {
  const match = FENCE.exec(text)
  if (fence) return isClosingFence(match, fence) ? null : fence
  return match ? { char: match[1]![0]!, length: match[1]!.length } : null
}

/** The column a line's text starts at: a space steps one, a tab steps to the next multiple of four,
 * the way the renderer measures the indent that keeps a line inside its container. */
function advance(column: number, white: string): number {
  let next = column
  for (const space of white) next += space === '\t' ? 4 - (next % 4) : 1
  return next
}

/** The column a list item's text starts at, or `null` for a line that is not a marker. */
function markerColumn(text: string): number | null {
  const marker = LIST_MARKER.exec(text)
  if (!marker) return null
  const indent = advance(0, /^[ \t]*/.exec(text)![0]!)
  return advance(indent + marker[1]!.length, marker[2]!)
}

function readLine(text: string, at: number, offset: number, state: BlockState): LineRead {
  const white = /^[ \t]*/.exec(text)![0]!
  const body = text.slice(white.length)
  const indent = advance(0, white)
  // A paragraph keeps its container's column: a line written deeper than that is a lazy
  // continuation whatever it looks like, and only a line within three of it starts a new block.
  const inner = state.paragraph ? indent - state.paragraph.column : indent
  if (text.trim() === '') return { kind: 'text', level: 0, anchor: null, ...state, paragraph: null, html: false }
  if (inner > 3) return { kind: 'text', level: 0, anchor: null, ...state }

  const opened = nextFence(text, state.fence)
  // Nothing inside a fenced block, including a rule written there, is anything but code.
  if (state.fence || opened) return { kind: 'fence', level: 0, anchor: null, ...NO_BLOCK, fence: opened }
  if (state.html) return { kind: 'text', level: 0, anchor: null, ...state }

  const folded = state.paragraph !== null && inner >= 0
  if (SETEXT_DASH.test(body) && folded) return { kind: 'heading', level: 2, anchor: state.paragraph, ...state, paragraph: null }
  if (SETEXT_EQUAL.test(body) && folded) return { kind: 'heading', level: 1, anchor: state.paragraph, ...state, paragraph: null }
  if (RULE.test(body)) return { kind: 'divider', level: 0, anchor: null, ...state, paragraph: null }

  const heading = ATX_HEADING.exec(body)
  if (heading) return { kind: 'heading', level: heading[1]!.length, anchor: null, ...state, paragraph: null }
  // A quote, a table row and a comment each open a block of their own, so the line after one of them
  // is never the underline of a heading the renderer would have folded.
  if (QUOTE.test(body) || TABLE_ROW.test(body) || COMMENT_LINE.test(body)) return { kind: 'text', level: 0, anchor: null, ...state, paragraph: null }
  if (HTML_BLOCK_TAG.test(body) || HTML_LONE_TAG.test(body) || body.startsWith('<!--')) {
    return { kind: 'text', level: 0, anchor: null, ...state, paragraph: null, html: true }
  }

  const column = markerColumn(text)
  if (column !== null) return { kind: 'text', level: 0, anchor: null, ...state, paragraph: { line: at, offset, column } }
  // A prose line continues the paragraph already open; only the first line of a paragraph is where
  // the renderer starts the block, at its container's column.
  if (state.paragraph) return { kind: 'text', level: 0, anchor: null, ...state }
  return { kind: 'text', level: 0, anchor: null, ...state, paragraph: { line: at, offset, column: 0 } }
}

function trimBlankEdges(slide: string): string {
  return slide.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '')
}

function readLines(source: string): Line[] {
  const parts = source.split(LINE_PARTS)
  const lines: Line[] = []
  let offset = 0
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index]!
    lines.push({ text, offset })
    offset += text.length + (parts[index + 1]?.length ?? 0)
  }
  return lines
}

function slideLevelOf(data: Record<string, unknown>): DeclaredSlideLevel | null {
  const value = data[SLIDE_LEVEL_KEY]
  if (typeof value === 'string' && value.trim().toLowerCase() === SLIDE_LEVEL_NONE) return SLIDE_LEVEL_NONE
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return parsed === 1 || parsed === 2 ? parsed : null
}

interface ReadNote {
  /** The line as the slide sees it; `null` means it belonged to a cue and is gone. */
  text: string | null
  state: NoteState
  note: NoteMark | null
}

function noteClosed(text: string, startLine: number, parts: string[]): ReadNote {
  const end = text.indexOf(NOTE_END)
  if (end < 0) {
    parts.push(text)
    return { text: null, state: { kind: 'open', line: startLine, parts }, note: null }
  }
  parts.push(text.slice(0, end))
  // Prose written after the closing marker stays in the slide: the line is not a private cue line,
  // and dropping it would eat what the author typed.
  const rest = text.slice(end + NOTE_END.length)
  return { text: rest === '' ? null : rest, state: { kind: 'out' }, note: { line: startLine, text: parts.join('\n').trim() } }
}

function readNoteLine(text: string, state: NoteState, index: number): ReadNote {
  if (state.kind === 'open') return noteClosed(text, state.line, state.parts)
  const opener = NOTE_OPEN.exec(text)
  if (!opener) return { text, state, note: null }
  return noteClosed(text.slice(opener[0].length), index, [])
}

function takeNote(note: NoteMark, dropped: boolean, kept: Line[]): NoteMark {
  if (!dropped || kept[note.line - 1]?.text.trim() !== '') return note
  kept.splice(note.line - 1, 1)
  return { line: note.line - 1, text: note.text }
}

function readSpeakerNotes(lines: Line[], bodyStart: number): { notes: NoteMark[]; lines: Line[] } {
  const notes: NoteMark[] = []
  const kept: Line[] = []
  let fence: FenceMarker | null = null
  let state: NoteState = { kind: 'out' }
  for (const line of lines) {
    if (line.offset < bodyStart) {
      kept.push(line)
      continue
    }
    if (state.kind === 'out') {
      const inside = fence !== null
      fence = nextFence(line.text, fence)
      // A fenced block may demo the syntax itself, so nothing inside one is ever a cue.
      if (inside || fence) {
        kept.push(line)
        continue
      }
    }
    const read = readNoteLine(line.text, state, kept.length)
    state = read.state
    if (read.text !== null) kept.push({ text: read.text, offset: line.offset })
    if (read.note) notes.push(takeNote(read.note, read.text === null, kept))
  }
  // A cue nobody closed stays private to the end of the note, the way the reader drops it anyway.
  if (state.kind === 'open') {
    notes.push(takeNote({ line: state.line, text: state.parts.join('\n').trim() }, true, kept))
  }
  return { notes, lines: kept }
}

function placeCues(marks: NoteMark[], bodyLine: number, lineCount: number): NoteMark[] {
  // A cue that swallows the tail leaves no line behind, and a blank trailing slide is dropped
  // along with its cues, so a cue sits on the last line the body still has and joins the slide above.
  const last = Math.max(bodyLine, lineCount - 1)
  return marks.map((mark) => ({ ...mark, line: Math.min(mark.line, last) }))
}

/** Where one slide's cue group ends: a separator belongs to no slide's text, but a cue typed on
 * its line was meant for the slide above it; a heading opens the slide it belongs to. */
function noteLimit(boundary: Boundary): number {
  return boundary.level === 0 ? boundary.line + 1 : boundary.line
}

function scanBoundaries(lines: Line[], bodyStart: number): { breaks: Boundary[]; headings: Boundary[] } {
  const breaks: Boundary[] = []
  const headings: Boundary[] = []
  let block: BlockState = NO_BLOCK
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.offset < bodyStart) continue
    const read = readLine(line.text, index, line.offset, block)
    block = { fence: read.fence, paragraph: read.paragraph, html: read.html }
    if (read.kind === 'divider') breaks.push({ line: index, offset: line.offset, level: 0 })
    else if (read.kind === 'heading') {
      // A setext heading begins at the prose its underline folded up, not at the underline itself.
      const start = read.anchor ?? { line: index, offset: line.offset }
      headings.push({ line: start.line, offset: start.offset, level: read.level })
    }
  }
  return { breaks, headings }
}

function autoSlideLevel(headings: Boundary[]): 1 | 2 | null {
  const count = (level: number) => headings.filter((heading) => heading.level <= level).length
  if (count(1) >= 2) return 1
  return count(2) >= 2 ? 2 : null
}

/**
 * Where the deck divides: the separators the author wrote, plus the headings at the level in force.
 *
 * One set used to switch the other off, so a note with a rule in it lost its heading sections. The
 * two are read together now, and `buildDeck` drops the edges that land on an already-open slide.
 */
function slideBoundaries(lines: Line[], bodyStart: number, declaredLevel: DeclaredSlideLevel | null): Boundary[] {
  const { breaks, headings } = scanBoundaries(lines, bodyStart)
  if (declaredLevel === SLIDE_LEVEL_NONE) return breaks
  const level = declaredLevel ?? autoSlideLevel(headings)
  const edges = level === null ? breaks : [...breaks, ...headings.filter((heading) => heading.level <= level)]
  return edges.sort((left, right) => left.line - right.line)
}

/** Whether the lines between two cuts hold nothing to draw: blanks and a layout switch. A heading
 * under them has no slide of its own to open, because the cut above already starts the slide it would
 * begin — and a switch is a property of the slide rather than content on it, so paging it alone would
 * leave a slide that shows nothing and take the layout off the slide that asked for it. */
function holdsNothingToDraw(lines: Line[], from: number, to: number): boolean {
  for (let index = from; index < to; index++) {
    const text = lines[index]!.text
    if (text.trim() === '' || LAYOUT_LINE.test(text)) continue
    return false
  }
  return true
}

function sliceSlide(lines: Line[], from: number, to: number): string {
  return trimBlankEdges(lines.slice(from, to).map((line) => line.text).join('\n'))
}

function joinNotes(marks: NoteMark[], from: number, to: number): string {
  return marks.filter((mark) => mark.line >= from && mark.line < to).map((mark) => mark.text).join('\n\n')
}

function buildDeck(source: string): Deck {
  const raw = readLines(source)
  const frontMatter = parseFrontMatter(source)
  const bodyStart = raw[frontMatter.lineOffset]?.offset ?? source.length
  const { notes: found, lines } = readSpeakerNotes(raw, bodyStart)
  const marks = placeCues(found, frontMatter.lineOffset, lines.length)
  const boundaries = slideBoundaries(lines, bodyStart, slideLevelOf(frontMatter.data))
  const slides: string[] = []
  const notes: string[] = []
  const starts: number[] = [bodyStart]
  let from = frontMatter.lineOffset
  for (const boundary of boundaries) {
    // Cutting here too would make a page of the region's own blanks and hand the heading to it.
    if (boundary.level !== 0 && holdsNothingToDraw(lines, from, boundary.line)) continue
    slides.push(sliceSlide(lines, from, boundary.line))
    notes.push(joinNotes(marks, from, noteLimit(boundary)))
    // A separator only divides, so it belongs to no slide; a heading is the first line of
    // the slide it opens.
    from = boundary.level === 0 ? boundary.line + 1 : boundary.line
    // Where the deck starts counting this slide: a heading counts from its own line, since the
    // caret sitting on a title means that title, while a caret before a divider still reads as
    // the end of the slide above it.
    starts.push(boundary.level === 0 ? boundary.offset + 1 : boundary.offset)
  }
  slides.push(sliceSlide(lines, from, lines.length))
  // Run the last group past every remaining line, since the cue it holds may have dropped them all.
  notes.push(joinNotes(marks, from, Number.POSITIVE_INFINITY))
  // Edge separators (e.g. an unclosed front matter opener) would otherwise yield
  // blank first/last slides; blank slides between two breaks stay as written.
  while (slides.length > 1 && slides[0] === '') {
    slides.shift()
    notes.shift()
    starts.shift()
  }
  while (slides.length > 1 && slides[slides.length - 1] === '') {
    slides.pop()
    notes.pop()
    starts.pop()
  }
  return { slides, starts, notes }
}

export function splitIntoSlides(source: string): string[] {
  return buildDeck(source).slides
}

/** The deck with each slide's private cue, index-aligned with `splitIntoSlides()`. */
export function splitIntoSlidesWithNotes(source: string): { slides: string[]; notes: string[] } {
  const { slides, notes } = buildDeck(source)
  return { slides, notes }
}

function readLayoutLine(text: string): SlideLayout | undefined {
  const value = LAYOUT_LINE.exec(text)?.[1]?.toLowerCase()
  return value ? LAYOUT_VALUES[value] : undefined
}

/**
 * A slide's layout switch, lifted out of its source. The line itself must not reach the markup:
 * the projector reads the switch off the entry the slide renders to, and every surface that
 * renders that slide — the canvas, the slide list, the overview grid, the printed deck — then
 * draws the same layout without one of them being told about it.
 */

/**
 * The slide's other switch: `<!-- steps -->` reveals the page's blocks one at a time instead of
 * arriving whole. Like the layout switch it takes its own line (and the blank above it) out of the
 * body, because a comment left in the text would paint as a stray node on the projector, and like it
 * a switch demoed inside a fenced block is prose, not an instruction.
 */
export function takeStepDirective(source: string): { body: string; steps: boolean } {
  const lines = readLines(source)
  let fence: FenceMarker | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const inside = fence !== null
    fence = nextFence(line.text, fence)
    if (inside || fence) continue
    if (!STEP_LINE.test(line.text)) continue
    const blank = index > 0 && lines[index - 1]!.text.trim() === '' ? index - 1 : -1
    const kept = lines.filter((_, at) => at !== index && at !== blank).map((item) => item.text)
    return { body: trimBlankEdges(kept.join('\n')), steps: true }
  }
  return { body: source, steps: false }
}

export function takeLayoutDirective(source: string): { body: string; layout: SlideLayout | undefined } {
  const lines = readLines(source)
  let fence: FenceMarker | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    // A fenced block may demo the syntax itself, so nothing inside one switches the layout.
    const inside = fence !== null
    fence = nextFence(line.text, fence)
    if (inside || fence) continue
    const layout = readLayoutLine(line.text)
    if (!layout) continue
    // A switch takes its own line out of the slide, so the blank above it goes with it — leaving
    // it would open a hole where the switch was.
    const blank = index > 0 && lines[index - 1]!.text.trim() === '' ? index - 1 : -1
    const kept = lines.filter((_, at) => at !== index && at !== blank).map((item) => item.text)
    return { body: trimBlankEdges(kept.join('\n')), layout }
  }
  return { body: source, layout: undefined }
}

export function findSlideIndexByOffset(source: string, offset: number): number {
  if (offset <= 0) return 0
  const { slides, starts } = buildDeck(source)
  if (slides.length <= 1) return 0
  let index = 0
  while (index < starts.length - 1 && offset >= starts[index + 1]!) index++
  return index
}
