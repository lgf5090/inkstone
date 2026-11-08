/**
 * Database store for the Password Manager submodule under Tools.
 *
 * All operations are strictly tenant-isolated using `user_id = ?1` as the primary dimension.
 */

import type {
  PasswordAccount,
  PasswordAuditEntry,
  PasswordBackupRecord,
  PasswordGroup,
  PasswordSettings,
  PasswordVaultState,
} from '@shared/tools/password/types'
import { ApiError } from '../../lib/errors'

/**
 * D1 caps the number of statements one `batch` may carry, and the repository's other stores chunk at
 * 90. Every caller that maps an unbounded list goes through here instead of handing `batch` a list
 * whose length came from a request body.
 */
const STATEMENT_CHUNK = 90
const MAX_GROUP_DEPTH = 7

/** How many security events one vault keeps; older rows are dropped as new ones arrive. */
const AUDIT_RETENTION = 1000

/** How many snapshots a vault keeps before the oldest are dropped. */
const BACKUP_RETENTION = 20

async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += STATEMENT_CHUNK) {
    await db.batch(statements.slice(offset, offset + STATEMENT_CHUNK))
  }
}

interface VaultRow {
  user_id: string
  master_hash: string
  kdf_salt: string
  created_at: number
  updated_at: number
}

interface GroupRow {
  user_id: string
  id: string
  name: string
  parent_id: string
  icon: string
  sort: number
  created_at: number
  updated_at: number
}

interface AccountRow {
  user_id: string
  id: string
  group_id: string
  title: string
  username: string
  password: string
  link: string
  remark: string
  totp_secret: string
  is_favorite: number
  sort: number
  created_at: number
  updated_at: number
}

interface SettingsRow {
  user_id: string
  auto_lock_minutes: number
  updated_at: number
}

interface BackupRow {
  user_id: string
  id: string
  filename: string
  r2_key: string
  size: number
  type: string
  created_at: number
}

/** One-based depth of a group in the tenant's tree, or 0 when the id is unknown. */
function groupDepth(groups: PasswordGroup[], groupId: string): number {
  const byId = new Map(groups.map((group) => [group.id, group]))
  let depth = 1
  let cursor = byId.get(groupId)
  const seen = new Set<string>()
  while (cursor?.parentId) {
    if (seen.has(cursor.id)) break
    seen.add(cursor.id)
    depth += 1
    cursor = byId.get(cursor.parentId)
  }
  return byId.has(groupId) ? depth : 0
}

/** Number of levels the subtree rooted at `groupId` occupies. */
function subtreeHeight(groups: PasswordGroup[], groupId: string): number {
  const children = groups.filter((group) => group.parentId === groupId)
  if (children.length === 0) return 1
  return 1 + Math.max(...children.map((child) => subtreeHeight(groups, child.id)))
}

function toGroup(row: GroupRow): PasswordGroup {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    parentId: row.parent_id,
    icon: row.icon,
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAccount(row: AccountRow): PasswordAccount {
  return {
    id: row.id,
    userId: row.user_id,
    groupId: row.group_id,
    title: row.title,
    username: row.username,
    password: row.password,
    link: row.link,
    remark: row.remark,
    totpSecret: row.totp_secret,
    isFavorite: Boolean(row.is_favorite),
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PasswordStore {
  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
  ) {}

  // ---------------------------------------------------------------- Vault
  /**
   * The old `recovery_hint` column held the first three characters of the master password under a
   * key that shipped in the bundle. It is gone from the schema; databases created before that keep
   * the unused column until a future migration drops it, but nothing reads or writes it.
   */
  async getVaultState(): Promise<PasswordVaultState> {
    const row = await this.db
      .prepare(`SELECT kdf_salt, created_at, updated_at FROM tools_password_vault WHERE user_id = ?1`)
      .bind(this.userId)
      .first<Pick<VaultRow, 'kdf_salt' | 'created_at' | 'updated_at'>>()

    if (!row) {
      return { hasVault: false }
    }
    return {
      hasVault: true,
      kdfSalt: row.kdf_salt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async getVault(): Promise<{ masterHash: string; kdfSalt: string; createdAt: number; updatedAt: number } | null> {
    const row = await this.db
      .prepare(`SELECT master_hash, kdf_salt, created_at, updated_at FROM tools_password_vault WHERE user_id = ?1`)
      .bind(this.userId)
      .first<VaultRow>()

    if (!row) return null
    return {
      masterHash: row.master_hash,
      kdfSalt: row.kdf_salt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async initVault(masterHash: string, kdfSalt: string): Promise<PasswordVaultState> {
    const existing = await this.getVaultState()
    if (existing.hasVault) {
      throw ApiError.badRequest('Vault is already initialized')
    }

    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_password_vault (user_id, master_hash, kdf_salt, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(this.userId, masterHash, kdfSalt, now, now)
      .run()

    return {
      hasVault: true,
      kdfSalt,
      createdAt: now,
      updatedAt: now,
    }
  }

  /**
   * Swaps the verifier and every sealed row together, without a transaction.
   *
   * The write order is what makes a failure recoverable: the verifier is written **last**, so a
   * failure while the rows are being replaced still leaves a vault the old password opens, and the
   * rows already written are rolled back to the snapshot taken before the first write. The request
   * must carry every account the server currently has; a stale client list would silently leave an
   * old-key row behind, which is a vault that cannot be opened completely.
   */
  async resetMasterPassword(
    newMasterHash: string,
    newKdfSalt: string,
    accounts: Array<{
      id: string
      title: string
      username: string
      password: string
      link?: string
      remark?: string
      totpSecret?: string
    }>,
  ): Promise<void> {
    const existing = await this.getVaultState()
    if (!existing.hasVault) {
      throw ApiError.badRequest('Vault is not initialized')
    }

    const snapshot = await this.getAccounts()
    const snapshotById = new Map(snapshot.map((account) => [account.id, account]))
    const incomingIds = new Set<string>()
    for (const account of accounts) {
      if (incomingIds.has(account.id)) {
        throw ApiError.badRequest(`Duplicate account id ${account.id} in reset payload`)
      }
      incomingIds.add(account.id)
      if (!snapshotById.has(account.id)) {
        throw ApiError.conflict('The vault changed while the password was being reset. Refresh and try again.')
      }
    }
    if (incomingIds.size !== snapshot.length) {
      throw ApiError.conflict('The reset payload does not cover every account. Refresh and try again.')
    }

    const now = Date.now()
    try {
      await runBatched(this.db, this.buildAccountUpdates(accounts, now))
      await this.db
        .prepare(
          `UPDATE tools_password_vault SET master_hash = ?1, kdf_salt = ?2, updated_at = ?3
           WHERE user_id = ?4`,
        )
        .bind(newMasterHash, newKdfSalt, now, this.userId)
        .run()
    } catch (error) {
      try {
        await runBatched(
          this.db,
          this.buildAccountUpdates(
            snapshot.map((account) => ({
              id: account.id,
              title: account.title,
              username: account.username,
              password: account.password,
              link: account.link,
              remark: account.remark,
              totpSecret: account.totpSecret ?? '',
            })),
            Date.now(),
          ),
        )
      } catch (rollbackError) {
        throw new ApiError(
          500,
          'reset_rollback_failed',
          `The reset failed and the previous rows could not be written back: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
          { cause: error },
        )
      }
      throw error
    }
  }

  private buildAccountUpdates(
    accounts: Array<{
      id: string
      title: string
      username: string
      password: string
      link?: string
      remark?: string
      totpSecret?: string
    }>,
    now: number,
  ): D1PreparedStatement[] {
    return accounts.map((account) =>
      this.db
        .prepare(
          `UPDATE tools_password_accounts
           SET title = ?1, username = ?2, password = ?3, link = ?4, remark = ?5, totp_secret = ?6, updated_at = ?7
           WHERE user_id = ?8 AND id = ?9`,
        )
        .bind(
          account.title,
          account.username,
          account.password,
          account.link ?? '',
          account.remark ?? '',
          account.totpSecret ?? '',
          now,
          this.userId,
          account.id,
        ),
    )
  }

  /**
   * Forgets the vault and everything in it. This is the one write that needs no master password:
   * a reader who lost it cannot open the rows anyway, and keeping them only leaves ciphertext that
   * nobody can ever decrypt. Backup objects are returned so the route can drop them from R2 too.
   */
  async wipeVault(): Promise<string[]> {
    const backups = await this.db
      .prepare(`SELECT r2_key FROM tools_password_backups WHERE user_id = ?1`)
      .bind(this.userId)
      .all<{ r2_key: string }>()

    await this.db.batch([
      this.db.prepare(`DELETE FROM tools_password_accounts WHERE user_id = ?1`).bind(this.userId),
      this.db.prepare(`DELETE FROM tools_password_groups WHERE user_id = ?1`).bind(this.userId),
      this.db.prepare(`DELETE FROM tools_password_settings WHERE user_id = ?1`).bind(this.userId),
      this.db.prepare(`DELETE FROM tools_password_backups WHERE user_id = ?1`).bind(this.userId),
      // A wipe is meant to leave nothing; the route records the wipe itself afterwards.
      this.db.prepare(`DELETE FROM tools_password_audit WHERE user_id = ?1`).bind(this.userId),
      this.db.prepare(`DELETE FROM tools_password_vault WHERE user_id = ?1`).bind(this.userId),
    ])

    return (backups.results ?? []).map((row) => row.r2_key)
  }

  // ---------------------------------------------------------------- Groups
  async getGroups(): Promise<PasswordGroup[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, user_id, name, parent_id, icon, sort, created_at, updated_at
         FROM tools_password_groups
         WHERE user_id = ?1
         ORDER BY sort ASC, id ASC`,
      )
      .bind(this.userId)
      .all<GroupRow>()

    return (results ?? []).map(toGroup)
  }

  async getGroup(id: string): Promise<PasswordGroup | null> {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, name, parent_id, icon, sort, created_at, updated_at
         FROM tools_password_groups
         WHERE user_id = ?1 AND id = ?2`,
      )
      .bind(this.userId, id)
      .first<GroupRow>()

    return row ? toGroup(row) : null
  }

  async createGroup(data: { id?: string; name: string; parentId?: string; icon?: string; sort?: number }): Promise<PasswordGroup> {
    const id = data.id || crypto.randomUUID()
    const parentId = data.parentId ?? ''
    if (parentId) {
      const groups = await this.getGroups()
      const parent = groups.find((group) => group.id === parentId)
      if (!parent) {
        throw ApiError.badRequest('Parent group not found')
      }
      if (groupDepth(groups, parentId) + 1 > MAX_GROUP_DEPTH) {
        throw ApiError.badRequest(`Groups cannot be nested deeper than ${MAX_GROUP_DEPTH} levels`)
      }
    }
    const icon = data.icon ?? ''
    const sort = data.sort ?? 0
    const now = Date.now()

    await this.db
      .prepare(
        `INSERT INTO tools_password_groups (user_id, id, name, parent_id, icon, sort, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(this.userId, id, data.name, parentId, icon, sort, now, now)
      .run()

    return {
      id,
      userId: this.userId,
      name: data.name,
      parentId,
      icon,
      sort,
      createdAt: now,
      updatedAt: now,
    }
  }

  async updateGroup(id: string, data: { name?: string; parentId?: string; icon?: string; sort?: number }): Promise<PasswordGroup> {
    const existing = await this.getGroup(id)
    if (!existing) {
      throw ApiError.notFound('Group not found')
    }

    const name = data.name !== undefined ? data.name : existing.name
    const parentId = data.parentId !== undefined ? data.parentId : existing.parentId
    if (parentId !== existing.parentId && parentId) {
      const groups = await this.getGroups()
      if (!groups.some((group) => group.id === parentId)) {
        throw ApiError.badRequest('Parent group not found')
      }
      if (parentId === id) {
        throw ApiError.badRequest('A group cannot be its own parent')
      }
      const seen = new Set<string>([id])
      let cursor = parentId
      while (cursor) {
        if (seen.has(cursor)) {
          throw ApiError.badRequest('A group cannot be moved under its own descendant')
        }
        seen.add(cursor)
        cursor = groups.find((group) => group.id === cursor)?.parentId ?? ''
      }
      const depth = groupDepth(groups, parentId) + 1
      if (depth + subtreeHeight(groups, id) - 1 > MAX_GROUP_DEPTH) {
        throw ApiError.badRequest(`Groups cannot be nested deeper than ${MAX_GROUP_DEPTH} levels`)
      }
    }
    const icon = data.icon !== undefined ? data.icon : existing.icon
    const sort = data.sort !== undefined ? data.sort : existing.sort
    const now = Date.now()

    await this.db
      .prepare(
        `UPDATE tools_password_groups
         SET name = ?1, parent_id = ?2, icon = ?3, sort = ?4, updated_at = ?5
         WHERE user_id = ?6 AND id = ?7`,
      )
      .bind(name, parentId, icon, sort, now, this.userId, id)
      .run()

    return {
      ...existing,
      name,
      parentId,
      icon,
      sort,
      updatedAt: now,
    }
  }

  async deleteGroup(id: string): Promise<void> {
    const existing = await this.getGroup(id)
    if (!existing) {
      throw ApiError.notFound('Group not found')
    }

    // Check subgroups
    const subgroup = await this.db
      .prepare(`SELECT 1 FROM tools_password_groups WHERE user_id = ?1 AND parent_id = ?2 LIMIT 1`)
      .bind(this.userId, id)
      .first()
    if (subgroup) {
      throw ApiError.badRequest('Cannot delete group with subgroups')
    }

    // Check accounts
    const account = await this.db
      .prepare(`SELECT 1 FROM tools_password_accounts WHERE user_id = ?1 AND group_id = ?2 LIMIT 1`)
      .bind(this.userId, id)
      .first()
    if (account) {
      throw ApiError.badRequest('Cannot delete group with accounts')
    }

    await this.db
      .prepare(`DELETE FROM tools_password_groups WHERE user_id = ?1 AND id = ?2`)
      .bind(this.userId, id)
      .run()
  }

  // ---------------------------------------------------------------- Accounts
  async getAccounts(groupId?: string): Promise<PasswordAccount[]> {
    if (groupId) {
      const { results } = await this.db
        .prepare(
          `SELECT id, user_id, group_id, title, username, password, link, remark, totp_secret, is_favorite, sort, created_at, updated_at
           FROM tools_password_accounts
           WHERE user_id = ?1 AND group_id = ?2
           ORDER BY sort ASC, id ASC`,
        )
        .bind(this.userId, groupId)
        .all<AccountRow>()
      return (results ?? []).map(toAccount)
    }

    const { results } = await this.db
      .prepare(
        `SELECT id, user_id, group_id, title, username, password, link, remark, totp_secret, is_favorite, sort, created_at, updated_at
         FROM tools_password_accounts
         WHERE user_id = ?1
         ORDER BY sort ASC, id ASC`,
      )
      .bind(this.userId)
      .all<AccountRow>()

    return (results ?? []).map(toAccount)
  }

  async getAccount(id: string): Promise<PasswordAccount | null> {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, group_id, title, username, password, link, remark, totp_secret, is_favorite, sort, created_at, updated_at
         FROM tools_password_accounts
         WHERE user_id = ?1 AND id = ?2`,
      )
      .bind(this.userId, id)
      .first<AccountRow>()

    return row ? toAccount(row) : null
  }

  async createAccount(data: {
    id?: string
    groupId: string
    title?: string
    username?: string
    password?: string
    link?: string
    remark?: string
    totpSecret?: string
    isFavorite?: boolean
    sort?: number
  }): Promise<PasswordAccount> {
    // A group id the tenant does not own used to be inserted verbatim, which produced rows no view
    // could reach (they are filtered by a group the client never selects). Refusing here keeps the
    // dangling-row class out of the table instead of cleaning it up later.
    const group = await this.getGroup(data.groupId)
    if (!group) {
      throw ApiError.badRequest('Target group not found')
    }

    const id = data.id || crypto.randomUUID()
    const title = data.title ?? ''
    const username = data.username ?? ''
    const password = data.password ?? ''
    const link = data.link ?? ''
    const remark = data.remark ?? ''
    const totpSecret = data.totpSecret ?? ''
    const isFavorite = data.isFavorite ? 1 : 0
    const sort = data.sort ?? 0
    const now = Date.now()

    await this.db
      .prepare(
        `INSERT INTO tools_password_accounts (
           user_id, id, group_id, title, username, password, link, remark, totp_secret, is_favorite, sort, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(
        this.userId,
        id,
        data.groupId,
        title,
        username,
        password,
        link,
        remark,
        totpSecret,
        isFavorite,
        sort,
        now,
        now,
      )
      .run()

    return {
      id,
      userId: this.userId,
      groupId: data.groupId,
      title,
      username,
      password,
      link,
      remark,
      totpSecret,
      isFavorite: Boolean(isFavorite),
      sort,
      createdAt: now,
      updatedAt: now,
    }
  }

  async updateAccount(
    id: string,
    data: {
      groupId?: string
      title?: string
      username?: string
      password?: string
      link?: string
      remark?: string
      totpSecret?: string
      isFavorite?: boolean
      sort?: number
      expectedUpdatedAt?: number
    },
  ): Promise<PasswordAccount> {
    const existing = await this.getAccount(id)
    if (!existing) {
      throw ApiError.notFound('Account not found')
    }
    if (data.expectedUpdatedAt !== undefined && data.expectedUpdatedAt !== existing.updatedAt) {
      throw ApiError.conflict('This account changed in another tab. Refresh before saving again.')
    }

    if (data.groupId !== undefined && data.groupId !== existing.groupId) {
      const group = await this.getGroup(data.groupId)
      if (!group) {
        throw ApiError.badRequest('Target group not found')
      }
    }

    const groupId = data.groupId !== undefined ? data.groupId : existing.groupId
    const title = data.title !== undefined ? data.title : existing.title
    const username = data.username !== undefined ? data.username : existing.username
    const password = data.password !== undefined ? data.password : existing.password
    const link = data.link !== undefined ? data.link : existing.link
    const remark = data.remark !== undefined ? data.remark : existing.remark
    const totpSecret = data.totpSecret !== undefined ? data.totpSecret : existing.totpSecret
    const isFavorite = data.isFavorite !== undefined ? (data.isFavorite ? 1 : 0) : (existing.isFavorite ? 1 : 0)
    const sort = data.sort !== undefined ? data.sort : existing.sort
    const now = Date.now()

    await this.db
      .prepare(
        `UPDATE tools_password_accounts
         SET group_id = ?1, title = ?2, username = ?3, password = ?4, link = ?5, remark = ?6,
             totp_secret = ?7, is_favorite = ?8, sort = ?9, updated_at = ?10
         WHERE user_id = ?11 AND id = ?12`,
      )
      .bind(
        groupId,
        title,
        username,
        password,
        link,
        remark,
        totpSecret,
        isFavorite,
        sort,
        now,
        this.userId,
        id,
      )
      .run()

    return {
      ...existing,
      groupId,
      title,
      username,
      password,
      link,
      remark,
      totpSecret,
      isFavorite: Boolean(isFavorite),
      sort,
      updatedAt: now,
    }
  }

  async deleteAccount(id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM tools_password_accounts WHERE user_id = ?1 AND id = ?2`)
      .bind(this.userId, id)
      .run()
  }

  async batchDeleteAccounts(accountIds: string[]): Promise<void> {
    if (accountIds.length === 0) return
    const statements = accountIds.map((id) =>
      this.db
        .prepare(`DELETE FROM tools_password_accounts WHERE user_id = ?1 AND id = ?2`)
        .bind(this.userId, id),
    )
    await runBatched(this.db, statements)
  }

  async batchMoveAccounts(accountIds: string[], targetGroupId: string): Promise<void> {
    if (accountIds.length === 0) return
    const group = await this.getGroup(targetGroupId)
    if (!group) {
      throw ApiError.badRequest('Target group not found')
    }

    const now = Date.now()
    const statements = accountIds.map((id) =>
      this.db
        .prepare(
          `UPDATE tools_password_accounts
           SET group_id = ?1, updated_at = ?2
           WHERE user_id = ?3 AND id = ?4`,
        )
        .bind(targetGroupId, now, this.userId, id),
    )
    await runBatched(this.db, statements)
  }

  async reorderAccounts(accounts: Array<{ id: string; sort: number }>): Promise<void> {
    if (accounts.length === 0) return
    const now = Date.now()
    const statements = accounts.map((acc) =>
      this.db
        .prepare(
          `UPDATE tools_password_accounts
           SET sort = ?1, updated_at = ?2
           WHERE user_id = ?3 AND id = ?4`,
        )
        .bind(acc.sort, now, this.userId, acc.id),
    )
    await runBatched(this.db, statements)
  }

  async batchImportAccounts(
    groupId: string,
    accounts: Array<{
      id?: string
      title?: string
      username?: string
      password?: string
      link?: string
      remark?: string
      totpSecret?: string
      sort?: number
    }>,
  ): Promise<PasswordAccount[]> {
    const group = await this.getGroup(groupId)
    if (!group) {
      throw ApiError.badRequest('Target group not found')
    }

    const now = Date.now()
    const created: PasswordAccount[] = []
    const statements: D1PreparedStatement[] = []

    for (let i = 0; i < accounts.length; i++) {
      const item = accounts[i]
      const id = item.id || crypto.randomUUID()
      const title = item.title ?? ''
      const username = item.username ?? ''
      const password = item.password ?? ''
      const link = item.link ?? ''
      const remark = item.remark ?? ''
      const totpSecret = item.totpSecret ?? ''
      const sort = item.sort ?? i

      statements.push(
        this.db
          .prepare(
            `INSERT INTO tools_password_accounts (
               user_id, id, group_id, title, username, password, link, remark, totp_secret, is_favorite, sort, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
          )
          .bind(
            this.userId,
            id,
            groupId,
            title,
            username,
            password,
            link,
            remark,
            totpSecret,
            0,
            sort,
            now,
            now,
          ),
      )

      created.push({
        id,
        userId: this.userId,
        groupId,
        title,
        username,
        password,
        link,
        remark,
        totpSecret,
        isFavorite: false,
        sort,
        createdAt: now,
        updatedAt: now,
      })
    }

    if (statements.length > 0) {
      await runBatched(this.db, statements)
    }

    return created
  }

  // ---------------------------------------------------------------- Settings
  async getSettings(): Promise<PasswordSettings> {
    const row = await this.db
      .prepare(
        `SELECT auto_lock_minutes, updated_at
         FROM tools_password_settings
         WHERE user_id = ?1`,
      )
      .bind(this.userId)
      .first<SettingsRow>()

    if (!row) {
      return {
        autoLockMinutes: 5,
        updatedAt: 0,
      }
    }

    return {
      autoLockMinutes: row.auto_lock_minutes,
      updatedAt: row.updated_at,
    }
  }

  async saveSettings(data: { autoLockMinutes?: number }): Promise<PasswordSettings> {
    const current = await this.getSettings()
    const autoLockMinutes = data.autoLockMinutes !== undefined ? data.autoLockMinutes : current.autoLockMinutes
    const now = Date.now()

    await this.db
      .prepare(
        `INSERT INTO tools_password_settings (user_id, auto_lock_minutes, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id) DO UPDATE SET
           auto_lock_minutes = excluded.auto_lock_minutes,
           updated_at = excluded.updated_at`,
      )
      .bind(this.userId, autoLockMinutes, now)
      .run()

    return {
      autoLockMinutes,
      updatedAt: now,
    }
  }

  // ---------------------------------------------------------------- Audit
  /**
   * Appends one security event and trims the oldest beyond the retention limit.
   *
   * The entry carries what the console line carries: an action name and ids/counts. A caller must
   * never put a password, a TOTP secret or a ciphertext body in `detail`; the route helper is the
   * only writer and keeps to that shape.
   */
  async recordAudit(action: string, detail: Record<string, unknown> = {}): Promise<void> {
    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_password_audit (user_id, id, action, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(this.userId, crypto.randomUUID(), action, JSON.stringify(detail), now)
      .run()

    await this.db
      .prepare(
        `DELETE FROM tools_password_audit
         WHERE user_id = ?1 AND id NOT IN (
           SELECT id FROM tools_password_audit WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2
         )`,
      )
      .bind(this.userId, AUDIT_RETENTION)
      .run()
  }

  async listAudit(limit = 30): Promise<PasswordAuditEntry[]> {
    const capped = Math.min(Math.max(limit, 1), 100)
    const { results } = await this.db
      .prepare(
        `SELECT id, action, detail, created_at
         FROM tools_password_audit
         WHERE user_id = ?1
         ORDER BY created_at DESC
         LIMIT ?2`,
      )
      .bind(this.userId, capped)
      .all<{ id: string; action: string; detail: string; created_at: number }>()

    return (results ?? []).map((row) => {
      let detail: Record<string, unknown> = {}
      if (row.detail) {
        try {
          detail = JSON.parse(row.detail) as Record<string, unknown>
        } catch {
          detail = {}
        }
      }
      return { id: row.id, action: row.action, detail, createdAt: row.created_at }
    })
  }

  // ---------------------------------------------------------------- Backups
  async getBackups(): Promise<PasswordBackupRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, user_id, filename, r2_key, size, type, created_at
         FROM tools_password_backups
         WHERE user_id = ?1
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .bind(this.userId)
      .all<BackupRow>()

    return (results ?? []).map((row) => ({
      id: row.id,
      userId: row.user_id,
      filename: row.filename,
      r2Key: row.r2_key,
      size: row.size,
      type: row.type as 'auto' | 'manual',
      createdAt: row.created_at,
    }))
  }

  async getBackupRecord(id: string): Promise<PasswordBackupRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, filename, r2_key, size, type, created_at
         FROM tools_password_backups
         WHERE user_id = ?1 AND id = ?2`,
      )
      .bind(this.userId, id)
      .first<BackupRow>()

    if (!row) return null
    return {
      id: row.id,
      userId: row.user_id,
      filename: row.filename,
      r2Key: row.r2_key,
      size: row.size,
      type: row.type as 'auto' | 'manual',
      createdAt: row.created_at,
    }
  }

  /**
   * Drops the snapshots past the retention limit and returns their R2 keys so the route can delete
   * the objects. Snapshots used to accumulate one per click, forever.
   */
  async pruneBackups(): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, r2_key FROM tools_password_backups
         WHERE user_id = ?1
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(this.userId)
      .all<{ id: string; r2_key: string }>()

    const stale = (results ?? []).slice(BACKUP_RETENTION)
    if (stale.length === 0) return []

    await runBatched(
      this.db,
      stale.map((row) =>
        this.db
          .prepare(`DELETE FROM tools_password_backups WHERE user_id = ?1 AND id = ?2`)
          .bind(this.userId, row.id),
      ),
    )
    return stale.map((row) => row.r2_key)
  }

  async addBackupRecord(record: {
    id?: string
    filename: string
    r2Key: string
    size: number
    type: 'auto' | 'manual'
  }): Promise<PasswordBackupRecord> {
    const id = record.id || crypto.randomUUID()
    const now = Date.now()

    await this.db
      .prepare(
        `INSERT INTO tools_password_backups (user_id, id, filename, r2_key, size, type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(this.userId, id, record.filename, record.r2Key, record.size, record.type, now)
      .run()

    return {
      id,
      userId: this.userId,
      filename: record.filename,
      r2Key: record.r2Key,
      size: record.size,
      type: record.type,
      createdAt: now,
    }
  }

  async deleteBackupRecord(id: string): Promise<PasswordBackupRecord | null> {
    const record = await this.getBackupRecord(id)
    if (!record) return null

    await this.db
      .prepare(`DELETE FROM tools_password_backups WHERE user_id = ?1 AND id = ?2`)
      .bind(this.userId, id)
      .run()

    return record
  }

  async getAllData(): Promise<{ groups: PasswordGroup[]; accounts: PasswordAccount[] }> {
    const [groups, accounts] = await Promise.all([
      this.getGroups(),
      this.getAccounts(),
    ])
    return { groups, accounts }
  }

  /**
   * Replaces the vault with a validated backup.
   *
   * Two write plans, because D1 cannot hold an interactive transaction:
   * - a small backup is written as one `batch` (deletes and inserts together, applied atomically);
   * - a large backup upserts every row first and only then drops rows the backup does not contain.
   *   A failure half way therefore never leaves the vault empty, and the pre-restore snapshot is
   *   written back before the error leaves the request.
   */
  async restoreData(data: { groups: PasswordGroup[]; accounts: PasswordAccount[] }): Promise<void> {
    assertRestorableBackup(data)

    const snapshot = await this.getAllData()
    const statements = this.buildReplaceStatements(data)

    if (statements.length <= STATEMENT_CHUNK) {
      await this.db.batch(statements)
      return
    }

    try {
      await runBatched(this.db, this.buildUpsertStatements(data))
      await this.deleteRowsMissingFrom(data, snapshot)
    } catch (error) {
      try {
        await runBatched(this.db, this.buildReplaceStatements(snapshot))
      } catch (rollbackError) {
        throw new ApiError(
          500,
          'restore_rollback_failed',
          `Restore failed and the previous rows could not be written back: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
          { cause: error },
        )
      }
      throw error
    }
  }

  private buildReplaceStatements(data: {
    groups: PasswordGroup[]
    accounts: PasswordAccount[]
  }): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`DELETE FROM tools_password_accounts WHERE user_id = ?1`).bind(this.userId),
      this.db.prepare(`DELETE FROM tools_password_groups WHERE user_id = ?1`).bind(this.userId),
    ]
    for (const group of data.groups) statements.push(this.bindGroupInsert(group))
    for (const account of data.accounts) statements.push(this.bindAccountInsert(account))
    return statements
  }

  /**
   * The large-backup plan: every row is written with `ON CONFLICT DO UPDATE`, so existing rows are
   * replaced in place and no delete happens until all inserts have landed.
   */
  private buildUpsertStatements(data: {
    groups: PasswordGroup[]
    accounts: PasswordAccount[]
  }): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = []
    for (const group of data.groups) statements.push(this.bindGroupInsert(group, true))
    for (const account of data.accounts) statements.push(this.bindAccountInsert(account, true))
    return statements
  }

  private bindGroupInsert(group: PasswordGroup, upsert = false): D1PreparedStatement {
    const conflict = upsert
      ? ` ON CONFLICT(user_id, id) DO UPDATE SET
            name = excluded.name,
            parent_id = excluded.parent_id,
            icon = excluded.icon,
            sort = excluded.sort,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`
      : ''
    return this.db
      .prepare(
        `INSERT INTO tools_password_groups (user_id, id, name, parent_id, icon, sort, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)${conflict}`,
      )
      .bind(
        this.userId,
        group.id,
        group.name,
        group.parentId ?? '',
        group.icon ?? '',
        group.sort ?? 0,
        group.createdAt || Date.now(),
        group.updatedAt || Date.now(),
      )
  }

  private bindAccountInsert(account: PasswordAccount, upsert = false): D1PreparedStatement {
    const conflict = upsert
      ? ` ON CONFLICT(user_id, id) DO UPDATE SET
            group_id = excluded.group_id,
            title = excluded.title,
            username = excluded.username,
            password = excluded.password,
            link = excluded.link,
            remark = excluded.remark,
            totp_secret = excluded.totp_secret,
            is_favorite = excluded.is_favorite,
            sort = excluded.sort,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at`
      : ''
    return this.db
      .prepare(
        `INSERT INTO tools_password_accounts (
           user_id, id, group_id, title, username, password, link, remark, totp_secret, is_favorite, sort, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)${conflict}`,
      )
      .bind(
        this.userId,
        account.id,
        account.groupId,
        account.title ?? '',
        account.username ?? '',
        account.password ?? '',
        account.link ?? '',
        account.remark ?? '',
        account.totpSecret ?? '',
        account.isFavorite ? 1 : 0,
        account.sort ?? 0,
        account.createdAt || Date.now(),
        account.updatedAt || Date.now(),
      )
  }

  /**
   * Drops rows that are not in the backup. Only runs after every insert succeeded, so a failure here
   * leaves a superset of the backup rather than an empty vault.
   */
  private async deleteRowsMissingFrom(
    data: { groups: PasswordGroup[]; accounts: PasswordAccount[] },
    snapshot: { groups: PasswordGroup[]; accounts: PasswordAccount[] },
  ): Promise<void> {
    const groupIds = new Set(data.groups.map((group) => group.id))
    const accountIds = new Set(data.accounts.map((account) => account.id))
    const statements: D1PreparedStatement[] = []

    for (const group of snapshot.groups) {
      if (!groupIds.has(group.id)) {
        statements.push(
          this.db
            .prepare(`DELETE FROM tools_password_accounts WHERE user_id = ?1 AND group_id = ?2`)
            .bind(this.userId, group.id),
        )
        statements.push(
          this.db
            .prepare(`DELETE FROM tools_password_groups WHERE user_id = ?1 AND id = ?2`)
            .bind(this.userId, group.id),
        )
      }
    }
    for (const account of snapshot.accounts) {
      if (!accountIds.has(account.id)) {
        statements.push(
          this.db
            .prepare(`DELETE FROM tools_password_accounts WHERE user_id = ?1 AND id = ?2`)
            .bind(this.userId, account.id),
        )
      }
    }

    if (statements.length > 0) await runBatched(this.db, statements)
  }
}

const RESTORE_MAX_GROUPS = 5000
const RESTORE_MAX_ACCOUNTS = 20000
const RESTORE_FIELD_MAX = 8000
const RESTORE_ID_MAX = 128

function invalidRestore(message: string): never {
  throw ApiError.badRequest(message)
}

function requireFieldString(value: unknown, field: string, max = RESTORE_FIELD_MAX): string {
  if (typeof value !== 'string' || value.length > max) {
    invalidRestore(`${field} must be a string of at most ${max} characters`)
  }
  return value
}

/**
 * Validates a backup before a single row is written. The previous flow deleted first and validated
 * (partly) later, so a duplicate id or a dangling group turned into a wiped vault.
 */
export function assertRestorableBackup(data: {
  groups: PasswordGroup[]
  accounts: PasswordAccount[]
}): void {
  if (!Array.isArray(data.groups) || !Array.isArray(data.accounts)) {
    invalidRestore('Backup must contain groups and accounts arrays')
  }
  if (data.groups.length > RESTORE_MAX_GROUPS) {
    invalidRestore(`Backup has more than ${RESTORE_MAX_GROUPS} groups`)
  }
  if (data.accounts.length > RESTORE_MAX_ACCOUNTS) {
    invalidRestore(`Backup has more than ${RESTORE_MAX_ACCOUNTS} accounts`)
  }

  const groupIds = new Set<string>()
  for (const group of data.groups) {
    if (typeof group.id !== 'string' || !group.id || group.id.length > RESTORE_ID_MAX) {
      invalidRestore('Every group needs an id of at most 128 characters')
    }
    if (groupIds.has(group.id)) invalidRestore(`Duplicate group id ${group.id}`)
    groupIds.add(group.id)
    requireFieldString(group.name, `Group ${group.id} name`, 100)
    requireFieldString(group.parentId ?? '', `Group ${group.id} parentId`, RESTORE_ID_MAX)
    requireFieldString(group.icon ?? '', `Group ${group.id} icon`, 64)
    if (!Number.isFinite(group.sort)) invalidRestore(`Group ${group.id} sort must be a number`)
  }

  for (const group of data.groups) {
    if (group.parentId && !groupIds.has(group.parentId)) {
      invalidRestore(`Group ${group.id} points at a missing parent`)
    }
    if (group.parentId === group.id) invalidRestore(`Group ${group.id} is its own parent`)

    const seen = new Set<string>([group.id])
    let parentId = group.parentId
    while (parentId) {
      if (seen.has(parentId)) invalidRestore(`Group ${group.id} is part of a parent cycle`)
      seen.add(parentId)
      parentId = data.groups.find((candidate) => candidate.id === parentId)?.parentId ?? ''
    }
  }

  const accountIds = new Set<string>()
  for (const account of data.accounts) {
    if (typeof account.id !== 'string' || !account.id || account.id.length > RESTORE_ID_MAX) {
      invalidRestore('Every account needs an id of at most 128 characters')
    }
    if (accountIds.has(account.id)) invalidRestore(`Duplicate account id ${account.id}`)
    accountIds.add(account.id)
    if (!groupIds.has(account.groupId)) {
      invalidRestore(`Account ${account.id} belongs to a missing group`)
    }
    requireFieldString(account.title ?? '', `Account ${account.id} title`)
    requireFieldString(account.username ?? '', `Account ${account.id} username`)
    requireFieldString(account.password ?? '', `Account ${account.id} password`)
    requireFieldString(account.link ?? '', `Account ${account.id} link`)
    requireFieldString(account.remark ?? '', `Account ${account.id} remark`)
    requireFieldString(account.totpSecret ?? '', `Account ${account.id} totpSecret`)
    if (!Number.isFinite(account.sort)) invalidRestore(`Account ${account.id} sort must be a number`)
    if (!Number.isFinite(account.createdAt) || !Number.isFinite(account.updatedAt)) {
      invalidRestore(`Account ${account.id} timestamps must be numbers`)
    }
  }
}
