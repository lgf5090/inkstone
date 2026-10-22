import { MEMO_TAG_RULE_MAX_LENGTH } from '@shared/memos/constants'
import type { MemoTagRule } from '@shared/memos/types'
import { patternSafety } from '@shared/regex-safety'

const compiledPatterns = new Map<string, RegExp | null>()

function regexFor(pattern: string): RegExp | null {
  const cached = compiledPatterns.get(pattern)
  if (cached !== undefined) return cached
  let compiled: RegExp | null = null
  if (!patternSafety(pattern, MEMO_TAG_RULE_MAX_LENGTH)) {
    try {
      compiled = new RegExp(pattern)
    } catch {
      compiled = null
    }
  }
  if (compiled === null) {
    console.warn('[inkstone] Ignoring an invalid memo tag rule pattern', pattern)
  }
  compiledPatterns.set(pattern, compiled)
  return compiled
}

export function memoTagMatchesRule(tag: string, rule: MemoTagRule): boolean {
  if (rule.mode === 'exact') return tag === rule.pattern
  const regex = regexFor(rule.pattern)
  return regex !== null && regex.test(tag)
}

export function matchingMemoTagRule(
  tag: string,
  rules: readonly MemoTagRule[],
): MemoTagRule | null {
  for (const rule of rules) {
    if (memoTagMatchesRule(tag, rule)) return rule
  }
  return null
}

export function memoTagRulesByTag(
  tags: readonly string[],
  rules: readonly MemoTagRule[],
): Map<string, MemoTagRule> {
  const matches = new Map<string, MemoTagRule>()
  if (rules.length === 0) return matches
  for (const tag of tags) {
    const rule = matchingMemoTagRule(tag, rules)
    if (rule) matches.set(tag, rule)
  }
  return matches
}

export function memoTagRuleBlursContent(
  tags: readonly string[],
  rules: readonly MemoTagRule[],
): boolean {
  for (const tag of tags) {
    const rule = matchingMemoTagRule(tag, rules)
    if (rule?.blurContent) return true
  }
  return false
}
