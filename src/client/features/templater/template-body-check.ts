/**
 * What the engine reads in a template body, without running it.
 *
 * The body editor asks for a preview, and a Templater run cannot answer that from here.
 * `lib/templater/host/run-template.ts` renders *into a note*, through the one page host the app installs
 * (`features/templater/run-shell.ts` says why a second host would be two capability checks and two write
 * paths that can disagree), and every effect a template can ask for — a prompt, a file, the network — is
 * a port on that host. A preview that ran would therefore either write a note the reader never asked for
 * or quietly refuse the half of the template that matters.
 *
 * So this answers the narrower question that *is* answerable in the page, with the same lexer a run uses:
 * did the whole body read, where did it stop if it did not, and which commands did it find. The answer is
 * the reader's own text back to them, never a rendering of it. `parseTemplate` is plain data in, plain data
 * out, which is what makes calling it on untrusted text safe: nothing executes, nothing writes, nothing is
 * asked of the reader, nothing leaves the machine.
 */
import { parseTemplate } from '../../lib/templater/engine/parser'
import type { ParseFailure } from '../../lib/templater/protocol'

/**
 * How many commands one report lists.
 *
 * A body of a few thousand commands is a machine-written file, and the dialog should not mount a row per
 * command for it. The count the report carries is the whole body's, so what was left off is still said.
 */
const MAX_LISTED_COMMANDS = 40

/** One command, in the form the reader can navigate to it with. */
export interface TemplateCommandRow {
  /** 1-based, the way the engine and every editor in this app count lines. */
  line: number
  /** The command exactly as written, `<%` through `%>`. */
  text: string
}

export interface TemplateBodyReport {
  /** Whether the whole body read as Templater. */
  parsed: boolean
  /** Which of the two failures it was and where, or null when the body parsed. */
  failure: ParseFailure | null
  /** The commands read, in source order, listed up to `MAX_LISTED_COMMANDS`. */
  commands: TemplateCommandRow[]
  /** How many commands the body holds, listed or not. */
  total: number
}

/**
 * Read a template body the way a run would, and report what was found.
 *
 * The engine walks left to right and stops at the first command it cannot read, so a failure means the
 * commands before it were fine and the position is the reader's next place to look. Earlier commands are
 * not listed beside a failure: the editor already paints the ones that parsed, and a report that disagreed
 * with the text on screen would be the worse of the two.
 */
export function describeTemplateBody(body: string): TemplateBodyReport {
  const parse = parseTemplate(body)
  if (!parse.ok) return { parsed: false, failure: parse.failure, commands: [], total: 0 }
  const commands = parse.output.commands.map((command): TemplateCommandRow => ({
    line: command.line,
    text: command.raw,
  }))
  return {
    parsed: true,
    failure: null,
    commands: commands.slice(0, MAX_LISTED_COMMANDS),
    total: commands.length,
  }
}
