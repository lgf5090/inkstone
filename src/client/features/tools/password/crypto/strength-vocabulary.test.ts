/**
 * The Chinese feedback dictionary has to speak zxcvbn's own vocabulary.
 *
 * A warning whose key is one word off is not a translation gap a reader can see: the evaluator falls
 * back to the English sentence, so a Chinese UI quietly shows "This is similar to a commonly used
 * password". Two keys were exactly that far off until a real browser run caught it. This pins the
 * dictionary to the strings the installed library actually emits.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import zxcvbn from 'zxcvbn'
import {
  ZH_CN_PASSWORD_SUGGESTIONS,
  ZH_CN_PASSWORD_WARNINGS,
} from '@shared/locales/zh-CN-tools'
import { initI18n, setLocale } from '../../../../lib/i18n'
import { evaluatePasswordStrength } from './strength'

// A corpus wide enough to reach every feedback branch the evaluator can take.
const CORPUS = [
  '123456',
  'password',
  'qwerty',
  'abcabcabc',
  'aaa',
  '6543',
  '1990',
  '12/12/1990',
  'johnsmith',
  'drowssap',
  'P@ssw0rd',
  'letmein',
  'monkey',
  'iloveyou',
  'admin',
  'test1234',
  'zaq12wsx',
  'asdfgh',
  'qazwsx',
  'trustno1',
  'superman',
  'batman',
  'starwars',
  'correcthorsebatterystaple',
  'aaaaaaaaaaaa',
  '1qaz2wsx3edc',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'welcome',
  'shadow',
  'master',
  'hello',
]

function feedbackVocabulary(): { warnings: Set<string>; suggestions: Set<string> } {
  const warnings = new Set<string>()
  const suggestions = new Set<string>()
  for (const input of CORPUS) {
    const result = zxcvbn(input)
    if (result.feedback.warning) warnings.add(result.feedback.warning)
    for (const suggestion of result.feedback.suggestions ?? []) suggestions.add(suggestion)
  }
  return { warnings, suggestions }
}

describe('zxcvbn Chinese feedback dictionary', () => {
  beforeAll(async () => {
    await initI18n()
    await setLocale('zh-CN', false)
  })

  it('translates every warning the library can emit for this corpus', () => {
    const { warnings } = feedbackVocabulary()
    const missing = [...warnings].filter((text) => !(text in ZH_CN_PASSWORD_WARNINGS))
    expect(missing).toEqual([])
  })

  it('translates every suggestion the library can emit for this corpus', () => {
    const { suggestions } = feedbackVocabulary()
    const missing = [...suggestions].filter((text) => !(text in ZH_CN_PASSWORD_SUGGESTIONS))
    expect(missing).toEqual([])
  })

  it('never leaves English behind in the evaluator result', () => {
    for (const input of CORPUS) {
      const result = evaluatePasswordStrength(input)
      for (const text of [result.warning, ...result.suggestions]) {
        if (!text) continue
        expect(/^[\x20-\x7e]+$/.test(text), `${input}: ${text}`).toBe(false)
      }
    }
  })
})
