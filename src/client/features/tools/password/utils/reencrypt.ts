import type { KeyIV } from '@shared/tools/password/types'
import { decryptValue, encryptValue } from '../crypto'

/**
 * Every sealed column on an account row, not just the ones the form shows first. `totpSecret` was
 * missing from this list once, and a reset silently replaced every second-factor secret with ''.
 */
export const REENCRYPT_FIELDS = ['title', 'username', 'password', 'link', 'remark', 'totpSecret'] as const

export type ReencryptField = (typeof REENCRYPT_FIELDS)[number]

export type ReencryptSource = { id: string } & Partial<Record<ReencryptField, string>>

export interface ReencryptRow {
  id: string
  title: string
  username: string
  password: string
  link: string
  remark: string
  totpSecret: string
}

export interface ReencryptResult {
  rows: ReencryptRow[]
  /**
   * Index of the first row that could not be opened with `from` or read back with `to`, or -1.
   * The caller must abort on a non-negative value: this is the step that cannot be undone.
   */
  failedIndex: number
}

/**
 * Re-seals every field under a new key, but never guesses.
 *
 * A field that fails to decrypt under the old key is left empty and reported instead of being
 * written back as-is — encrypting raw ciphertext again is how a reset used to lose a whole vault.
 * Every sealed value is also read back under the new key so a half-finished key switch is caught
 * before it is uploaded.
 */
export function reencryptAccounts(
  accounts: readonly ReencryptSource[],
  from: KeyIV,
  to: KeyIV,
): ReencryptResult {
  let failedIndex = -1
  const rows = accounts.map((account, index): ReencryptRow => {
    const row: ReencryptRow = {
      id: account.id,
      title: '',
      username: '',
      password: '',
      link: '',
      remark: '',
      totpSecret: '',
    }

    for (const field of REENCRYPT_FIELDS) {
      const ciphertext = account[field] ?? ''
      const aad = `${field}:${account.id}`
      let plain = ''
      if (ciphertext) {
        try {
          plain = decryptValue(from, ciphertext, aad)
        } catch {
          if (failedIndex < 0) failedIndex = index
          continue
        }
      }

      const sealed = encryptValue(to, plain, aad)
      try {
        if (decryptValue(to, sealed, aad) !== plain && failedIndex < 0) failedIndex = index
      } catch {
        if (failedIndex < 0) failedIndex = index
      }
      row[field] = sealed
    }

    return row
  })

  return { rows, failedIndex }
}
