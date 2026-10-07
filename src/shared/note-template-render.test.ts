import { describe, expect, it } from 'vitest'
import { DEFAULT_NEW_NOTE_TEMPLATE } from './constants'
import { extractTags, parseFrontMatter } from './markdown-utils'
import { interpolateNewNoteTemplate, renderNewNoteTemplate, yamlFlowItem, yamlSafeScalar } from './note-template-render'

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
    for (const value of ['', ' x', 'x ', '12', '1.5', 'true', 'No', '~', 'null', '#tag', 'a: b', '- x', '? x', '[a]', '{a}', 'a\nb', '1e3', 'a:', 'x #y'])
      expect(yamlSafeScalar(value)).not.toBe(value)
  })

  it('leaves an ordinary title alone', () => {
    for (const value of ['Reading list', 'a-b', '2026 年度计划', 'snake_case', '5%', 'a, b', 'a]b', '2026-10-07 13:04:09'])
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

const NASTY_NAMES = [
  '工作: 项目',
  '- 草稿',
  'a]b',
  '[x',
  '{y}',
  '#c',
  '"q"',
  "'s'",
  'a: b: c',
  '中文 名称',
  'true',
  'null',
  '~',
  '1e3',
  '5%',
  '&a',
  '*b',
  '!c',
  '|d',
  '>e',
  '@f',
  '`g',
  '---',
  '...',
  '%p',
  '  x',
  'x  ',
  '',
]

describe('front matter survives any folder a note can live in', () => {
  it.each(NASTY_NAMES)('quotes a whole-value folder named %j', (folder) => {
    const { content } = interpolateNewNoteTemplate('---\ntitle: {{title}}\nfolder: {{folder}}\n---\n# {{title}}\n', context({ folder }))
    const parsed = parseFrontMatter(content)
    expect(parsed.errors).toEqual([])
    expect(parsed.data.folder).toBe(folder)
    expect(parsed.data.title).toBe('Reading list')
  })

  it.each(NASTY_NAMES)('keeps a flow folder item named %j readable', (folder) => {
    const { content } = interpolateNewNoteTemplate('---\ntags: [{{folder}}]\n---\n', context({ folder }))
    const parsed = parseFrontMatter(content)
    expect(parsed.errors).toEqual([])
    if (!folder.includes(',')) expect(parsed.data.tags).toEqual(folder === '' ? [] : [folder])
  })

  it.each(NASTY_NAMES)('repairs a folder named %j that shares a line with other text', (folder) => {
    const { content } = interpolateNewNoteTemplate('---\nfolder: /{{folder}}/x\n---\n', context({ folder }))
    const parsed = parseFrontMatter(content)
    expect(parsed.errors).toEqual([])
    expect(parsed.data.folder).toBe(`/${folder}/x`)
  })

  it('still expands a comma separated tag list into several flow items', () => {
    const { content } = interpolateNewNoteTemplate('---\ntags: [{{tags}}]\n---\n', context({ tags: 'daily, reading' }))
    const parsed = parseFrontMatter(content)
    expect(parsed.errors).toEqual([])
    expect(parsed.data.tags).toEqual(['daily', 'reading'])
  })

  it('splits a comma separated value into items and quotes only the unsafe one', () => {
    const { content } = interpolateNewNoteTemplate('---\ntags: [{{tags}}]\n---\n', context({ tags: 'x]y, 工作: 项目, plain' }))
    const parsed = parseFrontMatter(content)
    expect(parsed.errors).toEqual([])
    expect(parsed.data.tags).toEqual(['x]y', '工作: 项目', 'plain'])
  })

  it('drops empty items a trailing comma would have produced', () => {
    const { content } = interpolateNewNoteTemplate('---\ntags: [{{tags}}]\n---\n', context({ tags: 'a, ,b,' }))
    const parsed = parseFrontMatter(content)
    expect(parsed.errors).toEqual([])
    expect(parsed.data.tags).toEqual(['a', 'b'])
  })

  it('leaves a placeholder outside front matter as plain text', () => {
    const { content } = interpolateNewNoteTemplate('---\ntitle: x\n---\n# {{folder}}\n\n{{folder}} inline\n', context({ folder: '工作: 项目' }))
    expect(content).toBe('---\ntitle: x\n---\n# 工作: 项目\n\n工作: 项目 inline\n')
  })

  it('leaves an author-written flow list alone when the template has no placeholder there', () => {
    const { content } = interpolateNewNoteTemplate('---\ntags: [daily, reading]\nfolder: {{folder}}\n---\n', context({ folder: 'Notes' }))
    const parsed = parseFrontMatter(content)
    expect(parsed.errors).toEqual([])
    expect(parsed.data.tags).toEqual(['daily', 'reading'])
    expect(content).toContain('tags: [daily, reading]')
  })

  it('reports a caret that survived the repair pass', () => {
    const { content, cursor } = interpolateNewNoteTemplate('---\nfolder: /{{folder}}/\n---\n{{cursor}}body', context({ folder: 'a: b' }))
    expect(parseFrontMatter(content).errors).toEqual([])
    expect(content.slice(cursor!)).toBe('body')
    expect(content.slice(0, cursor!)).toBe('---\nfolder: "/a: b/"\n---\n')
  })

  it('does not run the repair pass when the plain render already parses', () => {
    const { content } = interpolateNewNoteTemplate('---\nfolder: {{folder}}\n---\n', context({ folder: 'Plain name' }))
    expect(content).toBe('---\nfolder: Plain name\n---\n')
  })
})

describe('yamlFlowItem', () => {
  it('quotes only what a flow parser would not read back', () => {
    for (const value of ['x]y', '[x', '{y}', 'a: b', '工作: 项目', '#c', '"q"', 'true', '1e3', '', '- x', 'a,b'])
      expect(yamlFlowItem(value)).not.toBe(value)
  })

  it('leaves a plain tag alone', () => {
    for (const value of ['daily', 'reading', '中文', 'a-b', '2026 年度计划'])
      expect(yamlFlowItem(value)).toBe(value)
  })
})
