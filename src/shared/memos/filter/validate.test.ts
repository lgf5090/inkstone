import { describe, expect, it } from 'vitest'
import { MEMO_FILTER_MAX_BYTES, MEMO_FILTER_MAX_DEPTH, MEMO_FILTER_REGEX_MAX_LENGTH } from '../constants'
import { validateMemoFilter, type MemoFilterError } from './index'

function errorOf(expression: string): MemoFilterError {
  const result = validateMemoFilter(expression)
  if (result.ok || !result.error) throw new Error(`expected "${expression}" to be rejected`)
  return result.error
}

const isDeep = (error: MemoFilterError) => error.message.includes('deep')

describe('memo filter validation', () => {
  it('accepts the documented expressions', () => {
    const expressions = [
      'pinned',
      'created_ts >= now - duration("1h")',
      'visibility == "PUBLIC"',
      'tag in ["work", "personal"]',
      'size(tags) == 0',
      'tags.exists(t, t.startsWith("archive"))',
      'space == null',
      'space == "spaces/your-space-id"',
      'has_task_list && has_incomplete_tasks',
      'has_link || has_code',
      '!has_location',
      'content.contains("TODO")',
      'content.startsWith("TODO")',
      'content.matches("v[0-9]+")',
      'tags.all(t, t.endsWith("-done"))',
      'tags.exists_one(t, t.startsWith("project/"))',
      'sets.intersects(tags, ["work", "urgent"])',
      'sets.equivalent(tags, ["inbox"])',
      'created_ts.getFullYear() == 2024',
      'created_ts.getDayOfWeek() == 0 || created_ts.getDayOfWeek() == 6',
      'size(content) > 280',
      'visibility in ["PUBLIC", "PROTECTED"]',
      'tag in []',
      '"work" in tags',
      'creator == "me"',
      'size > 100',
      'pinned == false',
      'tags.exists(t, t in ["work"])',
      'created_ts + duration("30m") == updated_ts',
      '(now - duration("1h")).getHours() == 20',
    ]
    for (const expression of expressions) {
      const result = validateMemoFilter(expression)
      expect(result.ok, `${expression}: ${result.error?.message ?? ''}`).toBe(true)
    }
  })

  it('reports a position for an expression that ends early', () => {
    const error = errorOf('pinned &&')
    expect(error.position).toBe(9)
    expect(error.message).toContain('unexpected end')
  })

  it('reports an unknown field at its own position', () => {
    const error = errorOf('foo == 1')
    expect(error.position).toBe(0)
    expect(error.message).toContain('unknown field')
  })

  it('reports a chained comparison at the second operator', () => {
    const error = errorOf('1 < 2 < 3')
    expect(error.position).toBe(6)
    expect(error.message).toContain('chained')
  })

  it('reports an ordering type mismatch at the operator', () => {
    const error = errorOf('content > 3')
    expect(error.position).toBe(8)
    expect(error.message).toContain('cannot order')
  })

  it('reports a null comparison against a non-nullable field', () => {
    expect(errorOf('content == null').message).toContain('null')
    expect(errorOf('null == 1').position).toBe(8)
  })

  it('reports boolean operator type mismatches', () => {
    const error = errorOf('pinned && 1')
    expect(error.position).toBe(7)
    expect(error.message).toContain('booleans')
    expect(errorOf('!content').message).toContain('boolean')
    expect(errorOf('pinned || "x"').message).toContain('booleans')
  })

  it('rejects arithmetic outside the supported combinations', () => {
    expect(errorOf('content + 1').message).toContain('does not accept')
    expect(errorOf('pinned + duration("1h")').message).toContain('does not accept')
    expect(errorOf('-content').message).toContain('number')
  })

  it('requires a boolean expression at the top level', () => {
    expect(errorOf('now').message).toContain('boolean')
    expect(errorOf('tag').message).toContain('boolean')
    expect(errorOf('now - timestamp("2024-01-01")').message).toContain('boolean')
    expect(errorOf('null').message).toContain('boolean')
  })

  it('checks method argument counts', () => {
    expect(errorOf('content.contains()').message).toContain('1 argument')
    expect(errorOf('content.matches("a", "b")').message).toContain('1 argument')
    expect(errorOf('size(content, tags)').message).toContain('1 argument')
    expect(errorOf('created_ts.getFullYear(1)').message).toContain('0 arguments')
    expect(errorOf('tags.exists(t)').message).toContain('2 arguments')
    expect(errorOf('sets.contains(tags)').message).toContain('2 arguments')
  })

  it('checks method argument types and names', () => {
    expect(errorOf('content.contains(1)').message).toContain('expects a string')
    expect(errorOf('content.unknown("x")').message).toContain('unknown string method')
    expect(errorOf('created_ts.getDayOfMonth()').message).toContain('unknown date accessor')
    expect(errorOf('sets.unknown(tags, [])').message).toContain('unknown sets method')
    expect(errorOf('sets.contains(content, ["a"])').message).toContain('expect tags')
    expect(errorOf('sets.contains(tags, "a")').message).toContain('string list')
    expect(errorOf('tags.unknown(t, t)').message).toContain('unknown tags method')
    expect(errorOf('duration(1)').message).toContain('string literal')
    expect(errorOf('timestamp(1)').message).toContain('string literal')
    expect(errorOf('content.matches(1)').message).toContain('string literal')
  })

  it('checks lambda bindings', () => {
    expect(errorOf('tags.exists(content, content)').message).toContain('conflicts')
    expect(errorOf('tags.exists(t, 1)').message).toContain('boolean')
    expect(errorOf('tags.exists(1, true)').message).toContain('lambda variable')
  })

  it('reports invalid duration and timestamp literals at the literal', () => {
    expect(errorOf('duration("garbage")')).toEqual({
      message: 'invalid duration literal',
      position: 9,
    })
    expect(errorOf('timestamp("yesterday")')).toEqual({
      message: 'invalid timestamp literal',
      position: 10,
    })
    expect(errorOf('timestamp("2024-13-01")').message).toContain('timestamp')
    expect(errorOf('timestamp("2024-02-30")').message).toContain('timestamp')
    expect(errorOf('timestamp("2024-01-01T25:00:00Z")').message).toContain('timestamp')
    expect(errorOf('duration("1x")').message).toContain('duration')
    expect(errorOf('duration("-1h")').message).toContain('duration')
  })

  it('rejects unsafe and malformed regular expressions', () => {
    const position = 'content.matches('.length
    expect(errorOf('content.matches("(a+)+")')).toEqual({
      message: 'regular expression is too complex',
      position,
    })
    expect(errorOf('content.matches("(a|a)+")').message).toContain('complex')
    expect(errorOf('content.matches("(")').message).toBe('invalid regular expression')
    expect(errorOf('content.matches("(")').position).toBe(position)
    expect(errorOf('content.matches("[a-")').message).toBe('invalid regular expression')
  })

  it('limits the regular expression length', () => {
    const pattern = 'a'.repeat(MEMO_FILTER_REGEX_MAX_LENGTH + 1)
    const error = errorOf(`content.matches("${pattern}")`)
    expect(error.position).toBe('content.matches('.length)
    expect(error.message).toContain(String(MEMO_FILTER_REGEX_MAX_LENGTH))
    expect(validateMemoFilter(`content.matches("${'a'.repeat(MEMO_FILTER_REGEX_MAX_LENGTH)}")`).ok).toBe(true)
  })

  it('limits the expression size in UTF-8 bytes', () => {
    const error = errorOf(`pinned${' '.repeat(MEMO_FILTER_MAX_BYTES)}`)
    expect(error.position).toBe(0)
    expect(error.message).toContain('longer')
    expect(errorOf(`pinned${'😀'.repeat(MEMO_FILTER_MAX_BYTES / 2)}`).position).toBe(0)
  })

  it('limits nesting depth of parentheses', () => {
    const depth = MEMO_FILTER_MAX_DEPTH + 1
    const error = errorOf(`${'('.repeat(depth)}pinned${')'.repeat(depth)}`)
    expect(isDeep(error)).toBe(true)
    expect(validateMemoFilter(`${'('.repeat(MEMO_FILTER_MAX_DEPTH - 1)}pinned${')'.repeat(MEMO_FILTER_MAX_DEPTH - 1)}`).ok).toBe(true)
  })

  it('limits nesting depth of operator chains', () => {
    const expression = Array.from({ length: MEMO_FILTER_MAX_DEPTH + 8 }, () => 'pinned').join(' && ')
    expect(isDeep(errorOf(expression))).toBe(true)
  })

  it('reports lexical errors with positions', () => {
    expect(errorOf('pinned @').position).toBe(7)
    expect(errorOf('pinned @').message).toContain('unexpected character')
    expect(errorOf('content.contains("x)')).toEqual({
      message: 'unterminated string literal',
      position: 'content.contains('.length,
    })
    expect(errorOf('content.contains("\\q")')).toEqual({
      message: 'invalid escape sequence "\\q"',
      position: 'content.contains('.length + 1,
    })
    expect(errorOf('content.contains("\\u12")').message).toContain('unicode')
    expect(errorOf('pinned 1').message).toContain('unexpected token')
    expect(errorOf('1.2.3').message).toContain('method name')
  })

  it('reports unexpected tokens and missing separators', () => {
    expect(errorOf('content.contains(').message).toContain('unexpected end')
    expect(errorOf('(pinned').message).toContain('expected ")"')
    expect(errorOf('tag in ["a" "b"]').message).toContain('expected "]"')
    expect(errorOf('tags.exists(t t.startsWith("x"))').message).toContain('expected ")"')
    expect(errorOf('pinned pinned').message).toContain('unexpected token')
  })

  it('never throws for arbitrary input', () => {
    const inputs = ['', ' ', '((((', '))))', '&&', '!!!', 'content.', '"', "'", '1..2', '[]', '{}', 'a in', 'sets.', 'pinned &&& true']
    for (const input of inputs) {
      expect(() => validateMemoFilter(input), input).not.toThrow()
    }
  })

  it('accepts string and list literals', () => {
    expect(validateMemoFilter('content == "x"').ok).toBe(true)
    expect(validateMemoFilter('content != "x"').ok).toBe(true)
    expect(validateMemoFilter('content.contains("a\\"b")').ok).toBe(true)
    expect(validateMemoFilter("content.contains('a')").ok).toBe(true)
    expect(validateMemoFilter('tag in []').ok).toBe(true)
    expect(validateMemoFilter('tag in ["a"]').ok).toBe(true)
  })
})
