/**
 * Shared types for the Password Manager submodule under Tools (`tools/password`).
 */

export interface KeyIV {
  key: string
  iv: string
}

export interface PasswordVaultState {
  hasVault: boolean
  recoveryHint?: string
  createdAt?: number
  updatedAt?: number
}

export interface PasswordGroup {
  id: string
  userId?: string
  name: string
  parentId: string
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
  favicon: string
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
  favicon: string
  isFavorite: boolean
  sort: number
  createdAt: number
  updatedAt: number
}

export interface WebdavConfig {
  url: string
  username: string
  password?: string
  enabled: boolean
}

export interface PasswordSettings {
  webdav: WebdavConfig
  autoBackupEnabled: boolean
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
  }
  data: {
    groups: PasswordGroup[]
    accounts: PasswordAccount[]
  }
}

export interface PasswordStrengthResult {
  score: number
  color: 'danger' | 'warning' | 'info' | 'success'
  labelKey: string
  suggestions: string[]
}
