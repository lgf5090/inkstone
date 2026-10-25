import zxcvbn from 'zxcvbn'
import {
  ZH_CN_PASSWORD_LENGTH_SUGGESTION,
  ZH_CN_PASSWORD_STRENGTH_LABELS,
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
const STRENGTH_LABELS: readonly string[] = ZH_CN_PASSWORD_STRENGTH_LABELS

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

  const suggestions = (result.feedback.suggestions || []).map(
    (s) => SUGGESTION_TRANSLATIONS[s] || s,
  )

  if (score === 2 && suggestions.length === 0) {
    suggestions.push(ZH_CN_PASSWORD_LENGTH_SUGGESTION)
  }

  const rawWarning = result.feedback.warning || ''
  const warning = rawWarning ? (WARNING_TRANSLATIONS[rawWarning] || rawWarning) : ''

  return {
    score,
    color: STRENGTH_COLORS[score] ?? 'error',
    label: STRENGTH_LABELS[score] ?? '',
    suggestions,
    warning,
    feedback: suggestions,
  }
}
