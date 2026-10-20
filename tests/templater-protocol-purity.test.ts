import { readFileSync } from 'node:fs'
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
