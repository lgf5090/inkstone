/**
 * Shared types for the Password Manager submodule under Tools (`tools/password`).
 */

/**
 * A new master password must be long enough to be worth a scrypt round; nothing caps it at six any
 * more. Unlocking is deliberately not held to the minimum: vaults created before this rule still
 * have a shorter password and their owners must be able to open them.
 */
export const MASTER_PASSWORD_MIN_LENGTH = 8
export const MASTER_PASSWORD_MAX_LENGTH = 128

export interface KeyIV {
  key: string
  iv: string
}

export interface PasswordVaultState {
  hasVault: boolean
  /** The KDF salt, so a local backup can record which key its ciphertext belongs to. Not a secret. */
  kdfSalt?: string
  createdAt?: number
  updatedAt?: number
}

export interface PasswordGroup {
  id: string
  userId?: string
  name: string
  parentId: string
  icon?: string
  sort: number
  createdAt: number
  updatedAt: number
  childs?: PasswordGroup[]
}

export interface PasswordAccount {
  id: string
  userId?: string
  groupId: string
  /** AES-256-CBC ciphertext hex string */
  title: string
  /** AES-256-CBC ciphertext hex string */
  username: string
  /** AES-256-CBC ciphertext hex string */
  password: string
  /** AES-256-CBC ciphertext hex string */
  link: string
  /** AES-256-CBC ciphertext hex string */
  remark: string
  /** Sealed TOTP secret (base32) or '' when the account has none. */
  totpSecret?: string
  isFavorite: boolean
  sort: number
  createdAt: number
  updatedAt: number
}

export interface DecryptedAccount {
  id: string
  groupId: string
  title: string
  username: string
  password: string
  link: string
  remark: string
  totpSecret?: string
  /**
   * Client-only: the stored TOTP ciphertext exists but cannot be opened with the current key, so the
   * secret has to be entered again. Never sent to the server.
   */
  totpUnreadable?: boolean
  /** Client-only: at least one sealed field could not be opened with the current key. */
  decryptUnreadable?: boolean
  isFavorite: boolean
  sort: number
  createdAt: number
  updatedAt: number
}

export interface PasswordSettings {
  autoLockMinutes: number
  updatedAt: number
}

export interface PasswordBackupRecord {
  id: string
  userId?: string
  filename: string
  r2Key: string
  size: number
  type: 'auto' | 'manual'
  createdAt: number
}

export interface PasswordBackupData {
  _backup_info: {
    type: 'upassword_backup' | 'inkstone_password_backup'
    version: string
    createTime: number
    platform: string
    /**
     * The salt the vault used when this snapshot was written. A restore refuses a snapshot whose
     * salt no longer matches, instead of replacing the vault with rows it cannot decrypt.
     */
    kdfSalt?: string
  }
  data: {
    groups: PasswordGroup[]
    accounts: PasswordAccount[]
  }
}
