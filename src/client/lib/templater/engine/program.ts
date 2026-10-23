/**
 * The program compiler: a parsed template turned into one async function body, as source text.
 *
 * This file produces JavaScript and never runs it. Execution belongs to the QuickJS VM in `../worker`,
 * whose whole design (memory, stack and instruction limits, no host bindings) rests on the template being
 * an ordinary program it can hand to `evalCode`; compiling to a *string* is what keeps this module free of
 * `eval`, `new Function` and the CSP argument that comes with them.
 *
 * The shape is one wrapper around every command, not one evaluation per command:
 *
 * ```js
 * (async () => {
 *   let tR = "";
 *   tR += "prose…";
 *   tR += String(await (tp.date.now()));
 *   if (tp.file.title == "MyFile") {
 *   tR += "…";
 *   }
 *   return tR;
 * })()
 * ```
 *
 * Three of Templater's rules make the single body necessary rather than merely tidy. A `function` or `let`
 * declared in one execution command has to be visible to the later ones, which a command-by-command eval
 * cannot express. An execution command may leave a brace open and close it in the next one, which only
 * parses as one program. And `tR` has to be readable, writable and resettable (`tR = ""` discards what the
 * engine produced so far) from inside the template's own code, so it is a `let` of this function rather
 * than a value threaded through calls. Interpolations get an `await` the author did not write, which is
 * how `<% tp.file.exists(x) %>` answers without any ceremony.
 *
 * Two consequences are worth stating because they are the reasons the code below looks the way it does.
 * Text goes through `JSON.stringify` and nothing else, so prose can hold a quote, a backtick, `${` or a
 * `</script>` and still only ever be a string literal. And every emitted line remembers which command it
 * came from, because a VM error names a line of *this generated text*, and the reader wrote a template —
 * `templatePositionFor` is what turns one into the other.
 */
import type { ParseFailure, ParserOutput, ProgramLine, ProgramSource } from '../protocol'
import { parseTemplate } from './parser'

/** The wrapper lines, written out once so the prologue and the epilogue cannot drift from each other. */
const PROLOGUE = ['(async () => {', '  let tR = "";']
const EPILOGUE = ['  return tR;', '})()']

/**
 * Named so a stack trace produced by a host that reads this comment can say where the code came from.
 *
 * QuickJS itself takes the script name from `evalCode`'s second argument and ignores this line; it is here
 * because the same string is what a developer pastes into a browser console, and there the name is not
 * decoration.
 */
const SOURCE_URL = '//# sourceURL=templater-template.js'

/** Where one command's generated text begins and ends, both 1-based and inclusive. */
export interface ProgramSpan {
  /** Index into `ProgramSource.lineMap`. */
  command: number
  startLine: number
  endLine: number
}

/**
 * A compiled template, as the frozen contract asks for it plus the line table only the compiler has.
 *
 * The extra fields are plain data, so a host that serialises a program across a boundary can carry the
 * table with it instead of keeping the compiler resident on both sides.
 */
export interface CompiledProgram extends ProgramSource {
  /** Sorted by `command`, and each span's lines are disjoint. */
  spans: ProgramSpan[]
}

/** What compiling one template produced: the program, or the reason there is none. */
export type CompileResult = { ok: true; program: CompiledProgram } | { ok: false; failure: ParseFailure }

export function compileTemplate(template: string): CompileResult {
  const parsed = parseTemplate(template)
  if (!parsed.ok) return { ok: false, failure: parsed.failure }
  return { ok: true, program: compileProgram(parsed.output, template) }
}

/**
 * Compile a parse result into a program.
 *
 * Takes the frozen `ParserOutput` rather than this package's richer one, so anything that can produce the
 * contract (a template stored already split, a test feeding segments in) compiles here unchanged. The
 * template text is required, not optional: it is what a line number is measured against, and the reported
 * position has to mean the template the reader is looking at.
 */
export function compileProgram(output: ParserOutput, template: string): CompiledProgram {
  const lineStarts = collectLineStarts(template)
  const lines: string[] = [...PROLOGUE]
  const spans: ProgramSpan[] = []
  const lineMap: ProgramLine[] = []

  // A command's text is emitted as written, newlines included, so that a line of the program inside a
  // multi-line command is the same distance from the line the tag opened on as it is in the template.
  const emit = (text: string): void => {
    for (const line of text.split('\n')) lines.push(line)
  }

  for (const segment of output.segments) {
    if (segment.kind === 'text') {
      emit(`  tR += ${stringLiteral(segment.text)};`)
      continue
    }
    const command = lineMap.length
    // The line comes from the parser, which counted it while reading; the column does not exist in
    // `ProgramSegment`, so it is measured off the template text this program is paired with.
    lineMap.push({ command, line: segment.line, column: positionOf(lineStarts, segment.origin).column })

    // Every command gets at least one generated line, even a blank one, so the span table stays a
    // complete index: a command with no line of its own is a command a later error cannot be traced to.
    const startLine = lines.length + 1
    emit(segment.kind === 'interpolate' ? interpolateStatement(segment.expression) : executeStatement(segment.body))
    spans.push({ command, startLine, endLine: lines.length })
  }

  emit(EPILOGUE.join('\n'))
  emit(SOURCE_URL)

  return {
    source: lines.join('\n'),
    template,
    lineMap,
    // How many commands this program runs, which is what a caller counts before anything is executed. The
    // `ProgramSource` note on this field calls it a byte length, and that is the wrong measure for a cap:
    // bytes of generated text say nothing about what the template does, while the command count does.
    commandCount: lineMap.length,
    spans,
  }
}

/**
 * Where a line of the generated program sits in the template.
 *
 * A VM error carries a line of `source`, which is a different document from the one the reader wrote: the
 * wrapper's own lines have no template behind them (`null` is the honest answer, and the caller says "the
 * program as a whole" rather than inventing a line), and inside a command the offset from the line the tag
 * opened on is the offset in the template, because an execution body is emitted verbatim and keeps its own
 * newlines.
 */
export function templatePositionFor(program: CompiledProgram, generatedLine: number): ProgramLine | null {
  const span = program.spans.find((candidate) => generatedLine >= candidate.startLine && generatedLine <= candidate.endLine)
  if (!span) return null
  const origin = program.lineMap[span.command]
  if (!origin) return null
  return { command: origin.command, line: origin.line + (generatedLine - span.startLine), column: origin.column }
}

/**
 * An interpolation, awaited and stringified.
 *
 * `String()` rather than a bare `+=` so a number, an array or an object reaches the note the way the
 * language says it does — `undefined` prints as `undefined` instead of silently vanishing, which is the
 * difference between a template that reads as broken and one that is.
 */
function interpolateStatement(expression: string): string {
  if (expression.trim() === '') return '  tR += "";'
  return `  tR += String(await (${expression}));`
}

/** A blank execution command emits an empty statement: it ran, and there was nothing for it to do. */
function executeStatement(body: string): string {
  const trimmed = body.trim()
  if (trimmed === '') return '  ;'
  return `  ${body}`
}

/**
 * A text segment as a string literal that cannot stop being one.
 *
 * `JSON.stringify` handles the quotes, the backslashes and the control characters; the pass after it covers
 * the three that are worth naming. `<` is for the other audience, since a program string can end up inside
 * an HTML script tag, a log line or a copied console paste, and a literal `</script>` in a note would close
 * the element out from under it. The two line separators are for the line table: JavaScript counts them as
 * line breaks, so one left raw would make the interpreter count a line the compiler never emitted, and every
 * position reported after it would be one off. An escape sequence inside a double quoted literal means the
 * same character to the interpreter, so nothing about the note changes.
 */
function stringLiteral(text: string): string {
  return JSON.stringify(text).replace(/[\u2028\u2029<]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function collectLineStarts(text: string): number[] {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1)
  }
  return starts
}

/** Line and column of an offset in the template, both 1-based, found by walking the line starts. */
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
