import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATE_DEFS } from '@shared/note-templates'
import { EN_US_NOTE_TEMPLATE_CONTENT } from '@shared/locales/en-US-note-template-content'
import { ZH_CN_NOTE_TEMPLATE_CONTENT } from '@shared/locales/zh-CN-note-template-content'
import { parseKanbanBody } from '../../lib/markdown/kanban/body'

function kanbanFences(body: string): string[] {
  const fences: string[] = []
  const scanner = /```(?:kanban|board|notion-kanban)[ \t]*\r?\n([\s\S]*?)\r?\n```/g
  let match: RegExpExecArray | null
  while ((match = scanner.exec(body)) !== null) fences.push(match[1]!)
  return fences
}

const locales = [
  ['en-US', EN_US_NOTE_TEMPLATE_CONTENT as Record<string, string>],
  ['zh-CN', ZH_CN_NOTE_TEMPLATE_CONTENT as Record<string, string>],
] as const

describe('built-in templates that carry a kanban fence', () => {
  for (const [locale, catalog] of locales) {
    const withFences = BUILTIN_TEMPLATE_DEFS.filter((def) => kanbanFences(catalog[def.contentKey] ?? '').length > 0)

    it(`has at least one, so the demo side of the catalog is covered (${locale})`, () => {
      expect(withFences.length).toBeGreaterThan(0)
    })

    for (const def of withFences) {
      const fences = kanbanFences(catalog[def.contentKey] ?? '')
      fences.forEach((fence, index) => {
        it(`${def.id} fence ${index + 1} opens as a board with cards and columns (${locale})`, () => {
          const parsed = parseKanbanBody(fence)
          expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true)
          if (!parsed.ok) return
          expect(parsed.data.items.length, 'a demo board with no cards demos nothing').toBeGreaterThan(0)
          const statuses = new Set(parsed.data.items.map((item) => item.properties.status))
          expect(statuses.size, 'the columns come from the headings above the cards').toBeGreaterThan(1)
        })
      })
    }
  }
})
