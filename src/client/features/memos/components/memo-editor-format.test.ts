import { describe, expect, it } from 'vitest'
import {
  applyMemoFormat,
  attachmentMarkdown,
  insertMemoLink,
  insertMemoSnippet,
  MEMO_ANY_LIST_PREFIX,
  MEMO_LIST_PATTERNS,
  setMemoHeading,
  toggleMemoInline,
  toggleMemoLinePrefix,
} from './memo-editor-format'
import { memoDateValue, memoLocalTimestamp, memoTimeValue } from './memo-time'

describe('memo editor inline formatting', () => {
  it('wraps a selection and unwraps the same selection', () => {
    const bold = toggleMemoInline('hello world', 6, 11, '**')
    expect(bold.text).toBe('hello **world**')
    expect(bold).toMatchObject({ from: 8, to: 13 })
    const plain = toggleMemoInline(bold.text, bold.from, bold.to, '**')
    expect(plain.text).toBe('hello world')
    expect(plain).toMatchObject({ from: 6, to: 11 })
  })

  it('expands a collapsed caret to the word under it', () => {
    const result = toggleMemoInline('make this bold', 5, 5, '**')
    expect(result.text).toBe('make **this** bold')
    expect(result).toMatchObject({ from: 7, to: 11 })
  })

  it('drops the markers of a selection that is already wrapped', () => {
    const result = applyMemoFormat('say **now**', 4, 11, { kind: 'inline', open: '**' })
    expect(result.text).toBe('say now')
    expect(result).toMatchObject({ from: 4, to: 7 })
  })
})

describe('memo editor block formatting', () => {
  it('quotes every selected line and removes the quotes on a second press', () => {
    const quoted = toggleMemoLinePrefix('one\ntwo', 0, 7, '> ', MEMO_LIST_PATTERNS.quote)
    expect(quoted.text).toBe('> one\n> two')
    const plain = toggleMemoLinePrefix(quoted.text, 0, quoted.text.length, '> ', MEMO_LIST_PATTERNS.quote)
    expect(plain.text).toBe('one\ntwo')
  })

  it('turns a bullet into a task instead of stacking markers', () => {
    const result = applyMemoFormat('- buy milk', 0, 10, {
      kind: 'line',
      prefix: '- [ ] ',
      pattern: MEMO_LIST_PATTERNS.task,
      replacement: MEMO_ANY_LIST_PREFIX,
    })
    expect(result.text).toBe('- [ ] buy milk')
  })

  it('turns a task back into a bullet', () => {
    const result = applyMemoFormat('- [ ] buy milk', 0, 14, {
      kind: 'line',
      prefix: '- ',
      pattern: MEMO_LIST_PATTERNS.bullet,
      replacement: MEMO_ANY_LIST_PREFIX,
    })
    expect(result.text).toBe('- buy milk')
  })

  it('swaps levels and removes a heading at level zero', () => {
    const heading = setMemoHeading('title', 0, 5, 2)
    expect(heading.text).toBe('## title')
    const toggled = setMemoHeading(heading.text, 0, heading.text.length, 2)
    expect(toggled.text).toBe('title')
    const promoted = setMemoHeading('## title', 0, 8, 1)
    expect(promoted.text).toBe('# title')
    const plain = setMemoHeading('# title', 0, 7, 0)
    expect(plain.text).toBe('title')
  })
})

describe('memo editor insertion', () => {
  it('inserts a link around a selection with the caret in the target', () => {
    const result = insertMemoLink('see docs', 4, 8)
    expect(result.text).toBe('see [docs]()')
    expect(result).toMatchObject({ from: 11, to: 11 })
  })

  it('names an empty link for the label', () => {
    const result = insertMemoLink('hello', 0, 0)
    expect(result.text).toBe('[]()hello')
    expect(result).toMatchObject({ from: 1, to: 1 })
  })

  it('inserts a snippet at the selection and honours the cursor offset', () => {
    const result = insertMemoSnippet('hello world', 6, 11, '**bold**', 2)
    expect(result.text).toBe('hello **bold**')
    expect(result).toMatchObject({ from: 8, to: 8 })
  })

  it('embeds images and links every other file', () => {
    expect(attachmentMarkdown({
      filename: 'photo [1].png',
      mime: 'image/png',
      url: '/api/memos/files/abc',
    })).toBe('![photo \\[1\\].png](/api/memos/files/abc)')
    expect(attachmentMarkdown({
      filename: 'report.pdf',
      mime: 'application/pdf',
      url: '/api/memos/files/def',
    })).toBe('[report.pdf](/api/memos/files/def)')
  })
})

describe('memo time helpers', () => {
  it('round-trips a local date and time', () => {
    const stamp = Math.floor(new Date(2026, 4, 6, 9, 30, 0, 0).getTime() / 1000)
    expect(memoDateValue(stamp)).toBe('2026-05-06')
    expect(memoTimeValue(stamp)).toBe('09:30')
    expect(memoLocalTimestamp('2026-05-06', '09:30')).toBe(stamp)
  })

  it('rejects a date the calendar does not have', () => {
    expect(memoLocalTimestamp('2026-02-30', '09:30')).toBeNull()
    expect(memoLocalTimestamp('2026-05-06', '24:00')).toBeNull()
  })
})
