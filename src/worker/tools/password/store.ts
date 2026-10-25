/**
 * Database store for the Password Manager submodule under Tools.
 *
 * All operations are strictly tenant-isolated using `user_id = ?1` as the primary dimension.
 */

import type {
  PasswordAccount,
  PasswordBackupRecord,
  PasswordGroup,
  PasswordSettings,
  PasswordVaultState,
} from '@shared/tools/password/types'
import { ApiError } from '../../lib/errors'

interface VaultRow {
  user_id: string
  master_hash: string
  recovery_hint: string
  created_at: number
  updated_at: number
}

interface GroupRow {
  user_id: string
  id: string
  name: string
  parent_id: string
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
  favicon: string
  is_favorite: number
  sort: number
  created_at: number
  updated_at: number
}

interface SettingsRow {
  user_id: string
  webdav_url: string
  webdav_username: string
  webdav_password: string
  webdav_enabled: number
  auto_backup_enabled: number
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

function toGroup(row: GroupRow): PasswordGroup {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    parentId: row.parent_id,
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
    favicon: row.favicon,
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
  async getVaultState(): Promise<PasswordVaultState> {
    const row = await this.db
      .prepare(`SELECT recovery_hint, created_at, updated_at FROM tools_password_vault WHERE user_id = ?1`)
      .bind(this.userId)
      .first<Pick<VaultRow, 'recovery_hint' | 'created_at' | 'updated_at'>>()

    if (!row) {
      return { hasVault: false }
    }
    return {
      hasVault: true,
      recoveryHint: row.recovery_hint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async getVault(): Promise<{ masterHash: string; recoveryHint: string; createdAt: number; updatedAt: number } | null> {
    const row = await this.db
      .prepare(`SELECT master_hash, recovery_hint, created_at, updated_at FROM tools_password_vault WHERE user_id = ?1`)
      .bind(this.userId)
      .first<VaultRow>()

    if (!row) return null
    return {
      masterHash: row.master_hash,
      recoveryHint: row.recovery_hint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async initVault(masterHash: string, recoveryHint: string): Promise<PasswordVaultState> {
    const existing = await this.getVaultState()
    if (existing.hasVault) {
      throw ApiError.badRequest('Vault is already initialized')
    }

    const now = Date.now()
    await this.db
      .prepare(
        `INSERT INTO tools_password_vault (user_id, master_hash, recovery_hint, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(this.userId, masterHash, recoveryHint, now, now)
      .run()

    return {
      hasVault: true,
      recoveryHint,
      createdAt: now,
      updatedAt: now,
    }
  }

  async resetMasterPassword(
    newMasterHash: string,
    newRecoveryHint: string,
    accounts: Array<{
      id: string
      title: string
      username: string
      password: string
      link?: string
      remark?: string
    }>,
  ): Promise<void> {
    const existing = await this.getVaultState()
    if (!existing.hasVault) {
      throw ApiError.badRequest('Vault is not initialized')
    }

    const now = Date.now()
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE tools_password_vault SET master_hash = ?1, recovery_hint = ?2, updated_at = ?3
           WHERE user_id = ?4`,
        )
        .bind(newMasterHash, newRecoveryHint, now, this.userId),
    ]

    for (const acc of accounts) {
      statements.push(
        this.db
          .prepare(
            `UPDATE tools_password_accounts
             SET title = ?1, username = ?2, password = ?3, link = ?4, remark = ?5, updated_at = ?6
             WHERE user_id = ?7 AND id = ?8`,
          )
          .bind(acc.title, acc.username, acc.password, acc.link ?? '', acc.remark ?? '', now, this.userId, acc.id),
      )
    }

    await this.db.batch(statements)
  }

  // ---------------------------------------------------------------- Groups
  async getGroups(): Promise<PasswordGroup[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, user_id, name, parent_id, sort, created_at, updated_at
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
        `SELECT id, user_id, name, parent_id, sort, created_at, updated_at
         FROM tools_password_groups
         WHERE user_id = ?1 AND id = ?2`,
      )
      .bind(this.userId, id)
      .first<GroupRow>()

    return row ? toGroup(row) : null
  }

  async createGroup(data: { id?: string; name: string; parentId?: string; sort?: number }): Promise<PasswordGroup> {
    const id = data.id || crypto.randomUUID()
    const parentId = data.parentId ?? ''
    const sort = data.sort ?? 0
    const now = Date.now()

    await this.db
      .prepare(
        `INSERT INTO tools_password_groups (user_id, id, name, parent_id, sort, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(this.userId, id, data.name, parentId, sort, now, now)
      .run()

    return {
      id,
      userId: this.userId,
      name: data.name,
      parentId,
      sort,
      createdAt: now,
      updatedAt: now,
    }
  }

  async updateGroup(id: string, data: { name?: string; parentId?: string; sort?: number }): Promise<PasswordGroup> {
    const existing = await this.getGroup(id)
    if (!existing) {
      throw ApiError.notFound('Group not found')
    }

    const name = data.name !== undefined ? data.name : existing.name
    const parentId = data.parentId !== undefined ? data.parentId : existing.parentId
    const sort = data.sort !== undefined ? data.sort : existing.sort
    const now = Date.now()

    await this.db
      .prepare(
        `UPDATE tools_password_groups
         SET name = ?1, parent_id = ?2, sort = ?3, updated_at = ?4
         WHERE user_id = ?5 AND id = ?6`,
      )
      .bind(name, parentId, sort, now, this.userId, id)
      .run()

    return {
      ...existing,
      name,
      parentId,
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

  async reorderGroups(groups: Array<{ id: string; parentId?: string; sort: number }>): Promise<void> {
    if (groups.length === 0) return
    const now = Date.now()
    const statements = groups.map((g) =>
      this.db
        .prepare(
          `UPDATE tools_password_groups
           SET parent_id = ?1, sort = ?2, updated_at = ?3
           WHERE user_id = ?4 AND id = ?5`,
        )
        .bind(g.parentId ?? '', g.sort, now, this.userId, g.id),
    )
    await this.db.batch(statements)
  }

  // ---------------------------------------------------------------- Accounts
  async getAccounts(groupId?: string): Promise<PasswordAccount[]> {
    if (groupId) {
      const { results } = await this.db
        .prepare(
          `SELECT id, user_id, group_id, title, username, password, link, remark, favicon, is_favorite, sort, created_at, updated_at
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
        `SELECT id, user_id, group_id, title, username, password, link, remark, favicon, is_favorite, sort, created_at, updated_at
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
        `SELECT id, user_id, group_id, title, username, password, link, remark, favicon, is_favorite, sort, created_at, updated_at
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
    favicon?: string
    isFavorite?: boolean
    sort?: number
  }): Promise<PasswordAccount> {
    const id = data.id || crypto.randomUUID()
    const title = data.title ?? ''
    const username = data.username ?? ''
    const password = data.password ?? ''
    const link = data.link ?? ''
    const remark = data.remark ?? ''
    const favicon = data.favicon ?? ''
    const isFavorite = data.isFavorite ? 1 : 0
    const sort = data.sort ?? 0
    const now = Date.now()

    await this.db
      .prepare(
        `INSERT INTO tools_password_accounts (
           user_id, id, group_id, title, username, password, link, remark, favicon, is_favorite, sort, created_at, updated_at
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
        favicon,
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
      favicon,
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
      favicon?: string
      isFavorite?: boolean
      sort?: number
    },
  ): Promise<PasswordAccount> {
    const existing = await this.getAccount(id)
    if (!existing) {
      throw ApiError.notFound('Account not found')
    }

    const groupId = data.groupId !== undefined ? data.groupId : existing.groupId
    const title = data.title !== undefined ? data.title : existing.title
    const username = data.username !== undefined ? data.username : existing.username
    const password = data.password !== undefined ? data.password : existing.password
    const link = data.link !== undefined ? data.link : existing.link
    const remark = data.remark !== undefined ? data.remark : existing.remark
    const favicon = data.favicon !== undefined ? data.favicon : existing.favicon
    const isFavorite = data.isFavorite !== undefined ? (data.isFavorite ? 1 : 0) : (existing.isFavorite ? 1 : 0)
    const sort = data.sort !== undefined ? data.sort : existing.sort
    const now = Date.now()

    await this.db
      .prepare(
        `UPDATE tools_password_accounts
         SET group_id = ?1, title = ?2, username = ?3, password = ?4, link = ?5, remark = ?6,
             favicon = ?7, is_favorite = ?8, sort = ?9, updated_at = ?10
         WHERE user_id = ?11 AND id = ?12`,
      )
      .bind(
        groupId,
        title,
        username,
        password,
        link,
        remark,
        favicon,
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
      favicon,
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
    await this.db.batch(statements)
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
    await this.db.batch(statements)
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
    await this.db.batch(statements)
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
      favicon?: string
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
      const favicon = item.favicon ?? ''
      const sort = item.sort ?? i

      statements.push(
        this.db
          .prepare(
            `INSERT INTO tools_password_accounts (
               user_id, id, group_id, title, username, password, link, remark, favicon, is_favorite, sort, created_at, updated_at
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
            favicon,
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
        favicon,
        isFavorite: false,
        sort,
        createdAt: now,
        updatedAt: now,
      })
    }

    if (statements.length > 0) {
      await this.db.batch(statements)
    }

    return created
  }

  // ---------------------------------------------------------------- Settings
  async getSettings(): Promise<PasswordSettings> {
    const row = await this.db
      .prepare(
        `SELECT webdav_url, webdav_username, webdav_password, webdav_enabled, auto_backup_enabled, auto_lock_minutes, updated_at
         FROM tools_password_settings
         WHERE user_id = ?1`,
      )
      .bind(this.userId)
      .first<SettingsRow>()

    if (!row) {
      return {
        webdav: {
          url: '',
          username: '',
          password: '',
          enabled: false,
        },
        autoBackupEnabled: true,
        autoLockMinutes: 5,
        updatedAt: 0,
      }
    }

    return {
      webdav: {
        url: row.webdav_url,
        username: row.webdav_username,
        password: row.webdav_password,
        enabled: Boolean(row.webdav_enabled),
      },
      autoBackupEnabled: Boolean(row.auto_backup_enabled),
      autoLockMinutes: row.auto_lock_minutes,
      updatedAt: row.updated_at,
    }
  }

  async saveSettings(data: {
    webdavUrl?: string
    webdavUsername?: string
    webdavPassword?: string
    webdavEnabled?: boolean
    autoBackupEnabled?: boolean
    autoLockMinutes?: number
  }): Promise<PasswordSettings> {
    const current = await this.getSettings()
    const webdavUrl = data.webdavUrl !== undefined ? data.webdavUrl : current.webdav.url
    const webdavUsername = data.webdavUsername !== undefined ? data.webdavUsername : current.webdav.username
    const webdavPassword = data.webdavPassword !== undefined ? data.webdavPassword : (current.webdav.password ?? '')
    const webdavEnabled = data.webdavEnabled !== undefined ? (data.webdavEnabled ? 1 : 0) : (current.webdav.enabled ? 1 : 0)
    const autoBackupEnabled = data.autoBackupEnabled !== undefined ? (data.autoBackupEnabled ? 1 : 0) : (current.autoBackupEnabled ? 1 : 0)
    const autoLockMinutes = data.autoLockMinutes !== undefined ? data.autoLockMinutes : current.autoLockMinutes
    const now = Date.now()

    await this.db
      .prepare(
        `INSERT INTO tools_password_settings (
           user_id, webdav_url, webdav_username, webdav_password, webdav_enabled, auto_backup_enabled, auto_lock_minutes, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(user_id) DO UPDATE SET
           webdav_url = excluded.webdav_url,
           webdav_username = excluded.webdav_username,
           webdav_password = excluded.webdav_password,
           webdav_enabled = excluded.webdav_enabled,
           auto_backup_enabled = excluded.auto_backup_enabled,
           auto_lock_minutes = excluded.auto_lock_minutes,
           updated_at = excluded.updated_at`,
      )
      .bind(
        this.userId,
        webdavUrl,
        webdavUsername,
        webdavPassword,
        webdavEnabled,
        autoBackupEnabled,
        autoLockMinutes,
        now,
      )
      .run()

    return {
      webdav: {
        url: webdavUrl,
        username: webdavUsername,
        password: webdavPassword,
        enabled: Boolean(webdavEnabled),
      },
      autoBackupEnabled: Boolean(autoBackupEnabled),
      autoLockMinutes,
      updatedAt: now,
    }
  }

  // ---------------------------------------------------------------- Backups
  async getBackups(): Promise<PasswordBackupRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, user_id, filename, r2_key, size, type, created_at
         FROM tools_password_backups
         WHERE user_id = ?1
         ORDER BY created_at DESC`,
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

  async restoreData(data: { groups: PasswordGroup[]; accounts: PasswordAccount[] }): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`DELETE FROM tools_password_accounts WHERE user_id = ?1`).bind(this.userId),
      this.db.prepare(`DELETE FROM tools_password_groups WHERE user_id = ?1`).bind(this.userId),
    ]

    for (const g of data.groups) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO tools_password_groups (user_id, id, name, parent_id, sort, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(this.userId, g.id, g.name, g.parentId ?? '', g.sort ?? 0, g.createdAt || Date.now(), g.updatedAt || Date.now()),
      )
    }

    for (const a of data.accounts) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO tools_password_accounts (
               user_id, id, group_id, title, username, password, link, remark, favicon, is_favorite, sort, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
          )
          .bind(
            this.userId,
            a.id,
            a.groupId,
            a.title ?? '',
            a.username ?? '',
            a.password ?? '',
            a.link ?? '',
            a.remark ?? '',
            a.favicon ?? '',
            a.isFavorite ? 1 : 0,
            a.sort ?? 0,
            a.createdAt || Date.now(),
            a.updatedAt || Date.now(),
          ),
      )
    }

    await this.db.batch(statements)
  }
}
