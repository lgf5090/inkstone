import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { parseMemoOutline } from './memo-outline'

describe('the memo outline parser', () => {
  it('collects h1 to h3 with the ids the body carries', () => {
    const content = [
      '# Alpha',
      '',
      '## Beta',
      '',
      '### Gamma',
      '',
      '#### Deep',
      '',
      '## Beta',
    ].join('\n')
    expect(parseMemoOutline(content)).toEqual([
      { level: 1, text: 'Alpha', id: 'alpha' },
      { level: 2, text: 'Beta', id: 'beta' },
      { level: 3, text: 'Gamma', id: 'gamma' },
      { level: 2, text: 'Beta', id: 'beta-1' },
    ])
  })

  it('ignores fenced headings and front matter', () => {
    const content = [
      '---',
      'title: Sample',
      '---',
      '# Real',
      '```md',
      '# Hidden',
      '```',
    ].join('\n')
    expect(parseMemoOutline(content)).toEqual([{ level: 1, text: 'Real', id: 'real' }])
  })

  it('answers nothing for an empty memo', () => {
    expect(parseMemoOutline('   ')).toEqual([])
  })

  it('names the same ids the rendered body carries', () => {
    const content = '# Alpha\n\n## Beta\n\n## Beta'
    const html = renderMarkdown(content, { hideFrontMatter: true }).html
    for (const entry of parseMemoOutline(content)) {
      expect(html).toContain(`id="${entry.id}"`)
    }
  })
})
