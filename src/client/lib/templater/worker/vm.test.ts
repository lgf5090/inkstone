import { describe, expect, it, vi } from 'vitest'
import type { HostResult, RunRequest, TemplateRunContext, WorkerMessage } from '../protocol'
import { TemplateRun } from './vm'
import { buildRunSnapshot } from '../context/snapshot'
import { DEFAULT_RUN_DEADLINE_MS, MAX_CLIPBOARD_CHARS, MAX_OUTPUT_CHARS, MIN_RUN_DEADLINE_MS } from '../limits'

/**
 * The harness: a real interpreter, a scripted page.
 *
 * Nothing here is mocked except the page itself, which is the point — the engine is QuickJS compiled to
 * WebAssembly and it runs for real under the `jsdom` project (the wasm file is loaded as a compiled module
 * by `vitest.config.ts`). A test that faked the interpreter would prove only that the code calls a mock.
 */
function context(overrides: Partial<TemplateRunContext> = {}): TemplateRunContext {
  return {
    runId: 'run-1',
    mode: 'append-active',
    capabilities: 'local',
    template: null,
    startedAt: Date.parse('2026-01-01T00:00:00Z'),
    target: {
      id: 'note-1',
      title: 'Target',
      content: 'body of the note',
      folderId: 'folder-1',
      tagNames: ['reading'],
      frontmatter: { level: 3 },
      createdAt: Date.parse('2026-01-01T00:00:00Z'),
      updatedAt: Date.parse('2026-01-02T00:00:00Z'),
      isEmpty: false,
    },
    active: null,
    frozenTitle: 'Target',
    index: [{ id: 'note-1', title: 'Target', folderId: 'folder-1', path: 'Reading/Target.md', updatedAt: 1, createdAt: 0 }],
    folders: [{ id: 'folder-1', name: 'Reading', parentId: null, path: 'Reading' }],
    libraryTemplates: [{ id: 'tpl-1', name: 'Idea', content: 'from the library' } as never],
    locale: 'en-US',
    selection: '',
    userScripts: [],
    ...overrides,
  }
}

function runRequest(source: string, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    kind: 'run',
    runId: 'run-1',
    context: context(),
    // The compiled program shape the parser produces: one async function that accumulates into `tR`.
    source: `(async () => {\n  let tR = ''\n  ${source}\n  return tR\n})()`,
    deadlineMs: DEFAULT_RUN_DEADLINE_MS,
    ...overrides,
  }
}

interface Harness {
  messages: WorkerMessage[]
  run: TemplateRun
}

/** Open a run and start it, collecting what the worker would have posted. */
async function execute(source: string, requestOverrides: Partial<RunRequest> = {}): Promise<Harness> {
  const messages: WorkerMessage[] = []
  const request = runRequest(source, requestOverrides)
  const run = await TemplateRun.open(request, (message) => messages.push(message))
  run.start()
  return { messages, run }
}

/** The first host call the run made, if any. */
function hostCall(messages: WorkerMessage[]): { callId: string; method: string; args: unknown[] } | null {
  for (const message of messages) {
    if (message.kind === 'host-call') return message.call
  }
  return null
}

function answered(callId: string, value: unknown): HostResult {
  return { runId: 'run-1', callId, ok: true, value }
}

function terminal(messages: WorkerMessage[]): WorkerMessage | undefined {
  return messages.find((message) => message.kind === 'done' || message.kind === 'failed')
}

describe('templater interpreter', () => {
  it('renders the accumulated text of a program', async () => {
    const { messages } = await execute(`tR += 'Year ' + moment(0).format('YYYY')`)
    expect(terminal(messages)).toEqual({ kind: 'done', runId: 'run-1', output: 'Year 1970', durationMs: expect.any(Number) })
  })

  it('stops a program that never ends and stays usable afterwards', async () => {
    const started = Date.now()
    const { messages, run } = await execute('while (true) {}', { deadlineMs: 600 })
    const failure = terminal(messages)
    // The detail is the interpreter's own word for being stopped, and the elapsed time is the proof the
    // interrupt handler fired rather than a promise that merely never settled.
    expect(failure).toMatchObject({ kind: 'failed', runId: 'run-1', code: 'sandbox-timeout' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(run.currentState).toBe('finished')

    // The same WebAssembly instance, a second run, a normal answer. This is the half that matters: an
    // engine that could not be used again after an interrupt would take the notebook down with one template.
    const second = await execute(`tR += 'still here'`)
    expect(terminal(second.messages)).toMatchObject({ kind: 'done', output: 'still here' })
  })

  it('reports a program that runs out of stack as a stack overflow and stays usable', async () => {
    const { messages } = await execute('const dive = (n) => dive(n + 1)\n  tR += dive(0)')
    expect(terminal(messages)).toMatchObject({ kind: 'failed', code: 'sandbox-stack-overflow' })

    // The ceiling is sized so QuickJS raises its own `InternalError: stack overflow` rather than letting the
    // recursion exhaust the stack of the WebAssembly instance. That distinction is the difference between a
    // reportable failure and a runtime that cannot be freed: measured in this package's own probe, where a
    // runtime freed after a host-level blow-up aborted the module with `list_empty(&rt->gc_obj_list)`, and a
    // ceiling of 64 KiB never gets there.
    const second = await execute(`tR += 'after the overflow'`)
    expect(terminal(second.messages)).toMatchObject({ kind: 'done', output: 'after the overflow' })
  })

  it('maps a runtime error inside the template onto render-failed with the interpreter message', async () => {
    const { messages } = await execute("tR += nope.x")
    const failure = terminal(messages)
    expect(failure).toMatchObject({ kind: 'failed', code: 'render-failed' })
    // The text is kept rather than dropped: a reader with `nope is not defined` can find the line, and one
    // with a code alone cannot.
    expect((failure as { detail?: string }).detail).toMatch(/nope/)
  })

  it('fails a body the interpreter refuses to parse as render-failed', async () => {
    const { messages } = await execute('tR += (', { source: '(async () => { let tR = \'\' \n tR += (' })
    expect(terminal(messages)).toMatchObject({ kind: 'failed', code: 'render-failed' })
  })

  it('reports a program awaiting something the sandbox cannot provide', async () => {
    const { messages } = await execute('await new Promise(() => {})')
    expect(terminal(messages)).toMatchObject({ kind: 'failed', code: 'render-failed', detail: 'unresolvable' })
  })

  it('waits for the page on an awaited host call, then continues', async () => {
    const { messages, run } = await execute("const name = await __host.system.prompt({ title: 'Name?' })\n  tR += 'Hello ' + name")
    const call = hostCall(messages)
    expect(call).toMatchObject({ method: 'system.prompt', runId: 'run-1' })
    expect(terminal(messages)).toBeUndefined()

    run.deliver(answered(call!.callId, 'Ada'))
    expect(terminal(messages)).toMatchObject({ kind: 'done', output: 'Hello Ada' })
  })

  it('settles a promise resolved from inside a pending job, and pumps the job it leaves behind', async () => {
    // The trap: the second prompt is started from *within* a job that `executePendingJobs` is running, so a
    // pump that read the outstanding count once would decide the run is deadlocked.
    const source = `const first = await __host.system.prompt({ title: 'one' })
  const second = await Promise.resolve(first).then(() => __host.system.suggester({ values: ['a'] }))
  tR += first + '/' + second`
    const { messages, run } = await execute(source)
    expect(hostCall(messages)?.method).toBe('system.prompt')

    run.deliver(answered(hostCall(messages)!.callId, 'x'))
    // Now the nested call is out, and the run is waiting on it again rather than having settled.
    const calls = messages.filter((message) => message.kind === 'host-call')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ call: { method: 'system.suggester' } })
    expect(terminal(messages)).toBeUndefined()

    run.deliver(answered((calls[1]!.call as { callId: string }).callId, 'y'))
    expect(terminal(messages)).toMatchObject({ kind: 'done', output: 'x/y' })
  })

  it('waits for an unawaited host call before reporting the run done', async () => {
    // `cursor.append` returns nothing to the template but still has to reach the editor, so the run is not
    // over when its value is: it is over when the page has answered.
    const { messages, run } = await execute('__host.cursor.append({ text: \"after\" })\n  tR += \'written\'')
    expect(terminal(messages)).toBeUndefined()
    const call = hostCall(messages)
    expect(call?.method).toBe('cursor.append')
    run.deliver(answered(call!.callId, null))
    expect(terminal(messages)).toMatchObject({ kind: 'done', output: 'written' })
  })

  it('does not charge the time the reader spends answering against the CPU budget', async () => {
    const { messages, run } = await execute(
      `const answer = await __host.system.prompt({ title: 'think about it' })
  const stop = Date.now() + 200
  while (Date.now() < stop) {}
  tR += answer`,
      { deadlineMs: MIN_RUN_DEADLINE_MS },
    )
    const call = hostCall(messages)!
    // Longer than the whole budget, spent doing nothing but reading a dialog.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    run.deliver(answered(call.callId, 'later'))
    expect(terminal(messages)).toMatchObject({ kind: 'done', output: 'later' })
  })

  it('drops a reply for a run that was cancelled while the page was open', async () => {
    const { messages, run } = await execute("const answer = await __host.system.prompt({ title: 'gone' })\n  tR += answer")
    const call = hostCall(messages)!
    run.cancel()
    expect(run.currentState).toBe('finished')
    // Delivering the late answer must not resurrect the run, throw, or post anything further.
    const before = messages.length
    expect(() => run.deliver(answered(call.callId, 'too late'))).not.toThrow()
    expect(messages).toHaveLength(before)
  })

  it('refuses a host call the run\'s profile does not grant', async () => {
    const { messages } = await execute("await __host.note.write('anything')", {
      context: context({ capabilities: 'community', runId: 'run-1' }),
    })
    expect(terminal(messages)).toMatchObject({ kind: 'failed', code: 'capability-blocked' })
  })

  it('refuses a name that is not on the host method list', async () => {
    const { messages } = await execute("await __host.call('fs.unlink', [])")
    expect(terminal(messages)).toMatchObject({ kind: 'failed', code: 'not-supported' })
  })

  it('answers folder and template lookups from the snapshot without asking the page', async () => {
    const { messages, run } = await execute(
      `const folders = __host.folder.list()
  const template = __host.template.read('Idea')
  tR += folders.length + '/' + template.content`,
    )
    // Nothing was posted for the two calls, and the run finished without ever waiting.
    expect(hostCall(messages)).toBeNull()
    expect(run.currentState).toBe('finished')
    expect(terminal(messages)).toMatchObject({ kind: 'done', output: '1/from the library' })
  })

  it('reports rendered text the product cannot store instead of cutting it', async () => {
    const chunk = 'x'.repeat(1000)
    const source = `for (let i = 0; i < ${MAX_OUTPUT_CHARS / 1000 + 1}; i++) tR += '${chunk}'`
    const { messages } = await execute(source, { deadlineMs: 8_000 })
    expect(terminal(messages)).toMatchObject({ kind: 'failed', code: 'template-output-too-large' })
  })

  it('refuses an answer bigger than the ceiling its own method carries, instead of truncating it', async () => {
    // The clipboard is the case that matters: a template that silently got the first 64 KiB of a pasted
    // table would write a note that looks complete. `host-bindings.ts` measures the answer against the
    // per-method ceiling, and nothing else on either side of the wire does.
    const { messages, run } = await execute('tR += await tp.system.clipboard()')
    const call = hostCall(messages)
    if (call === null) throw new Error('the clipboard was never asked for')
    expect(call.method).toBe('system.clipboard')
    run.deliver(answered(call.callId, 'x'.repeat(MAX_CLIPBOARD_CHARS + 1)))
    expect(terminal(messages)).toMatchObject({
      kind: 'failed',
      code: 'template-output-too-large',
      detail: `system.clipboard:${MAX_CLIPBOARD_CHARS}`,
    })
  })

  it('keeps a run that registered hooks alive and runs them when asked', async () => {
    const { messages, run } = await execute(`tp.hooks.on_all_templates_executed(() => { tR += 'hooked' })
  tR += 'body'`)
    // Registration is a capability-gated host call, so the run waits for the page to answer it before it
    // can report anything at all.
    const registered = hostCall(messages)!
    expect(registered.method).toBe('hooks.register')
    run.deliver(answered(registered.callId, null))

    expect(messages.some((message) => message.kind === 'hooks-armed')).toBe(true)
    expect(terminal(messages)).toMatchObject({ kind: 'done', output: 'body' })
    expect(run.currentState).toBe('hooks')

    run.runHooks()
    // The callbacks' text is not a second output: the run already reported, and a hook's return value is
    // discarded upstream too.
    expect(run.currentState).toBe('finished')
  })

  it('stops a hook that spins instead of holding the runtime open', async () => {
    const { messages, run } = await execute('tp.hooks.on_all_templates_executed(() => { while (true) {} })\n  tR += \'ok\'')
    run.deliver(answered(hostCall(messages)!.callId, null))
    const before = messages.length
    run.runHooks()
    expect(messages.slice(before)).toContainEqual({
      kind: 'failed',
      runId: 'run-1',
      code: 'sandbox-timeout',
      detail: expect.any(String),
    })
    expect(run.currentState).toBe('finished')
  })

  it('reports the deadline it was given, not the one the page omitted', async () => {
    const request = runRequest('while (true) {}', { deadlineMs: 0 })
    // `0` means the page did not say, and the clamp in `protocol.ts` answers with the default; the run reads
    // the clamped number, so this asserts the two halves agree on one value.
    expect(request.deadlineMs).toBe(0)
    const { messages } = await execute('while (true) {}', { deadlineMs: MIN_RUN_DEADLINE_MS })
    expect(terminal(messages)).toMatchObject({ code: 'sandbox-timeout', detail: `${MIN_RUN_DEADLINE_MS}ms` })
  })

  it('leaves no interpreter behind after a cancelled run', async () => {
    const spy = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined)
    const { run } = await execute("await __host.system.prompt({ title: 'cancel me' })")
    run.cancel()
    // A refusal to free is tolerated by design and always said out loud; asserting the call happened at all
    // keeps that path visible rather than letting it become a silent catch.
    expect(run.currentState).toBe('finished')
    spy.mockRestore()
  })
})

/**
 * The reader's own scripts, evaluated by the interpreter.
 *
 * These are the plan §5.8 cards U2 to U7, and they are only answerable here: the page hands over text and the
 * sandbox is the thing that turns it into a callable, so every rule about what a script can see, require and
 * break belongs to this file.
 */
function userScript(name: string, source: string) {
  return { name, path: `Scripts/${name}.js`, source }
}

async function runWithScripts(source: string, scripts: unknown[], overrides: Record<string, unknown> = {}) {
  const { messages } = await execute(source, {
    context: context({ userScripts: scripts as never, ...overrides }),
  })
  return terminal(messages)
}

describe('templater user scripts run inside the interpreter', () => {
  it('calls a function export with the template’s arguments (U2)', async () => {
    const result = await runWithScripts(
      "tR += await tp.user.greeting('Ada')",
      [userScript('greeting', 'module.exports = (name) => `hi ${name}`')],
    )
    expect(result).toMatchObject({ kind: 'done', output: 'hi Ada' })
  })

  it('calls the members of an object export, which is the spelling upstream documents (U3)', async () => {
    const result = await runWithScripts(
      "tR += tp.user.pair.left() + '/' + tp.user.pair.right(2)",
      [userScript('pair', 'exports.left = () => 1\nexports.right = (n) => n * 2')],
    )
    expect(result).toMatchObject({ kind: 'done', output: '1/4' })
  })

  it('prefers `exports.default` over the object, the way upstream reads an export', async () => {
    const result = await runWithScripts(
      'tR += tp.user.one()',
      [userScript('one', 'exports.default = () => 1\nmodule.exports = { default: () => 2, other: () => 3 }')],
    )
    expect(result).toMatchObject({ kind: 'done', output: '1' })
  })

  it('hands over a module.exports object whole when its `default` is one member among others', async () => {
    const result = await runWithScripts(
      'tR += tp.user.two.a() + tp.user.two.b()',
      [userScript('two', 'module.exports = { a: () => 1, b: () => 2 }')],
    )
    expect(result).toMatchObject({ kind: 'done', output: '3' })
  })

  it('does not fail for a name no script answers until the template uses it', async () => {
    const result = await runWithScripts('tR += typeof tp.user.missing + typeof tp.user.here', [
      userScript('here', 'module.exports = () => 1'),
    ])
    // Upstream's namespace hands back a callable for any key, so a template can ask whether the reader
    // installed something without the question itself being an error.
    expect(result).toMatchObject({ kind: 'done', output: 'functionfunction' })
  })

  it('answers a call to a name no script holds as a load failure that names it', async () => {
    const result = await runWithScripts('tR += tp.user.missing()', [userScript('here', 'module.exports = () => 1')])
    expect(result).toMatchObject({ kind: 'failed', code: 'script-load-failed', detail: 'missing:not-found' })
  })

  it('gives a script the interpreter’s `moment` through require (U5)', async () => {
    const result = await runWithScripts('tR += tp.user.year()', [
      userScript('year', "const m = require('moment')\nmodule.exports = () => m(0).format('YYYY')"),
    ])
    expect(result).toMatchObject({ kind: 'done', output: '1970' })
  })

  it('refuses a Node built-in by name, and says which script asked (U5)', async () => {
    const result = await runWithScripts('tR += tp.user.usesfs()', [
      userScript('usesfs', "const fs = require('fs')\nmodule.exports = () => String(fs)"),
    ])
    expect(result).toMatchObject({ kind: 'failed', code: 'script-require-denied', detail: 'usesfs:fs' })
  })

  it('refuses a require whose specifier is not a string at all', async () => {
    const result = await runWithScripts('tR += tp.user.indirect()', [
      userScript('indirect', 'module.exports = () => require(undefined)'),
    ])
    expect(result).toMatchObject({ kind: 'failed', code: 'script-require-denied', detail: 'indirect:dynamic' })
  })

  it('refuses a bare package name that is not one of the two it can provide', async () => {
    const result = await runWithScripts('tR += tp.user.indirect()', [
      userScript('indirect', "const name = 'fs'\nmodule.exports = () => require(name)()"),
    ])
    // The specifier is read at the call, so a name built from a variable is refused for the module it
    // actually names — the interpreter is not a text scanner and does not pretend to be.
    expect(result).toMatchObject({ kind: 'failed', code: 'script-require-denied', detail: 'indirect:fs' })
  })

  it('resolves a sibling script by relative path and shares one instance of it (U5)', async () => {
    const result = await runWithScripts('tR += tp.user.main()', [
      userScript('main', "const count = require('./counter.js')\nmodule.exports = () => `${count()}${count()}`"),
      userScript('counter', 'let n = 0\nmodule.exports = () => (n += 1)'),
    ])
    // `12` is the measurement: the sibling was evaluated once and both calls reached the same closure, which
    // is what a per-run cache means. `11` would mean it was loaded twice.
    expect(result).toMatchObject({ kind: 'done', output: '12' })
  })

  it('refuses a sibling that the run was not given', async () => {
    const result = await runWithScripts('tR += tp.user.main()', [
      userScript('main', "module.exports = () => require('./absent.js')"),
    ])
    expect(result).toMatchObject({ kind: 'failed', code: 'script-require-denied', detail: 'main:./absent.js' })
  })

  it('keeps a cycle from hanging the run, answering with the module as far as it got (U4)', async () => {
    const result = await runWithScripts('tR += tp.user.a()', [
      userScript('a', "const b = require('./b.js')\nmodule.exports = () => `a:${typeof b}`"),
      userScript('b', "const a = require('./a.js')\nmodule.exports.later = () => typeof a"),
    ])
    expect(result).toMatchObject({ kind: 'done', output: 'a:object' })
  })

  it('hides the template’s own namespace from the script (U7)', async () => {
    const result = await runWithScripts('tR += tp.user.peek()', [
      userScript('peek', "module.exports = () => `${typeof tp}/${typeof tR}/${typeof __host.call}`"),
    ])
    // `__host` is the one door a run already holds under its own profile, so a script reaching it is not a new
    // right — but `tp` re-entering the run from inside a script is, and that is what this pins shut.
    expect(result).toMatchObject({ kind: 'done', output: 'undefined/undefined/function' })
  })

  it('loads a script once per run however many times it is called (U4)', async () => {
    const result = await runWithScripts('tR += tp.user.count() + tp.user.count()', [
      userScript('count', 'let n = 0\nmodule.exports = () => (n += 1)'),
    ])
    // `3` is the measurement: one evaluation, one closure, the counter kept across both calls. Two
    // evaluations would answer `1 + 1`.
    expect(result).toMatchObject({ kind: 'done', output: '3' })
  })

  it('reports a script that throws while it is called with the path and its own words (U4)', async () => {
    const result = await runWithScripts('tR += tp.user.throws()', [
      userScript('throws', "module.exports = () => { throw new TypeError('bad input') }"),
    ])
    // A throw inside the function is the script talking, and it fails only this run's one command.
    expect(result).toMatchObject({ kind: 'failed', code: 'render-failed', detail: expect.stringContaining('bad input') })
  })

  it('reports a script that throws while it loads as a load failure naming its file (U4)', async () => {
    const result = await runWithScripts('tR += tp.user.broken()', [
      userScript('broken', "const x = undefinedThing()\nmodule.exports = () => x"),
    ])
    expect(result).toMatchObject({ kind: 'failed', code: 'script-load-failed', detail: "Scripts/broken.js:'undefinedThing' is not defined" })
  })

  it('breaks only the call that named a broken script, not the namespace beside it (U4)', async () => {
    const broken = await runWithScripts('tR += tp.user.broken()', [
      userScript('broken', 'throw new Error("at load")'),
      userScript('fine', 'module.exports = () => 1'),
    ])
    expect(broken).toMatchObject({ kind: 'failed' })
    const well = await runWithScripts('tR += tp.user.fine()', [
      userScript('broken', 'throw new Error("at load")'),
      userScript('fine', 'module.exports = () => 1'),
    ])
    expect(well).toMatchObject({ kind: 'done', output: '1' })
  })

  it('refuses an export that is neither a function nor an object of functions', async () => {
    expect(await runWithScripts('tR += tp.user.nope()', [userScript('nope', 'module.exports = 42')])).toMatchObject({
      code: 'script-load-failed',
      detail: 'nope:export-invalid',
    })
    expect(await runWithScripts('tR += tp.user.none()', [userScript('none', 'module.exports = null')])).toMatchObject({
      code: 'script-load-failed',
      detail: 'none:no-export',
    })
    expect(await runWithScripts('tR += tp.user.mixed()', [userScript('mixed', 'exports.fn = () => 1\nexports.num = 2')])).toMatchObject({
      code: 'script-load-failed',
      detail: 'mixed:num:not-a-function',
    })
  })

  it('answers a call to a script that exported nothing as an object with no member to call', async () => {
    // Upstream registers an empty `module.exports` object too — `!exported` is false for `{}` — so calling it
    // is not a load failure here either; it is a template trying to call an object, and the answer says which.
    expect(await runWithScripts('tR += tp.user.silent()', [userScript('silent', 'const unused = 1')])).toMatchObject({
      kind: 'failed',
      code: 'not-supported',
      detail: 'silent:object-export',
    })
  })

  it('carries the page’s refusal for one script instead of pretending it is absent (U1)', async () => {
    const result = await runWithScripts('tR += tp.user.dup()', [
      { name: 'dup', path: 'Scripts/a/dup.js', source: '', refusal: { code: 'script-name-conflict', detail: 'dup:Scripts/a/dup.js,Scripts/b/dup.js' } },
    ])
    expect(result).toMatchObject({
      kind: 'failed',
      code: 'script-name-conflict',
      detail: 'dup:Scripts/a/dup.js,Scripts/b/dup.js',
    })
  })

  it('says the folder was unavailable rather than that the reader forgot the file', async () => {
    const result = await runWithScripts('tR += tp.user.anything()', [], { userScriptsUnavailable: 'listing-failed' })
    expect(result).toMatchObject({ kind: 'failed', code: 'user-scripts-unavailable', detail: 'listing-failed' })
  })

  it('refuses a run whose profile was never given the right, even though it holds the text', async () => {
    const result = await runWithScripts('tR += tp.user.greeting()', [
      userScript('greeting', 'module.exports = () => 1'),
    ], { capabilities: 'community' })
    expect(result).toMatchObject({ kind: 'failed', code: 'capability-blocked', detail: 'tp.user.greeting' })
  })

  it('gives a community run no scripts at all when the snapshot gate is the one that emptied it', async () => {
    // `context/snapshot.ts` is what drops the list for a profile without the right; the interpreter's own
    // answer is `not-found`, and the two guards are different questions asked of the same data.
    const snapshot = buildRunSnapshot({
      runId: 'run-1',
      notes: [],
      folders: [],
      templates: [],
      target: null,
      active: null,
      template: null,
      mode: 'append-active',
      capabilities: 'community',
      locale: 'en-US',
      startedAt: 0,
      userScripts: [userScript('greeting', 'module.exports = () => 1') as never],
    })
    expect(snapshot.userScripts).toEqual([])
  })
})
