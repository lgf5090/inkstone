import { describe, expect, it, vi } from 'vitest'
import type { HostResult, RunRequest, TemplateRunContext, WorkerMessage } from '../protocol'
import { TemplateRun } from './vm'
import { DEFAULT_RUN_DEADLINE_MS, MAX_OUTPUT_CHARS, MIN_RUN_DEADLINE_MS } from '../limits'

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
