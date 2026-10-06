import { describe, expect, it } from 'vitest'
import { applyFencePatchAtSource, fenceAt, joinLines, normalizeEol, splitLines } from './fence-edit'

const MD = ['md-example', 'markdown-example']
const NOTE = [
  '# Title',
  '',
  '~~~md-example title="Demo"',
  '- [x] a',
  '~~~',
  '',
  'after',
].join('\n')

describe('fenceAt', () => {
  it('reads the info string and body of the fence the renderer drew', () => {
    expect(fenceAt(NOTE, 2, MD)).toEqual({ info: 'md-example title="Demo"', body: '- [x] a' })
  })

  it('refuses a line that is not a fence, or is a fence of another language', () => {
    expect(fenceAt(NOTE, 0, MD)).toBeNull()
    expect(fenceAt(NOTE, 3, MD)).toBeNull()
    expect(fenceAt('~~~js\nx\n~~~', 0, MD)).toBeNull()
    expect(fenceAt('~~~js\nx\n~~~', 0, [])).toEqual({ info: 'js', body: 'x' })
  })

  it('accepts a fence indented up to three spaces and a longer closing run', () => {
    expect(fenceAt('  ~~~md-example\nx\n  ~~~~', 0, MD)?.body).toBe('x')
    expect(fenceAt('````md-example\n```\n````', 0, MD)?.body).toBe('```')
  })

  it('treats an unclosed fence as running to the end of the note', () => {
    expect(fenceAt('~~~md-example\nx\ny', 0, MD)).toEqual({ info: 'md-example', body: 'x\ny' })
  })
})

describe('applyFencePatchAtSource', () => {
  it('rewrites only the info string and leaves every other line byte-identical', () => {
    const next = applyFencePatchAtSource(NOTE, { line: 2, body: '- [x] a' }, { info: 'md-example layout=rl' }, MD)
    expect(next).toBe(NOTE.replace('~~~md-example title="Demo"', '~~~md-example layout=rl'))
  })

  it('keeps CRLF endings and a missing trailing newline', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n')
    const next = applyFencePatchAtSource(crlf, { line: 2, body: '- [x] a' }, { info: 'md-example layout=rl' }, MD)
    expect(next).toBe(crlf.replace('~~~md-example title="Demo"', '~~~md-example layout=rl'))
    expect(next!.includes('\r\n')).toBe(true)
    const noFinalNewline = applyFencePatchAtSource('~~~md-example\nx\n~~~', { line: 0, body: 'x' }, { info: 'md-example wrap' }, MD)
    expect(noFinalNewline).toBe('~~~md-example wrap\nx\n~~~')
  })

  it('widens the fence when the new body could otherwise close it early', () => {
    const next = applyFencePatchAtSource('~~~md-example\nx\n~~~\n', { line: 0, body: 'x' }, { body: 'a\n~~~\nb' }, MD)
    expect(next).toBe('~~~~md-example\na\n~~~\nb\n~~~~\n')
  })

  it('keeps a closing run that is still long enough and rewrites one that is not', () => {
    expect(applyFencePatchAtSource('~~~md-example\nx\n~~~~~\n', { line: 0, body: 'x' }, { info: 'md-example wrap' }, MD))
      .toBe('~~~md-example wrap\nx\n~~~~~\n')
  })

  it('follows the fence when something above it moved, and declines when the body no longer matches', () => {
    const moved = `intro\n\n${NOTE}`
    expect(applyFencePatchAtSource(moved, { line: 2, body: '- [x] a' }, { info: 'md-example layout=rl' }, MD)).toContain('~~~md-example layout=rl')
    expect(applyFencePatchAtSource(NOTE, { line: 2, body: 'nothing like this' }, { info: 'x' }, MD)).toBeNull()
  })

  it('declines to write when two identical bodies make the target ambiguous', () => {
    const twin = ['~~~md-example\nsame\n~~~', '', '~~~md-example\nsame\n~~~'].join('\n')
    expect(applyFencePatchAtSource(twin, { line: 3, body: 'same' }, { info: 'md-example layout=rl' }, MD)).toBeNull()
    expect(applyFencePatchAtSource(twin, { line: 0, body: 'same' }, { info: 'md-example layout=rl' }, MD)).toContain('layout=rl')
  })

  it('closes a fence that the note left open, which is what the renderer already drew', () => {
    expect(applyFencePatchAtSource('~~~md-example\nx', { line: 0, body: 'x' }, { info: 'md-example wrap' }, MD))
      .toBe('~~~md-example wrap\nx\n~~~')
  })
})

describe('line helpers', () => {
  it('round-trips a document through split and join', () => {
    for (const text of [NOTE, `${NOTE}\n`, 'a\r\nb\r\n', '', 'a\nb']) {
      const { lines, eol, trailingNewline } = splitLines(text)
      expect(joinLines(lines, eol, trailingNewline)).toBe(text)
    }
  })

  it('normalizes only CRLF pairs', () => {
    expect(normalizeEol('a\r\nb\nc\r\n')).toBe('a\nb\nc\n')
    expect(normalizeEol('a\\nb')).toBe('a\\nb')
  })
})
