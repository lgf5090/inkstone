import { LIMITS } from '@shared/constants'

export const KEEP_CURRENT_EXPIRY = 'current'

export function expiresInForSelection(selection: string): number | null | undefined {
  if (selection === KEEP_CURRENT_EXPIRY) return undefined
  const milliseconds = Number(selection)
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null
}

export function needsNewSharePasscode(
  enabled: boolean,
  alreadyProtected: boolean,
  passcode: string,
): boolean {
  if (!enabled) return false
  if (!alreadyProtected && passcode.length === 0) return true
  // A new or replaced passcode must be at least 8 characters (the server
  // enforces the same minimum); short codes are trivially brute-forced.
  return passcode.length > 0 && passcode.length < SHARE_PASSCODE_MIN_LENGTH
}

export const SHARE_PASSCODE_MIN_LENGTH = LIMITS.sharePasscodeMinLength
