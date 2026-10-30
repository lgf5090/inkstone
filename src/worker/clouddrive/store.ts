import { parseCloudDriveSettings, type CloudDriveSettings } from '@shared/clouddrive/settings'
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

export async function readCloudDriveSettings(db: D1Database, userId: string): Promise<CloudDriveSettings> {
  const { results } = await db.prepare(
    `SELECT key, value FROM CloudDrive_settings WHERE user_id = ?1`,
  ).bind(userId).all<{ key: string; value: string }>()
  const rows: Record<string, string> = {}
  for (const row of results ?? []) rows[row.key] = row.value
  return parseCloudDriveSettings(rows)
}

export async function cloudDriveUsage(db: D1Database, userId: string, env: Env): Promise<CloudDriveUsage> {
  const live = await db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS bytes FROM (
       SELECT storage_key, MAX(size) AS size FROM CloudDrive_files
        WHERE user_id = ?1 AND storage_key IS NOT NULL AND deleted_at IS NULL
        GROUP BY storage_key
     )`,
  ).bind(userId).first<{ bytes: number }>()
  const trash = await db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS bytes FROM (
       SELECT storage_key, MAX(size) AS size FROM CloudDrive_files
        WHERE user_id = ?1 AND storage_key IS NOT NULL AND deleted_at IS NOT NULL
        GROUP BY storage_key
     )`,
  ).bind(userId).first<{ bytes: number }>()
  const [liveParts, trashParts] = await Promise.all([
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
    quotaBytes: settings.quotaDefaultBytes,
    primaryAvailable: Boolean(env.FILES),
  }
}
