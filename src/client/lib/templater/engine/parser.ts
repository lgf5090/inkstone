/**
 * Templater's command lexer: prose and commands, split the way the tag grammar documents them.
 *
 * Upstream does this step in Rust (`@silentvoid13/rusty_engine`, reached from `core/parser/Parser.ts`),
 * which cannot be reused here: that package ships no licence and its glue hands every command body to
 * `new Function` in the host realm, which the CSP of this app forbids and its constitution forbids for
 * untrusted input. So this file re-implements the *semantics* that file configures —
 * `ParserConfig("<%", "%>", "\0", "*", "-", "_", "tR")` — together with the one documented utility the
 * config itself does not express (`+`, dynamic commands), read off Templater 2.26.0's
 * `docs/src/syntax.md`, `docs/src/commands/overview.md` and `docs/src/commands/whitespace-control.md`.
 * No upstream code is copied; only its documented behaviour is.
 *
 * Reading that configuration in order is what settles the arguments:
 * - `\0` as the interpolation marker means "no marker character means interpolation", so `<% x %>` is an
 *   expression and only `*` opens an execution command. `~` is *not* an execution marker, whatever the
 *   dead regex at upstream `utils/Utils.ts:33` looks like, because `ParserConfig` never registers it —
 *   see `reports/templater-port-plan.md` §5.1 S2, where that was checked and recorded.
 * - `-` and `_` are two operations, not two spellings of one: `_` discards every whitespace character
 *   beside the tag, `-` discards exactly one newline (whitespace-control.md:31-34). A third behaviour
 *   would be an invention, so a newline separated from the tag by spaces is left alone.
 * - `tR` is a name the *compiler* binds; nothing here knows about it.
 *
 * Output is plain data in, plain data out: no DOM, no store, no editor, no interpreter. A command that
 * never closes is a failure this function returns with its position rather than one it papers over, and
 * the caller decides whether that is an exception or a message.
 */
import { TemplaterError } from '../errors'
import type { ParseFailure, ParserOutput, ParserSegment } from '../protocol'

/** The two characters that open and close every command. */
const OPEN_TAG = '<%'
const CLOSE_TAG = '%>'

/** How much whitespace a tag marker took away from the text beside it. */
export type WhitespaceRule = 'none' | 'newline' | 'all'

/** The three things a command can be; `dynamic` is the one this engine does not run. */
export type CommandKind = 'interpolate' | 'execute' | 'dynamic'

/** One command as the lexer read it, before whitespace control touched the text around it. */
export interface CommandToken {
  kind: CommandKind
  /** Whether a dynamic command was written `<%*+ %>` (runs as code in the preview pass) or `<%+ %>`. */
  execution: boolean
  /** Everything between the markers, verbatim, with only the whitespace-control characters taken off. */
  body: string
  /** The command exactly as written, `<%` through `%>`: what a dynamic command leaves in the note. */
  raw: string
  whitespaceBefore: WhitespaceRule
  whitespaceAfter: WhitespaceRule
  /** 0-based offset of the `<%`. */
  origin: number
  /** Offset just past the `%>`, so the next piece of text starts here. */
  end: number
  /** 1-based, the way every editor and error list in this app counts. */
  line: number
  column: number
}

/**
 * A `<%+ %>` command, handed back rather than compiled.
 *
 * Only the preview post-processor may run these, and only against the text a reader is looking at, so
 * the note has to keep the command as the author wrote it. The compiler therefore emits `raw` as data;
 * this list exists so the preview pass, the editor's highlighting and the risk checks can name the same
 * commands without re-lexing the template. An offset *in the rendered output* is not knowable here — it
 * depends on what the earlier commands produce — which is why the preview pass still scans the note.
 */
export interface DynamicCommand {
  body: string
  execution: boolean
  raw: string
  origin: number
  line: number
  column: number
}

/** What a successful parse produced: the frozen shape, plus what this engine alone can know. */
export interface TemplaterParseResult extends ParserOutput {
  /** Every command in source order, dynamic ones included. */
  commands: CommandToken[]
  dynamicCommands: DynamicCommand[]
}

/**
 * The outcome of one parse.
 *
 * A result rather than an exception because the parser is also what the editor calls while the reader is
 * typing: an unclosed command there is a state to display, not a crash to unwind through.
 * `parseTemplateOrThrow` is the other face of the same answer for a run, which has to stop.
 */
export type ParseResult = { ok: true; output: TemplaterParseResult } | { ok: false; failure: ParseFailure }

/** A piece of the template, as the scanner found it before whitespace control was applied. */
type Piece = { type: 'text'; text: string } | { type: 'command'; token: CommandToken }

export function parseTemplate(template: string): ParseResult {
  const lineStarts = collectLineStarts(template)
  const scan = scanPieces(template, lineStarts)
  if (!scan.ok) return { ok: false, failure: scan.failure }
  return { ok: true, output: assemble(scan.pieces) }
}

/**
 * The throwing form, for a run that cannot continue.
 *
 * The position travels inside the detail as `line:column`, which is language-neutral: the reader's
 * sentence comes from the locale catalog, and the numbers beside it are what they have to navigate to.
 */
export function parseTemplateOrThrow(template: string): TemplaterParseResult {
  const result = parseTemplate(template)
  if (result.ok) return result.output
  const { failure } = result
  throw new TemplaterError(failure.code, `${failure.line}:${failure.column}`)
}

function scanPieces(
  template: string,
  lineStarts: number[],
): { ok: true; pieces: Piece[] } | { ok: false; failure: ParseFailure } {
  const pieces: Piece[] = []
  let cursor = 0
  for (;;) {
    const start = template.indexOf(OPEN_TAG, cursor)
    if (start === -1) break
    if (start > cursor) pieces.push({ type: 'text', text: template.slice(cursor, start) })
    const read = readCommand(template, start, lineStarts)
    if (!read.ok) return { ok: false, failure: read.failure }
    pieces.push({ type: 'command', token: read.token })
    cursor = read.token.end
  }
  if (cursor < template.length) pieces.push({ type: 'text', text: template.slice(cursor) })
  return { ok: true, pieces }
}

/**
 * Read one command that begins at `start`, which is the index of a `<%`.
 *
 * The marker characters are accepted in any order: `<%_*`, `<%_-`, `<%*+` and `<%+-` are just their
 * single-marker forms written the other way round, and refusing one spelling would turn a working
 * template into a parse error a reader cannot explain. What is *not* accepted is a space between `<%`
 * and its markers, because the Rust parser reads the character immediately after the tag and every
 * documented example writes them adjacent; `<% *x* %>` therefore stays an interpolation, which is what
 * the person who wrote it means by it.
 */
function readCommand(
  template: string,
  start: number,
  lineStarts: number[],
): { ok: true; token: CommandToken } | { ok: false; failure: ParseFailure } {
  let index = start + OPEN_TAG.length
  let whitespaceBefore: WhitespaceRule = 'none'
  let whitespaceAfter: WhitespaceRule = 'none'
  let execution = false
  let dynamic = false

  for (;;) {
    const marker = template[index]
    // The one marker a reader may have seen in upstream's dead regex, named here so the failure says
    // which character was refused rather than leaving them to hunt for it.
    if (marker === '~') return { ok: false, failure: invalidFailure(start, lineStarts) }
    if (marker === '-' && whitespaceBefore === 'none') {
      whitespaceBefore = 'newline'
      index += 1
      continue
    }
    if (marker === '_' && whitespaceBefore === 'none') {
      whitespaceBefore = 'all'
      index += 1
      continue
    }
    if (marker === '*' && !execution) {
      execution = true
      index += 1
      continue
    }
    if (marker === '+' && !dynamic) {
      dynamic = true
      index += 1
      continue
    }
    break
  }

  const close = findClosingTag(template, index)
  if (close === -1) return { ok: false, failure: unclosedFailure(start, lineStarts) }

  // A whitespace marker belongs to the tag, not to the code, so it is read off the end of the body first.
  // The guard matters: in `<%-%>` the single dash already served as the opening marker, and letting it
  // close the command as well would give one character two jobs and slice the body backwards.
  let bodyEnd = close
  if (close - 1 >= index) {
    const tail = template[close - 1]
    if (tail === '-' || tail === '_') {
      whitespaceAfter = tail === '-' ? 'newline' : 'all'
      bodyEnd = close - 1
    }
  }
  const end = close + CLOSE_TAG.length
  const position = positionOf(lineStarts, start)

  return {
    ok: true,
    token: {
      kind: dynamic ? 'dynamic' : execution ? 'execute' : 'interpolate',
      execution,
      body: template.slice(index, bodyEnd),
      raw: template.slice(start, end),
      whitespaceBefore,
      whitespaceAfter,
      origin: start,
      end,
      line: position.line,
      column: position.column,
    },
  }
}

/**
 * The next `%>` that closes a command, skipping what cannot end one.
 *
 * A quote-aware scan is not decoration: `<%* tR += "a%>b" %>` is a command an author can write, and a
 * scanner that stopped at the first `%>` inside it would report the whole template as unclosed — a failure
 * the reader cannot see the reason for. Strings of all three quote kinds and both comment forms are stepped
 * over whole, which also covers a delimiter inside a template literal's `${ … }`. What is left over is a
 * `/`, which cannot be resolved into a regex or a division without the JavaScript parser this file
 * deliberately does not have, so a literal `%>` inside a regex still closes the command. Both that limit and
 * the one of an unterminated quote (which ends the scan and reports the command unclosed, loudly) are
 * asserted in the tests rather than left as a rumour.
 */
function findClosingTag(template: string, from: number): number {
  let index = from
  let quote: string | null = null
  let inLineComment = false
  let inBlockComment = false
  while (index < template.length) {
    const char = template[index]
    const next = template[index + 1]
    if (inLineComment) {
      if (char === '\n') inLineComment = false
      index += 1
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (quote !== null) {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      inLineComment = true
      index += 2
      continue
    }
    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      index += 1
      continue
    }
    if (char === '%' && next === '>') return index
    index += 1
  }
  return -1
}

/**
 * Turn the pieces into segments, applying whitespace control on the way.
 *
 * Whitespace lives outside a command, so the two rules can only be applied once every command is known:
 * each marker edits the text next to it, and text a marker empties completely is dropped instead of being
 * carried along as an empty string the compiler would then emit as `tR += ""`.
 */
function assemble(pieces: Piece[]): TemplaterParseResult {
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]
    if (piece.type !== 'command') continue
    const { whitespaceBefore, whitespaceAfter } = piece.token
    if (whitespaceBefore !== 'none') {
      const previous = pieces[index - 1]
      if (previous && previous.type === 'text') {
        previous.text = whitespaceBefore === 'all' ? trimEndWhitespace(previous.text) : trimOneNewlineEnd(previous.text)
      }
    }
    if (whitespaceAfter !== 'none') {
      const following = pieces[index + 1]
      if (following && following.type === 'text') {
        following.text = whitespaceAfter === 'all' ? trimStartWhitespace(following.text) : trimOneNewlineStart(following.text)
      }
    }
  }

  const segments: ParserSegment[] = []
  const commands: CommandToken[] = []
  const dynamicCommands: DynamicCommand[] = []
  for (const piece of pieces) {
    if (piece.type === 'text') {
      if (piece.text !== '') segments.push({ kind: 'text', text: piece.text })
      continue
    }
    const token = piece.token
    commands.push(token)
    if (token.kind === 'dynamic') {
      // Left as the author wrote it, so the preview pass has the same command to read.
      segments.push({ kind: 'text', text: token.raw })
      dynamicCommands.push({
        body: token.body,
        execution: token.execution,
        raw: token.raw,
        origin: token.origin,
        line: token.line,
        column: token.column,
      })
      continue
    }
    segments.push(
      token.kind === 'interpolate'
        ? { kind: 'interpolate', expression: token.body, origin: token.origin, line: token.line }
        : { kind: 'execute', body: token.body, origin: token.origin, line: token.line },
    )
  }

  const first = commands[0]
  return {
    // The frozen shape carries one origin and line for the whole output; the only reading that means
    // something for a template of several commands is the first one, which is where a reader who is
    // told "this template did not parse" wants the editor to put them.
    origin: first ? first.origin : 0,
    line: first ? first.line : 1,
    segments,
    commands,
    dynamicCommands,
  }
}

function trimEndWhitespace(text: string): string {
  return text.replace(/\s+$/, '')
}

function trimStartWhitespace(text: string): string {
  return text.replace(/^\s+/, '')
}

/** One newline, and only one: `\r\n` counts as the newline it is, not as two characters to remove. */
function trimOneNewlineEnd(text: string): string {
  if (!text.endsWith('\n')) return text
  const withoutNewline = text.slice(0, -1)
  return withoutNewline.endsWith('\r') ? withoutNewline.slice(0, -1) : withoutNewline
}

function trimOneNewlineStart(text: string): string {
  if (text.startsWith('\r\n')) return text.slice(2)
  if (text.startsWith('\n')) return text.slice(1)
  return text
}

function collectLineStarts(text: string): number[] {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1)
  }
  return starts
}

/** Line and column of an offset, both 1-based, found by walking the line starts. */
function positionOf(lineStarts: number[], offset: number): { line: number; column: number } {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (lineStarts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 }
}

function unclosedFailure(origin: number, lineStarts: number[]): ParseFailure {
  const position = positionOf(lineStarts, origin)
  return {
    code: 'parse-unclosed',
    line: position.line,
    column: position.column,
    detail: `${position.line}:${position.column}`,
  }
}

function invalidFailure(origin: number, lineStarts: number[]): ParseFailure {
  const position = positionOf(lineStarts, origin)
  return {
    // The character the template used, because that is the thing the reader has to go and change; the
    // position rides on its own two fields.
    code: 'parse-invalid',
    line: position.line,
    column: position.column,
    detail: "'~'",
  }
}
