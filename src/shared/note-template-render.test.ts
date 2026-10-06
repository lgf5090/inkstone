import { describe, expect, it } from 'vitest'
import { DEFAULT_NEW_NOTE_TEMPLATE } from './constants'
import { extractTags } from './markdown-utils'
import { interpolateNewNoteTemplate, renderNewNoteTemplate, yamlSafeScalar } from './note-template-render'

const NOON = new Date(2026, 9, 7, 13, 4, 9)

function context(overrides: Partial<Parameters<typeof interpolateNewNoteTemplate>[1]> = {}) {
  return { title: 'Reading list', now: NOON, ...overrides }
}

describe('new-note template interpolation', () => {
  it('fills every date placeholder from the supplied instant', () => {
    const { content } = interpolateNewNoteTemplate(
      '{{date}} {{time}} {{createdAt}} {{today}} {{tomorrow}} {{yesterday}}',
      context(),
    )
    expect(content).toBe('2026-10-07 13:04:09 2026-10-07 13:04:09 2026-10-07 2026-10-08 2026-10-06')
  })

  it('keeps a placeholder the renderer does not know', () => {
    expect(interpolateNewNoteTemplate('title: {{author}}', context()).content).toBe('title: {{author}}')
  })

  it('quotes a title in front matter only when YAML would misread it', () => {
    const frontMatter = (title: string) =>
      interpolateNewNoteTemplate('---\ntitle: {{title}}\n---\n', context({ title })).content
    expect(frontMatter('2026')).toBe('---\ntitle: "2026"\n---\n')
    expect(frontMatter('a: b')).toBe('---\ntitle: "a: b"\n---\n')
    expect(frontMatter('- item')).toBe('---\ntitle: "- item"\n---\n')
    expect(frontMatter('Plain title')).toBe('---\ntitle: Plain title\n---\n')
  })

  it('writes the same title into the body without JSON quotes', () => {
    const { content } = interpolateNewNoteTemplate('# {{title}}\n\n{{title}} again', context({ title: 'Q3: Planning' }))
    expect(content).toBe('# Q3: Planning\n\nQ3: Planning again')
  })

  it('never expands a placeholder that arrived inside another value', () => {
    const { content } = interpolateNewNoteTemplate('---\ntitle: {{title}}\nnotes: {{tags}}\n---\n', context({
      title: '{{tags}}',
      tags: 'daily, reading',
    }))
    expect(content).toBe('---\ntitle: "{{tags}}"\nnotes: daily, reading\n---\n')
  })

  it('reports the caret once and removes the marker', () => {
    const { content, cursor } = interpolateNewNoteTemplate('---\ntitle: x\n---\n\n# Heading\n{{cursor}}\nBody', context())
    expect(content).toBe('---\ntitle: x\n---\n\n# Heading\n\nBody')
    expect(content.slice(cursor!)).toBe('\nBody')
    expect(content.slice(0, cursor!)).toBe('---\ntitle: x\n---\n\n# Heading\n')
  })

  it('counts a caret that follows an expanded placeholder', () => {
    const { content, cursor } = interpolateNewNoteTemplate('{{title}}|{{cursor}}|end', context({ title: 'abcd' }))
    expect(cursor).toBe(5)
    expect(content.slice(cursor!, 6)).toBe('|')
  })

  it('flattens a contextual value that arrives with a line break', () => {
    const { content } = interpolateNewNoteTemplate('folder: {{folder}}', context({ folder: 'a\nb' }))
    expect(content.split('\n')).toHaveLength(1)
  })

  it('renders the shipped default template with a parseable front matter first', () => {
    const { content } = interpolateNewNoteTemplate(DEFAULT_NEW_NOTE_TEMPLATE, context({ title: 'Chart notes' }))
    expect(content.startsWith('---\n')).toBe(true)
    expect(content).toContain('title: Chart notes')
    expect(content).toContain('createdAt: 2026-10-07 13:04:09')
  })

  it('handles a CRLF template', () => {
    const { content, cursor } = interpolateNewNoteTemplate('---\r\ntitle: {{title}}\r\n---\r\n{{cursor}}', context())
    expect(content).toBe('---\r\ntitle: Reading list\r\n---\r\n')
    expect(cursor).toBe(content.length)
  })
})

describe('yamlSafeScalar', () => {
  it('quotes what YAML would not read back as the same string', () => {
    for (const value of ['', ' x', 'x ', '12', '1.5', 'true', 'No', '~', 'null', '#tag', 'a: b', '- x', '? x', '[a]', '{a}', 'a\nb', '5%'])
      expect(yamlSafeScalar(value)).not.toBe(value)
  })

  it('leaves an ordinary title alone', () => {
    for (const value of ['Reading list', 'a-b', '2026 年度计划', 'snake_case'])
      expect(yamlSafeScalar(value)).toBe(value)
  })
})

describe('renderNewNoteTemplate tag merge', () => {
  it('keeps a flow tags list flow when the note is created under a tag', () => {
    const { content } = renderNewNoteTemplate(DEFAULT_NEW_NOTE_TEMPLATE, context(), ['每日'])
    expect(content).toContain('tags: [每日]')
    expect(extractTags(content)).toEqual(['每日'])
  })

  it('does not repeat a tag the template already carries', () => {
    const { content } = renderNewNoteTemplate('---\ntags: [daily]\n---\n', context(), ['Daily'])
    expect(content.match(/daily/gi)).toHaveLength(1)
  })

  it('shifts a caret that sits behind the merged tags', () => {
    const without = renderNewNoteTemplate('---\ntags: []\n---\nbody {{cursor}}', context())
    const withTags = renderNewNoteTemplate('---\ntags: []\n---\nbody {{cursor}}', context(), ['daily'])
    expect(without.content.slice(0, without.cursor!)).toBe('---\ntags: []\n---\nbody ')
    expect(withTags.content.slice(0, withTags.cursor!)).toBe('---\ntags: [daily]\n---\nbody ')
  })

  it('leaves a template without front matter untouched', () => {
    const { content } = renderNewNoteTemplate('# {{title}}\n', context(), ['daily'])
    expect(content).toBe('# Reading list\n')
  })
})
