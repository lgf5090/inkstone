import type { DecryptedAccount } from '@shared/tools/password/types'
import { evaluatePasswordStrength } from '../crypto/strength'

/** A password untouched for this long is worth rotating even if it is strong. */
export const STALE_AFTER_DAYS = 180

const DAY_MS = 24 * 60 * 60 * 1000

export interface VaultHealth {
  total: number
  /** Score 0–1 from the same evaluator the form uses. */
  weak: DecryptedAccount[]
  /** Accounts whose password appears more than once, every member of the group. */
  reused: DecryptedAccount[]
  /** Not edited for `STALE_AFTER_DAYS`; `updatedAt` is the only timestamp a row has. */
  stale: DecryptedAccount[]
  /** No URL and no username: a credential that cannot be used on its own. */
  incomplete: DecryptedAccount[]
  withTotp: number
}

/**
 * Reads the vault the reader already holds in memory.
 *
 * Reuse is found by comparing plaintexts here rather than by any stored fingerprint: the sealed
 * envelope is randomised, so two rows that decrypt to the same password share no bytes on the server.
 */
export function analyzeVault(accounts: readonly DecryptedAccount[], now = Date.now()): VaultHealth {
  const byPassword = new Map<string, DecryptedAccount[]>()
  for (const account of accounts) {
    if (!account.password) continue
    const list = byPassword.get(account.password)
    if (list) list.push(account)
    else byPassword.set(account.password, [account])
  }

  const reused: DecryptedAccount[] = []
  for (const list of byPassword.values()) {
    if (list.length > 1) reused.push(...list)
  }

  const staleCutoff = now - STALE_AFTER_DAYS * DAY_MS

  return {
    total: accounts.length,
    weak: accounts.filter((account) => account.password && evaluatePasswordStrength(account.password).score <= 1),
    reused,
    stale: accounts.filter((account) => account.updatedAt > 0 && account.updatedAt < staleCutoff),
    incomplete: accounts.filter((account) => !account.link.trim() && !account.username.trim()),
    withTotp: accounts.filter((account) => Boolean(account.totpSecret?.trim())).length,
  }
}
