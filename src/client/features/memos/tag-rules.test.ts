import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoTagRule } from '@shared/memos/types'
import {
  matchingMemoTagRule,
  memoTagMatchesRule,
  memoTagRuleBlursContent,
  memoTagRulesByTag,
} from './tag-rules'

function rule(overrides: Partial<MemoTagRule> = {}): MemoTagRule {
  return {
    pattern: 'work',
    mode: 'exact',
    backgroundColor: null,
    blurContent: false,
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('memo tag rules', () => {
  it('matches exact rules only against the whole tag', () => {
    const exact = rule()
    expect(memoTagMatchesRule('work', exact)).toBe(true)
    expect(memoTagMatchesRule('work/client', exact)).toBe(false)
  })

  it('matches regex rules against the tag name', () => {
    const regex = rule({ pattern: '^client/', mode: 'regex' })
    expect(memoTagMatchesRule('client/acme', regex)).toBe(true)
    expect(memoTagMatchesRule('work/acme', regex)).toBe(false)
  })

  it('returns the first matching rule and paints each tag once', () => {
    const rules = [
      rule({ pattern: 'work', backgroundColor: '#ff0000' }),
      rule({ pattern: '^work', mode: 'regex', backgroundColor: '#00ff00' }),
      rule({ pattern: 'secret', blurContent: true }),
    ]
    expect(matchingMemoTagRule('work', rules)?.backgroundColor).toBe('#ff0000')
    const byTag = memoTagRulesByTag(['work', 'secret', 'other'], rules)
    expect([...byTag.keys()]).toEqual(['work', 'secret'])
    expect(byTag.get('secret')?.blurContent).toBe(true)
  })

  it('reports blur when any matched tag asks for it', () => {
    const rules = [rule({ pattern: 'secret', blurContent: true })]
    expect(memoTagRuleBlursContent(['public', 'secret'], rules)).toBe(true)
    expect(memoTagRuleBlursContent(['public'], rules)).toBe(false)
  })

  it('ignores invalid and unsafe regular expressions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rules = [
      rule({ pattern: '(', mode: 'regex' }),
      rule({ pattern: '(a+)+$', mode: 'regex' }),
    ]
    expect(matchingMemoTagRule('aaa', rules)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
