import { describe, expect, it } from 'vitest'
import moment from 'moment'
import type { QuickJSWASMModule } from 'quickjs-emscripten-core'
import type { HostCall, RunNoteRef, TemplateRunContext } from '../protocol'
import { TEMPLATE_GLOBAL_NAMES, createBootstrap, runModeNumber } from './bootstrap'
import { createHostBindings } from './host-bindings'
import { capabilitiesFor } from '../protocol'
import { MAX_LOG_LINES, RUNTIME_MEMORY_BYTES, STACK_BYTES } from '../limits'
import { loadEngine } from './vm'

/**
 * The namespace, tested against the interpreter rather than against a mock of it.
 *
 * Every case here is an expression evaluated *inside* QuickJS and read back as text, because what is under
 * test is which names a template can speak and what they reach — a question a fake cannot answer. The
 * fixtures use locally constructed dates, since the sandbox inherits the machine's timezone and a test that
 * compares a formatted UTC instant against a fixed string would pass on one machine and fail on another.
 *
 * The `tp.*` cases are the upstream e2e specs (`test/specs/internal-modules/*.e2e.ts`) restated against this
 * sandbox: the same calls, the same expected text, the same thrown code. Where upstream compared its output
 * with `moment()` computed in the test process, this compares with `moment(STARTED)`, because the port reads
 * the run's own instant rather than a live clock.
 */

/** The instant the fixture run began; every date expectation below is measured from it. */
const STARTED = Date.parse('2026-03-04T05:06:07Z')

/** A host answer the test gives back for one call: either a value, or the failure code the page sends. */
type Reply = { value?: unknown } | { code: string; detail?: string }

function context(overrides: Partial<TemplateRunContext> = {}): TemplateRunContext {
  return {
    runId: 'ns-1',
    mode: 'overwrite-active',
    capabilities: 'local',
    template: { id: 'tpl-1', name: 'Idea', content: 'from the library' },
    startedAt: STARTED,
    target: {
      id: 'note-1',
      title: 'Target',
      content: 'the body',
      folderId: 'folder-1',
      tagNames: ['reading', 'long'],
      frontmatter: { level: 3 },
      createdAt: Date.parse('2026-01-01T00:00:00Z'),
      updatedAt: Date.parse('2026-02-02T00:00:00Z'),
      isEmpty: false,
    },
    active: {
      id: 'note-2',
      title: 'Active',
      content: '',
      folderId: null,
      tagNames: [],
      frontmatter: {},
      createdAt: 0,
      updatedAt: 0,
      isEmpty: true,
    },
    frozenTitle: 'Target',
    index: [
      { id: 'note-1', title: 'Target', folderId: 'folder-1', path: 'Reading/Target.md', updatedAt: 2, createdAt: 1 },
      { id: 'note-9', title: 'Other', folderId: null, path: 'Other.md', updatedAt: 2, createdAt: 1 },
    ],
    folders: [{ id: 'folder-1', name: 'Reading', parentId: null, path: 'Reading' }],
    libraryTemplates: [{ id: 'tpl-1', name: 'Idea', content: 'from the library' } as never],
    locale: 'en-US',
    ...overrides,
  }
}

let engine: QuickJSWASMModule | null = null

async function interpreter(): Promise<QuickJSWASMModule> {
  engine ??= await loadEngine()
  return engine
}

interface Namespace {
  logs: string[]
  calls: HostCall[]
  host: ReturnType<typeof createHostBindings>
  evaluate: (expression: string) => Promise<string>
  evaluateBody: (body: string) => Promise<string>
  /** Run a body, answering each host call the run makes on the way, in the order it makes them. */
  evaluateAwaiting: (body: string, answer: (call: HostCall) => Reply | undefined) => Promise<string>
  /** How many lines the ceiling dropped, which `logs` cannot show by construction. */
  suppressedLines: () => number
}

/** A context with the namespace installed and a working door, which is what a template actually sees. */
async function namespace(options: { locale?: string; snapshot?: TemplateRunContext } = {}): Promise<Namespace> {
  const given = options.snapshot ?? context()
  // One language per run: `vm.ts` hands the snapshot's own `locale` to `createBootstrap`, so a test that
  // names a locale has to name it in both places or it is describing a run the page could not build.
  const snapshot = options.locale && options.locale !== given.locale ? { ...given, locale: options.locale } : given
  const runtime = (await interpreter()).newRuntime()
  runtime.setMemoryLimit(RUNTIME_MEMORY_BYTES)
  runtime.setMaxStackSize(STACK_BYTES)
  const vm = runtime.newContext()
  const logs: string[] = []
  const calls: HostCall[] = []
  const bootstrap = createBootstrap({
    context: vm,
    locale: options.locale ?? snapshot.locale,
    log: (level, text) => logs.push(`${level} ${text}`),
  })
  const host = createHostBindings({
    context: vm,
    runId: snapshot.runId,
    capabilities: capabilitiesFor(snapshot.capabilities),
    snapshot,
    marshalling: { toValue: bootstrap.toValue, error: bootstrap.error },
    post: (message) => {
      if (message.kind === 'host-call') calls.push(message.call)
    },
    nextCallId: () => `c${calls.length + 1}`,
  })
  bootstrap.install({ snapshot, host: host.handle })

  /**
   * Run one *body* in global code, the shape the real engine compiles to.
   *
   * `evaluate` can only hold an expression, because it splices its argument inside `String(...)`. A test
   * that needs a loop, a `try`, or several statements has to go in as a body — which is also how a template
   * reaches the interpreter, so this is the closer of the two probes.
   *
   * With an `answer`, every host call the run posts is replied to before the job queue is pumped again,
   * which is the only way an awaited `tp.system.prompt` or `tp.web.request` can finish inside one probe:
   * the page is not running here, so the test is the page.
   */
  async function runBody(body: string, answer?: (call: HostCall) => Reply | undefined): Promise<string> {
    const program = vm.evalCode(`(async () => { let tR = ''\n  ${body}\n  return tR })()`, 'ns-probe.js')
    if (program.error) {
      const dumped = vm.dump(program.error) as { message?: string }
      const message = typeof dumped?.message === 'string' ? dumped.message : 'evaluation failed'
      program.error.dispose()
      throw new Error(message)
    }
    const promise = program.value
    let state = vm.getPromiseState(promise)
    let answered = 0
    while (state.type === 'pending') {
      // Answered in call order, and only as far as the run has got: a test that returns `undefined` for a
      // call leaves it outstanding, so the run stops and the probe reads as `PENDING` rather than guessing.
      while (answer && answered < calls.length) {
        const call = calls[answered]
        const reply = answer(call)
        if (reply === undefined) break
        const settled = 'code' in reply
          ? { runId: snapshot.runId, callId: call.callId, ok: false as const, code: reply.code, detail: reply.detail }
          : { runId: snapshot.runId, callId: call.callId, ok: true as const, value: reply.value }
        host.deliver(settled)
        answered += 1
      }
      const jobs = runtime.executePendingJobs()
      if (jobs.error) {
        jobs.error.dispose()
        break
      }
      if (jobs.value === 0) break
      state = vm.getPromiseState(promise)
    }
    if (state.type !== 'fulfilled') {
      promise.dispose()
      if (state.type === 'rejected') {
        const dumped = vm.dump(state.error) as { message?: string }
        return `REJECTED ${typeof dumped?.message === 'string' ? dumped.message : ''}`
      }
      return 'PENDING'
    }
    const text = vm.getString(state.value)
    state.value.dispose()
    promise.dispose()
    return text
  }

  /** One body, no host answers: the probe for anything that does not leave the interpreter. */
  function evaluateBody(body: string): Promise<string> {
    return runBody(body)
  }

  /** One body with the page standing in, answering each call in the order the run makes it. */
  function evaluateAwaiting(body: string, answer: (call: HostCall) => Reply | undefined): Promise<string> {
    return runBody(body, answer)
  }

  /** Run one expression and read what it made; the shorthand nearly every probe here wants. */
  function evaluate(expression: string): Promise<string> {
    return runBody(`tR += String(${expression})`)
  }

  return { logs, calls, host, evaluate, evaluateBody, evaluateAwaiting, suppressedLines: () => bootstrap.suppressedLines() }
}

/** The names an untouched context has, as the baseline the installed namespace is measured against. */
async function baselineGlobals(): Promise<string[]> {
  const runtime = (await interpreter()).newRuntime()
  const vm = runtime.newContext()
  const listed = vm.evalCode('Object.getOwnPropertyNames(globalThis).join("|")', 'baseline.js')
  // `.value` is only readable once the failure branch has been ruled out; the baseline of an empty
  // context is not allowed to answer as an empty list, because that would make every later "added name"
  // look like the namespace's own doing.
  if (listed.error) {
    const dumped = String(vm.dump(listed.error) ?? '')
    listed.error.dispose()
    vm.dispose()
    runtime.dispose()
    throw new Error(`baseline globals failed: ${dumped}`)
  }
  const names = String(vm.dump(listed.value) ?? '').split('|')
  listed.value.dispose()
  vm.dispose()
  runtime.dispose()
  return names.filter(Boolean)
}

describe('templater namespace', () => {
  it('installs exactly the names a template may speak', async () => {
    const before = await baselineGlobals()
    const seen = await namespace()
    const after = (await seen.evaluate('Object.getOwnPropertyNames(globalThis).join("|")')).split('|')
    const added = after.filter((name) => !before.includes(name)).sort()
    // The claim is "and only that", so the assertion is the difference between an empty context from the same
    // engine and this one — not a list somebody maintains. A helper that escaped the prelude's closure would
    // show up here as an extra name.
    expect(added).toEqual([...TEMPLATE_GLOBAL_NAMES].sort())
  })

  it('keeps the prelude helpers out of the namespace', async () => {
    const seen = await namespace()
    // The names the ported modules live behind, and the helpers they are built from. None of them is a
    // global: they reach each other through the closure, so a template that names one gets `undefined`.
    for (const helper of [
      'jsonToValue', 'hostError', 'callHost', 'hydrate', 'install', 'fileOf', 'index', 'settle',
      'fileModule', 'dateModule', 'webModule', 'frontmatter', 'run', 'nowMoment', 'referenceOf',
      'readByPath', 'includeFile', 'requirePath', 'withTagMark', 'getAllTags', 'labelsOf',
    ]) {
      expect(await seen.evaluate(`typeof ${helper}`), `${helper} leaked into the template's world`).toBe('undefined')
    }
  })

  it('gives the template no route to the worker realm', async () => {
    const seen = await namespace()
    // A marker hung off the realm outside the interpreter. If `Function('return this')()` reached it, both
    // of these would come back as the marker rather than `undefined`.
    ;(globalThis as Record<string, unknown>).__realm_marker = 'worker-realm'
    expect(await seen.evaluate("Function('return this')().__realm_marker")).toBe('undefined')
    expect(await seen.evaluate('globalThis.__realm_marker')).toBe('undefined')
    // The interpreter's global is what `this` is, so the route a template has is to a place with nothing in it.
    expect(await seen.evaluate("Function('return this')() === globalThis")).toBe('true')
    expect(await seen.evaluate("globalThis.__realm_marker === undefined && typeof postMessage")).toBe('undefined')
    delete (globalThis as Record<string, unknown>).__realm_marker
  })

  it('has no browser, network or storage names at all', async () => {
    const seen = await namespace()
    const forbidden = [
      'window', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'indexedDB', 'caches',
      'localStorage', 'sessionStorage', 'postMessage', 'importScripts', 'close', 'Worker', 'SharedWorker',
      'navigator', 'self', 'require', 'module', 'exports', 'define', 'process', 'Atomics', 'WebAssembly',
      'location', 'history',
    ]
    for (const name of forbidden) {
      expect(await seen.evaluate(`typeof ${name}`), `${name} reached the template`).toBe('undefined')
    }
  })

  it('leaves SharedArrayBuffer as the interpreter own memory, not a shared one', async () => {
    // QuickJS implements `SharedArrayBuffer` as a language built-in, so it is `typeof 'function'` here
    // while the worker has no `WebAssembly` and no `Atomics` at all. It is not a channel: a buffer made
    // inside the interpreter cannot be posted to the page (there is no `postMessage`) and nothing outside
    // can map it. Asserting it is absent would be theatre; asserting it cannot leave is the check.
    const seen = await namespace()
    expect(await seen.evaluate('typeof SharedArrayBuffer')).toBe('function')
    expect(await seen.evaluate('(() => { const b = new SharedArrayBuffer(8); return b.byteLength })()')).toBe('8')
    expect(await seen.evaluate("Function('return typeof postMessage')()")).toBe('undefined')
    expect(await seen.evaluate("Function('return typeof Worker')()")).toBe('undefined')
  })

  it('leaves eval and Function where they cannot escape the sandbox', async () => {
    const seen = await namespace()
    // These two exist inside QuickJS by design: a template can build code, and what it builds runs in the
    // interpreter's own global under the same memory, stack and CPU ceilings. The realm test above is the
    // proof that this is not a route out, and it is asserted rather than assumed.
    expect(await seen.evaluate('typeof eval')).toBe('function')
    expect(await seen.evaluate('typeof Function')).toBe('function')
    expect(await seen.evaluate("Function('return typeof fetch')()")).toBe('undefined')
    expect(await seen.evaluate("Function('return typeof WebAssembly')()")).toBe('undefined')
  })

  it('hydrates host records into classes defined inside the interpreter', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('tp.config.target_file instanceof tp.obsidian.TFile')).toBe('true')
    expect(await seen.evaluate('tp.config.target_file.parent instanceof tp.obsidian.TFolder')).toBe('true')
    expect(await seen.evaluate('tp.config.target_file.folder instanceof tp.obsidian.TFolder')).toBe('true')
    expect(await seen.evaluate('tp.config.active_file instanceof tp.obsidian.TFile')).toBe('true')
    expect(await seen.evaluate('tp.config.template_file instanceof tp.obsidian.TFile')).toBe('true')
    // Upstream's own documented test. A host-side class handed over as a handle would make every one of the
    // lines above read `false`, which is the bug this file exists to prevent.
    expect(await seen.evaluate('obsidian === tp.obsidian && typeof obsidian.TFolder === "function"')).toBe('true')
    expect(await seen.evaluate('tp.config.target_file instanceof obsidian.TFile')).toBe('true')
    expect(await seen.evaluate('tp.config.target_file.parent instanceof obsidian.TFile')).toBe('false')
  })

  it('carries the Obsidian shapes a template reads off a file', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('tp.config.target_file.path')).toBe('Reading/Target.md')
    expect(await seen.evaluate('tp.config.target_file.name')).toBe('Target.md')
    expect(await seen.evaluate('tp.config.target_file.basename')).toBe('Target')
    expect(await seen.evaluate('tp.config.target_file.extension')).toBe('md')
    expect(await seen.evaluate('tp.config.target_file.parent.path')).toBe('Reading')
    expect(await seen.evaluate('tp.config.target_file.frontmatter.level')).toBe('3')
    expect(await seen.evaluate('tp.config.target_file.tags.join(",")')).toBe('reading,long')
    // Obsidian stores file times as a 'YYYYMMDDHHMMSS' string and Templater hands it straight to moment,
    // which is why hydration builds that shape rather than passing an epoch number through.
    expect(await seen.evaluate("moment(tp.config.target_file.stat.ctime, 'YYYYMMDDHHMMSS').valueOf()"))
      .toBe(String(Date.parse('2026-01-01T00:00:00Z')))
    expect(await seen.evaluate('tp.config.target_file.children')).toBe('undefined')
    expect(await seen.evaluate('tp.config.target_file.parent.children.map((one) => one.name).join(",")')).toBe('Target.md')
    expect(await seen.evaluate('tp.config.target_file.isFolder()')).toBe('false')
    expect(await seen.evaluate('tp.config.target_file.parent.isFolder()')).toBe('true')
    // The note being created has no index entry yet, so its path is its title rather than a guess at a folder.
    const created = await namespace({ snapshot: context({ mode: 'create-new', target: null }) })
    expect(await created.evaluate('tp.config.target_file')).toBe('null')
    expect(await created.evaluate('tp.config.run_mode')).toBe('0')
  })

  it('reports the run through the names upstream templates use', async () => {
    const seen = await namespace()
    // `tp.config` is upstream's `RunningConfig`, which is exactly these four names. Anything else on it
    // would be this app's invention sitting in the middle of a portable template.
    expect(await seen.evaluate('Object.keys(tp.config).sort().join(",")')).toBe('active_file,run_mode,target_file,template_file')
    expect(await seen.evaluate('tp.config.run_mode')).toBe(String(runModeNumber('overwrite-active')))
    expect(await seen.evaluate('tp.file.title')).toBe('Target')
    expect(await seen.evaluate('tp.file.content')).toBe('the body')
    expect(await seen.evaluate('tp.file.folder()')).toBe('Reading')
    expect(await seen.evaluate('tp.file.folder(true)')).toBe('Reading')
    expect(await seen.evaluate('tp.file.path(true)')).toBe('Reading/Target.md')
    // The absolute half cannot be a disk path here, so the port answers the vault root as `/` (plan F12).
    expect(await seen.evaluate('tp.file.path()')).toBe('/Reading/Target.md')
    expect(await seen.evaluate('tp.file.path(false)')).toBe('/Reading/Target.md')
    expect(await seen.evaluate('tp.file.find_tfile("Reading/Target").basename')).toBe('Target')
    expect(await seen.evaluate('tp.file.find_tfile("Other") instanceof tp.obsidian.TFile')).toBe('true')
    expect(await seen.evaluate('tp.file.find_tfile("missing")')).toBe('null')
    expect(await seen.evaluate('tp.file.cursor(2)')).toBe('<% tp.file.cursor(2) %>')
    expect(await seen.evaluate('tp.file.cursor()')).toBe('<% tp.file.cursor() %>')
    expect(await seen.evaluate('tp.file.cursor(0)')).toBe('<% tp.file.cursor(0) %>')
    // The bare form and `0` are different groups to the jumper, so the two texts must stay different.
    expect(await seen.evaluate('tp.file.cursor() === tp.file.cursor(0)')).toBe('false')
    // The date helpers format the same string hydration wrote, which is the round trip that matters; the
    // absolute day is not asserted because the sandbox follows the machine's timezone.
    expect(await seen.evaluate('tp.file.creation_date("YYYYMMDDHHMMSS")')).toBe(await seen.evaluate('tp.config.target_file.stat.ctime'))
    expect(await seen.evaluate('tp.file.last_modified_date("YYYYMMDDHHMMSS")')).toBe(await seen.evaluate('tp.config.target_file.stat.mtime'))
    expect(await seen.evaluate('typeof tp.file.creation_date()')).toBe('string')
    // `tp.file` carries upstream's read side and nothing invented; the write half (`create_new`, `move`,
    // `rename`, `cursor_append`) is not this stage, so it is simply absent rather than a wrong answer.
    expect(await seen.evaluate('Object.keys(tp.file).sort().join(",")'))
      .toBe('content,creation_date,cursor,exists,find_tfile,folder,include,last_modified_date,path,selection,tags,title')
    expect(await seen.evaluate('tp.file.find_tfolder')).toBe('undefined')
    expect(await seen.evaluate('tp.file.basename')).toBe('undefined')
  })

  it('runs moment inside the interpreter, not beside it', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('typeof moment')).toBe('function')
    expect(await seen.evaluate('typeof moment().format')).toBe('function')
    expect(await seen.evaluate('moment(new Date(2026, 0, 1)).format("YYYY-MM-DD")')).toBe('2026-01-01')
    // The two lines a token subset gets wrong: an ordinal with a long month name, and an ISO duration.
    expect(await seen.evaluate('moment(new Date(2026, 9, 21)).format("Do MMMM YYYY")')).toBe('21st October 2026')
    expect(await seen.evaluate('moment(new Date(2026, 0, 1)).add(moment.duration("P1M")).format("YYYY-MM")')).toBe('2026-02')
    expect(await seen.evaluate('moment("2026-02-30", "YYYY-MM-DD").isValid()')).toBe('false')
    expect(await seen.evaluate('moment("2026-01-05", "YYYY-MM-DD").format("YYYY-MM-DD")')).toBe('2026-01-05')
    expect(await seen.evaluate('typeof moment().weekday')).toBe('function')
    expect(await seen.evaluate('tp.moment === moment')).toBe('true')
    expect(await seen.evaluate('moment(new Date(2026, 9, 21)).hours()')).toBe('0')
  })

  it('takes the reader locale before any date is read', async () => {
    const chinese = await namespace({ locale: 'zh-CN' })
    expect(await chinese.evaluate('moment(new Date(2026, 9, 21)).format("Do MMMM YYYY dddd")')).toBe('21日 十月 2026 星期三')
    // `zh-cn` starts the week on Monday and moment's default does not, so a week boundary computed before the
    // locale was set would be a day out.
    expect(await chinese.evaluate('moment(new Date(2026, 9, 21)).startOf("week").format("YYYY-MM-DD")')).toBe('2026-10-19')

    const english = await namespace({ locale: 'en-GB' })
    expect(await english.evaluate('moment(new Date(2026, 9, 21)).format("Do MMMM YYYY")')).toBe('21st October 2026')
    expect(await english.evaluate('moment(new Date(2026, 9, 21)).startOf("week").format("YYYY-MM-DD")')).toBe('2026-10-18')
  })

  it('keeps console output bounded and counted', async () => {
    const seen = await namespace()
    expect(await seen.evaluateBody(`for (let i = 0; i < ${MAX_LOG_LINES + 5}; i++) console.log('line ' + i)\n  tR += 'done'`)).toBe('done')
    expect(seen.logs).toHaveLength(MAX_LOG_LINES)
    expect(seen.logs[0]).toBe('log line 0')
    // An object argument is serialised rather than printed as `[object Object]`, because the point of logging
    // a template is to read what it computed.
    expect(seen.logs[MAX_LOG_LINES]).toBeUndefined()
    // Everything past the ceiling is counted rather than silently dropped, which is the difference between
    // "the template printed 500 lines" and a reader believing the note printed 300.
    expect(seen.suppressedLines()).toBeGreaterThan(0)
  })

  it('serialises an object argument instead of printing [object Object]', async () => {
    // Its own namespace: the probe above spends the log budget on purpose, and a line after that would be
    // suppressed, which is a different fact from the one being checked here.
    const seen = await namespace()
    expect(await seen.evaluate('console.warn({ a: 1 })')).toBe('undefined')
    expect(seen.logs).toEqual(['warn {"a":1}'])
  })

  it('prints a rejection nobody awaited instead of losing it', async () => {
    const snapshot = context({ capabilities: 'local' })
    const seen = await namespace({ snapshot })
    expect(await seen.evaluate('tp.hooks.on_all_templates_executed(() => {}) && "armed"')).toBe('armed')
    expect(seen.calls[0]).toMatchObject({ method: 'hooks.register', args: [1], runId: snapshot.runId })
    // The template did not await the registration, so a refusal from the page would vanish unless it is
    // printed. This is the one path in the namespace where an error has no awaiting caller.
    seen.host.deliver({ runId: snapshot.runId, callId: seen.calls[0].callId, ok: false, code: 'web-blocked' })
    const drained = await seen.evaluate('await Promise.resolve("moved")')
    expect(drained).toBe('moved')
    expect(seen.logs.some((line) => line.startsWith('error unhandled rejection: web-blocked'))).toBe(true)
  })

  it('names a toast as unsupported rather than swallowing it', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('(() => { try { new obsidian.Notice("hi"); return "shown" } catch (error) { return String(error.code) } })()'))
      .toBe('not-supported')
  })

  it('exposes the two compatibility facades as the objects tp reports', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('app === tp.app')).toBe('true')
    expect(await seen.evaluate('obsidian === tp.obsidian')).toBe('true')
    expect(await seen.evaluate('Object.keys(tp).sort().join(",")'))
      .toBe('app,base,config,date,file,frontmatter,hooks,moment,obsidian,system,user,web')
    // The ported modules are installed on the objects above, so a template reaches them by their upstream
    // names and a missing one is a defect rather than a hole in the port.
    expect(await seen.evaluate('typeof tp.date.now')).toBe('function')
    expect(await seen.evaluate('typeof tp.file.include')).toBe('function')
    expect(await seen.evaluate('Object.keys(tp.frontmatter).join(",")')).toBe('level')
    expect(await seen.evaluate('typeof tp.user.anything')).toBe('function')
    expect(await seen.evaluate('Object.keys(tp.user)')).toBe('')
    // `tp.obsidian` answers its real members, and a throwing function for anything else — never `undefined`,
    // which would fail three statements later with no name attached to it.
    expect(await seen.evaluate('typeof tp.obsidian.TFile')).toBe('function')
    expect(await seen.evaluate('typeof tp.obsidian.normalizePath')).toBe('function')
    expect(await seen.evaluate('typeof tp.obsidian.getAllTags')).toBe('function')
    expect(await seen.evaluate('tp.obsidian.then === undefined')).toBe('true')
  })

  it('keeps the user-script proxy from answering the engine', async () => {
    const seen = await namespace()
    // Awaiting the namespace itself must not start a script called `then`, and must not pretend to be one.
    expect(await seen.evaluate('tp.user.then === undefined')).toBe('true')
    expect(await seen.evaluate('"anything" in tp.user')).toBe('false')
    expect(await seen.calls).toHaveLength(0)
  })

  it('names tR as the accumulator and lets the program shadow it', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('typeof tR')).toBe('string')
    expect(await seen.evaluate('tR')).toBe('')
    // An execution command that writes the global without the compiler's own declaration still accumulates,
    // which is the reading upstream gives `tR`.
    const program = seen.evaluate('(() => { tR = "kept"; return tR })()')
    expect(await program).toBe('kept')
  })

  it('reports the sandbox as unavailable before the door is fitted', async () => {
    const runtime = (await interpreter()).newRuntime()
    const vm = runtime.newContext()
    const bootstrap = createBootstrap({ context: vm, locale: 'en-US', log: () => undefined })
    // No `install`, so no `__host`: the answer must be a named failure rather than a ReferenceError on a name
    // the template never wrote.
    const evaluated = vm.evalCode('(() => { try { return String(tp.system.clipboard()) } catch (error) { return String(error.code) } })()', 'ns-nohost.js')
    if (evaluated.error) {
      const dumped = String(vm.dump(evaluated.error) ?? '')
      evaluated.error.dispose()
      throw new Error(`the no-host expression itself failed: ${dumped}`)
    }
    expect(vm.dump(evaluated.value)).toBe('sandbox-unavailable')
    evaluated.value.dispose()
    bootstrap.dispose()
    vm.dispose()
    runtime.dispose()
  })

  it('normalizes the paths and link texts the pure helpers promise', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('obsidian.normalizePath("a\\\\b\\\\c.md")')).toBe('a/b/c.md')
    expect(await seen.evaluate('obsidian.normalizePath("/a//b/")')).toBe('a/b')
    expect(await seen.evaluate('obsidian.parseLinktext("Note#Heading").path')).toBe('Note')
    expect(await seen.evaluate('obsidian.parseLinktext("Note#^abc123").subpath.type')).toBe('block-id')
    expect(await seen.evaluate('obsidian.parseLinktext("Note#^abc123").subpath.target')).toBe('abc123')
    expect(await seen.evaluate('obsidian.parseLinktext("Note").subpath')).toBe('null')
  })

  it('gives each run its own instance table', async () => {
    // Two contexts from the same engine must not share the hydration cache: that is what makes one
    // interpreter per run mean something, and a shared `Map` would show up as one run's title leaking into
    // another's file objects.
    const first = await namespace({ snapshot: context({ runId: 'ns-a' }) })
    const second = await namespace({ snapshot: context({ runId: 'ns-b', target: null }) })
    expect(await first.evaluate('tp.config.target_file.basename')).toBe('Target')
    expect(await second.evaluate('tp.config.target_file')).toBe('null')
    expect(await first.evaluate('tp.file.title')).toBe('Target')
  })
})

/** The fixture's target note, with a few fields replaced; most cases differ only in their frontmatter. */
function targetNote(overrides: Partial<RunNoteRef>): RunNoteRef {
  return { ...context().target as RunNoteRef, ...overrides }
}

/** What one expression fails with, read inside the interpreter: `code`, `code:detail`, or `none`. */
function failureOf(seen: Namespace, expression: string, answer?: (call: HostCall) => Reply | undefined): Promise<string> {
  const body = `try { await (${expression}); tR += 'none' } catch (error) {
  tR += String(error && error.code ? (error.detail ? error.code + ':' + error.detail : error.code) : error)
}`
  return answer ? seen.evaluateAwaiting(body, answer) : seen.evaluateBody(body)
}

describe('tp.date', () => {
  // Restated from `test/specs/internal-modules/date.e2e.ts`: same defaults, same offsets, same references,
  // same thrown error for a reference that will not read with the format it was given. Upstream compared the
  // output with `moment()` in the test process; the port reads the run's instant, so `moment(STARTED)`.
  it('formats now with the upstream default, format, offsets and references', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('tp.date.now()')).toBe(moment(STARTED).format('YYYY-MM-DD'))
    expect(await seen.evaluate('tp.date.now("Do MMMM YYYY")')).toBe(moment(STARTED).format('Do MMMM YYYY'))
    expect(await seen.evaluate('tp.date.now("YYYY-MM-DD", 7)')).toBe(moment(STARTED).add(7, 'days').format('YYYY-MM-DD'))
    expect(await seen.evaluate('tp.date.now("YYYY-MM-DD", -7)')).toBe(moment(STARTED).add(-7, 'days').format('YYYY-MM-DD'))
    expect(await seen.evaluate('tp.date.now("YYYY-MM-DD", "P1M")')).toBe(moment(STARTED).add('P1M').format('YYYY-MM-DD'))
    expect(await seen.evaluate('tp.date.now("YYYY-MM-DD", "P-1M")')).toBe(moment(STARTED).add('P-1M').format('YYYY-MM-DD'))
    expect(await seen.evaluate('tp.date.now("DD/MM/YYYY", 0)')).toBe(moment(STARTED).format('DD/MM/YYYY'))
    // A reference is read with `reference_format`, and the offset is still days.
    expect(await seen.evaluate('tp.date.now("YYYY-MM-DD", 0, "2025-01-15")')).toBe('2025-01-15')
    expect(await seen.evaluate('tp.date.now("YYYY-MM-DD", 0, "01/15/2025", "MM/DD/YYYY")')).toBe('2025-01-15')
    expect(await seen.evaluate('tp.date.now("YYYY-MM-DD", 7, "2025-06-01")')).toBe('2025-06-08')
    // `now` answers a date. A template that wanted the time asks moment itself; the defect this pins is the
    // one where `tp.date.now()` was a clock reading, which no upstream template can be relying on.
    expect(await seen.evaluate('tp.date.now()')).not.toContain(':')
  })

  it('refuses a reference that does not read with its format', async () => {
    const seen = await namespace()
    expect(await failureOf(seen, 'tp.date.now("YYYY-MM-DD", 0, "01/15/2025", "DD/MM/YYYY")'))
      .toBe('render-failed:tp.date.now.reference')
    expect(await failureOf(seen, 'tp.date.weekday("YYYY-MM-DD", 0, "13/12/2025", "MM/DD/YYYY")'))
      .toBe('render-failed:tp.date.weekday.reference')
  })

  it('answers tomorrow and yesterday from the run instant', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('tp.date.tomorrow()')).toBe(moment(STARTED).add(1, 'days').format('YYYY-MM-DD'))
    expect(await seen.evaluate('tp.date.tomorrow("DD/MM/YYYY")')).toBe(moment(STARTED).add(1, 'days').format('DD/MM/YYYY'))
    expect(await seen.evaluate('tp.date.yesterday()')).toBe(moment(STARTED).add(-1, 'days').format('YYYY-MM-DD'))
    expect(await seen.evaluate('tp.date.yesterday("DD/MM/YYYY")')).toBe(moment(STARTED).add(-1, 'days').format('DD/MM/YYYY'))
    // `tp.system.now` was this port's invention, and upstream's `tp.system` has no clock on it.
    expect(await seen.evaluate('typeof tp.system.now')).toBe('undefined')
  })

  it('computes weekday in the locale the run was given', async () => {
    // 2025-01-12 is a Sunday. English starts its week there; `zh-cn` starts on Monday, so the same call
    // answers a different day — which is only true if the prelude's locale survived into `tp.date`.
    const english = await namespace({ locale: 'en-GB' })
    expect(await english.evaluate('tp.date.weekday("YYYY-MM-DD", 0, "2025-01-12")')).toBe('2025-01-12')
    expect(await english.evaluate('tp.date.weekday("dddd", 0, "2025-01-12")')).toBe('Sunday')
    expect(await english.evaluate('tp.date.weekday("DD/MM/YYYY", 3, "2025-01-12")')).toBe('15/01/2025')
    expect(await english.evaluate('tp.date.weekday("YYYY-MM-DD", -7, "2025-01-12")')).toBe('2025-01-05')
    expect(await english.evaluate('tp.date.weekday("YYYY-MM-DD", 0, "12/01/2025", "DD/MM/YYYY")')).toBe('2025-01-12')
    expect(await english.evaluate('tp.date.weekday("YYYY-MM-DD", -7, "12/01/2025", "DD/MM/YYYY")')).toBe('2025-01-05')
    expect(await english.evaluate('tp.date.weekday(undefined, 0)')).toBe(moment(STARTED).weekday(0).format('YYYY-MM-DD'))

    const chinese = await namespace({ locale: 'zh-CN' })
    expect(await chinese.evaluate('tp.date.weekday("YYYY-MM-DD", 0, "2025-01-12")')).toBe('2025-01-06')
  })

  it('fails the way upstream fails when weekday is called with nothing', async () => {
    const seen = await namespace()
    // Upstream gives `weekday` no default either, so moment answers its getter with a number and the
    // format call after it is a TypeError. The spec pins a failed run, not an empty string.
    expect(await failureOf(seen, 'tp.date.weekday()')).toContain('TypeError')
    expect(await failureOf(seen, 'tp.date.weekday("DD/MM/YYYY")')).toContain('TypeError')
  })
})

describe('tp.file', () => {
  it('keeps the title the run started with across a rename', async () => {
    const seen = await namespace()
    // `file.e2e.ts:27`: `<% tp.file.title %><%* await tp.file.rename(...) %><% tp.file.title %>` prints the
    // old name twice. The rename here is the same host call the write side will make.
    const body = `const before = tp.file.title
  const after = await tp.config.target_file.rename('Renamed')
  tR += before + '|' + tp.file.title + '|' + after.basename`
    const out = await seen.evaluateAwaiting(body, (call) => (call.method === 'note.rename'
      ? { value: { path: 'Reading/Renamed.md', name: 'Renamed.md', basename: 'Renamed' } }
      : undefined))
    expect(out).toBe('Target|Target|Renamed')
  })

  it('joins tags with the hash kept on, and answers nothing for a note without tags', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('String(tp.file.tags)')).toBe('#reading,#long')
    expect(await seen.evaluate('tp.file.tags.length')).toBe('2')
    const bare = await namespace({ snapshot: context({ target: targetNote({ tagNames: [] }) }) })
    expect(await bare.evaluate('String(tp.file.tags)')).toBe('')
    expect(await bare.evaluate('tp.file.tags.length')).toBe('0')
  })

  it('answers the folder of a root note as the empty string', async () => {
    const seen = await namespace({
      snapshot: context({
        target: targetNote({ folderId: null }),
        index: [{ id: 'note-1', title: 'Target', folderId: null, path: 'Target.md', updatedAt: 2, createdAt: 1 }],
        folders: [],
      }),
    })
    expect(await seen.evaluate('tp.file.folder()')).toBe('')
    expect(await seen.evaluate('tp.file.folder(true)')).toBe('')
    expect(await seen.evaluate('tp.file.path(true)')).toBe('Target.md')
  })

  it('asks the page whether a path exists, and refuses to guess one', async () => {
    const seen = await namespace()
    expect(await seen.evaluateAwaiting(`tR += String(await tp.file.exists('Reading/Target.md'))`,
      (call) => (call.method === 'note.exists' ? { value: true } : undefined))).toBe('true')
    expect(seen.calls[0].method).toBe('note.exists')
    expect(seen.calls[0].args).toEqual(['Reading/Target.md'])

    const missing = await namespace()
    expect(await missing.evaluateAwaiting(`tR += String(await tp.file.exists('nonexistent.md'))`,
      (call) => (call.method === 'note.exists' ? { value: false } : undefined))).toBe('false')

    // Upstream hands the argument to `normalizePath`, so an absent one throws rather than looking for "".
    expect(await failureOf(seen, 'tp.file.exists()')).toBe('path-invalid:tp.file.exists')
  })

  it('resolves find_tfile to a file or to nothing, never to a guess', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('tp.file.find_tfile("Other").path')).toBe('Other.md')
    expect(await seen.evaluate('tp.file.find_tfile("Reading/Target").basename')).toBe('Target')
    expect(await seen.evaluate('tp.file.find_tfile("nonexistent")')).toBe('null')
    expect(await failureOf(seen, 'tp.file.find_tfile()')).toBe('path-invalid:tp.file.find_tfile')
  })

  it('reads an included note through the door the run is allowed to use', async () => {
    const seen = await namespace()
    expect(await seen.evaluateAwaiting(`tR += await tp.file.include('[[Other]]')`,
      (call) => (call.method === 'note.read' ? { value: { content: 'the other body' } } : undefined)))
      .toBe('the other body')
    expect(seen.calls.map((call) => [call.method, call.args[0]])).toEqual([['note.read', 'Other.md']])

    // A library template is answered from the snapshot, but still through `template.read`, so a run without
    // the right to read other notes cannot pull a template body out of its own table.
    const local = await namespace()
    expect(await local.evaluateAwaiting(`tR += await tp.file.include('[[Idea]]')`, () => undefined))
      .toBe('from the library')
    expect(local.calls).toHaveLength(0)

    // The note the run is writing into is already in hand; asking the page for it again would need a right
    // the narrow profiles do not carry.
    const self = await namespace()
    expect(await self.evaluateAwaiting(`tR += await tp.file.include('[[Reading/Target]]')`, () => undefined))
      .toBe('the body')
    expect(self.calls).toHaveLength(0)
  })

  it('answers a library template through one path, whichever way the run reached it', async () => {
    // The snapshot a real run carries indexes its templates as `Templates/<name>.md`, the same projection
    // the notes get. When the two lists disagree about that path, `include` stops matching the template
    // list and asks the page for a note no vault has — so the file object, `find_tfile` and `include` all
    // have to answer the indexed path, and the body still comes from the snapshot without a round trip.
    const indexed = await namespace({
      snapshot: context({
        index: [
          { id: 'note-9', title: 'Other', folderId: null, path: 'Other.md', updatedAt: 2, createdAt: 1 },
          { id: 'tpl-1', title: 'Idea', folderId: 'templater:templates', path: 'Templates/Idea.md', updatedAt: 2, createdAt: 1 },
        ],
      }),
    })
    expect(await indexed.evaluate('tp.config.template_file.path')).toBe('Templates/Idea.md')
    expect(await indexed.evaluate('tp.config.template_file.basename')).toBe('Idea')
    expect(await indexed.evaluate('tp.file.find_tfile("Idea").path')).toBe('Templates/Idea.md')
    expect(await indexed.evaluateAwaiting(`tR += await tp.file.include('[[Idea]]')`, () => undefined))
      .toBe('from the library')
    expect(indexed.calls).toHaveLength(0)
  })

  it('refuses an inclusion it cannot honour', async () => {
    const seen = await namespace()
    // Upstream's link form, upstream's error: the bare text is not a link.
    expect(await failureOf(seen, "tp.file.include('Other')")).toBe('path-invalid:tp.file.include')
    expect(await failureOf(seen, "tp.file.include('[[Nope]]')")).toBe('note-not-found:[[Nope]]')
    // A section or a block needs the note's parse positions, which no host method carries.
    expect(await failureOf(seen, "tp.file.include('[[Other#Heading]]')")).toBe('not-supported:tp.file.include.subpath')
    expect(await failureOf(seen, "tp.file.include('[[Other#^abc123]]')")).toBe('not-supported:tp.file.include.subpath')
    // A file object is accepted the way upstream accepts one.
    expect(await seen.evaluateAwaiting(`tR += await tp.file.include(tp.file.find_tfile('Other'))`,
      (call) => (call.method === 'note.read' ? { value: { content: 'by file object' } } : undefined)))
      .toBe('by file object')
  })

  it('counts simultaneous inclusions the way upstream counts nested ones', async () => {
    const seen = await namespace()
    const answer = (call: HostCall) => (call.method === 'note.read' ? { value: { content: 'x' } } : undefined)
    // Eleven at once: upstream's limit is ten deep, so the eleventh is refused and the ten are not.
    expect(await seen.evaluateAwaiting(`const all = []
  for (let i = 0; i < 11; i++) all.push(tp.file.include('[[Other]]').then(() => 'ok', (error) => String(error.code)))
  tR += (await Promise.all(all)).filter((one) => one === 'template-recursion').length`, answer)).toBe('1')
    expect(await seen.evaluateAwaiting(`let done = 0
  for (let i = 0; i < 11; i++) { await tp.file.include('[[Other]]'); done += 1 }
  tR += done`, answer)).toBe('11')
  })

  it('names the selection it has no way to read, instead of answering the note', async () => {
    const seen = await namespace()
    expect(await failureOf(seen, 'tp.file.selection()')).toBe('not-supported:tp.file.selection')
    // The refusal is made here, so nothing is asked of the page and no text is invented for it.
    expect(seen.calls).toHaveLength(0)
  })

  it('answers date helpers with a failure rather than with the clock when there is no note', async () => {
    const created = await namespace({ snapshot: context({ mode: 'create-new', target: null }) })
    expect(await failureOf(created, 'tp.file.creation_date()')).toBe('note-not-found:tp.file.creation_date')
    expect(await failureOf(created, 'tp.file.last_modified_date()')).toBe('note-not-found:tp.file.last_modified_date')
    expect(await failureOf(created, 'tp.file.path(true)')).toBe('note-not-found:tp.file.path')
    expect(await created.evaluate('tp.file.folder()')).toBe('')
  })
})

describe('tp.frontmatter', () => {
  // `test/specs/internal-modules/frontmatter.e2e.ts`, against a snapshot whose target carries the same
  // frontmatter those notes were written with.
  function withFrontmatter(): Promise<Namespace> {
    return namespace({
      snapshot: context({
        target: targetNote({
          frontmatter: { tags: ['work', 'project'], items: ['a', 'b', 'c'], name: 'Alice', role: 'admin', published: true, priority: 42, 'note type': 'daily' },
        }),
      }),
    })
  }

  it('reads each key the way the target note holds it', async () => {
    const world = await withFrontmatter()
    expect(await world.evaluate('tp.frontmatter.name')).toBe('Alice')
    expect(await world.evaluate('String(tp.frontmatter["note type"])')).toBe('daily')
    expect(await world.evaluate('String(tp.frontmatter.tags)')).toBe('work,project')
    expect(await world.evaluate('String(tp.frontmatter.items)')).toBe('a,b,c')
    expect(await world.evaluate('tp.frontmatter.name + " " + tp.frontmatter.role')).toBe('Alice admin')
    expect(await world.evaluate('String(tp.frontmatter.published)')).toBe('true')
    expect(await world.evaluate('tp.frontmatter.priority')).toBe('42')
    expect(await world.evaluate('Object.keys(tp.frontmatter).sort().join(",")'))
      .toBe('items,name,note type,priority,published,role,tags')
  })

  it('prints the word undefined for a key the note does not have', async () => {
    const world = await withFrontmatter()
    // Upstream's spec pins this exactly: the missing key is `undefined`, and the template writes it out.
    expect(await world.evaluate('String(tp.frontmatter.missing)')).toBe('undefined')
    const none = await namespace({ snapshot: context({ target: targetNote({ frontmatter: {} }) }) })
    expect(await none.evaluate('String(tp.frontmatter.anything)')).toBe('undefined')
    expect(await none.evaluate('Object.keys(tp.frontmatter)')).toBe('')
  })

  it('keeps a frontmatter key named after the prototype a key, not a prototype', async () => {
    // A note can hold a `__proto__` key. Assignment would replace the object's prototype with it, which is
    // the pollution upstream's `Object.fromEntries` does not do and this port must not either.
    const polluted = await namespace({ snapshot: context({ target: targetNote({ frontmatter: { ['__proto__']: { poisoned: 'yes' } } }) }) })
    expect(await polluted.evaluate('Object.prototype.hasOwnProperty.call(tp.frontmatter, "__proto__")')).toBe('true')
    expect(await polluted.evaluate('tp.frontmatter.poisoned')).toBe('undefined')
    expect(await polluted.evaluate('({}).poisoned')).toBe('undefined')
  })
})

describe('tp.system', () => {
  it('sends the prompt upstream sends', async () => {
    const seen = await namespace()
    expect(await seen.evaluateAwaiting(`tR += await tp.system.prompt('Enter a value')`,
      () => ({ value: 'my typed value' }))).toBe('my typed value')
    expect(seen.calls[0].args[0]).toMatchObject({ kind: 'text', title: 'Enter a value', multiLine: false, selectDefaultValue: false, throwOnCancel: false })
    // No default given, so none is sent: the dialog opens empty rather than carrying a value upstream
    // would not have carried.
    expect((seen.calls[0].args[0] as { defaultValue?: unknown }).defaultValue).toBeUndefined()

    const withDefaults = await namespace()
    await withDefaults.evaluateAwaiting(`tR += await tp.system.prompt('Enter a value', 'default text', false, true, true)`,
      () => ({ value: 'default text' }))
    // The argument order is upstream's: text, default, throw_on_cancel, multi_line, select_default_value.
    expect(withDefaults.calls[0].args[0]).toMatchObject({
      title: 'Enter a value', defaultValue: 'default text', multiLine: true, selectDefaultValue: true,
    })
  })

  it('cancels the three dialogs the three different ways upstream cancels them', async () => {
    const cancelled = (call: HostCall) => (call.method.startsWith('system.') ? { code: 'prompt-cancelled' } : undefined)
    const prompt = await namespace()
    expect(await prompt.evaluateAwaiting('tR += String(await tp.system.prompt("Ask"))', cancelled)).toBe('null')
    const suggester = await namespace()
    expect(await suggester.evaluateAwaiting('tR += String(await tp.system.suggester(["A", "B"], ["a", "b"]))', cancelled)).toBe('null')
    const multi = await namespace()
    expect(await multi.evaluateAwaiting('tR += String(await tp.system.multi_suggester(["A", "B"], ["a", "b"]))', cancelled)).toBe('')

    const throwing = await namespace()
    expect(await failureOf(throwing, 'tp.system.prompt("Ask", "", true)', () => ({ code: 'prompt-cancelled' }))).toBe('prompt-cancelled')
    const throwingSuggester = await namespace()
    expect(await failureOf(throwingSuggester, 'tp.system.suggester(["A"], ["a"], true)', () => ({ code: 'prompt-cancelled' }))).toBe('prompt-cancelled')
    const throwingMulti = await namespace()
    expect(await failureOf(throwingMulti, 'tp.system.multi_suggester(["A"], ["a"], true)', () => ({ code: 'prompt-cancelled' }))).toBe('prompt-cancelled')
  })

  it('answers the suggester with the item, in upstream argument positions', async () => {
    const seen = await namespace()
    expect(await seen.evaluateAwaiting(`tR += await tp.system.suggester(['Apple', 'Banana', 'Cherry'], ['apple', 'banana', 'cherry'])`,
      () => ({ value: 'Banana' }))).toBe('banana')
    expect(seen.calls[0].args[0]).toMatchObject({ kind: 'suggest', values: ['Apple', 'Banana', 'Cherry'], title: '' })

    const fourth = await namespace()
    expect(await fourth.evaluateAwaiting(`tR += await tp.system.suggester(['Apple', 'Banana'], ['apple', 'banana'], false, 'Pick a fruit', 2, 'banana')`,
      () => ({ value: 'Banana' }))).toBe('banana')
    expect(fourth.calls[0].args[0]).toMatchObject({ placeholder: 'Pick a fruit', limit: 2, defaultValue: 'Banana' })

    const byFunction = await namespace()
    expect(await byFunction.evaluateAwaiting(`tR += String((await tp.system.suggester((item) => item.label, [{ label: 'A', id: 7 }])).id)`,
      () => ({ value: 'A' }))).toBe('7')
    expect(byFunction.calls[0].args[0]).toMatchObject({ values: ['A'] })

    // Cancellation is the only null; an answer the labels do not hold travels back unchanged.
    const unknown = await namespace()
    expect(await unknown.evaluateAwaiting(`tR += await tp.system.suggester(['Apple'], ['apple'])`,
      () => ({ value: 'Something the page typed' }))).toBe('Something the page typed')
  })

  it('answers the multi suggester with the items it was given', async () => {
    const seen = await namespace()
    expect(await seen.evaluateAwaiting(`tR += (await tp.system.multi_suggester(['Apple', 'Banana', 'Cherry'], ['apple', 'banana', 'cherry'])).join(',')`,
      () => ({ value: ['Banana', 'Cherry'] }))).toBe('banana,cherry')

    const titled = await namespace()
    expect(await titled.evaluateAwaiting(`tR += (await tp.system.multi_suggester(['Apple', 'Banana', 'Cherry'], ['apple', 'banana', 'cherry'], false, 'Pick a fruit', 2, ['banana'])).join(',')`,
      () => ({ value: ['Cherry'] }))).toBe('cherry')
    expect(titled.calls[0].args[0]).toMatchObject({ kind: 'multi-suggest', title: 'Pick a fruit', limit: 2, defaultPicks: ['Banana'] })
    expect(await seen.evaluate('Object.keys(tp.system).sort().join(",")')).toBe('clipboard,multi_suggester,prompt,suggester')
  })

  it('reads the clipboard through the door and nothing else', async () => {
    const seen = await namespace()
    expect(await seen.evaluateAwaiting('tR += await tp.system.clipboard()',
      (call) => (call.method === 'system.clipboard' ? { value: 'copied text' } : undefined))).toBe('copied text')
    expect(seen.calls[0].method).toBe('system.clipboard')
  })
})

describe('tp.web', () => {
  // The proxy's envelope is `{ status, ok, contentType, text }`, so the JSON is read here — which is what
  // upstream's `response.json` was for — and the dot path is walked here too.
  const json = (text: string) => ({ status: 200, ok: true, contentType: 'application/json', text })

  it('requests a url and walks the path through the response', async () => {
    const seen = await namespace()
    const body = '{"todos":[{"title":"write it"}]}'
    expect(await seen.evaluateAwaiting(`tR += await tp.web.request('https://example.test/todos', 'todos.0.title')`,
      () => ({ value: json(body) }))).toBe('write it')
    // Two arguments, GET, no method or headers: upstream's signature and the plan's W3.
    expect(seen.calls[0].args).toEqual([{ url: 'https://example.test/todos' }])

    const whole = await namespace()
    expect(await whole.evaluateAwaiting(`tR += (await tp.web.request('https://example.test/todos')).todos[0].title`,
      () => ({ value: json(body) }))).toBe('write it')

    const missing = await namespace()
    expect(await failureOf(missing, "tp.web.request('https://example.test/todos', 'todos.5.title')",
      () => ({ value: json(body) }))).toBe('path-invalid:todos.5.title')
  })

  it('fails a response that is not a readable json body', async () => {
    // Upstream flattens all of these into one sentence; the port keeps the code and the number, so the
    // reader can tell a refused address from a body that is not json.
    const refused = await namespace()
    expect(await failureOf(refused, "tp.web.request('https://example.test/x')",
      () => ({ value: { status: 404, ok: false, contentType: 'text/html', text: 'no such page' } }))).toBe('web-request-failed:404')
    const prose = await namespace()
    expect(await failureOf(prose, "tp.web.request('https://example.test/x')",
      () => ({ value: json('not json at all') }))).toBe('web-request-failed:json')
    const empty = await namespace()
    expect(await failureOf(empty, "tp.web.request('https://example.test/x')",
      () => ({ value: { status: 200, ok: true, contentType: 'application/json' } }))).toBe('web-request-failed:web.request')
  })

  it('assembles a random picture from the size the template asked for', async () => {
    const photo = { full: 'https://images.unsplash.com/photo-1', photog: 'Ada', photogUrl: 'https://unsplash.com/@ada' }
    const seen = await namespace()
    expect(await seen.evaluateAwaiting(`tR += await tp.web.random_picture('200x300', 'landscape,water')`,
      () => ({ value: photo }))).toBe('![photo by Ada(https://unsplash.com/@ada) on Unsplash](https://images.unsplash.com/photo-1&w=200&h=300)')
    expect(seen.calls[0].method).toBe('web.randomPicture')
    expect(seen.calls[0].args).toEqual(['landscape,water'])

    const width = await namespace()
    expect(await width.evaluateAwaiting(`tR += await tp.web.random_picture('400')`,
      () => ({ value: photo }))).toBe('![photo by Ada(https://unsplash.com/@ada) on Unsplash](https://images.unsplash.com/photo-1&w=400)')

    const marked = await namespace()
    expect(await marked.evaluateAwaiting(`tR += await tp.web.random_picture('200x300', undefined, true)`,
      () => ({ value: photo }))).toBe('![photo by Ada(https://unsplash.com/@ada) on Unsplash|200x300](https://images.unsplash.com/photo-1)')

    // No size at all still answers a picture: `size` is required in upstream's implementation even though
    // its own reference writes `size?`, and the implementation is what a template runs.
    const plain = await namespace()
    expect(await plain.evaluateAwaiting(`tR += await tp.web.random_picture()`,
      () => ({ value: photo }))).toBe('![photo by Ada(https://unsplash.com/@ada) on Unsplash](https://images.unsplash.com/photo-1)')

    const refused = await namespace()
    expect(await failureOf(refused, 'tp.web.random_picture("200x200")', () => ({ value: null })))
      .toBe('web-request-failed:web.randomPicture')
  })

  it('resolves the quote language the way upstream does', async () => {
    const quote = { quote: 'A line worth keeping', author: 'Someone' }
    const seen = await namespace()
    expect(await seen.evaluateAwaiting('tR += await tp.web.daily_quote()', () => ({ value: quote })))
      .toBe('> [!quote] A line worth keeping\n> \u2014 Someone')
    // No argument: the reader's language, taken from the snapshot the run arrived with.
    expect(seen.calls[0].args).toEqual(['en-us'])

    const explicit = await namespace()
    expect(await explicit.evaluateAwaiting('tR += await tp.web.daily_quote("es")', () => ({ value: quote })))
      .toBe('> [!quote] A line worth keeping\n> \u2014 Someone')
    expect(explicit.calls[0].args).toEqual(['es'])

    const chinese = await namespace({ locale: 'zh-CN' })
    await chinese.evaluateAwaiting('tR += await tp.web.daily_quote()', () => ({ value: quote }))
    expect(chinese.calls[0].args).toEqual(['zh-cn'])

    const refused = await namespace()
    expect(await failureOf(refused, 'tp.web.daily_quote()', () => ({ value: null })))
      .toBe('web-request-failed:web.dailyQuote')
    expect(await seen.evaluate('Object.keys(tp.web).sort().join(",")')).toBe('daily_quote,random_picture,request')
  })
})

describe('tp.obsidian', () => {
  it('names the tags the way Obsidian hands them out', async () => {
    const seen = await namespace()
    expect(await seen.evaluate('String(tp.obsidian.getAllTags(tp.config.target_file))')).toBe('#reading,#long')
    expect(await seen.evaluate('tp.obsidian.getAllTags(tp.config.target_file).length')).toBe('2')
    // Null, not an empty array: that is what Obsidian's own function answers for a note without tags.
    expect(await seen.evaluate('tp.obsidian.getAllTags(tp.config.active_file)')).toBe('null')
    expect(await seen.evaluate('tp.obsidian.getAllTags(null)')).toBe('null')
  })

  it('answers a member it does not have with the refusal, named', async () => {
    const seen = await namespace()
    expect(await failureOf(seen, 'tp.obsidian.MarkdownView("x")')).toBe('not-supported:tp.obsidian.MarkdownView')
    expect(await failureOf(seen, 'new tp.obsidian.Notice("x")')).toBe('not-supported:obsidian.Notice')
    expect(await seen.evaluate('typeof tp.obsidian.TFolder')).toBe('function')
    expect(await seen.evaluate('typeof tp.obsidian.parseLinktext')).toBe('function')
  })
})
