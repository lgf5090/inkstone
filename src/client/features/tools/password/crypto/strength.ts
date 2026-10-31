import zxcvbn from 'zxcvbn'
import { getLocale, t } from '../../../../lib/i18n'
import {
  ZH_CN_PASSWORD_LENGTH_SUGGESTION,
  ZH_CN_PASSWORD_SUGGESTIONS,
  ZH_CN_PASSWORD_WARNINGS,
} from '@shared/locales/zh-CN-tools'

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4
export type PasswordStrengthColor = 'error' | 'warning' | 'info' | 'success'

export interface PasswordStrengthResult {
  score: PasswordStrengthScore
  color: PasswordStrengthColor
  label: string
  suggestions: string[]
  warning: string
  feedback: string[]
}

export const SUGGESTION_TRANSLATIONS = ZH_CN_PASSWORD_SUGGESTIONS
export const WARNING_TRANSLATIONS = ZH_CN_PASSWORD_WARNINGS

export const STRENGTH_I18N_KEYS = [
  'tools.password.strength.very_weak',
  'tools.password.strength.weak',
  'tools.password.strength.medium',
  'tools.password.strength.strong',
  'tools.password.strength.very_strong',
] as const

const STRENGTH_COLORS: readonly PasswordStrengthColor[] = ['error', 'warning', 'info', 'success', 'success']

/** zxcvbn's feedback is English; the dictionary only maps it when the reader is reading Chinese. */
function translateFeedback(text: string, table: Record<string, string>): string {
  if (!text) return ''
  return getLocale() === 'zh-CN' ? (table[text] ?? text) : text
}

export function evaluatePasswordStrength(password: string): PasswordStrengthResult {
  if (!password) {
    return {
      score: 0,
      color: 'error',
      label: '',
      suggestions: [],
      warning: '',
      feedback: [],
    }
  }

  const result = zxcvbn(password)
  const score = Math.max(0, Math.min(4, result.score)) as PasswordStrengthScore

  const suggestions = (result.feedback.suggestions || []).map((s) =>
    translateFeedback(s, SUGGESTION_TRANSLATIONS),
  )

  if (score === 2 && suggestions.length === 0) {
    suggestions.push(
      getLocale() === 'zh-CN'
        ? ZH_CN_PASSWORD_LENGTH_SUGGESTION
        : 'Use a longer password — length matters more than symbols',
    )
  }

  const warning = translateFeedback(result.feedback.warning || '', WARNING_TRANSLATIONS)

  return {
    score,
    color: STRENGTH_COLORS[score] ?? 'error',
    label: t(STRENGTH_I18N_KEYS[score] ?? STRENGTH_I18N_KEYS[0]),
    suggestions,
    warning,
    feedback: suggestions,
  }
}
