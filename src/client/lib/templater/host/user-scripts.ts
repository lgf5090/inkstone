/**
 * The reader's own scripts, as the page sees them: which notes are scripts, what one is called, and what it
 * takes to hand one to a run.
 *
 * A script is JavaScript the reader wrote, and the interpreter is the only thing in this app that runs it —
 * `worker/bootstrap.ts` says why (upstream's `UserScriptFunctions.ts:19` hands the body to the browser, and
 * this app ships no `unsafe-eval`). So nothing here evaluates a body. What this module does is the part only
 * the page can do: read the folder the reader pointed at, decide which of those notes are scripts and what
 * name each one gets, refuse the ones a run cannot be handed, and hand the rest over as text.
 *
 * There is no filesystem, so a script is a note: whatever {@link UserScriptPort} lists whose title ends in
 * `.js` (plan §D13), named by the title without that suffix. The listing is the page's choice — the folder the
 * reader picked — and {@link userScriptNameOf} is the rule applied to it, so a folder read for a run and a
 * folder read for the completion list cannot drift apart.
 *
 * Two refusals are made here rather than in the interpreter, because only this side can name the file:
 *
 * - **a collision.** Two notes claiming one script name. Upstream's map keeps whichever file sorted last and
 *   runs it silently; here both paths go into the answer, so the reader has something to fix (U1).
 * - **a budget.** A folder past {@link MAX_USER_SCRIPTS_PER_RUN}, a file past {@link MAX_USER_SCRIPT_BYTES},
 *   or a batch past {@link MAX_USER_SCRIPTS_TOTAL_BYTES}. Each script still arrives, with a reason instead of
 *   with text, so that only the template that *names* it fails. That is the improvement over upstream, which
 *   loads every script before any template runs and lets one bad file take the whole `tp.user` namespace
 *   down for the vault (U4).
 *
 * `describe` answers a different question — what a script's *text* exports — and is what the completion list
 * and the reference panel ask, since neither may run the reader's code to find out. The scanning itself lives
 * in `./user-script-scan.ts`.
 */
import { normalizeVirtualPath } from '../context/note-index'
import type { TemplaterErrorCode } from '../errors'
import type { UserScriptSource } from '../protocol'
import { MAX_USER_SCRIPTS_PER_RUN, MAX_USER_SCRIPTS_TOTAL_BYTES, MAX_USER_SCRIPT_BYTES } from '../limits'
import { scanUserScript, type UserScriptSurface } from './user-script-scan'

/** The note-title suffix that makes a note a script. */
const SCRIPT_EXTENSION = 'js'

/** A name as templates type it: `tp.user.<name>`. The note title, minus its `.js` suffix. */
export type UserScriptName = string

/** A script as the page's store holds it: identifiers and a path, never a store handle. */
export interface UserScriptRecord {
  id: string
  /** The note's own title; the trailing `.js` on it is what makes this note a script. */
  title: string
  /** The note's virtual path (`Scripts/my_script.js`), for the messages the reader is given. */
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

/** A script, its text, and what that text was found to export. */
export interface UserScriptModule {
  id: string
  name: UserScriptName
  path: string
  /** The stored text. It travels as a string; nothing here evaluates it. */
  source: string
  surface: UserScriptSurface
}

export type UserScriptLookup = { ok: true; module: UserScriptModule } | UserScriptFailure

/**
 * What a run was told about the script folder.
 *
 * `sources` is what `TemplateRunContext.userScripts` carries: one entry per name the folder holds, each with
 * either the script's text or the reason it has none. `unavailable` is the folder's own answer — set when the
 * listing could not be read at all — which is a different fact from "no script by that name" and has to stay
 * a different fact, or a store hiccup reads to the reader as a missing file.
 */
export interface UserScriptBatch {
  sources: UserScriptSource[]
  unavailable: string | null
}

export interface UserScriptProvider {
  /** Read one script's surface: locate it, read it once, scan it. */
  describe: (name: UserScriptName) => Promise<UserScriptLookup>
  /** Everything the folder holds, as the snapshot wants it. Read once per provider. */
  gather: () => Promise<UserScriptBatch>
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
 * read at most once. A note edited while a template runs keeps the text the run was given; the next run gets
 * a fresh provider and re-reads. There is no TTL to invalidate, because the unit of validity is the run.
 *
 * The one thing that is *not* kept is a listing that failed. "No such script" is only an answer when the
 * folder was actually read, so that case is logged and tried again by the next call rather than cached into a
 * refusal the reader could not fix without restarting.
 */
export function createUserScriptProvider(port: UserScriptPort): UserScriptProvider {
  let listing: Promise<{ table: UserScriptIndex; usable: boolean }> | null = null
  // Keyed by name, holding the *promise*: two calls for one script in one run share one read. Every failure
  // is turned into an `{ ok: false }` value before it is stored, so a cached promise never carries an
  // unhandled rejection into a later call.
  const surfaces = new Map<UserScriptName, Promise<UserScriptLookup>>()
  let batch: Promise<UserScriptBatch> | null = null

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

  async function describe(name: UserScriptName): Promise<UserScriptLookup> {
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

  async function gather(): Promise<UserScriptBatch> {
    if (batch) return batch
    const pending = collect().catch((error: unknown) => {
      // A read that threw rather than being refused is a store failure, and the run must still start: the
      // answer is an empty folder and one line in the console, which is what `collect` would have said
      // anyway had it been able to ask. Nothing here re-throws, because the caller is starting a template.
      reportCause('user script gathering failed', error)
      return { sources: [], unavailable: 'listing-failed' }
    })
    batch = pending
    const result = await pending
    // A folder the page could not read is not an answer worth keeping. Unlike one script's refusal, which is
    // that file's fact for the whole run, this one is a moment in the store, and dropping it is what lets the
    // next run see a real folder without a reload.
    if (result.unavailable !== null) batch = null
    return result
  }

  async function collect(): Promise<UserScriptBatch> {
    const { table, usable } = await index()
    if (!usable) return { sources: [], unavailable: 'listing-failed' }
    const readable = readableNames(table)
    // A folder past the count is refused from the listing alone: reading a hundred and one bodies only to be
    // told not to use them is the same cost paid twice, and the number the answer carries is already known.
    if (readable.length > MAX_USER_SCRIPTS_PER_RUN) {
      return { sources: sourcesFromListing(table, new Map()), unavailable: null }
    }
    const texts = new Map<UserScriptName, string | null>()
    for (const name of readable) {
      const entry = table.byName.get(name)
      if (!entry) continue
      try {
        texts.set(name, await port.readScript(entry.id))
      } catch (error) {
        reportCause(`user script read failed: ${entry.path}`, error)
        texts.set(name, null)
      }
    }
    return { sources: sourcesFromListing(table, texts), unavailable: null }
  }

  return { describe, gather }
}

/** Every name the folder holds, collided or not, sorted: the set a run is allowed to ask about. */
function namesOf(table: UserScriptIndex): UserScriptName[] {
  return [...new Set([...table.byName.keys(), ...table.conflicts.keys()])].sort()
}

/**
 * The names that could be read: every name except the ones two notes claim.
 *
 * Sorting is the whole of the determinism here. The store answers a folder in whatever order it holds, and a
 * batch whose contents depend on that order is not something a reader could reason about from their notes —
 * while the budgets below are questions about the batch as a whole.
 */
function readableNames(table: UserScriptIndex): UserScriptName[] {
  if (table.conflicts.size === 0) return [...table.byName.keys()].sort()
  // A collided name is refused from the listing alone: reading one of the two files to scan or size it would
  // be choosing a winner, which is the silence plan §D13's U1 refuses.
  return namesOf(table).filter((name) => !table.conflicts.has(name))
}

/**
 * The snapshot's entries for one folder listing, with the budgets and the collisions applied.
 *
 * A name is answered in exactly one of three ways — its text, a refusal beside no text, or (a name the
 * listing does not hold at all) nothing, which the interpreter turns into `not-found`. Nothing is dropped
 * quietly: a script the run cannot be handed still arrives, so a template that names it fails with the reason
 * and the path instead of looking like a file the reader never saved.
 */
function sourcesFromListing(table: UserScriptIndex, texts: Map<UserScriptName, string | null>): UserScriptSource[] {
  const sources: UserScriptSource[] = []
  const readable = readableNames(table)
  for (const name of namesOf(table)) {
    const paths = table.conflicts.get(name)
    if (paths) {
      // Two notes claim one name, so there is no text to carry: which file the interpreter would run is
      // precisely the question the reader has to settle first.
      sources.push({
        name,
        path: paths[0] ?? `${name}.${SCRIPT_EXTENSION}`,
        source: '',
        refusal: { code: 'script-name-conflict', detail: `${name}:${paths.join(',')}` },
      })
    }
  }
  if (readable.length > MAX_USER_SCRIPTS_PER_RUN) {
    const detail = `count:${readable.length}`
    for (const entry of table.byName.values()) {
      sources.push({ name: entry.name, path: entry.modulePath, source: '', refusal: { code: 'user-scripts-unavailable', detail } })
    }
    return sources
  }
  let total = 0
  for (const name of readable) total += bytesOf(texts.get(name) ?? '')
  // One file over the per-script ceiling is that file's failure; the whole folder over the run's transport
  // budget is the folder's, and saying so is the only version a reader can act on by deleting something.
  const overBudget = total > MAX_USER_SCRIPTS_TOTAL_BYTES ? `bytes:${total}` : null
  for (const name of readable) {
    const entry = table.byName.get(name)
    if (!entry) continue
    const source = texts.get(name)
    if (source === null || source === undefined) {
      sources.push({ name, path: entry.modulePath, source: '', refusal: { code: 'script-load-failed', detail: entry.modulePath } })
      continue
    }
    if (overBudget) {
      sources.push({ name, path: entry.modulePath, source: '', refusal: { code: 'user-scripts-unavailable', detail: overBudget } })
      continue
    }
    if (bytesOf(source) > MAX_USER_SCRIPT_BYTES) {
      sources.push({ name, path: entry.modulePath, source: '', refusal: { code: 'script-load-failed', detail: `${entry.modulePath}:too-large` } })
      continue
    }
    sources.push({ name, path: entry.modulePath, source })
  }
  return sources
}

/** The script text as bytes, which is what both the transport budget and the per-file ceiling are about. */
function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
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
  if (conflict) return { ok: false, code: 'script-name-conflict', detail: `${name}:${conflict.join(',')}` }
  const entry = table.byName.get(name)
  if (!entry) return { ok: false, code: 'script-load-failed', detail: `${name}:not-found` }
  let source: string
  try {
    source = await port.readScript(entry.id)
  } catch (error) {
    // The store's own words go to the console, where whoever debugs the page can read them; the reader gets
    // the path, which is the thing they can act on. Not re-thrown: this call has an answer.
    reportCause(`user script read failed: ${entry.path}`, error)
    return { ok: false, code: 'script-load-failed', detail: entry.modulePath }
  }
  const surface = scanUserScript(source)
  if (surface.kind === 'none') {
    // Upstream's own words for this are "No exports detected."; the detail keeps the name and the token.
    return { ok: false, code: 'script-load-failed', detail: `${name}:no-export` }
  }
  // The interpreter will run a class export because upstream does (`typeof exported === "function"` covers
  // it), and calling it then throws inside the sandbox. A panel that lists it as callable would be the worse
  // guide, so the description refuses it by name while the run keeps the more forgiving answer.
  if (surface.kind === 'class') return { ok: false, code: 'not-supported', detail: `${name}:class-export` }
  return { ok: true, module: { id: entry.id, name, path: entry.modulePath, source, surface } }
}

/** One script, as the folder listing sees it. */
interface ScriptEntry {
  id: string
  name: UserScriptName
  path: string
  /**
   * The identity a relative `require` resolves against: `<folder>/<name>.js`.
   *
   * Derived from the name rather than read off the note's own path, because a title may spell the extension
   * as `.JS` and this app's note projection adds `.md` on top of a title (`context/file-wrapper.ts`); the
   * interpreter walks `./sibling.js` against this, and one spelling of it is the only one that can match.
   */
  modulePath: string
}

interface UserScriptIndex {
  byName: Map<UserScriptName, ScriptEntry>
  /** Names claimed by more than one note, with the module paths that collided. */
  conflicts: Map<UserScriptName, string[]>
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
      modulePath: `${parentOf(path) ? `${parentOf(path)}/` : ''}${name}.${SCRIPT_EXTENSION}`,
    }
    const existing = table.byName.get(name)
    if (existing) {
      // The same note listed twice is the page's duplicate row, not a conflict. Two different notes are.
      if (existing.id === entry.id || existing.path === entry.path) continue
      const known = table.conflicts.get(name) ?? [existing.modulePath]
      if (!known.includes(entry.modulePath)) known.push(entry.modulePath)
      table.conflicts.set(name, known)
      continue
    }
    table.byName.set(name, entry)
  }
  return table
}

function emptyIndex(): UserScriptIndex {
  return { byName: new Map(), conflicts: new Map() }
}

/** A path's folder, or `''` for the root — the same shape `context/snapshot.ts` gives a note with no folder. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** A diagnostic line for a failure the reader cannot be given, kept off the wire rather than swallowed. */
function reportCause(context: string, error: unknown): void {
  // Best-effort by design: the call already has its refusal, and a console that refuses to be written to is no
  // reason to lose it. This is the only place the original text survives, which is why it is logged.
  globalThis.console.warn(`[templater] ${context}: ${error instanceof Error ? error.message : String(error)}`)
}
