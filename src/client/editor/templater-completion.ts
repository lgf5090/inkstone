/**
 * Templater completion for the note editor.
 *
 * The registry in `lib/templater/reference` is the only list of names this file reads. The syntax-reference
 * panel and these tooltips are two surfaces a reader compares, and a second table of function names is
 * precisely how they start disagreeing, so every row here is built from `REFERENCE_ENTRIES` and
 * `REFERENCE_MODULES` at request time.
 *
 * A member is offered only when the registry documents that exact path (`tp.file.rename`), which is what
 * keeps `tp.user.` and `tp.frontmatter.` from inventing members: the names under those are the reader's own
 * scripts and the note's own keys, so nothing here can enumerate them, and the module's own description says
 * the list cannot be closed.
 *
 * Documentation depth follows the reader's `templater.intellisenseRender` setting. It arrives as a closure
 * because this module must not reach for the settings store, and reading it per request is what makes a
 * change land on the next keystroke instead of on the next editor rebuild.
 *
 * The document is never scanned whole. The question "is the caret inside a command" is answered by one
 * `parseTemplate` call over a bounded window ending at the caret, which is also the only text the typed path
 * is matched against — the same engine a run uses, so a `%>` inside a string and a tag that is still open
 * mid-typing are read the way the interpreter reads them.
 */
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import { DEFAULT_SETTINGS, TEMPLATER_INTELLISENSE_RENDER } from '@shared/constants'
import type { TemplaterIntellisenseRender } from '@shared/types'
import { truncateText } from '@shared/text-utils'
import { t } from '../lib/i18n'
import { parseTemplate } from '../lib/templater/engine/parser'
import { capabilitiesFor, type CapabilityProfile, type Capabilities } from '../lib/templater/protocol'
import {
  REFERENCE_ENTRIES,
  REFERENCE_MODULES,
  referenceIsAvailable,
  referenceIsMember,
  referenceModuleDoc,
  type ReferenceDocEntry,
  type ReferenceModuleDoc,
} from '../lib/templater/reference/registry'

/**
 * How far back from the caret an open command may be traced.
 *
 * A command body longer than this is a miss rather than a wrong answer: the window would start inside it,
 * the parse would find no `<%` left open, and the tooltip would simply not come.
 */
const TAG_WINDOW_CHARACTERS = 2_000

/** The rows live in a fixed-width tooltip whose detail column cannot wrap, so prose is clipped here. */
const DETAIL_MAX_CHARACTERS = 48

/** `tp`, `tp.file`, `tp.file.ren`: the chain the caret sits at the end of, and nothing before it. */
const ACCESS_PATH = /(?:^|[^.\w$])tp((?:\.[\w$]+)*)\.?$/

/** What is being completed: the modules, or the members of one named module. */
interface TypedPath {
  /** Null while the module itself is the thing being typed. */
  module: string | null
  /** The script a `tp.user.<script>.` chain is asking the members of. Null for every other path. */
  script: string | null
  /** The part of the name already in the note: the replacement range starts here. */
  partial: string
}

/**
 * The shape a completion leaves behind, read off the registry's signature.
 *
 * `no-args` and `with-args` both arrive as a call; only where the caret lands differs, and a value must not
 * grow parentheses it cannot be called with.
 */
type CallShape = 'value' | 'no-args' | 'with-args'

export interface TemplaterCompletionOptions {
  /** The reader's `templater.intellisenseRender`, read on every request. */
  intellisenseRender: () => string
  /** Whether completion is offered at all. Defaults to on: the switch belongs to the caller. */
  enabled?: () => boolean
  /**
   * Which capability profile a run of this note would get.
   *
   * Optional because the note editor already knows it is the reader's own note. Where it is given — a
   * community template in the template editor — a member the profile would refuse is still completed, since
   * the reader is writing rather than running, and is marked in the documentation panel instead.
   */
  profile?: () => CapabilityProfile
  /**
   * The reader's own scripts, as the page can see them without running them.
   *
   * Absent by default because the editor half may not reach a store: the note editor and the template body
   * editor both hand this over from `features/templater/completion-surface.ts`. With no source the `tp.user`
   * chain offers nothing, which is the honest list for a reader who has not chosen a script folder.
   */
  userScripts?: TemplaterScriptSource
}

/**
 * The two questions the `tp.user` chain asks the page.
 *
 * Split rather than one call returning a tree, because the first is answered by a folder listing and the
 * second by reading one note and scanning its text: completing `tp.user.` must not cost a read per script,
 * and completing `tp.user.helper.` must not read the rest of the folder.
 */
export interface TemplaterScriptSource {
  /** Every name the script folder holds, in any order — this file sorts nothing. */
  names: () => Promise<string[]>
  /** The callable members of one object-exporting script; empty for a function export or an unreadable one. */
  members: (name: string) => Promise<string[]>
}

/** The shipped default, taken from the settings table rather than restated here. */
const FALLBACK_RENDER = DEFAULT_SETTINGS.templater.intellisenseRender

/** An unreadable stored value falls back to the default rather than silencing the documentation. */
function renderLevel(raw: string): TemplaterIntellisenseRender {
  const known = TEMPLATER_INTELLISENSE_RENDER as readonly string[]
  return known.includes(raw) ? raw as TemplaterIntellisenseRender : FALLBACK_RENDER
}

/**
 * The three things the reader's level decides, one predicate each, as upstream spells them.
 *
 * `Autocomplete.ts:119-135` asks these three questions per suggestion, and the levels are the answers'
 * combinations (`RenderSettings/IntellisenseRenderOption.ts:5-9`): `1` shows all three, `2` drops the return,
 * `3` drops the parameters, `4` keeps only the description, `0` shows nothing. The signature and, for a
 * dynamic module, its caveat are not gated — the call itself is the one thing a completion has to say.
 * Examples are not part of this ladder upstream either, so they belong to the reference panel, not here.
 */
const rendersDescription = (level: TemplaterIntellisenseRender): boolean => level !== '0'
const rendersParameters = (level: TemplaterIntellisenseRender): boolean => level === '1' || level === '2'
const rendersReturns = (level: TemplaterIntellisenseRender): boolean => level === '1' || level === '3'

/**
 * The text between a bounded window and the caret, when the caret sits inside an unclosed command.
 *
 * The window stops at the caret on purpose: a command still open there is exactly what the engine reports as
 * `parse-unclosed`, and its left-to-right walk is what decides whether an earlier `<%` — one inside a string,
 * or one a previous command already closed — counts. Deciding that here instead would be a second parser.
 */
function commandWindow(state: EditorState, pos: number): string | null {
  const window = state.sliceDoc(Math.max(0, pos - TAG_WINDOW_CHARACTERS), pos)
  if (!window.includes('<%')) return null
  const parse = parseTemplate(window)
  if (parse.ok) return null
  return parse.failure.code === 'parse-unclosed' ? window : null
}

/** Which list the caret is asking for, or nothing when the text there is not a `tp` chain. */
function pathBeforeCaret(text: string): TypedPath | null {
  const matched = ACCESS_PATH.exec(text)
  if (!matched) return null
  const segments = (matched[1] ?? '').split('.').filter(Boolean)
  // The match runs to the caret, so a trailing dot can only be the one the reader just typed.
  const afterDot = text.endsWith('.')
  if (segments.length === 0) return afterDot ? { module: null, script: null, partial: '' } : null
  if (segments.length === 1) {
    return afterDot
      ? { module: segments[0]!, script: null, partial: '' }
      : { module: null, script: null, partial: segments[0]! }
  }
  // `tp.user.<script>.` is the one two-level chain the editor can answer, and only because the reader's own
  // scripts are a list the page can hand over. Every other module's second level is either a placeholder the
  // registry refuses to write (`tp.frontmatter.<key>`) or the app facade, whose members are documented one
  // level up as flat rows — `tp.app.` already offers `vault.read` — so there is no second list to open here.
  if (segments.length === 2 && afterDot && segments[0] === 'user') {
    return { module: 'user', script: segments[1]!, partial: '' }
  }
  if (segments.length === 2 && !afterDot) return { module: segments[0]!, script: null, partial: segments[1]! }
  // Past two segments the registry has nothing to say either: a row is a member path rather than a chain this
  // file walks, so a third dot answers nothing instead of guessing at what the reader meant.
  return null
}

/** The entry documenting the module as a value — `tp.moment` is moment's function, not a namespace. */
function selfEntry(module: string): ReferenceDocEntry | null {
  return REFERENCE_ENTRIES.find((entry) => entry.module === module && entry.name === module) ?? null
}

/**
 * Whether the registry documents a callable, and whether it takes anything.
 *
 * Read off the parenthesis in the signature rather than off the path, because `moment(input?)` documents
 * `tp.moment` itself and still describes a call.
 */
function callShapeOf(entry: ReferenceDocEntry): CallShape {
  const open = entry.signature.indexOf('(')
  if (open === -1) return 'value'
  return entry.signature.slice(open + 1).trimStart().startsWith(')') ? 'no-args' : 'with-args'
}

/** One block per line: the tooltip's own element keeps no whitespace, so newlines alone would collapse. */
function infoBlock(lines: readonly string[], codeLines: ReadonlySet<number>): Node {
  const block = document.createDocumentFragment()
  lines.forEach((line, index) => {
    const row = document.createElement(codeLines.has(index) ? 'code' : 'div')
    row.textContent = line
    block.append(row)
  })
  return block
}

/** A member's documentation: the call, then the parts the reader's level asks for. */
function memberLines(
  entry: ReferenceDocEntry,
  module: ReferenceModuleDoc,
  level: TemplaterIntellisenseRender,
  capabilities: Capabilities | null,
): { lines: string[], code: Set<number> } {
  const lines = [entry.signature]
  const code = new Set([0])
  // A dynamic module's blurb is the caveat that the list below it is not a boundary, so it leads.
  if (module.dynamic) lines.push(t(module.descriptionKey))
  if (rendersDescription(level)) lines.push(t(entry.descriptionKey))
  if (rendersParameters(level)) {
    for (const arg of entry.args) lines.push(`${arg.name}: ${t(arg.descriptionKey)}`)
  }
  if (rendersReturns(level) && entry.returnsKey) lines.push(t(entry.returnsKey))
  if (capabilities && !referenceIsAvailable(entry, capabilities)) lines.push(t('templater.error.capability_blocked'))
  return { lines, code }
}

function moduleLines(
  module: ReferenceModuleDoc,
  self: ReferenceDocEntry | null,
  level: TemplaterIntellisenseRender,
): { lines: string[], code: Set<number> } {
  const lines = [self ? self.signature : `tp.${module.module}`, t(module.descriptionKey)]
  const code = new Set([0])
  if (!self) return { lines, code }
  if (rendersParameters(level)) {
    for (const arg of self.args) lines.push(`${arg.name}: ${t(arg.descriptionKey)}`)
  }
  if (rendersReturns(level) && self.returnsKey) lines.push(t(self.returnsKey))
  return { lines, code }
}

/**
 * Replace the typed part of the path and put the caret where the reader's next keystroke belongs.
 *
 * A function arrives in call form. A parenthesis already sitting after the caret — the one `closeBrackets()`
 * paired when the reader typed `(` — is adopted instead of doubled, which is the same trap
 * `wikiLinkSource` documents for `]]`.
 */
function applyMember(name: string, shape: CallShape): NonNullable<Completion['apply']> {
  return (view, _completion, from, to) => {
    const caret = to ?? from
    const adopts = shape !== 'value' && view.state.sliceDoc(caret, caret + 1) === '('
    const insert = adopts || shape === 'value' ? name : `${name}()`
    // Offsets count from the start of the replacement: the partial name in front of the caret is gone by
    // the time the anchor is read, so adding to the caret would land that many characters too far.
    const onArguments = adopts || shape === 'with-args'
    view.dispatch({
      changes: { from, to: caret, insert },
      selection: { anchor: onArguments ? from + name.length + 1 : from + insert.length },
      userEvent: 'input.complete',
      scrollIntoView: true,
    })
  }
}

/** A module keeps the chain going: the dot is what the next list hangs on. */
function applyModule(name: string): NonNullable<Completion['apply']> {
  return (view, _completion, from, to) => {
    const caret = to ?? from
    const insert = `${name}.`
    view.dispatch({
      changes: { from, to: caret, insert },
      selection: { anchor: from + insert.length },
      userEvent: 'input.complete',
      scrollIntoView: true,
    })
  }
}

/** The modules the registry publishes, in the order the panel lists them. */
function moduleRows(level: TemplaterIntellisenseRender, documented: boolean): Completion[] {
  return REFERENCE_MODULES.map((module, index): Completion => {
    const self = selfEntry(module.module)
    const shape = self ? callShapeOf(self) : 'value'
    return {
      label: module.module,
      type: 'namespace',
      detail: documented ? truncateText(t(module.descriptionKey), DETAIL_MAX_CHARACTERS) : undefined,
      // Assembled when the panel opens rather than per keystroke: a row the reader never selects is
      // documentation they never read.
      info: documented ? () => {
        const built = moduleLines(module, self, level)
        return infoBlock(built.lines, built.code)
      } : undefined,
      boost: REFERENCE_MODULES.length - index,
      apply: self && shape !== 'value' ? applyMember(self.name, shape) : applyModule(module.module),
    }
  })
}

function memberRows(
  module: ReferenceModuleDoc,
  level: TemplaterIntellisenseRender,
  documented: boolean,
  capabilities: Capabilities | null,
): Completion[] {
  const entries = REFERENCE_ENTRIES.filter((entry) => entry.module === module.module && referenceIsMember(entry))
  return entries.map((entry, index): Completion => {
    const shape = callShapeOf(entry)
    return {
      label: entry.name,
      type: shape === 'value' ? 'property' : 'function',
      detail: documented ? truncateText(t(entry.descriptionKey), DETAIL_MAX_CHARACTERS) : undefined,
      info: documented ? () => {
        const built = memberLines(entry, module, level, capabilities)
        return infoBlock(built.lines, built.code)
      } : undefined,
      boost: entries.length - index,
      apply: applyMember(entry.name, shape),
    }
  })
}

/**
 * The rows for `tp.user.`: one per script the reader's folder holds.
 *
 * A script arrives as a bare name rather than in call form, because whether it exports a function or an
 * object of functions is a fact inside its own text, and guessing it here would mean reading every script in
 * the folder to complete one word. What the reader types next decides: a `(` calls it, a `.` asks for members.
 */
function scriptRows(names: string[], documented: boolean): Completion[] {
  return names.map((name, index): Completion => ({
    label: name,
    type: 'function',
    detail: documented ? truncateText(t('templater.completion.user_script'), DETAIL_MAX_CHARACTERS) : undefined,
    boost: names.length - index,
    apply: name,
  }))
}

/** The rows for `tp.user.<script>.`: the callable members of an object export. */
function scriptMemberRows(script: string, members: string[], documented: boolean): Completion[] {
  return members.map((member, index): Completion => ({
    label: member,
    type: 'function',
    detail: documented ? truncateText(t('templater.completion.user_member', { value0: script }), DETAIL_MAX_CHARACTERS) : undefined,
    boost: members.length - index,
    apply: applyMember(member, 'with-args'),
  }))
}

/**
 * The completion source, ready for `autocompletion({ override: [...] })`.
 *
 * A factory with closures rather than a constant, mirroring `templaterHighlight`: the editor is configured
 * once, and every reader setting has to be read when a list is actually asked for.
 */
export function templaterCompletion(options: TemplaterCompletionOptions): CompletionSource {
  const enabled = options.enabled ?? (() => true)
  return (context: CompletionContext): CompletionResult | null | Promise<CompletionResult | null> => {
    if (!enabled()) return null
    const window = commandWindow(context.state, context.pos)
    if (window === null) return null
    const path = pathBeforeCaret(window)
    if (path === null) return null
    const level = renderLevel(options.intellisenseRender())
    const documented = level !== '0'
    const from = context.pos - path.partial.length
    const listed = (rows: Completion[]): CompletionResult => ({ from, options: rows, validFor: /^[\w$]*$/ })
    const userScripts = options.userScripts
    if (userScripts && path.module === 'user') {
      // The one list in this file that is not plain data: a script is a note, so both the names and the
      // members arrive on a later tick, which is what a `CompletionSource` is allowed to return.
      if (path.script === null) {
        return userScripts.names().then((names) => {
          const rows = scriptRows(names, documented)
          return rows.length === 0 ? null : listed(rows)
        })
      }
      const script = path.script
      return userScripts.members(script).then((members) => {
        const rows = scriptMemberRows(script, members, documented)
        return rows.length === 0 ? null : listed(rows)
      })
    }
    const module = path.module === null ? null : referenceModuleDoc(path.module)
    if (path.module !== null && !module) return null
    const capabilities = options.profile ? capabilitiesFor(options.profile()) : null
    const rows = module ? memberRows(module, level, documented, capabilities) : moduleRows(level, documented)
    if (rows.length === 0) return null
    // CodeMirror's own matcher filters these: the lists are the registry's, small and already ordered, so
    // a second ranking path here would only be another thing to keep in step with the panel.
    return listed(rows)
  }
}
