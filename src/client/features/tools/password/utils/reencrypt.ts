import type { KeyIV } from '@shared/tools/password/types'
import { decryptValue, encryptValue } from '../crypto'

export const REENCRYPT_FIELDS = ['title', 'username', 'password', 'link', 'remark'] as const

export type ReencryptField = (typeof REENCRYPT_FIELDS)[number]

export type ReencryptSource = { id: string } & Partial<Record<ReencryptField, string>>

export interface ReencryptRow {
  id: string
  title: string
  username: string
  password: string
  link: string
  remark: string
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
    const row: ReencryptRow = { id: account.id, title: '', username: '', password: '', link: '', remark: '' }

    for (const field of REENCRYPT_FIELDS) {
      const ciphertext = account[field] ?? ''
      let plain = ''
      if (ciphertext) {
        try {
          plain = decryptValue(from, ciphertext)
        } catch {
          if (failedIndex < 0) failedIndex = index
          continue
        }
      }

      const sealed = encryptValue(to, plain)
      try {
        if (decryptValue(to, sealed) !== plain && failedIndex < 0) failedIndex = index
      } catch {
        if (failedIndex < 0) failedIndex = index
      }
      row[field] = sealed
    }

    return row
  })

  return { rows, failedIndex }
}
