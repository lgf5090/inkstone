import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATE_DEFS } from '@shared/note-templates'
import { EN_US_NOTE_TEMPLATE_CONTENT } from '@shared/locales/en-US-note-template-content'
import { ZH_CN_NOTE_TEMPLATE_CONTENT } from '@shared/locales/zh-CN-note-template-content'
import { detectEngine } from '../src/client/lib/templater/detection'
import { compileTemplate } from '../src/client/lib/templater/engine/program'

/**
 * A built-in template is the app's own advertisement of what the engine does.
 *
 * Its body is written inside a JavaScript template literal, so every escape sequence the reader sees as
 * two characters — `'\n'` inside a script block, for example — is one newline by the time the sandbox
 * parses it, and the template fails with a syntax error the reader cannot fix from the gallery. Only
 * running the engine catches that, so this compiles each body and hands the generated program to a parser
 * that stops at the first unbalanced quote.
 */
const locales = [
  ['en-US', EN_US_NOTE_TEMPLATE_CONTENT as Record<string, string>],
  ['zh-CN', ZH_CN_NOTE_TEMPLATE_CONTENT as Record<string, string>],
] as const

describe('built-in templates that run code', () => {
  for (const [locale, catalog] of locales) {
    const codeBodies = BUILTIN_TEMPLATE_DEFS
      .map((def) => ({ id: def.id, body: catalog[def.contentKey] ?? '' }))
      .filter((entry) => detectEngine(entry.body) === 'templater')

    it(`has at least one, so the engine side of the catalog is covered (${locale})`, () => {
      expect(codeBodies.length).toBeGreaterThan(0)
    })

    for (const { id, body } of codeBodies) {
      it(`${id} compiles to a program the sandbox can parse (${locale})`, () => {
        const compiled = compileTemplate(body)
        expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.failure)).toBe(true)
        if (!compiled.ok) return
        let failure: unknown = null
        try {
          new vm.Script(compiled.program.source)
        }
        catch (error) {
          failure = error
        }
        expect(failure, `the compiled program must parse: ${String(failure)}`).toBe(null)
      })
    }
  }
})
