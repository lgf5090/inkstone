import { LIMITS } from './constants'

export function sharePasscodeProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) return null
  if (password.length > LIMITS.passwordMaxLength) {
    return `The access password must not exceed ${LIMITS.passwordMaxLength} characters`
  }
  if (password.length < LIMITS.sharePasscodeMinLength) {
    return `The access password must be at least ${LIMITS.sharePasscodeMinLength} characters`
  }
  return null
}
