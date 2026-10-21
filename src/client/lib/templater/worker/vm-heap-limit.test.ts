import { describe, expect, it } from 'vitest'
import type { RunRequest, TemplateRunContext, WorkerMessage } from '../protocol'
import { TemplateRun } from './vm'
import { RUNTIME_MEMORY_BYTES } from '../limits'

/**
 * The heap ceiling, on its own.
 *
 * This case lives in a file of its own because it is the one budget that is measured against the WebAssembly
 * module rather than against one run: QuickJS's heap is shared by every runtime created from a module, and
 * `vm.ts` deliberately leaves a runtime undisposed after a stack overflow (freeing it was measured as an
 * aborted module). Run after that test in the same file, this program hits the ceiling in a different shape
 * and the run still fails — with `render-failed` rather than the heap's own code. Asserting the code is the
 * whole point of the test, so the test gets a clean module instead of a weaker assertion.
 *
 * A fresh interpreter, a scripted page that never answers, and no mocking of the engine.
 */
function context(): TemplateRunContext {
  return {
    runId: 'heap-1',
    mode: 'append-active',
    capabilities: 'local',
    template: null,
    startedAt: Date.parse('2026-01-01T00:00:00Z'),
    target: null,
    active: null,
    frozenTitle: '',
    index: [],
    folders: [],
    libraryTemplates: [],
    locale: 'en-US',
    selection: '',
    userScripts: [],
  }
}

async function execute(source: string, deadlineMs: number): Promise<WorkerMessage[]> {
  const messages: WorkerMessage[] = []
  const request: RunRequest = {
    kind: 'run',
    runId: 'heap-1',
    context: context(),
    source: `(async () => {\n  let tR = ''\n  ${source}\n  return tR\n})()`,
    deadlineMs,
  }
  const run = await TemplateRun.open(request, (message) => messages.push(message))
  run.start()
  return messages
}

describe('the interpreter heap ceiling', () => {
  it('reports a program that fills its heap as out of memory', async () => {
    // A generous deadline on purpose: the run must end because the heap refused, not because a timer fired,
    // or this would be measuring the interrupt handler and calling it a memory limit.
    const messages = await execute(
      'const kept = []\n  while (true) { kept.push(new Uint8Array(1024 * 1024)) }',
      8_000,
    )
    const terminalMessage = messages.find((message) => message.kind === 'done' || message.kind === 'failed')
    expect(terminalMessage).toMatchObject({ kind: 'failed', code: 'sandbox-out-of-memory' })
    // The detail is the ceiling itself, so a reader can tell "your template allocated too much" apart from
    // "the sandbox is small" without the two sharing one message.
    expect((terminalMessage as { detail?: string }).detail).toBe(String(RUNTIME_MEMORY_BYTES))
  }, 20_000)
})
