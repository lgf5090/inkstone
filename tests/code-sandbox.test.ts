// @vitest-environment node
/**
 * The code interpreter's two halves, and the seam between them.
 *
 * The wrapper this app generates is the part a fake loader cannot check: it is a string, it is what the
 * model's code is compiled inside, and a typo in it would surface only when a reader asked for a
 * calculation. So the loader double below does not pretend — it takes the module the app built, writes it
 * to a temporary `index.js`, and runs it in this process, returning the real `Response` the wrapper
 * produced. What that leaves unproven is workerd's own half, the network cut and the CPU budget, and those
 * are pinned separately: the code object is asserted field by field, and the runtime's own error strings
 * are replayed from a real run rather than imagined.
 *
 * The harness deliberately runs here rather than in workerd: this repo's tests are doubles, not a second
 * runtime, and the wrapper's behaviour — console capture, serialisation, the line numbers in an error — is
 * plain JavaScript that needs no sandbox to be exercised.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODE_EXECUTION_TIMEOUT_MS,
  MAX_SANDBOX_LOGS,
  MAX_SANDBOX_RESULT_CHARS,
  SANDBOX_CPU_MS,
  CodeExecutionError,
  runSandboxedCode,
  sandboxModule,
} from '../src/worker/assistant/code-sandbox'

/**
 * What workerd says when a module will not parse, in its own words, captured from a real run.
 *
 * The prefix and the `at index.js:<line>:<col>` frame are verbatim; only the line number is derived,
 * because the captured run compiled the model's code on its own while this app compiles it inside a
 * wrapper — so a syntax error on the model's first line lands on the wrapper's first line for it.
 */
function workerdRefusal(codeLine: number): string {
  return [
    'Failed to start Worker:',
    "Uncaught SyntaxError: Unexpected identifier 'is'",
    `  at index.js:${codeLine}:38`,
  ].join('\n')
}

/**
 * A loader that runs the module for real, minus workerd.
 *
 * Everything the app hands the loader is inspected as it arrives, and the module is then executed as the
 * file the runtime would name `index.js` — which is what makes the line numbers in a reported error
 * comparable to the model's own code.
 */
function runningLoader(options: { failWith?: string } = {}) {
  const seen: WorkerLoaderWorkerCode[] = []
  const directories: string[] = []
  const loader = {
    get(_name: string | null, getCode: () => WorkerLoaderWorkerCode) {
      return {
        getEntrypoint() {
          return {
            async fetch() {
              const code = getCode()
              seen.push(code)
              if (options.failWith) throw new Error(options.failWith)
              const dir = mkdtempSync(path.join(os.tmpdir(), 'inkstone-sandbox-'))
              directories.push(dir)
              const file = path.join(dir, 'index.js')
              writeFileSync(file, code.modules['index.js'] as string, 'utf8')
              const module = await import(pathToFileURL(file).href) as { default: { fetch: () => Promise<Response> } }
              return await module.default.fetch()
            },
          }
        },
      }
    },
  } as unknown as WorkerLoader
  return { loader, seen, cleanup: () => directories.forEach((dir) => rmSync(dir, { recursive: true, force: true })) }
}

const loaders: { cleanup: () => void }[] = []
const loaderFor = (options: { failWith?: string } = {}) => {
  const made = runningLoader(options)
  loaders.push(made)
  return made
}

afterEach(() => {
  loaders.splice(0).forEach((made) => made.cleanup())
  vi.useRealTimers()
})

describe('the sandbox module', () => {
  it('runs a program and brings back what it printed and returned', async () => {
    const { loader } = loaderFor()
    const result = await runSandboxedCode(loader, "console.log('rows', 3)\nreturn [1, 2, 3].map((n) => n * 2)")
    expect(result.logs).toEqual(['rows 3'])
    expect(result.result).toEqual([2, 4, 6])
    expect(result.error).toBeNull()
  })

  it('awaits the program, so a top-level await is not a race', async () => {
    const { loader } = loaderFor()
    const result = await runSandboxedCode(loader, "const value = await Promise.resolve('settled')\nreturn value")
    expect(result.result).toBe('settled')
  })

  it('reports a thrown error against the model\'s own line, not the wrapper\'s', async () => {
    const { loader } = loaderFor()
    // The throw is on the third line of the model's code, whatever line of the module that landed on.
    const result = await runSandboxedCode(loader, "const a = 1\nconst b = 2\nthrow new Error('boom')")
    expect(result.error).toContain('Error: boom')
    expect(result.error).toContain('at line 3:')
    // Nothing the wrapper owns is handed back: a frame the model cannot act on is noise.
    expect(result.error).not.toContain('index.js')
  })

  it('carries a program error back instead of failing the call', async () => {
    // The loop the tool exists for: run, read the error, fix the line, run again. So a broken program is a
    // result, not a thrown tool call, and the logs printed before it broke survive.
    const { loader } = loaderFor()
    const result = await runSandboxedCode(loader, "console.log('before')\nnull.boom")
    expect(result.logs).toEqual(['before'])
    expect(result.error).toContain('TypeError')
  })

  it('translates the runtime\'s own refusal to compile, and strips its prefix', async () => {
    const { loader } = loaderFor({ failWith: workerdRefusal(sandboxModule('this is not js').codeLine) })
    const result = await runSandboxedCode(loader, 'this is not js')
    expect(result.error).toContain("SyntaxError: Unexpected identifier 'is'")
    expect(result.error).not.toContain('Failed to start Worker')
    expect(result.error).toContain('at line 1:38')
  })

  it('says the shape of a value JSON cannot carry rather than dropping it', async () => {
    const { loader } = loaderFor()
    const result = await runSandboxedCode(loader, 'const cycle = {}\ncycle.self = cycle\nreturn { cycle, big: 10n, missing: undefined, fn: () => 1, when: new Date(0) }')
    expect(result.result).toEqual({
      cycle: { self: '[circular]' },
      big: '10n',
      missing: '[undefined]',
      fn: '[function]',
      when: '1970-01-01T00:00:00.000Z',
    })
  })

  it('keeps a value that is shared but not circular', async () => {
    // A `WeakSet` of everything ever seen would call the second reference a cycle; only the path matters.
    const { loader } = loaderFor()
    const result = await runSandboxedCode(loader, 'const shared = { n: 1 }\nreturn [shared, shared]')
    expect(result.result).toEqual([{ n: 1 }, { n: 1 }])
  })

  it('stops keeping logs once a program is chattering', async () => {
    const { loader } = loaderFor()
    const result = await runSandboxedCode(loader, `for (let i = 0; i < ${MAX_SANDBOX_LOGS + 50}; i++) console.log(i)\nreturn 'done'`)
    expect(result.logs).toHaveLength(MAX_SANDBOX_LOGS)
    expect(result.logs[0]).toBe('0')
  })

  it('hands back a result a model can read, saying so when it clipped one', async () => {
    const { loader } = loaderFor()
    const result = await runSandboxedCode(loader, `return 'x'.repeat(${MAX_SANDBOX_RESULT_CHARS + 500})`)
    expect(typeof result.result).toBe('string')
    expect(result.result as string).toContain('[truncated:')
    expect((result.result as string).length).toBeLessThan(MAX_SANDBOX_RESULT_CHARS + 100)
  })
})

describe('the module the app builds', () => {
  it('states where the model\'s own code begins', () => {
    const built = sandboxModule('return 1')
    const lines = built.source.split('\n')
    expect(lines[built.codeLine - 1]).toBe('return 1')
    expect(built.codeLines).toBe(1)
  })

  it('counts a multi-line program so a wrapper frame can be told from a real one', () => {
    const built = sandboxModule('const a = 1\nconst b = 2\nreturn a + b')
    expect(built.codeLines).toBe(3)
    const lines = built.source.split('\n')
    expect(lines[built.codeLine]).toBe('const b = 2')
    expect(lines[built.codeLine + 1]).toBe('return a + b')
  })
})

describe('the code object handed to the loader', () => {
  it('is cut off from the network, given no bindings, and bounded', async () => {
    const { loader, seen } = loaderFor()
    await runSandboxedCode(loader, 'return 1')
    expect(seen).toHaveLength(1)
    // The safety story, asserted where it is written: a null outbound is what makes `fetch()` inside the
    // sandbox throw before a packet is built.
    expect(seen[0]!.globalOutbound).toBeNull()
    expect(seen[0]!.limits).toEqual({ cpuMs: SANDBOX_CPU_MS, subRequests: 0 })
    expect(seen[0]!.mainModule).toBe('index.js')
    // Nothing else travels: no `env`, no tails, no bindings of the reader's.
    expect(seen[0]!.env).toBeUndefined()
    expect(seen[0]!.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('leaves each program in a Worker of its own', async () => {
    const names: (string | null)[] = []
    const inner = loaderFor()
    const loader = {
      get(name: string | null, getCode: () => WorkerLoaderWorkerCode) {
        names.push(name)
        return (inner.loader as unknown as WorkerLoader).get(name, getCode)
      },
    } as unknown as WorkerLoader
    await runSandboxedCode(loader, 'return 1')
    await runSandboxedCode(loader, 'return 2')
    // A named Worker is cached by name, so two programs under one name would mean the second silently ran
    // the first. `null` is the loader's own way of saying "this one is not reusable".
    expect(names).toEqual([null, null])
  })
})

describe('when the app cannot run anything at all', () => {
  it('gives the reader their turn back instead of waiting on a program that sleeps', async () => {
    vi.useFakeTimers()
    const loader = {
      get: () => ({ getEntrypoint: () => ({ fetch: () => new Promise<Response>(() => {}) }) }),
    } as unknown as WorkerLoader
    const pending = runSandboxedCode(loader, 'await new Promise(() => {})')
    const settled = expect(pending).rejects.toThrow(CodeExecutionError)
    await vi.advanceTimersByTimeAsync(CODE_EXECUTION_TIMEOUT_MS)
    await settled
    await expect(pending).rejects.toThrow('still running after 10 seconds')
  })

  it('refuses an answer that was not a result', async () => {
    const loader = {
      get: () => ({ getEntrypoint: () => ({ fetch: async () => new Response('not json', { status: 200 }) }) }),
    } as unknown as WorkerLoader
    await expect(runSandboxedCode(loader, 'return 1')).rejects.toThrow('was not a result')
  })

  it('refuses a sandbox that answered with a failure status', async () => {
    const loader = {
      get: () => ({ getEntrypoint: () => ({ fetch: async () => new Response('', { status: 500 }) }) }),
    } as unknown as WorkerLoader
    await expect(runSandboxedCode(loader, 'return 1')).rejects.toThrow('answered 500')
  })
})
