import type { PasswordAccount, PasswordVaultState } from '@shared/tools/password/types'
import { decryptValue, getOriginalPasswordPlus } from './aes'
import { getKeyIv } from './keyiv'
import { passwordApi } from '../api'

export function verifyPasswordWithHint(candidate: string, recoveryHint?: string): boolean {
  if (!candidate || candidate.length !== 6) return false
  if (!recoveryHint) return true
  try {
    const hint = getOriginalPasswordPlus(recoveryHint)
    return !hint || candidate.slice(0, 3) === hint
  } catch {
    return false
  }
}

export function verifyPasswordWithAccount(candidate: string, account: PasswordAccount): boolean {
  if (!candidate || candidate.length !== 6) return false
  const cipher = account.title || account.password || account.username
  if (!cipher) return true
  try {
    const keyiv = getKeyIv(candidate)
    const decrypted = decryptValue(keyiv, cipher)
    return Boolean(decrypted)
  } catch {
    return false
  }
}

export async function verifyMasterPasswordCandidate(
  candidate: string,
  vaultState: PasswordVaultState | null,
  cachedAccounts?: PasswordAccount[],
): Promise<boolean> {
  if (!candidate || candidate.length !== 6) return false

  if (vaultState?.recoveryHint) {
    if (!verifyPasswordWithHint(candidate, vaultState.recoveryHint)) {
      return false
    }
  }

  let accounts = cachedAccounts && cachedAccounts.length > 0 ? cachedAccounts : null
  if (!accounts) {
    try {
      accounts = await passwordApi.getAccounts()
    } catch {
      // Fallback
    }
  }

  if (accounts && accounts.length > 0) {
    const testAccount = accounts.find((a) => a.title || a.password || a.username)
    if (testAccount) {
      return verifyPasswordWithAccount(candidate, testAccount)
    }
  }

  return true
}
