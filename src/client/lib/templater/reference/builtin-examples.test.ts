import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATE_DEFS } from '@shared/note-templates'
import { EN_US_NOTE_TEMPLATE_CONTENT } from '@shared/locales/en-US-note-template-content'
import { ZH_CN_NOTE_TEMPLATE_CONTENT } from '@shared/locales/zh-CN-note-template-content'
import { parseTemplate } from '../engine/parser'

/**
 * The Templater examples the gallery ships have to run.
 *
 * A built-in template is the first thing a reader tries, and the worst first experience is a template that
 * fails to parse: the engine's error names a line in a note they did not write. So every body in the
 * `templater` category is put through the real parser here, in both languages, and a body that does not
 * compile is a build failure rather than a bug report.
 *
 * This is deliberately the parser and not a full run: running them would need a page host, and the engine's
 * own behaviour is tested where it lives. What is unique to these eight is that someone wrote prose and
 * syntax together, and that is what this checks.
 */
const templaterExamples = BUILTIN_TEMPLATE_DEFS.filter((def) => def.categoryId === 'templater')

describe('the built-in Templater examples', () => {
  it('are more than one, so the category is not a single example', () => {
    expect(templaterExamples.length).toBeGreaterThanOrEqual(8)
  })

  for (const def of templaterExamples) {
    it(`compiles ${def.id} in both languages`, () => {
      for (const [language, catalog] of [['en-US', EN_US_NOTE_TEMPLATE_CONTENT], ['zh-CN', ZH_CN_NOTE_TEMPLATE_CONTENT]] as const) {
        const body = catalog[def.contentKey as keyof typeof catalog] as string
        expect(body, `${def.id} has no ${language} body`).toBeTruthy()
        const parsed = parseTemplate(body)
        expect(parsed.ok, `${def.id} (${language}): ${parsed.ok ? '' : `${parsed.failure.code} at ${parsed.failure.line}:${parsed.failure.column}`}`).toBe(true)
      }
    })
  }

  it('shows the reader at least one command per example', () => {
    for (const def of templaterExamples) {
      const body = EN_US_NOTE_TEMPLATE_CONTENT[def.contentKey as keyof typeof EN_US_NOTE_TEMPLATE_CONTENT] as string
      const parsed = parseTemplate(body)
      if (!parsed.ok) continue
      expect(parsed.output.commands.length, def.id).toBeGreaterThan(0)
    }
  })
})
