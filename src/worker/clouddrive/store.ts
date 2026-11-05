import { CLOUDDRIVE_POLICY_KEYS, parseCloudDriveSettings, type CloudDriveSettings } from '@shared/clouddrive/settings'
import type { CloudDriveMountSummary, CloudDriveUsage } from '@shared/clouddrive/model'
import type { Env } from '../env'

export const PRIMARY_MOUNT_ID = 'primary'

interface MountRow {
  id: string
  storage_id: string
  name: string
  mount_path: string
  read_only: number
  enabled: number
  folder_summary: number
}

export async function ensurePrimaryMount(db: D1Database, userId: string): Promise<void> {
  const now = Date.now()
  await db.prepare(
    `INSERT OR IGNORE INTO CloudDrive_mounts
       (user_id, id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy, weight, sort_order, enabled, created_at, updated_at)
     VALUES (?1, ?2, 'primary', 'Cloud Drive', '/', 0, 300, 0, 'native_proxy', 1, 0, 1, ?3, ?3)`,
  ).bind(userId, PRIMARY_MOUNT_ID, now).run()
}

export async function listMounts(db: D1Database, userId: string): Promise<CloudDriveMountSummary[]> {
  const { results } = await db.prepare(
    `SELECT id, storage_id, name, mount_path, read_only, enabled, folder_summary
       FROM CloudDrive_mounts WHERE user_id = ?1 ORDER BY sort_order, created_at, id`,
  ).bind(userId).all<MountRow>()
  const storageTypes = await storageTypeMap(db, userId)
  return (results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    mountPath: row.mount_path,
    storageId: row.storage_id,
    storageType: row.storage_id === 'primary' ? 'r2' : storageTypes.get(row.storage_id) ?? 'unknown',
    readOnly: row.read_only === 1,
    enabled: row.enabled === 1,
    online: row.storage_id === 'primary' ? true : storageTypes.has(row.storage_id),
    folderSummary: row.folder_summary === 1,
  }))
}

async function storageTypeMap(db: D1Database, userId: string): Promise<Map<string, string>> {
  const { results } = await db.prepare(
    `SELECT id, type FROM CloudDrive_storages WHERE user_id = ?1 AND status = 'enabled'`,
  ).bind(userId).all<{ id: string; type: string }>()
  return new Map((results ?? []).map((row) => [row.id, row.type]))
}

/**
 * Whose row the policy settings come from. The owner reads their own, a member reads the owner's, and
 * a deployment without a `users` row for either falls back to the caller so a single-user install
 * behaves exactly as it did when every setting was personal.
 */
export async function cloudDrivePolicyOwnerId(db: D1Database, userId: string): Promise<string> {
  const row = await db.prepare(
    `SELECT (SELECT id FROM users WHERE role = 'owner' ORDER BY created_at, id LIMIT 1) AS owner_id,
            (SELECT role FROM users WHERE id = ?1) AS role`,
  ).bind(userId).first<{ owner_id: string | null; role: string | null }>()
  return row?.role === 'owner' || !row?.owner_id ? userId : row.owner_id
}

export async function readCloudDriveSettings(db: D1Database, userId: string): Promise<CloudDriveSettings> {
  const ownerId = await cloudDrivePolicyOwnerId(db, userId)
  const { results } = await db.prepare(
    `SELECT key, value, user_id FROM CloudDrive_settings WHERE user_id IN (?1, ?2)`,
  ).bind(userId, ownerId).all<{ key: string; value: string; user_id: string }>()
  const rows: Record<string, string> = {}
  for (const row of results ?? []) {
    const ownerRow = row.user_id === ownerId
    if (CLOUDDRIVE_POLICY_KEYS.has(row.key) ? ownerRow : row.user_id === userId) rows[row.key] = row.value
  }
  return parseCloudDriveSettings(rows)
}

export async function cloudDriveUsage(db: D1Database, userId: string, env: Env): Promise<CloudDriveUsage> {
  // A stored version is bytes in the bucket just like the file it came from, so each side of the card
  // counts its file's versions too — otherwise a quota looks half empty while ten revisions sit in it.
  const [live, trash, liveParts, trashParts] = await Promise.all([
    db.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes FROM (
         SELECT storage_key, MAX(size) AS size FROM (
           SELECT storage_key, size FROM CloudDrive_files
            WHERE user_id = ?1 AND storage_key IS NOT NULL AND deleted_at IS NULL
           UNION ALL
           SELECT v.storage_key, v.size FROM CloudDrive_file_versions v
             JOIN CloudDrive_files f ON f.user_id = v.user_id AND f.id = v.file_id
            WHERE v.user_id = ?1 AND v.storage_key IS NOT NULL AND f.deleted_at IS NULL
         )
         GROUP BY storage_key
       )`,
    ).bind(userId).first<{ bytes: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes FROM (
         SELECT storage_key, MAX(size) AS size FROM (
           SELECT storage_key, size FROM CloudDrive_files
            WHERE user_id = ?1 AND storage_key IS NOT NULL AND deleted_at IS NOT NULL
           UNION ALL
           SELECT v.storage_key, v.size FROM CloudDrive_file_versions v
             JOIN CloudDrive_files f ON f.user_id = v.user_id AND f.id = v.file_id
            WHERE v.user_id = ?1 AND v.storage_key IS NOT NULL AND f.deleted_at IS NOT NULL
         )
         GROUP BY storage_key
       )`,
    ).bind(userId).first<{ bytes: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(p.size), 0) AS bytes FROM CloudDrive_file_parts p
        JOIN CloudDrive_files f ON f.user_id = p.user_id AND f.id = p.file_id
       WHERE p.user_id = ?1 AND p.mount_id = 'primary' AND f.deleted_at IS NULL`,
    ).bind(userId).first<{ bytes: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(p.size), 0) AS bytes FROM CloudDrive_file_parts p
        JOIN CloudDrive_files f ON f.user_id = p.user_id AND f.id = p.file_id
       WHERE p.user_id = ?1 AND p.mount_id = 'primary' AND f.deleted_at IS NOT NULL`,
    ).bind(userId).first<{ bytes: number }>(),
  ])
  const settings = await readCloudDriveSettings(db, userId)
  return {
    usedBytes: (live?.bytes ?? 0) + (liveParts?.bytes ?? 0),
    trashBytes: (trash?.bytes ?? 0) + (trashParts?.bytes ?? 0),
    // A deployment that does not enforce a quota can still publish a display ceiling; otherwise the
    // capacity card would read "unlimited" for every account on a quota-less install.
    quotaBytes: settings.quotaDefaultBytes ?? settings.storageDisplayQuotaBytes,
    primaryAvailable: Boolean(env.FILES),
  }
}
