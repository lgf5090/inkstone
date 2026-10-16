// @vitest-environment node
/**
 * The interpreter, run for real.
 *
 * This is the one place the app executes code nobody reviewed, so what is pinned here is not the shape of
 * a wrapper string but what the engine actually does with a program: what it prints, what it returns, how
 * a thrown value comes back, and where the line numbers point. The engine is the real one — the wasm
 * module is compiled by the test's bundler the same way the platform compiles it — because a fake
 * interpreter would prove only that this file can call a function.
 *
 * Two properties are load-bearing and easy to lose. The program's own line numbers have to survive the
 * wrapper: a model told "at line 41" for a four-line program cannot fix anything. And the interpreter has
 * to be *empty* — no network, no timers, no imports — because that emptiness is the entire safety story
 * now that the code runs inside the app's own isolate.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  CODE_EXECUTION_TIMEOUT_MS,
  MAX_SANDBOX_LOGS,
  MAX_SANDBOX_RESULT_CHARS,
  runSandboxedCode,
  sandboxModule,
} from '../src/worker/assistant/code-sandbox'

/** A program that returns something, written the way the model is told to write one. */
const run = (code: string) => runSandboxedCode(code)
const require = createRequire(import.meta.url)

describe('what a program can do', () => {
  it('returns the value it was asked for', async () => {
    const result = await run('return [1, 2, 3].reduce((sum, n) => sum + n, 0)')
    expect(result.result).toBe(6)
    expect(result.error).toBeNull()
    expect(result.logs).toEqual([])
  })

  it('hands back what it printed, in order', async () => {
    const result = await run(`
      console.log('first', 1)
      console.info({ a: [1, 2] })
      console.warn('last')
      return null
    `)
    expect(result.logs).toEqual(['first 1', '{"a":[1,2]}', 'last'])
  })

  it('serialises the awkward values a calculation produces', async () => {
    const result = await run(`
      const loop = { name: 'loop' }
      loop.self = loop
      return {
        when: new Date(0),
        pairs: new Map([['a', 1]]),
        set: new Set([2]),
        missing: undefined,
        fn: () => 1,
        big: 10n,
        loop,
      }
    `)
    expect(result.result).toEqual({
      when: '1970-01-01T00:00:00.000Z',
      pairs: { a: 1 },
      set: [2],
      missing: '[undefined]',
      fn: '[function]',
      big: '10n',
      loop: { name: 'loop', self: '[circular]' },
    })
  })

  it('resolves a promise the program makes itself', async () => {
    // `await` on anything the interpreter can settle works, which is what a program that maps over a list
    // with an async callback needs. Awaiting something *outside* cannot work, and that is pinned below.
    const result = await run('const value = await Promise.resolve(21); return value * 2')
    expect(result.result).toBe(42)
  })

  it('stops at the log cap rather than letting a loop fill the answer', async () => {
    const result = await run(`for (let n = 0; n < ${MAX_SANDBOX_LOGS + 20}; n++) console.log(n)`)
    expect(result.logs).toHaveLength(MAX_SANDBOX_LOGS)
    expect(result.logs[0]).toBe('0')
  })

  it('clips an answer that is too big to hand back, and says so', async () => {
    const result = await run(`return 'x'.repeat(${MAX_SANDBOX_RESULT_CHARS + 500})`)
    expect(typeof result.result).toBe('string')
    expect((result.result as string).length).toBeGreaterThan(MAX_SANDBOX_RESULT_CHARS)
    expect(result.result as string).toContain('[truncated:')
  })
})

describe('what a program cannot do', () => {
  it('has no network, no timers and no imports', async () => {
    const result = await run(`
      return {
        fetch: typeof fetch,
        timer: typeof setTimeout,
        require: typeof require,
        process: typeof process,
      }
    `)
    // The emptiness is the safety story: there is nothing here to reach a note, a key or a packet with.
    expect(result.result).toEqual({ fetch: 'undefined', timer: 'undefined', require: 'undefined', process: 'undefined' })
  })

  it('says a program that waits for the outside world can never finish', async () => {
    const result = await run('await new Promise(() => {}); return 1')
    expect(result.result).toBeNull()
    expect(result.error).toContain('cannot happen here')
  })

  it('stops a program that spins, at the deadline the app enforces', async () => {
    const started = Date.now()
    const result = await run('while (true) {}')
    // The engine interrupts between instructions, so this is a stop rather than an abandoned turn — the
    // improvement the in-isolate interpreter buys back from the scratch Worker it replaced.
    expect(result.error).toContain('still running after')
    expect(Date.now() - started).toBeLessThan(CODE_EXECUTION_TIMEOUT_MS + 2_000)
  }, 20_000)
})

describe('what a program is told when it fails', () => {
  it('reports a thrown value with the model\'s own line number', async () => {
    const result = await run(`const rows = [1, 2]
      return rows[9].toString()`)
    expect(result.error).toContain('TypeError')
    // The second line of the model's code, not the twenty-something-th of the wrapped program.
    expect(result.error).toContain('line 2')
  })

  it('reports a program that never parsed, with its line', async () => {
    const result = await run('const a = 1\nthis is not javascript')
    expect(result.error).toMatch(/^SyntaxError/)
    expect(result.error).toContain('line 2')
  })

  it('keeps an error that has no frame in the model\'s code', async () => {
    const result = await run('throw new Error("the reader\'s own failure")')
    expect(result.error).toContain("the reader's own failure")
  })
})

describe('the wrapper the program is compiled inside', () => {
  it('states where the model\'s code begins', () => {
    const module = sandboxModule('return 1')
    const lines = module.source.split('\n')
    // The claim `codeLine` makes is checked against the source itself: that line is the model's first.
    expect(lines[module.codeLine - 1]).toBe('return 1')
    expect(module.codeLines).toBe(1)
  })

  it('counts the lines of a multi-line program', () => {
    const module = sandboxModule('const a = 1\nconst b = 2\nreturn a + b')
    expect(module.codeLines).toBe(3)
    expect(module.source.split('\n')[module.codeLine + 1]).toBe('return a + b')
  })
})

/**
 * The engine's binary is vendored because the bundler only compiles a `.wasm` file it can see in the
 * project, and the package exposes it under a subpath the bundler cannot use. A copy is only honest while
 * it is the copy the glue was written for: bumping the package without re-copying this file would leave a
 * new engine's JavaScript driving an old engine's bytecode, which fails in ways that look like bugs in the
 * sandbox rather than in the upgrade.
 */
describe('the vendored engine', () => {
  it('is the build the package ships', () => {
    const vendored = readFileSync(new URL('../src/worker/assistant/quickjs.wasm', import.meta.url))
    const shipped = readFileSync(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm'))
    expect(
      Buffer.compare(vendored, shipped),
      'src/worker/assistant/quickjs.wasm is not the binary this package version ships; copy it again',
    ).toBe(0)
  })
})
