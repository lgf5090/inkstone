// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  deriveMemoContentSearch,
  deriveMemoPreview,
  deriveMemoSnippet,
  deriveMemoTitle,
  scanMemoAttachmentIds,
  scanMemoProperties,
  scanMemoTags,
} from '../src/shared/memos/markdown'
import { deriveMemoFields } from '../src/worker/memos/derive'

describe('memo markdown derivation', () => {
  it('takes the first heading as the title and falls back to the first non-empty line', () => {
    expect(deriveMemoTitle('Intro paragraph.\n\n## A heading\n\nBody')).toBe('A heading')
    expect(deriveMemoTitle('\n\nPlain **first** line\nSecond line')).toBe('Plain first line')
    expect(deriveMemoTitle('```\n# not a heading\n```\n\nReal title')).toBe('Real title')
    expect(deriveMemoTitle('> quoted title\n\nrest')).toBe('quoted title')
    expect(deriveMemoTitle('')).toBe('')
  })

  it('builds a one-line snippet without the title and lower-cases content search', () => {
    const content = '# Launch plan\n\nShip **the** thing.\n\n- [ ] write notes'
    expect(deriveMemoSnippet(content)).toBe('Ship the thing. write notes')
    expect(deriveMemoContentSearch('Hello WORLD')).toBe('hello world')
  })

  it('flattens tables and drops block math from the snippet', () => {
    const content = [
      'Look:',
      '',
      '| Item | Owner |',
      '| --- | --- |',
      '| Import | Lin |',
      '',
      '$$',
      '\\sum_{i=1}^{n} i',
      '$$',
      '',
      'Inline $E = mc^2$ stays readable.',
    ].join('\n')
    expect(deriveMemoSnippet(content)).toBe(
      'Item Owner Import Lin Inline E = mc^2 stays readable.',
    )
    expect(deriveMemoPreview(content)).toBe(
      'Look: Item Owner Import Lin Inline E = mc^2 stays readable.',
    )
    expect(deriveMemoPreview('One line memo')).toBe('One line memo')
  })

  it('scans hierarchical, CJK, and emoji tags with their ancestors', () => {
    const content = '#work/project/alpha and #工作/子任务 plus #🎉 and #work/project'
    expect(scanMemoTags(content)).toEqual([
      'work',
      'work/project',
      'work/project/alpha',
      '工作',
      '工作/子任务',
      '🎉',
    ])
  })

  it('adds ancestors once even when several tags share them', () => {
    expect(scanMemoTags('#a/b/c #a/b/d #a/e')).toEqual(['a', 'a/b', 'a/b/c', 'a/b/d', 'a/e'])
  })

  it('excludes fenced code, inline code, escapes, and link destinations from tags', () => {
    const content = [
      '```md',
      '#inside-fence',
      '```',
      'Inline `#inside-code` and \\#escaped.',
      '[#linked-text](https://example.com/#fragment)',
      '![alt](https://example.com/#image-fragment)',
      'Real #outside',
    ].join('\n')
    expect(scanMemoTags(content)).toEqual(['linked-text', 'outside'])
  })

  it('caps tag count and tag name length', () => {
    const many = Array.from({ length: 70 }, (_, index) => `#tag${index}`).join(' ')
    expect(scanMemoTags(many)).toHaveLength(64)
    expect(scanMemoTags(`#${'a'.repeat(61)}`)).toEqual([])
    expect(scanMemoTags(`#${'a'.repeat(60)}`)).toEqual(['a'.repeat(60)])
  })

  it('reports links, code, task lists, and incomplete tasks outside code', () => {
    const properties = scanMemoProperties([
      'A [link](https://example.com) and <https://example.org> and www.example.net.',
      '',
      '- [ ] open task',
      '- [x] done task',
      '',
      '`inline code`',
      '',
      '```js',
      'const #notATag = "[not](a-link)"',
      '- [ ] hidden task',
      '```',
    ].join('\n'))
    expect(properties).toEqual({
      hasLink: true,
      hasCode: true,
      hasTaskList: true,
      hasIncompleteTasks: true,
    })
  })

  it('does not count code-only tasks or links', () => {
    const content = '```\n- [ ] hidden\n[link](https://example.com)\n```'
    expect(scanMemoProperties(content)).toEqual({
      hasLink: false,
      hasCode: true,
      hasTaskList: false,
      hasIncompleteTasks: false,
    })
  })

  it('finds attachment ids in managed file references only', () => {
    const first = 'a'.repeat(26)
    const second = 'b'.repeat(26)
    const content = [
      `![one](/api/memos/files/${first})`,
      `![one again](https://inkstone.example/api/memos/files/${first})`,
      `[two](/api/memos/files/${second}?thumb=1)`,
      `\`/api/memos/files/${'c'.repeat(26)}\``,
      '```',
      `/api/memos/files/${'d'.repeat(26)}`,
      '```',
    ].join('\n')
    expect(scanMemoAttachmentIds(content)).toEqual([first, second])
  })

  it('derives every memo field together, including location', () => {
    const first = 'e'.repeat(26)
    const fields = deriveMemoFields(`# Title\n\n#tag/path\n\n- [ ] TODO\n\n![x](/api/memos/files/${first})`, true)
    expect(fields.title).toBe('Title')
    expect(fields.tags).toEqual(['tag', 'tag/path'])
    expect(fields.hasTaskList).toBe(true)
    expect(fields.hasIncompleteTasks).toBe(true)
    expect(fields.hasLocation).toBe(true)
    expect(fields.attachmentIds).toEqual([first])
  })
})
