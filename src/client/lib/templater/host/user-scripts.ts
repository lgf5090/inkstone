/**
 * The reader's own scripts, read and described — never run.
 *
 * `tp.user.<script>()` calls into JavaScript the reader wrote. Upstream gets that text into a callable by
 * handing it to the browser: `UserScriptFunctions.ts:19` wraps the body as
 * `(function anonymous(require, module, exports){ … })`, puts it behind a Blob `<script>` tag, and reads the
 * function back off `window`. That path is not available here and would not be allowed even if it were — the
 * app's CSP carries no `unsafe-eval` (`src/worker/lib/security-headers.ts`), and the rule this whole package
 * is built on is that template and script code runs only inside the QuickJS interpreter (`../worker/vm.ts`).
 * So this module is the half that can be done without executing anything: it finds the script note, reads its
 * text, works out *by scanning* which names it exports and what arguments they take, decides whether what the
 * body `require`s is something this app can provide, and turns one `user.script` host call into either a
 * refusal with a code or the plan the worker would have to execute.
 *
 * What is deliberately **not** here: no `new Function`, no `eval`, no `Blob`, no `<script>`, no script
 * evaluation anywhere on the page. A script body leaves this module as a string.
 *
 * There is no filesystem, so a script is a note: whatever the page lists through {@link UserScriptPort} whose
 * title ends in `.js` (plan §D13), with the name being the title without that suffix. The listing is the page's
 * choice — the folder the reader picked, or library rows carrying the same naming — and {@link
 * userScriptNameOf} is the rule it applies, so the two cannot drift. Nothing here opens a store, and no second
 * script table is invented: a script is a note, which means it is already backed up, searched and synced.
 *
 * Two things the frozen wire cannot carry yet, both stated rather than worked around, because inventing a
 * second protocol here would be the more expensive mistake:
 *
 * - **execution.** A `HostResult` value becomes a VM value through `JSON.parse` (`jsonToValue` in
 *   `worker/bootstrap.ts`), so the only thing the page can hand back is data. `answerUserScriptCall`
 *   therefore refuses an otherwise clean call with `not-supported` until `user.script` is answered inside the
 *   worker instead of on the page. The smallest change that finishes it: `TemplateRunContext` gains a script
 *   list (`{ id, name, path, source }[]`, carried only when the run's profile grants `userScripts`, bounded by
 *   `MAX_PROGRAM_BYTES` per file), and `user.script` becomes the third shape of call in
 *   `worker/host-bindings.ts` beside "answered from the snapshot" and "answered by the page" — evaluated in
 *   the interpreter on first use, wrapped as `(function anonymous(require, module, exports){ … })`, cached per
 *   run, and called with the template's arguments, whose promise is settled like any other.
 * - **member calls.** `bootstrap.ts`'s `userNamespace` proxy sends `[name, args]` for the *first* key only, so
 *   `tp.user.my_scripts.one(x)` cannot reach this module with `one` in it. `UserScriptInvocation.members`
 *   exists so the resolution rules are already written when the proxy carries the member path; until then
 *   `decodeUserScriptCall` always yields an empty list.
 *
 * One behaviour is improved against upstream on purpose. Upstream loads *every* script before any template
 * runs, and one file that fails to evaluate throws out of `generate_object()`, taking the whole `tp.user`
 * namespace down for every template. Here a script is read and scanned only when a template names it, and a
 * failure is the answer to that one call (plan §D13, card U4).
 */
import { normalizeVirtualPath } from '../context/note-index'
import type { TemplaterErrorCode } from '../errors'
import type { HostCall, HostResult } from '../protocol'

/** The note-title suffix that makes a note a script, and the extension a `require` resolves to. */
const SCRIPT_EXTENSION = 'js'

/**
 * What a script may `require` by name.
 *
 * Upstream hands the script Obsidian's `window.require` (`UserScriptFunctions.ts:102`), so any Node built-in
 * and anything Electron can resolve works there. There is no Node and no package resolution here: the
 * interpreter's global object has `moment`, and the Obsidian compatibility façade is this port's own
 * `tp.obsidian`/`obsidian` surface. Those two names — plus the script's sibling scripts, which are notes —
 * are everything this app can honour, so the rule is an allowlist and the default answer is refusal.
 */
const ALLOWED_MODULES: readonly string[] = ['moment', 'obsidian']

/** What `require(...)` with anything but a readable string literal is reported as, so it can only be refused. */
const DYNAMIC_REQUIRE = 'dynamic'

/** A name as templates type it: `tp.user.<name>`. The note title, minus its `.js` suffix. */
export type UserScriptName = string

/** A script as the page's store holds it: identifiers and a path, never a store handle. */
export interface UserScriptRecord {
  id: string
  /** The note's own title; the trailing `.js` on it is what makes this note a script. */
  title: string
  /** The note's virtual path (`Scripts/my_script.js`), for messages and for resolving relative `require`s. */
  path: string
}

/**
 * The store access this module needs, injected.
 *
 * Two calls, because those are the two things the job has: list the folder, read one note. Async, because a
 * script note's body may not be in the page's loaded set yet. This module must not import a store — the same
 * rule `context/snapshot.ts` keeps when it takes plain rows instead of reaching for the app's state.
 */
export interface UserScriptPort {
  /** Every note under the reader's chosen script folder, recursively, in any order. */
  listScripts: () => Promise<UserScriptRecord[]>
  /** The stored text of one script note, exactly as saved. */
  readScript: (id: string) => Promise<string>
}

/** A refusal, as the code the interface translates and the data beside it. */
export interface UserScriptFailure {
  ok: false
  code: TemplaterErrorCode
  /** A path, a name, or a `name:token` pair — never prose, per the rule in `../errors.ts`. */
  detail: string
}

/** One documented `@param`, as the reference panel and the completion item show it. */
export interface UserScriptParamDoc {
  name: string
  description: string
}

/** The documentation half of a callable surface. */
export interface UserScriptDocs {
  summary: string
  params: UserScriptParamDoc[]
  returns: string
}

/** One member of an object export: `tp.user.<script>.<name>(…)`. */
export interface UserScriptMember {
  name: string
  /** Whether the text says this value is callable. A member that cannot be seen to be a function is refused. */
  callable: boolean
  params: string[]
  docs: UserScriptDocs
}

/** The kind of export a script's text was found to produce. */
export type UserScriptExportKind = 'function' | 'object' | 'class' | 'none'

/** The surface one script exports, as far as its text can be read without running it. */
export interface UserScriptSurface {
  kind: UserScriptExportKind
  /** Members of an object export, in source order; empty for any other kind. */
  members: UserScriptMember[]
  /** Parameters of a function export; empty for any other kind. */
  params: string[]
  docs: UserScriptDocs
  /**
   * False when a member list may be missing names — a spread, a computed key, an entry the scanner could not
   * read. Upstream gets these right by parsing with `acorn`; this app does not depend on it (plan §D8), so an
   * unseen name is a name that does not exist rather than a guess.
   */
  membersComplete: boolean
  /** Every `require(…)` specifier the body mentions, in source order, duplicates removed. */
  requires: string[]
}

/** A script, its text, and what that text was found to export. */
export interface UserScriptModule {
  id: string
  name: UserScriptName
  path: string
  /** The path a sibling's relative `require` is resolved against: `<folder>/<name>.js`. */
  modulePath: string
  /** The stored text. It travels as a string; nothing here evaluates it. */
  source: string
  surface: UserScriptSurface
}

/** What the template asked for, read off the host call. */
export interface UserScriptInvocation {
  name: UserScriptName
  /** The member path beyond the script name. Always empty on today's wire — see the header. */
  members: readonly string[]
  args: readonly unknown[]
}

/**
 * What the worker would need in order to make the call happen.
 *
 * The shape is also the answer to "what would the protocol have to carry": the source text, where to reach
 * into it, and what to pass. Nothing in here is executable on the page.
 */
export interface UserScriptCallPlan {
  module: UserScriptModule
  members: readonly string[]
  args: readonly unknown[]
  /** The parameter names the reference panel shows for the thing being called. */
  params: readonly string[]
}

export type UserScriptLookup = { ok: true; module: UserScriptModule } | UserScriptFailure
export type UserScriptCallResult = { ok: true; plan: UserScriptCallPlan } | UserScriptFailure

export interface UserScriptProvider {
  /** Read one script's surface: locate it, read it once, scan it. */
  describe: (name: UserScriptName) => Promise<UserScriptLookup>
  /** Resolve one `tp.user` call against that surface, and say what would have to run. */
  prepare: (invocation: UserScriptInvocation) => Promise<UserScriptCallResult>
}

/**
 * The name a note title gives the script namespace, or `null` when the note is not a script.
 *
 * The extension is matched case-insensitively the way upstream matches it (`extension.toLowerCase() ===
 * "js"`), and the rest of the title keeps its case, because `tp.user.<name>` is matched exactly: upstream
 * registers `file.basename`, and a namespace that answered two spellings for one file would be a second rule
 * nobody documented.
 */
export function userScriptNameOf(title: string): UserScriptName | null {
  const trimmed = title.trim()
  if (!trimmed.toLowerCase().endsWith(`.${SCRIPT_EXTENSION}`)) return null
  const stem = trimmed.slice(0, -(SCRIPT_EXTENSION.length + 1)).trim()
  // A separator inside the name could not be typed as a property, and `.`/`..`/empty would make the folder
  // listing claim a path that is not the file it is in.
  if (!stem || stem === '.' || stem === '..' || /[/\\]/.test(stem)) return null
  return stem
}

/**
 * The provider over one run's script folder.
 *
 * Built once per run, which *is* the cache lifetime: the folder listing is read once, and each script note is
 * read at most once — on the first call that names it. A note edited while a template runs keeps the text the
 * first call of that run saw; the next run gets a fresh provider and re-reads. There is no TTL to invalidate,
 * because the unit of validity is the run.
 *
 * The one thing that is *not* kept is a listing that failed. "No such script" is only a script's answer when
 * the folder was actually read, so that case is logged, dropped, and tried again by the next call rather than
 * cached into a refusal the reader could not fix without restarting.
 */
export function createUserScriptProvider(port: UserScriptPort): UserScriptProvider {
  let listing: Promise<{ table: UserScriptIndex; usable: boolean }> | null = null
  // Keyed by name, holding the *promise*: two calls for one script in one run share one read. Every failure
  // is turned into an `{ ok: false }` value before it is stored, so a cached promise never carries an
  // unhandled rejection into a later call.
  const surfaces = new Map<UserScriptName, Promise<UserScriptLookup>>()

  function index(): Promise<{ table: UserScriptIndex; usable: boolean }> {
    if (!listing) {
      listing = port.listScripts().then(
        (records) => ({ table: indexScripts(records), usable: true }),
        (error: unknown) => {
          // A folder listing that failed is the page's problem, not the template's, and it must not be kept:
          // the promise is dropped so the next call asks again, and the reason is logged rather than lost.
          reportCause('user script listing failed', error)
          listing = null
          return { table: emptyIndex(), usable: false }
        },
      )
    }
    return listing
  }

  function describe(name: UserScriptName): Promise<UserScriptLookup> {
    const cached = surfaces.get(name)
    if (cached) return cached
    const pending = index().then(async ({ table, usable }) => {
      const result = await lookupScript(table, name, port)
      // "Not found" is only this script's answer when the listing actually happened. With an unusable
      // listing the entry is removed again, so the retry gets a real folder rather than a cached refusal.
      if (!usable) surfaces.delete(name)
      return result
    })
    surfaces.set(name, pending)
    return pending
  }

  return {
    describe,
    async prepare(invocation) {
      const found = await describe(invocation.name)
      if (!found.ok) return found
      const resolution = resolveCallable(found.module, invocation.members)
      if (!resolution.ok) return resolution
      return {
        ok: true,
        plan: { module: found.module, members: invocation.members, args: invocation.args, params: resolution.params },
      }
    },
  }
}

/**
 * The answer a `user.script` host call gets from this module.
 *
 * Every refusal is one call's failure and carries the script name; nothing is an empty catch. `prepare`
 * answers with a code for everything that can go wrong in the script, and a rejection that still escapes is a
 * bug in this module rather than a template failure — `worker/client.ts` catches that case and reports it as
 * `render-failed` with the original text, so the reply is never lost.
 *
 * A call that resolves cleanly is refused with `not-supported`, because the frozen wire cannot carry
 * evaluation (header). That is the honest current answer for a script this app cannot yet run: the reader is
 * told the template used something the app does not offer, and the detail names the script so they can find it.
 */
export async function answerUserScriptCall(call: HostCall, provider: UserScriptProvider): Promise<HostResult> {
  const decoded = decodeUserScriptCall(call)
  if (!decoded.ok) return failureFor(call, decoded)
  const resolved = await provider.prepare(decoded.invocation)
  if (!resolved.ok) return failureFor(call, resolved)
  return failureFor(call, {
    ok: false,
    code: 'not-supported',
    detail: `${resolved.plan.module.name}:user-script-execution`,
  })
}

/** The call's own identity plus a refusal: the only shape the worker accepts for a call it is waiting on. */
function failureFor(call: HostCall, failure: UserScriptFailure): HostResult {
  return { runId: call.runId, callId: call.callId, ok: false, code: failure.code, detail: failure.detail }
}

/**
 * One `user.script` host call, read as data.
 *
 * The VM side (`userNamespace` in `worker/bootstrap.ts`) sends `[name, args]`, and both halves are whatever a
 * template typed — `tp.user[null](1)` is a thing someone can write. Anything that is not a name and an array
 * of arguments is refused rather than coerced, because guessing here would mean running a different call than
 * the one the template made.
 */
export function decodeUserScriptCall(
  call: HostCall,
): { ok: true; invocation: UserScriptInvocation } | UserScriptFailure {
  const name = call.args[0]
  if (typeof name !== 'string' || !name) return { ok: false, code: 'not-supported', detail: 'user.script:name' }
  const args = call.args[1]
  if (!Array.isArray(args)) return { ok: false, code: 'not-supported', detail: 'user.script:arguments' }
  return { ok: true, invocation: { name, members: [], args } }
}

/**
 * Which thing inside the export the invocation names, and whether it can be called.
 *
 * The two shapes are the ones upstream documents (`docs/src/user-functions/script-user-functions.md`): a
 * script is either one function, or an object whose values are functions and are reachable as one member. A
 * deeper path is refused instead of half-supported, because upstream would hand the template a value that is
 * not a function and fail somewhere with no name in the error.
 */
function resolveCallable(
  module: UserScriptModule,
  members: readonly string[],
): { ok: true; params: readonly string[] } | UserScriptFailure {
  const { surface } = module
  if (members.length === 0) {
    if (surface.kind !== 'function') {
      return { ok: false, code: 'not-supported', detail: `${module.name}:object-export` }
    }
    return { ok: true, params: surface.params }
  }
  if (surface.kind !== 'object') {
    return { ok: false, code: 'not-supported', detail: `${module.name}:function-export` }
  }
  const path = members.join('.')
  if (members.length > 1) return { ok: false, code: 'not-supported', detail: `${module.name}.${path}` }
  const member = surface.members.find((one) => one.name === members[0])
  if (!member) return { ok: false, code: 'not-supported', detail: `${module.name}.${path}` }
  if (!member.callable) {
    return { ok: false, code: 'not-supported', detail: `${module.name}.${member.name}:not-a-function` }
  }
  return { ok: true, params: member.params }
}

/**
 * Locate, read and describe one script.
 *
 * A script that cannot be loaded produces a refusal *value*, never a throw: one bad file must not be able to
 * break every other template, which is where upstream's load loop fails (plan §D13's U4).
 */
async function lookupScript(
  table: UserScriptIndex,
  name: UserScriptName,
  port: UserScriptPort,
): Promise<UserScriptLookup> {
  const conflict = table.conflicts.get(name)
  if (conflict) {
    // Two notes claiming one script name. Upstream's map keeps whichever file sorted last and runs it
    // silently; plan §D13 makes a duplicate an error that names both places, so the reader can fix one.
    return { ok: false, code: 'script-load-failed', detail: `${name}:conflict:${conflict.join(',')}` }
  }
  const entry = table.byName.get(name)
  if (!entry) return { ok: false, code: 'script-load-failed', detail: `${name}:not-found` }
  let source: string
  try {
    source = await port.readScript(entry.id)
  } catch (error) {
    // The store's own words go to the console, where whoever debugs the page can read them; the reader gets
    // the path, which is the thing they can act on. Not re-thrown: this call has an answer, and the run must
    // not lose its reply.
    reportCause(`user script read failed: ${entry.path}`, error)
    return { ok: false, code: 'script-load-failed', detail: entry.path }
  }
  const surface = scanUserScript(source)
  if (surface.kind === 'none') {
    // Upstream's own words for this are "No exports detected."; the detail keeps the name and the token.
    return { ok: false, code: 'script-load-failed', detail: `${name}:no-export` }
  }
  // Upstream can register a class export because it only asks `typeof exported === "function"`; calling it
  // then throws inside the interpreter, and `new` cannot reach through the VM's proxy either. Refusing at
  // load names the file instead of leaving a template to a constructor error.
  if (surface.kind === 'class') return { ok: false, code: 'not-supported', detail: `${name}:class-export` }
  const denied = firstDeniedRequire(surface.requires, entry.modulePath, table.modulePaths)
  if (denied) return { ok: false, code: 'script-require-denied', detail: `${name}:${denied}` }
  return {
    ok: true,
    module: { id: entry.id, name, path: entry.path, modulePath: entry.modulePath, source, surface },
  }
}

/** One script, as the folder listing sees it. */
interface ScriptEntry {
  id: string
  name: UserScriptName
  path: string
  modulePath: string
}

interface UserScriptIndex {
  byName: Map<UserScriptName, ScriptEntry>
  /** Names claimed by more than one note, with the paths that collided. */
  conflicts: Map<UserScriptName, string[]>
  /** Every script's `modulePath`, which is what a relative `require` has to land on. */
  modulePaths: Set<string>
}

/**
 * The folder listing, keyed for lookup.
 *
 * `Map`s and a `Set`, never a plain object: a script name arrives from a template, and `tp.user.__proto__`
 * written against an object literal would otherwise read a prototype property as a script.
 */
function indexScripts(records: UserScriptRecord[]): UserScriptIndex {
  const table = emptyIndex()
  for (const record of records) {
    const name = userScriptNameOf(record.title)
    if (name === null) continue
    const path = normalizeVirtualPath(record.path) || record.title
    const entry: ScriptEntry = {
      id: record.id,
      name,
      path,
      // The module path is the identity a sibling's `require('./name.js')` resolves against. It is derived
      // from the name rather than taken from the note's own virtual path, because a note title keeps its
      // `.js` and this app's projection adds `.md` on top of it (`context/file-wrapper.ts`).
      modulePath: joinPath(parentOf(path), `${name}.${SCRIPT_EXTENSION}`),
    }
    const existing = table.byName.get(name)
    if (existing) {
      // The same note listed twice is the page's duplicate row, not a conflict. Two different notes are.
      if (existing.id === entry.id || existing.path === entry.path) continue
      const known = table.conflicts.get(name) ?? [existing.path]
      if (!known.includes(entry.path)) known.push(entry.path)
      table.conflicts.set(name, known)
      continue
    }
    table.byName.set(name, entry)
    table.modulePaths.add(entry.modulePath)
  }
  return table
}

function emptyIndex(): UserScriptIndex {
  return { byName: new Map(), conflicts: new Map(), modulePaths: new Set() }
}

/** A path's folder, or `''` for the root — the same shape `context/snapshot.ts` gives a note with no folder. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function joinPath(folder: string, name: string): string {
  return normalizeVirtualPath(folder ? `${folder}/${name}` : name)
}

/**
 * A relative `require` resolved against the folder of the script that wrote it.
 *
 * `normalizeVirtualPath` deliberately leaves `.` and `..` alone, because the note index wants the path as the
 * reader wrote it. Here the segments have to be walked: `./helper.js` from `Scripts/x.js` is
 * `Scripts/helper.js`, and nothing else can match the listing.
 *
 * A `..` that would climb past the root is dropped rather than kept, which is safe only because of what the
 * listing is: {@link UserScriptPort.listScripts} hands over the notes of one folder the reader picked (plan
 * §D13), so every path that can match is inside that folder already. A specifier that walks out and back in
 * can therefore only name another script the reader chose — there is no path by which a note outside the
 * folder becomes reachable, because a note outside it is never in the set.
 */
function resolveRelativePath(folder: string, specifier: string): string {
  const cleaned = normalizeVirtualPath(specifier)
  const segments = `${folder ? `${folder}/` : ''}${cleaned}`
    .split('/')
    .filter((one) => one !== '' && one !== '.')
  const walked: string[] = []
  for (const segment of segments) {
    if (segment === '..') {
      walked.pop()
      continue
    }
    walked.push(segment)
  }
  return walked.join('/')
}

/**
 * The first `require` specifier this app cannot provide, or `null` when every one of them is fine.
 *
 * Checked when the script is loaded rather than when the call reaches the line, because a text scanner has no
 * idea which branch runs. Upstream's `require` is live, so a script that only touches `fs` on a path never
 * taken works there and is refused here. Refusing is the conservative reading of a body this module does not
 * execute: the reader learns about the module from the template that names the script, not from what an
 * untaken branch would have done.
 */
function firstDeniedRequire(requires: string[], fromModulePath: string, known: Set<string>): string | null {
  for (const specifier of requires) {
    if (!resolveRequire(specifier, fromModulePath, known)) return specifier
  }
  return null
}

/**
 * What one specifier means here, or `null` for "this app cannot provide it".
 *
 * A relative specifier is only satisfied by a script the folder listing actually has, resolved against the
 * requiring script's own path — which doubles as the traversal guard: anything that climbs out of the folder
 * lands on a path no listed script owns, because the listing is exactly the folder the reader picked.
 */
function resolveRequire(specifier: string, fromModulePath: string, known: Set<string>): string | null {
  if (!specifier || specifier === DYNAMIC_REQUIRE) return null
  if (!specifier.startsWith('.')) return ALLOWED_MODULES.includes(specifier) ? specifier : null
  const folder = parentOf(fromModulePath)
  const target = resolveRelativePath(folder, specifier)
  if (known.has(target)) return target
  // Node resolves `./x` to `./x.js`, and a reader copying an upstream script may write either. Both are
  // looked up in the set the listing actually has, so nothing is invented: a missing sibling is refused.
  return known.has(`${target}.${SCRIPT_EXTENSION}`) ? `${target}.${SCRIPT_EXTENSION}` : null
}

/**
 * The script's export surface, read out of its text.
 *
 * A scanner rather than a parser: `acorn` is not a dependency of this app and plan §D8 keeps it out of the
 * main chunk, so what is recognised is the set of shapes upstream documents and its own code reaches for.
 * Where the text is unclear the answer is "no such name" — never a plausible guess.
 */
export function scanUserScript(source: string): UserScriptSurface {
  const inert = makeInert(source)
  const requires = findRequires(inert, source)
  const chosen = chosenExport(findExportAssignments(inert))
  if (!chosen) return { kind: 'none', members: [], params: [], docs: emptyDocs(), membersComplete: true, requires }

  if (chosen.kind === 'members') {
    // `exports.a = …; exports.b = …`: the object is the sum of its writes, each documented by its own block.
    const read = chosen.sites.map((site) => readMemberSite(inert, source, site))
    const missing = read.some((one) => one === null)
    return {
      kind: 'object',
      members: dedupeMembers(read.filter((one): one is UserScriptMember => one !== null)),
      params: [],
      docs: docsAttachedTo(inert, earliestStatement(chosen.sites)),
      membersComplete: !missing,
      requires,
    }
  }

  const value = readValueAt(inert, source, chosen.site.valueAt, 0)
  // `module.exports = doSomething;` — the shape upstream's own guide teaches — is only readable through the
  // declaration the name refers to, and one hop is as far as this scanner chases. The block above *that*
  // declaration is the script's documentation, because that is where the reader wrote it.
  const declaration = value.kind === 'identifier' ? findDeclaration(inert.text, value.name) : null
  const surface = declaration ? resolveIdentifier(inert, source, value.name, 1) : value
  const docs = docsAttachedTo(inert, declaration ? declaration.statementAt : chosen.site.statementAt)
  if (surface.kind === 'class') {
    return { kind: 'class', members: [], params: [], docs, membersComplete: true, requires }
  }
  if (surface.kind === 'function') {
    return {
      kind: 'function',
      members: [],
      params: paramsFor(surface.params, surface.complete, docs),
      docs,
      membersComplete: true,
      requires,
    }
  }
  if (surface.kind === 'object') {
    return {
      kind: 'object',
      members: dedupeMembers(surface.members),
      params: [],
      docs,
      membersComplete: surface.complete,
      requires,
    }
  }
  // An export this scanner cannot classify — `module.exports = require('./x')`, a call expression, a chain of
  // re-exports — has no readable surface. Upstream would run it and find out; here the script is reported as
  // unreadable rather than called on a guess.
  return { kind: 'none', members: [], params: [], docs, membersComplete: false, requires }
}

/** Where an export is written, and where its value starts. */
interface ExportSite {
  /** Offset of the assigned expression: what a preceding `/** … *\/` block documents. */
  statementAt: number
  /** Offset of the first character after `=`, which is the value. */
  valueAt: number
  /** The member name for an `exports.<name> = …` write, or `''` for a whole-export assignment. */
  member: string
}

/** The export a file produces: one value, or the object its `exports.<name>` writes add up to. */
type ChosenExport =
  | { kind: 'single'; site: ExportSite }
  | { kind: 'members'; sites: ExportSite[] }

/**
 * The CommonJS export forms upstream supports, found in one pass over the blanked text.
 *
 * `module.exports`, `module.exports.<name>`, `exports.<name>` and `exports.default` all appear here in source
 * order; {@link chosenExport} applies upstream's precedence. Comparison operators are excluded by looking at
 * the characters around the `=`, because `module.exports === x` is a question, not an export.
 */
function findExportAssignments(inert: InertText): ExportSite[] {
  const found: ExportSite[] = []
  const pattern = /\b(?:(module)\s*\.\s*)?exports(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*=(?!=)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(inert.text)) !== null) {
    // `.exports` reached through some other object (`state.exports = …`) is not the CJS binding.
    if (inert.text[match.index - 1] === '.') continue
    const member = match[2] ?? ''
    // A bare `exports = value` rebinds the wrapper's own parameter, which is not an export at all: upstream's
    // runtime keeps reading the object it was handed, so the only conservative reading is to ignore it.
    if (member === '' && match[1] === undefined) continue
    const equals = match.index + match[0].length - 1
    found.push({
      statementAt: match.index,
      valueAt: skipSpace(inert.text, equals + 1),
      member,
    })
  }
  return found
}

/**
 * Which assignment is the export.
 *
 * The precedence is upstream's, from `UserScriptFunctions.ts:120`: `exports.default` beats `module.exports`,
 * which beats a set of `exports.<name>` writes — because upstream reads `exp["default"] ?? mod.exports`, and
 * `mod.exports` and `exports` start out as the *same* object. A later `module.exports = …` therefore discards
 * the members written before it, and this returns only the winning form.
 *
 * One divergence, stated rather than buried: a file that reassigns `module.exports` and *then* writes
 * `module.exports.default` is read as a default export here, where upstream's runtime would find the replaced
 * object. That shape comes from a transpiler mixing both idioms in one file.
 */
function chosenExport(sites: ExportSite[]): ChosenExport | null {
  const defaults = sites.filter((one) => one.member === 'default')
  const whole = sites.filter((one) => one.member === '')
  const members = sites.filter((one) => one.member !== '' && one.member !== 'default')
  const winner = defaults.length > 0 ? defaults[defaults.length - 1]! : whole.length > 0 ? whole[whole.length - 1]! : null
  if (winner) return { kind: 'single', site: winner }
  if (members.length === 0) return null
  // Keep the last write per name, the way the object would read at run time.
  const byName = new Map<string, ExportSite>()
  for (const site of members) byName.set(site.member, site)
  return { kind: 'members', sites: [...byName.values()] }
}

/**
 * The documentation a script publishes for itself.
 *
 * Upstream attaches documentation by matching a `/** … *\/` block directly against six declaration shapes
 * (`TpDocumentation.ts:450-466`). The same intent is one positional rule here: the last block that ends before
 * the offset with nothing but whitespace between it and that offset.
 */
function docsAttachedTo(inert: InertText, statementAt: number): UserScriptDocs {
  const block = docBefore(inert, statementAt)
  return block ? parseDocBlock(block) : emptyDocs()
}

/** The first of a set of export writes, which is where the file's own documentation block sits. */
function earliestStatement(sites: ExportSite[]): number {
  return sites.reduce((earliest, site) => Math.min(earliest, site.statementAt), Number.POSITIVE_INFINITY)
}

/** A value, as far as its text can be read. */
interface ValueShape {
  kind: 'function' | 'object' | 'class' | 'identifier' | 'unknown'
  /** The local name a value was assigned from, for one level of `module.exports = name`. */
  name: string
  params: string[]
  members: UserScriptMember[]
  /** Whether `params`/`members` are the whole truth for this value. */
  complete: boolean
}

function unknownValue(): ValueShape {
  return { kind: 'unknown', name: '', params: [], members: [], complete: false }
}

/**
 * Classify the value that starts at `at`.
 *
 * `depth` bounds the identifier chase: `module.exports = a` where `const a = b` is not followed past one hop,
 * because a chain of re-exports is a file whose surface should be reported unreadable rather than resolved
 * like a bundler.
 */
function readValueAt(inert: InertText, source: string, at: number, depth: number): ValueShape {
  const start = skipSpace(inert.text, at)
  const word = identifierAt(inert.text, start)
  if (word === 'function') return readFunctionHeader(inert, start + word.length)
  if (word === 'async') {
    const inner = readValueAt(inert, source, start + word.length, depth)
    return inner.kind === 'function' ? inner : unknownValue()
  }
  if (word === 'class') return { ...unknownValue(), kind: 'class' }
  if (inert.text[start] === '{') return readObjectLiteral(inert, source, start, depth)
  if (inert.text[start] === '(') {
    const close = matchingBracket(inert.text, start, '(', ')')
    if (close < 0 || !arrowAfter(inert.text, close + 1)) return unknownValue()
    const params = readParams(inert.text, start, close)
    return { kind: 'function', name: '', params: params.names, members: [], complete: params.complete }
  }
  if (word) {
    const after = skipSpace(inert.text, start + word.length)
    if (inert.text.slice(after, after + 2) === '=>') {
      return { kind: 'function', name: '', params: [word], members: [], complete: true }
    }
    if (depth >= 1) return unknownValue()
    return { kind: 'identifier', name: word, params: [], members: [], complete: true }
  }
  return unknownValue()
}

/** `function`, `function*`, `function name(...)` — the header is what carries the parameters. */
function readFunctionHeader(inert: InertText, at: number): ValueShape {
  let cursor = skipSpace(inert.text, at)
  if (inert.text[cursor] === '*') cursor = skipSpace(inert.text, cursor + 1)
  const name = identifierAt(inert.text, cursor)
  if (name) cursor = skipSpace(inert.text, cursor + name.length)
  if (inert.text[cursor] !== '(') return unknownValue()
  const close = matchingBracket(inert.text, cursor, '(', ')')
  if (close < 0) return unknownValue()
  const params = readParams(inert.text, cursor, close)
  return { kind: 'function', name, params: params.names, members: [], complete: params.complete }
}

function arrowAfter(text: string, at: number): boolean {
  const cursor = skipSpace(text, at)
  return text.slice(cursor, cursor + 2) === '=>'
}

/**
 * The keys of an object literal, and what each of them is.
 *
 * Spread (`...shared`), computed keys (`[name]: fn`), getters and setters and any entry whose shape will not
 * parse mark the list incomplete rather than inventing a name — exactly the accuracy gap plan §D8 accepts in
 * place of `acorn`.
 */
function readObjectLiteral(inert: InertText, source: string, at: number, depth: number): ValueShape {
  const close = matchingBracket(inert.text, at, '{', '}')
  if (close < 0) return unknownValue()
  const members: UserScriptMember[] = []
  let complete = true
  for (const entry of splitTopLevel(inert.text, at + 1, close, ',')) {
    const parsed = readObjectEntry(inert, source, entry, depth)
    if (!parsed) {
      complete = false
      continue
    }
    if (parsed.spread) complete = false
    else if (!members.some((one) => one.name === parsed.member.name)) members.push(parsed.member)
  }
  return { kind: 'object', name: '', params: [], members, complete }
}

interface ObjectEntryResult {
  member: UserScriptMember
  /** True for `…shared`, which contributes names this scanner cannot know. */
  spread?: boolean
}

/**
 * One entry of an object literal.
 *
 * The shapes are the ones upstream's documentation and examples use: `note: (text) => …`,
 * `one: function () {}`, `two(a, b) {}` as a shorthand method, `{ helper }` as a shorthand for a local, and
 * `'quoted key': fn`. A getter or a setter is refused as unreadable — upstream evaluates it at load and
 * registers whatever it returned, which cannot be seen from text.
 */
function readObjectEntry(inert: InertText, source: string, entry: Range, depth: number): ObjectEntryResult | null {
  const start = skipSpace(inert.text, entry.from)
  if (inert.text.startsWith('...', start)) return { member: unnamedMember(), spread: true }
  const key = readKey(inert, source, start)
  if (!key) return null
  const cursor = skipSpace(inert.text, key.after)
  if (inert.text[cursor] === ':') {
    return { member: readMember(inert, source, key.name, skipSpace(inert.text, cursor + 1), key.start, depth) }
  }
  if (inert.text[cursor] === '(') {
    // `{ two(a, b) {} }` — a shorthand method, which is a function by construction.
    const close = matchingBracket(inert.text, cursor, '(', ')')
    const params = close < 0 ? { names: [], complete: false } : readParams(inert.text, cursor, close)
    const docs = docsForEntry(inert, key.start, params.names)
    return { member: member(key.name, true, paramsFor(params.names, params.complete, docs), docs) }
  }
  if (BARE_IDENTIFIER.test(key.name) && skipSpace(inert.text, key.after) >= entry.to) {
    // `{ helper }` — the value is a local of the same name, so its declaration says what it is.
    return { member: readMemberFrom(inert, source, key.name, { ...unknownValue(), kind: 'identifier', name: key.name }, key.start) }
  }
  return null
}

/**
 * A member name and where it ends.
 *
 * A quoted key is blanked in the scanned copy, so its text is sliced from the original between the quotes that
 * were kept. `get`/`set` before a name is a getter, and a computed `[expr]` key is unreadable; both answer
 * `null` so the member list is marked incomplete.
 */
function readKey(inert: InertText, source: string, at: number): { name: string; start: number; after: number } | null {
  const text = inert.text
  const start = skipSpace(text, at)
  const first = text[start]
  if (first === '[') return null
  const quote = first === '"' || first === "'" ? first : null
  if (quote) {
    const end = text.indexOf(quote, start + 1)
    if (end < 0) return null
    return { name: source.slice(start + 1, end), start, after: end + 1 }
  }
  const word = identifierAt(text, start)
  if (!word) return null
  if (word === 'get' || word === 'set') {
    // `{ get: fn }` is a key called `get`; `{ get() {} }` and `{ get x() {} }` are accessors.
    const afterWord = skipSpace(text, start + word.length)
    if (text[afterWord] !== ':') return null
    return { name: word, start, after: afterWord }
  }
  return { name: word, start, after: start + word.length }
}

const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * One exported value, named and documented, as a member of the script's object.
 *
 * Shared by the three ways a member is written — `{ name: value }` inside a literal, `{ helper }` as a
 * shorthand for a local, and `exports.name = value` as a statement — because the only difference is where the
 * name came from.
 */
function readMember(
  inert: InertText,
  source: string,
  name: string,
  valueAt: number,
  statementAt: number,
  depth: number,
): UserScriptMember {
  return readMemberFrom(inert, source, name, readValueAt(inert, source, valueAt, depth), statementAt)
}

/**
 * A member, from a value that has already been read.
 *
 * A value that is a local identifier (`{ one: helper }`) is resolved against that local's declaration, so
 * `const helper = (a) => …` gives the real parameter names. A local that cannot be found — `require` among
 * them — makes the member present but not callable: the template that calls it is told so, rather than being
 * handed a signature this module invented.
 */
function readMemberFrom(
  inert: InertText,
  source: string,
  name: string,
  value: ValueShape,
  statementAt: number,
): UserScriptMember {
  const shape = value.kind === 'identifier' ? resolveIdentifier(inert, source, value.name, 1) : value
  const docs = docsForEntry(inert, statementAt, shape.params)
  return member(name, shape.kind === 'function', paramsFor(shape.params, shape.complete, docs), docs)
}

/**
 * One `exports.<name> = …` write, read as a member.
 *
 * `null` is the unreadable case — a value that is a call expression or anything else with no shape — and the
 * caller reports the member list as incomplete rather than guessing what the assignment produced.
 */
function readMemberSite(inert: InertText, source: string, site: ExportSite): UserScriptMember | null {
  const value = readValueAt(inert, source, site.valueAt, 0)
  if (value.kind === 'unknown') return null
  return readMemberFrom(inert, source, site.member, value, site.statementAt)
}

function member(name: string, callable: boolean, params: string[], docs: UserScriptDocs): UserScriptMember {
  return { name, callable, params, docs }
}

function unnamedMember(): UserScriptMember {
  return { name: '', callable: false, params: [], docs: emptyDocs() }
}

function dedupeMembers(members: UserScriptMember[]): UserScriptMember[] {
  const seen = new Set<string>()
  return members.filter((one) => {
    if (seen.has(one.name)) return false
    seen.add(one.name)
    return true
  })
}

/**
 * One hop from a re-exported identifier to its declaration.
 *
 * The three forms are the ones a CommonJS script writes: a `function` declaration, a `class`, and a
 * `const`/`let`/`var` initialised with a value. A `function` wins because it is hoisted, which is what a call
 * would reach in a file that declares the same name twice.
 */
function resolveIdentifier(inert: InertText, source: string, name: string, depth: number): ValueShape {
  if (!name) return unknownValue()
  const declaration = findDeclaration(inert.text, name)
  if (!declaration) return unknownValue()
  if (declaration.kind === 'function') return readFunctionHeader(inert, declaration.at)
  if (declaration.kind === 'class') return { ...unknownValue(), kind: 'class' }
  return readValueAt(inert, source, declaration.at, depth)
}

interface Declaration {
  kind: 'function' | 'class' | 'value'
  /** Offset of what to read: the parameter list for a function, the value for an initialiser. */
  at: number
  /** Offset of the `function`/`class`/`const` keyword, which is what a documentation block sits above. */
  statementAt: number
}

/**
 * Where `name` is declared, if the blanked text says so.
 *
 * Deliberately a whole-word search, not a scope-aware one: a script that declares `helper` twice, or shadows
 * it inside another function, can be read as the wrong declaration. That can only make a *parameter list* or a
 * *description* wrong, and can never invent a member name, which is the failure direction this scanner is
 * allowed to have.
 */
function findDeclaration(text: string, name: string): Declaration | null {
  const escaped = name.replace(/\$/g, '\\$')
  const header = lastMatch(text, new RegExp(`\\bfunction\\s+(?:\\*\\s*)?${escaped}\\s*\\(`, 'g'))
  if (header) return { kind: 'function', at: header.index + header[0].length - 1, statementAt: header.index }
  const classHeader = lastMatch(text, new RegExp(`\\bclass\\s+${escaped}\\b`, 'g'))
  if (classHeader) return { kind: 'class', at: classHeader.index, statementAt: classHeader.index }
  const initialiser = lastMatch(text, new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=(?!=)`, 'g'))
  if (initialiser) {
    return { kind: 'value', at: skipSpace(text, initialiser.index + initialiser[0].length), statementAt: initialiser.index }
  }
  return null
}

function lastMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  let match: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((match = pattern.exec(text)) !== null) last = match
  return last
}

/**
 * The parameter names of a list that starts at `open` and ends at `close`.
 *
 * Split at top level only, so `(a, { b, c })` reads as two parameters and `(a = "x,y")` as one. A parameter
 * this scanner cannot name — destructuring, or an odd shape — is left out and marks the list incomplete, which
 * is where {@link paramsFor} falls back to the documented `@param` names. Upstream's `get_fn_params`
 * (`utils/Utils.ts:262`) cuts between the first `(` and the first `)`, so a default value holding a
 * parenthesis is wrong there; here the brackets are matched.
 */
function readParams(text: string, open: number, close: number): { names: string[]; complete: boolean } {
  const names: string[] = []
  let complete = true
  for (const part of splitTopLevel(text, open + 1, close, ',')) {
    const raw = text.slice(part.from, part.to).trim()
    if (!raw) continue
    const name = parameterName(raw)
    if (name === null) {
      complete = false
      continue
    }
    names.push(name)
  }
  return { names, complete }
}

/**
 * The name of one parameter, or `null` when the text does not say.
 *
 * A rest parameter keeps its name (`...args` → `args`), a default keeps its own half (`count = 3` → `count`),
 * and a destructured `{ a, b }` or `[x, y]` answers nothing: the names inside it are not the parameter, and
 * publishing them would tell a template to pass two arguments where the script takes one object.
 */
function parameterName(raw: string): string | null {
  const text = raw.startsWith('...') ? raw.slice(3).trim() : raw
  if (!text || text.startsWith('{') || text.startsWith('[')) return null
  const head = text.split(/[=:]/, 1)[0]!.trim()
  return BARE_IDENTIFIER.test(head) ? head : null
}

/**
 * The parameter list to publish.
 *
 * A list that was read whole wins, including the empty one: a function written `function () {}` takes nothing,
 * and names taken from a comment would tell a template to pass arguments the script ignores. Only when the
 * written list had shapes that could not be named — a destructured first parameter, say — are the documented
 * `@param` names used, because that is the case where the comment is the only readable signature.
 */
function paramsFor(params: string[], complete: boolean, docs: UserScriptDocs): string[] {
  if (complete) return params
  return docs.params.length > 0 ? docs.params.map((one) => one.name) : params
}

/** The documentation written above one entry of an object, or above an `exports.<name>` write. */
function docsForEntry(inert: InertText, at: number, params: string[]): UserScriptDocs {
  const block = docBefore(inert, at)
  if (!block) return { ...emptyDocs(), params: params.map((one) => ({ name: one, description: '' })) }
  const docs = parseDocBlock(block)
  if (docs.params.length === 0 && params.length > 0) {
    return { ...docs, params: params.map((one) => ({ name: one, description: '' })) }
  }
  return docs
}

/**
 * The last doc block that ends before `at` with nothing but whitespace in between.
 *
 * The gap is measured on the blanked text, so a block followed by a line comment and then the export still
 * reads as attached — the comment carries no code, which is the only thing that should break the link.
 */
function docBefore(inert: InertText, at: number): DocBlock | null {
  for (let index = inert.docs.length - 1; index >= 0; index--) {
    const doc = inert.docs[index]!
    if (doc.end > at) continue
    return /^\s*$/.test(inert.text.slice(doc.end, at)) ? doc : null
  }
  return null
}

function emptyDocs(): UserScriptDocs {
  return { summary: '', params: [], returns: '' }
}

/**
 * One JSDoc/TSDoc block, read without `@microsoft/tsdoc`.
 *
 * The tag grammar recognised is the one upstream's documentation asks a reader to write: a summary, then
 * `@param name description` (the optional `{type}` and the `[optional]` bracket forms are both accepted), then
 * `@returns`. Nested markup, `@example` bodies and type expressions are kept as text, not interpreted.
 *
 * A line is split at every tag, so the single-line doc a minified or hand-rolled file writes
 * (`/** @param a one @param b two *\/`) yields both parameters instead of one swallowed description.
 */
function parseDocBlock(block: DocBlock): UserScriptDocs {
  const summary: string[] = []
  const params: UserScriptParamDoc[] = []
  const returns: string[] = []
  let bucket: 'summary' | 'params' | 'returns' = 'summary'
  for (const raw of block.body.split('\n')) {
    const line = raw.replace(/^\s*\*?\s?/, '').trimEnd()
    for (const part of line.split(/(?=@\w+)/)) {
      if (!part) continue
      const tag = /^@(\w+)([\s\S]*)$/.exec(part)
      if (tag) {
        const rest = tag[2]!.trim()
        if (tag[1] === 'param') {
          bucket = 'params'
          params.push(parseParamTag(rest))
        } else if (tag[1] === 'returns' || tag[1] === 'return') {
          bucket = 'returns'
          if (rest) returns.push(rest)
        } else {
          // Any other tag (`@example`, `@author`) ends the summary and publishes nothing.
          bucket = 'summary'
        }
        continue
      }
      if (bucket === 'summary') summary.push(part)
      else if (bucket === 'returns') returns.push(part)
    }
  }
  return { summary: summary.join('\n').trim(), params, returns: returns.join(' ').trim() }
}

const PARAM_TAG = /^(?:\{[^}]*\}\s*)?(\[[^\]]*\]|[\w$.]+)\s*[-–—]?\s*([\s\S]*)$/

/**
 * One `@param` line.
 *
 * A dotted name (`@param opts.depth`) documents a property of a destructured parameter, so the name published
 * is the parameter itself. `[name]` and `[name=default]` are the optional forms TSDoc allows.
 */
function parseParamTag(rest: string): UserScriptParamDoc {
  const parsed = PARAM_TAG.exec(rest)
  if (!parsed) return { name: rest, description: '' }
  const raw = parsed[1]!.replace(/^\[|\]$/g, '').split('=')[0]!.trim()
  const name = raw.includes('.') ? raw.slice(0, raw.indexOf('.')) : raw
  return { name, description: parsed[2]!.trim() }
}

/**
 * The `require` specifiers a body mentions, in source order.
 *
 * Only a string literal counts. `require(name)` is real, upstream-supported JavaScript, and here it is
 * reported as one fixed token so it can only be refused: this module cannot tell what the call would resolve
 * to, and the allowlist is the trust boundary.
 */
function findRequires(inert: InertText, source: string): string[] {
  const found: string[] = []
  const pattern = /\brequire\s*\(\s*/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(inert.text)) !== null) {
    if (inert.text[match.index - 1] === '.') continue
    const at = match.index + match[0].length
    const specifier = quotedAt(inert.text, source, at)
    const value = specifier === null ? DYNAMIC_REQUIRE : specifier
    if (!found.includes(value)) found.push(value)
  }
  return found
}

/** The text of the string literal that starts at `at`, or `null` when something else is there. */
function quotedAt(inertText: string, source: string, at: number): string | null {
  const quote = inertText[at]
  if (quote !== '"' && quote !== "'" && quote !== '`') return null
  const end = inertText.indexOf(quote, at + 1)
  if (end < 0) return null
  return source.slice(at + 1, end)
}

/** One `/** … *\/` block, with where it ended and what it said. */
interface DocBlock {
  /** Offset just past the closing `*\/`. */
  end: number
  /** The block's inner text, comment markers removed, lines as written. */
  body: string
}

/** A comment, string, or regex body blanked out of the text, so only real code is scanned. */
interface InertText {
  /**
   * The source with comments and regex literals replaced by spaces, and string and template bodies replaced by
   * spaces with their delimiters kept — so a specifier or a quoted key can still be sliced out of the original.
   * Length is preserved, which is what lets every offset found here be used against the source.
   */
  text: string
  /** Every `/** … *\/` block, in source order. */
  docs: DocBlock[]
}

/**
 * The blanked copy of a script, and its doc blocks.
 *
 * Scanning raw text would let a commented-out `module.exports`, or a string holding one, define the surface —
 * so those are taken out first. This is the whole reason the export scan can be trusted: a name that only
 * appears inside something inert is not reported, and a name reported was written as code.
 *
 * The regular-expression rule is a heuristic and its limits are pinned by tests rather than argued: a `/`
 * after `)` or after an identifier that is not a keyword is read as division, so a regex literal written in
 * that position is not blanked, and a quote inside it then blanks the rest of *that line*. Unterminated
 * strings and regexes stop at the newline on purpose, which is what bounds the damage to one line.
 */
function makeInert(source: string): InertText {
  const out = source.split('')
  const docs: DocBlock[] = []

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < source.length; i++) if (source[i] !== '\n') out[i] = ' '
  }
  const lineEnd = (from: number): number => {
    const next = source.indexOf('\n', from)
    return next < 0 ? source.length : next
  }

  /**
   * Code, until the end of the file or until the `}` that closes the interpolation this was called from.
   *
   * `scanCode` and `scanLiteral` call each other, which is what gets `${ … }` right: an interpolation is code
   * again, so a template literal nested inside it is a literal, and a string inside *that* is a string. The
   * recursion follows the nesting the reader wrote, and nothing else.
   */
  function scanCode(at: number, insideInterpolation: boolean): number {
    let index = at
    let braceDepth = 0
    while (index < source.length) {
      const char = source[index]!
      const next = source[index + 1]
      if (insideInterpolation && char === '}' && braceDepth === 0) {
        // The brace belongs to the template's text, so it goes blank and the literal carries on.
        out[index] = ' '
        return index + 1
      }
      if (char === '/' && next === '/') {
        const stop = lineEnd(index)
        blank(index, stop)
        index = stop
        continue
      }
      if (char === '/' && next === '*') {
        const closing = source.indexOf('*/', index + 2)
        const stop = closing < 0 ? source.length : closing + 2
        // `/**` and nothing else before the next character is the doc form; `/***` is a comment that happens
        // to start with a star, and upstream's TSDoc parser would not read it as documentation either.
        if (source[index + 2] === '*' && source[index + 3] !== '/') {
          docs.push({ end: stop, body: source.slice(index + 3, closing < 0 ? stop : closing) })
        }
        blank(index, stop)
        index = stop
        continue
      }
      if (char === '"' || char === "'" || char === '`') {
        index = scanLiteral(index, char)
        continue
      }
      if (char === '/' && startsRegex(source, index)) {
        const end = blankRegex(source, out, index, lineEnd)
        index = end > index ? end : index + 1
        continue
      }
      if (char === '{') braceDepth++
      if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
      index++
    }
    return index
  }

  /**
   * A string, single-quoted string or template literal, blanked between its quotes.
   *
   * The delimiters stay, because a module specifier and a quoted key have to be read out of the original text
   * afterwards. A quoted string that meets a newline stops there: in JavaScript it cannot span lines, so
   * stopping is both the correct reading and the reason a mis-detected quote cannot blank a whole file. A
   * template literal keeps its newlines, because it may genuinely span them.
   */
  function scanLiteral(at: number, quote: string): number {
    const template = quote === '`'
    let index = at + 1
    while (index < source.length) {
      const char = source[index]!
      if (char === '\\') {
        out[index] = ' '
        if (index + 1 < source.length && source[index + 1] !== '\n') out[index + 1] = ' '
        index += 2
        continue
      }
      if (char === quote) {
        out[index] = quote
        return index + 1
      }
      if (char === '\n') return template ? index + 1 : index
      if (template && char === '$' && source[index + 1] === '{') {
        blank(index, index + 2)
        index = scanCode(index + 2, true)
        continue
      }
      out[index] = ' '
      index++
    }
    return index
  }

  scanCode(0, false)
  return { text: out.join(''), docs }
}

/**
 * A regex literal, blanked including its delimiters.
 *
 * Returns `at` when the literal never closes before the end of the line, which is how a mis-detected `/` is
 * abandoned rather than allowed to blank a file. A `/` inside a `[ … ]` class is literal, which is why the
 * class is tracked.
 */
function blankRegex(source: string, out: string[], at: number, lineEnd: (from: number) => number): number {
  const stop = lineEnd(at)
  let index = at + 1
  let inClass = false
  while (index < stop) {
    const char = source[index]!
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) {
      for (let i = at; i < index + 1; i++) out[i] = ' '
      return index + 1
    }
    index++
  }
  return at
}

/**
 * Whether the `/` at `at` opens a regular expression.
 *
 * The test is what precedes it: after a value (an identifier, a number, `)`, `]`, a quote) a `/` divides, and
 * after an operator, a comma, an assignment, the start of the file, or one of the keywords that take an
 * expression (`return`, `typeof`, …) it starts a literal.
 */
function startsRegex(source: string, at: number): boolean {
  let cursor = at - 1
  while (cursor >= 0 && /\s/.test(source[cursor]!)) cursor--
  if (cursor < 0) return true
  const previous = source[cursor]!
  if (/[A-Za-z0-9_$]/.test(previous)) {
    const end = cursor
    while (cursor >= 0 && /[\w$]/.test(source[cursor]!)) cursor--
    return REGEX_KEYWORDS.has(source.slice(cursor + 1, end + 1).toLowerCase())
  }
  return REGEX_AFTER.has(previous)
}

const REGEX_AFTER = new Set(['(', ',', '=', ':', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '<', '>', '~', '['])
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

/** A range in the blanked text, `from` included, `to` excluded. */
interface Range {
  from: number
  to: number
}

/**
 * A range split on a separator that sits at bracket depth zero.
 *
 * Only brackets are counted, because the text has already had strings, comments and regexes blanked: a
 * separator inside any of those is a space by now and cannot split anything. Empty pieces are dropped, which is
 * what makes a trailing comma in an object or a parameter list read as one parameter fewer.
 */
function splitTopLevel(text: string, from: number, to: number, separator: string): Range[] {
  const ranges: Range[] = []
  let depth = 0
  let start = from
  const push = (end: number): void => {
    if (text.slice(start, end).trim()) ranges.push({ from: start, to: end })
  }
  for (let index = from; index < to; index++) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') depth--
    else if (char === separator && depth === 0) {
      push(index)
      start = index + 1
    }
  }
  push(to)
  return ranges
}

function skipSpace(text: string, at: number): number {
  let index = at
  while (index < text.length && /\s/.test(text[index]!)) index++
  return index
}

function identifierAt(text: string, at: number): string {
  let index = at
  if (index >= text.length || !/[A-Za-z_$]/.test(text[index]!)) return ''
  while (index < text.length && /[\w$]/.test(text[index]!)) index++
  return text.slice(at, index)
}

/** The index of the bracket that matches the one at `open`, or `-1` when the text never closes it. */
function matchingBracket(text: string, open: number, opening: string, closing: string): number {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === opening) depth++
    else if (char === closing) {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

/** A diagnostic line for a failure the reader cannot be given, kept off the wire rather than swallowed. */
function reportCause(context: string, error: unknown): void {
  // Best-effort by design: the call already has its refusal, and a console that refuses to be written to is no
  // reason to lose it. This is the only place the original text survives, which is why it is logged.
  globalThis.console.warn(`[templater] ${context}: ${error instanceof Error ? error.message : String(error)}`)
}
