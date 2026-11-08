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
  /** Total rows in the group, counted by the server so a paged list can still label the tree. */
  accountCount?: number
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
  /**
   * bcrypt cost the reader chose for the master-password verifier. It is a target, not a fact: the
   * stored digest may still carry another cost until the next successful verification rehashes it.
   */
  verifierCost: number
  /** What the stored verifier digest actually uses, read from its `$2a$NN$` prefix. */
  verifierStoredCost: number
  /** Measured verify time per bcrypt cost on this deployment, in milliseconds (keyed by cost). */
  verifierSamples: Record<string, number>
}

/**
 * The verifier's bcrypt cost is the only dial that decides how much CPU an unlock costs the Worker.
 * Three tiers, because a single value cannot serve both a Free-plan deployment and a reader who
 * wants a harder target for offline guessing.
 */
export const VERIFIER_TIERS = {
  low: 4,
  standard: 10,
  high: 12,
} as const

export type VerifierTier = keyof typeof VERIFIER_TIERS

export const VERIFIER_COSTS: readonly number[] = Object.values(VERIFIER_TIERS)

export const DEFAULT_VERIFIER_COST = VERIFIER_TIERS.standard

/** Workers Free allows 10 ms of CPU per request; a tier measured above it cannot unlock there. */
export const FREE_PLAN_CPU_MS = 10

export function isVerifierTierCost(cost: number): boolean {
  return VERIFIER_COSTS.includes(cost)
}

/**
 * bcrypt digests name their cost (`$2a$10$…`). Reading it back is what lets a deployment keep
 * verifying with whatever cost a vault was sealed at, instead of asking the reader to switch first.
 */
export function verifierCostFromHash(hash: string): number | null {
  const match = /^\$2[abxy]?\$(\d{2})\$/.exec(hash)
  if (!match) return null
  const cost = Number(match[1])
  return Number.isInteger(cost) && cost >= 4 && cost <= 31 ? cost : null
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

/** One suffix of a HIBP range response; the count is how often that hash appeared. */
export interface BreachRangeEntry {
  suffix: string
  count: number
}

/** One recorded security event. `detail` holds ids/counts only — never a secret. */
export interface PasswordAuditEntry {
  id: string
  action: string
  detail: Record<string, unknown>
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
