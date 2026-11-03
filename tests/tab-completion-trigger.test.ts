import { describe, expect, it } from 'vitest'
import { isTabCompletionTrigger } from '../src/client/editor/tab-completion'

describe('when Tab completion may ask the model', () => {
  it('accepts a clause boundary in either width', () => {
    expect(isTabCompletionTrigger('这一句，', '这一句，')).toBe(true)
    expect(isTabCompletionTrigger('This one.', 'This one.')).toBe(true)
    expect(isTabCompletionTrigger('colon:', 'colon:')).toBe(true)
    expect(isTabCompletionTrigger('colon：', 'colon：')).toBe(true)
  })

  it('accepts the newline that just opened an empty line', () => {
    expect(isTabCompletionTrigger('', 'previous line\n')).toBe(true)
  })

  it('accepts a list marker with its trailing space', () => {
    expect(isTabCompletionTrigger('- ', '- ')).toBe(true)
    expect(isTabCompletionTrigger('* ', '* ')).toBe(true)
    expect(isTabCompletionTrigger('1. ', '1. ')).toBe(true)
  })

  it('stays quiet in the middle of a word', () => {
    expect(isTabCompletionTrigger('wor', 'wor')).toBe(false)
    expect(isTabCompletionTrigger('- item', '- item')).toBe(false)
    expect(isTabCompletionTrigger('', '')).toBe(false)
  })
})
