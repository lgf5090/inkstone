import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/**
 * The template worker must be buildable without the application.
 *
 * Templater templates are executed inside a Web Worker so a runaway or hostile note cannot take the
 * page down with it. That only holds while the worker's own modules are free of the app: a `store`
 * import there would hand template-triggered code the note database and the fetch client, and the
 * sandbox would be decoration. The dependency is invisible at runtime — the bundle simply grows — so
 * it is pinned here, where the rest of the cross-layer guards live.
 */
describe('the templater worker stays independent of the app', () => {
  const protocol = read('../src/client/lib/templater/protocol.ts')

  it('names no page module in the shared wire contract', () => {
    // Anything the worker and the page both compile has to be importable by a thread with no DOM, no
    // store and no router.
    for (const forbidden of ['../store', '../features', '../../features', '../../store', 'react', 'document.', 'window.']) {
      expect(protocol, `protocol.ts must not reference ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('keeps the interpreter protocol free of editor and network clients', () => {
    expect(protocol).not.toContain('lib/api')
    expect(protocol).not.toContain('../editor')
  })
})

/**
 * The two halves of the templater module may not import from each other.
 *
 * `protocol.ts`'s header states the rule, and the rule is what makes the sandbox a sandbox: the worker is
 * the box template code runs in, the page host is the thing that holds the note store, the editor and the
 * reader's settings. A `store` import inside `worker/` would hand template-triggered code the database and
 * the fetch client without going through the host call allowlist at all, and the bundle would simply grow
 * to prove it — nothing throws, so the only way to catch it is to read the graph.
 *
 * Import specifiers are read out of `import … from '…'` and `import('…')`, not by scanning the text for
 * words: a comment in `worker/vm.ts` names a `features/…` file as the precedent it follows, and a guard
 * that fired on prose would be turned off within a week of being written.
 */
describe('neither half of the templater module reaches into the other', () => {
  /**
   * The module root, from the working directory rather than from `import.meta.url`.
   *
   * Measured, not assumed: in this project's jsdom environment `import.meta.url` is an `http://localhost`
   * URL, so `fileURLToPath` on a relative resolution of it throws before a single assertion runs — the
   * first draft of this guard died exactly there. Vitest runs at the repository root, and every path below
   * is built from that, which is also what makes the guard fail loudly (a missing directory throws) rather
   * than pass on an empty list.
   */
  const moduleRoot = join(process.cwd(), 'src', 'client', 'lib', 'templater')

  const sourceFiles = (directory: string): string[] =>
    readdirSync(join(moduleRoot, directory))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => join(moduleRoot, directory, name))

  /** Every module a file pulls in, as written: bare specifiers included, since `react` is one. */
  const importsOf = (path: string): string[] =>
    [...readFileSync(path, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!)

  const FORBIDDEN_FOR_WORKER = ['/store/', '/features/', '/lib/api', 'react', '../host', '../context']

  it('leaves the worker with no way to touch the app', () => {
    const files = sourceFiles('worker')
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        for (const forbidden of FORBIDDEN_FOR_WORKER) {
          // The assertion is on the specifier alone: naming the importing file inside the compared string
          // would make a rule about `store` fire on a file that is merely called `store-port.ts`.
          expect(specifier, `${file} must not import ${forbidden}`).not.toContain(forbidden)
        }
      }
    }
  })

  it('leaves the page host free of the interpreter modules', () => {
    const files = sourceFiles('host')
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} may not reach into worker/`).not.toContain('../worker')
      }
    }
  })

  it('keeps the door free of anyone who needs the door', () => {
    // `index.ts` is the module's public entry: the wiring imports it, and nothing below it may import it
    // back. A page host that minted its nested run ids through the door would have built exactly that
    // cycle — the kind that compiles, bundles, and then hands one half an `undefined` function at the first
    // moment it is called. `run-id.ts` exists so no half has a reason to reach for the door.
    for (const directory of ['host', 'worker', 'context', 'engine']) {
      for (const file of sourceFiles(directory)) {
        for (const specifier of importsOf(file)) {
          expect(specifier, `${file} may not import the door`).not.toMatch(/^(\.\.\/|\.\/)index$/)
        }
      }
    }
  })

  it('keeps the shared halves free of the app too', () => {
    // These four are compiled by both sides, so neither may reference a page module. `index.ts` is not in
    // the list on purpose: it is the door the page walks through, and a door may look at both halves.
    for (const name of ['protocol.ts', 'limits.ts', 'errors.ts', 'detection.ts']) {
      const file = join(moduleRoot, name)
      expect(existsSync(file), `${name} is part of the contract and must exist`).toBe(true)
      for (const specifier of importsOf(file)) {
        expect(specifier, `${name} is compiled by both sides and may not import ${specifier}`).not.toMatch(/store|features|\/api|react/)
      }
    }
  })
})
