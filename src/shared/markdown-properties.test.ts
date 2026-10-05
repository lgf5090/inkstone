import { describe, expect, it } from 'vitest'
import {
  deleteFrontMatterValue,
  parseFrontMatter,
  renameFrontMatterValue,
  setFrontMatterValue,
} from './markdown-utils'

const NOTE = ['---', 'title: \u793a\u4f8b', 'tags: [a, b]', '---', '', '# \u6b63\u6587', '', '\u5185\u5bb9\u3002'].join('\n')

function keys(content: string): string[] {
  return Object.keys(parseFrontMatter(content).data)
}

describe('setFrontMatterValue', () => {
  it('creates the block only when the note has none', () => {
    const next = setFrontMatterValue('# \u53ea\u6709\u6b63\u6587', 'status', 'draft')
    expect(next).toBe('---\nstatus: draft\n---\n# \u53ea\u6709\u6b63\u6587')
    expect(parseFrontMatter(next).data.status).toBe('draft')
  })

  it('keeps every other key and the whole body when adding one', () => {
    const next = setFrontMatterValue(NOTE, 'status', 'draft')
    expect(keys(next)).toEqual(['title', 'tags', 'status'])
    expect(next.slice(next.indexOf('# \u6b63\u6587'))).toBe('# \u6b63\u6587\n\n\u5185\u5bb9\u3002')
  })

  it('overwrites a key in place instead of duplicating it', () => {
    const next = setFrontMatterValue(NOTE, 'title', '\u53e6\u4e00\u4e2a\u6807\u9898')
    expect(keys(next)).toEqual(['title', 'tags'])
    expect(parseFrontMatter(next).data.title).toBe('\u53e6\u4e00\u4e2a\u6807\u9898')
  })

  it('writes arrays back as a list the tag extractor still reads', () => {
    const next = setFrontMatterValue(NOTE, 'tags', ['a', 'b', 'c'])
    expect(parseFrontMatter(next).data.tags).toEqual(['a', 'b', 'c'])
    expect(next).toContain('tags:')
  })

  it('preserves a comment and the ... fence that closes the block', () => {
    const source = ['---', '# \u8bf4\u660e', 'title: \u793a\u4f8b', '...', '\u6b63\u6587'].join('\n')
    const next = setFrontMatterValue(source, 'status', 'draft')
    expect(next).toContain('# \u8bf4\u660e')
    expect(next.split('\n')[4]).toBe('...')
    expect(keys(next)).toEqual(['title', 'status'])
  })

  it('refuses to touch a note whose front matter does not parse', () => {
    const broken = ['---', 'title: [unclosed', '---', 'body'].join('\n')
    expect(setFrontMatterValue(broken, 'status', 'draft')).toBe(broken)
  })

  it('leaves a horizontal rule in the body alone', () => {
    const source = '---\ntitle: x\n---\n\u4e0a\u6587\n\n---\n\n\u4e0b\u6587'
    const next = setFrontMatterValue(source, 'status', 'draft')
    expect(next.endsWith('\u4e0a\u6587\n\n---\n\n\u4e0b\u6587')).toBe(true)
    expect(keys(next)).toEqual(['title', 'status'])
  })
})

describe('deleteFrontMatterValue', () => {
  it('removes one key and leaves the rest readable', () => {
    const next = deleteFrontMatterValue(NOTE, 'tags')
    expect(keys(next)).toEqual(['title'])
    expect(next).toContain('# \u6b63\u6587')
  })

  it('drops the now-empty block instead of leaving bare fences', () => {
    const next = deleteFrontMatterValue('---\ntitle: x\n---\n\u6b63\u6587', 'title')
    expect(next).toBe('\u6b63\u6587')
  })

  it('is a no-op for a key that is not there', () => {
    expect(deleteFrontMatterValue(NOTE, 'missing')).toBe(NOTE)
  })
})

describe('renameFrontMatterValue', () => {
  it('carries the value across and keeps the body', () => {
    const next = renameFrontMatterValue(NOTE, 'title', 'name')
    expect(keys(next)).toContain('name')
    expect(keys(next)).not.toContain('title')
    expect(parseFrontMatter(next).data.name).toBe('\u793a\u4f8b')
  })

  it('will not overwrite a different key that already owns the target name', () => {
    const source = '---\ntitle: a\ntags: b\n---\nbody'
    expect(renameFrontMatterValue(source, 'title', 'tags')).toBe(source)
  })

  it('is a no-op for an unknown key or an identical name', () => {
    expect(renameFrontMatterValue(NOTE, 'missing', 'other')).toBe(NOTE)
    expect(renameFrontMatterValue(NOTE, 'title', 'title')).toBe(NOTE)
  })
})
