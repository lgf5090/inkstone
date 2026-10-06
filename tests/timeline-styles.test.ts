import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/client/lib/markdown/renderer'

const SOURCES = [
  '::: timeline History {dense marker=number status=off}\n:: [done] 2024-01-01 a\nbody\n:: [todo] plain\n:::',
  '::: timeline\nprose before the first node\n:: [milestone] b\n:::',
]

const emitted = new Set<string>()
for (const source of SOURCES) {
  for (const match of renderMarkdown(source).html.matchAll(/class="(markdown-timeline[\w-]*)"/g))
    emitted.add(match[1]!)
}
const names = [...emitted].sort()
const stylesheet = readFileSync('src/client/styles/prose.css', 'utf8')
const printed = readFileSync('src/client/lib/export-note.ts', 'utf8')

describe('timeline style parity', () => {
  it('collects the whole class family from the renderer', () => {
    expect(names).toEqual([
      'markdown-timeline',
      'markdown-timeline-block',
      'markdown-timeline-body',
      'markdown-timeline-caption',
      'markdown-timeline-head',
      'markdown-timeline-intro',
      'markdown-timeline-item',
      'markdown-timeline-node',
      'markdown-timeline-status',
      'markdown-timeline-time',
      'markdown-timeline-title',
    ])
  })

  for (const name of names) {
    it(`.${name} is styled in the app and in an exported page`, () => {
      const rule = new RegExp(`\\.${name}(?![\\w-])`)
      expect(stylesheet, `prose.css: .${name}`).toMatch(rule)
      expect(printed, `export-note.css: .${name}`).toMatch(rule)
    })
  }
})
