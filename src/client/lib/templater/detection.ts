/**
 * Which engine a template belongs to, and what it can do, read off the text alone.
 *
 * The library holds two template languages: this app's own `{{ token }}` form, which predates the
 * Templater port and has readers' saved notes in it, and Templater's `<% %>` form. A per-record engine
 * flag would have to be added to the database row, the backup export, the community gallery payload and
 * the local cache validation — four places to keep in step — to record something that is already
 * determined by the content. So it is derived instead: a body containing a Templater command runs
 * through Templater, anything else keeps the old renderer.
 *
 * Deriving it has one real cost, stated rather than hidden: a note that mentions `<%` without meaning a
 * command (writing about Templater in a template's description, say) switches engines and its `{{ … }}`
 * tokens stop expanding. That is why the gallery shows a badge for the detected engine — the reader can
 * see which way a template went before applying it.
 */

/** The two engines the library can render. */
export type TemplateEngine = 'templater' | 'legacy'

/**
 * A Templater command opener.
 *
 * `<%`, `<%*`, `<%-`, `<%_`, `<%+` and their `~`-free combinations all begin a command; the closing tag
 * is irrelevant here, since an unbalanced opener is a parse error the engine reports rather than a
 * reason to silently fall back to the other language.
 */
const COMMAND_OPEN = /<%[*_+~-]?/

/** Execution commands — the form that runs arbitrary JavaScript rather than interpolating a value. */
const EXECUTION = /<%[*~]/

/** Calls into the reader's user scripts, which are JavaScript files of their own. */
const USER_SCRIPTS = /\btp\.user\b/

/** Calls that leave the machine. */
const NETWORK = /\btp\.web\b/

/** Where the text first looks like a Templater command, or `null` when it does not. */
export function findCommandStart(content: string): number {
  const match = COMMAND_OPEN.exec(content)
  return match ? match.index : -1
}

/** Which engine renders this body. Empty text is the legacy engine: nothing to run, nothing to detect. */
export function detectEngine(content: string): TemplateEngine {
  return findCommandStart(content) === -1 ? 'legacy' : 'templater'
}

/**
 * What a reader is taking on by running this template.
 *
 * `executable` covers everything the sandbox has to stop: execution commands, user scripts and network
 * calls alike mean the text is code, not data, and the community gallery's "use directly" path is
 * restricted on exactly that basis. The three are kept apart because the warnings differ — a template
 * that touches `tp.web` sends the note's contents somewhere, which is not the same exposure as one that
 * runs a local script.
 */
export interface TemplateRisk {
  engine: TemplateEngine
  executable: boolean
  userScripts: boolean
  network: boolean
}

export function templateRisk(content: string): TemplateRisk {
  return {
    engine: detectEngine(content),
    executable: EXECUTION.test(content) || USER_SCRIPTS.test(content) || NETWORK.test(content),
    userScripts: USER_SCRIPTS.test(content),
    network: NETWORK.test(content),
  }
}
