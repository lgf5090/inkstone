import { describe, expect, it } from 'vitest'
import type { QuickJSWASMModule } from 'quickjs-emscripten-core'
import type { HostCall, TemplateRunContext } from '../protocol'
import { TEMPLATE_GLOBAL_NAMES, createBootstrap, runModeNumber } from './bootstrap'
import { createHostBindings } from './host-bindings'
import { capabilitiesFor } from './protocol'
import { MAX_LOG_LINES, RUNTIME_MEMORY_BYTES, STACK_BYTES } from './limits'
import { loadEngine } from './vm'

/**
 * The namespace, tested against the interpreter rather than against a mock of it.
 *
 * Every case here is an expression evaluated *inside* QuickJS and read back as text, because what is under
 * test is which names a template can speak and what they reach — a question a fake cannot answer. The
 * fixtures use locally constructed dates, since the sandbox inherits the machine's timezone and a test that
 * compares a formatted UTC instant against a fixed string would pass on one machine and fail on another.
 */
function context(overrides: Partial<TemplateRunContext> = {}): TemplateRunContext {
  return {
    runId: 'ns-1',
    mode: 'overwrite-active',
    capabilities: 'local',
    template: { id: 'tpl-1', name: 'Idea', content: 'from the library' },
    startedAt: Date.parse('2026-03-04T05:06:07Z'),
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
  /** How many lines the ceiling dropped, which `logs` cannot show by construction. */
  suppressedLines: () => number
}

/** A context with the namespace installed and a working door, which is what a template actually sees. */
async function namespace(options: { locale?: string; snapshot?: TemplateRunContext } = {}): Promise<Namespace> {
  const snapshot = options.snapshot ?? context()
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
   */
  async function evaluateBody(body: string): Promise<string> {
    const program = vm.evalCode(`(async () => { let tR = ''\n  ${body}\n  return tR })()`, 'ns-probe.js')
    if (program.error) {
      const dumped = vm.dump(program.error) as { message?: string }
      const message = typeof dumped?.message === 'string' ? dumped.message : 'evaluation failed'
      program.error.dispose()
      throw new Error(message)
    }
    const promise = program.value
    let state = vm.getPromiseState(promise)
    while (state.type === 'pending') {
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

  /** Run one expression and read what it made; the shorthand nearly every probe here wants. */
  function evaluate(expression: string): Promise<string> {
    return evaluateBody(`tR += String(${expression})`)
  }

  return { logs, calls, host, evaluate, evaluateBody, suppressedLines: () => bootstrap.suppressedLines() }
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
    for (const helper of ['jsonToValue', 'hostError', 'callHost', 'hydrate', 'install', 'fileOf', 'index', 'settle']) {
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
    expect(await seen.evaluate('tp.config.run_mode')).toBe(String(runModeNumber('overwrite-active')))
    expect(await seen.evaluate('tp.config.static')).toBe('true')
    expect(await seen.evaluate('tp.file.title')).toBe('Target')
    expect(await seen.evaluate('tp.file.content')).toBe('the body')
    expect(await seen.evaluate('tp.file.folder()')).toBe('Reading')
    expect(await seen.evaluate('tp.file.folder(true)')).toBe('Reading')
    expect(await seen.evaluate('tp.file.find_tfile("Reading/Target").basename')).toBe('Target')
    expect(await seen.evaluate('tp.file.find_tfile("Other") instanceof tp.obsidian.TFile')).toBe('true')
    expect(await seen.evaluate('tp.file.find_tfolder("Reading") instanceof tp.obsidian.TFolder')).toBe('true')
    expect(await seen.evaluate('tp.file.find_tfile("missing")')).toBe('null')
    expect(await seen.evaluate('tp.file.cursor(2)')).toBe('<% tp.file.cursor(2) %>')
    expect(await seen.evaluate('tp.file.cursor()')).toBe('<% tp.file.cursor() %>')
    // The date helpers format the same string hydration wrote, which is the round trip that matters; the
    // absolute day is not asserted because the sandbox follows the machine's timezone.
    expect(await seen.evaluate('tp.file.creation_date("YYYYMMDDHHMMSS")')).toBe(await seen.evaluate('tp.config.target_file.stat.ctime'))
    expect(await seen.evaluate('tp.file.last_modified_date("YYYYMMDDHHMMSS")')).toBe(await seen.evaluate('tp.config.target_file.stat.mtime'))
    expect(await seen.evaluate('typeof tp.file.creation_date()')).toBe('string')
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
    // The members the ported modules fill in are absent rather than invented, and the reason is stated where
    // they are created: a call into them fails with a TypeError naming the function, which is a report rather
    // than a silently wrong date or an empty frontmatter.
    expect(await seen.evaluate('typeof tp.date.now')).toBe('undefined')
    expect(await seen.evaluate('typeof tp.file.include')).toBe('undefined')
    expect(await seen.evaluate('Object.keys(tp.frontmatter)')).toBe('')
    expect(await seen.evaluate('typeof tp.user.anything')).toBe('function')
    expect(await seen.evaluate('Object.keys(tp.user)')).toBe('')
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
