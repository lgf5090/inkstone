import type { CloudDrivePublicSettings } from '@shared/clouddrive/settings'

const CONFIG_BACKUP_VERSION = 1

export async function buildCloudDriveConfigBackup(
  db: D1Database,
  userId: string,
  settings: CloudDrivePublicSettings,
): Promise<Record<string, unknown>> {
  const [storages, mounts, shares, syncTargets, requests, apiKeys, meta, tags] = await Promise.all([
    db.prepare(
      `SELECT id, name, type, config, status, is_default, api_key_visible, read_quota,
              default_path, last_used_at, last_test_at, last_test_status, created_at, updated_at
         FROM CloudDrive_storages WHERE user_id = ? ORDER BY created_at, id`,
    ).bind(userId).all(),
    db.prepare(
      `SELECT id, storage_id, name, mount_path, read_only, cache_ttl, web_proxy, webdav_policy,
              sign_expires, weight, sort_order, enabled, remark, folder_summary, created_at, updated_at
         FROM CloudDrive_mounts WHERE user_id = ? ORDER BY sort_order, created_at, id`,
    ).bind(userId).all(),
    db.prepare(
      `SELECT slug, target_kind, file_id, mount_id, path, name, size, mime, expires_at,
              max_views, max_downloads, allow_download, allow_list, is_enabled, created_at, revoked_at
         FROM CloudDrive_shares WHERE user_id = ? ORDER BY created_at DESC`,
    ).bind(userId).all(),
    db.prepare(
      `SELECT id, name, local_label, mount_id, remote_path, enabled, created_at, updated_at
         FROM CloudDrive_sync_targets WHERE user_id = ? ORDER BY created_at DESC`,
    ).bind(userId).all(),
    db.prepare(
      `SELECT slug, target_mount, target_path, name, expires_at, max_files, max_bytes,
              max_file_bytes, received_files, received_bytes, is_enabled, created_at, revoked_at
         FROM CloudDrive_file_requests WHERE user_id = ? ORDER BY created_at DESC`,
    ).bind(userId).all(),
    db.prepare(
      `SELECT id, name, scopes, path_prefix, expires_at, created_at, revoked_at
         FROM CloudDrive_api_keys WHERE user_id = ? ORDER BY created_at DESC`,
    ).bind(userId).all(),
    db.prepare(
      `SELECT mount_id, path, header_md, footer_md, hide_patterns, inherit_header,
              inherit_footer, inherit_hide, inherit_password, vault, created_at, updated_at
         FROM CloudDrive_meta WHERE user_id = ? ORDER BY mount_id, path`,
    ).bind(userId).all(),
    db.prepare(
      `SELECT t.file_id, f.path, t.tag, t.tag_folded, t.color, t.created_at
         FROM CloudDrive_file_tags t
         JOIN CloudDrive_files f ON f.user_id = t.user_id AND f.id = t.file_id
        WHERE t.user_id = ? ORDER BY t.created_at DESC`,
    ).bind(userId).all(),
  ])

  return {
    version: CONFIG_BACKUP_VERSION,
    exportedAt: Date.now(),
    settings,
    storages: storages.results ?? [],
    mounts: mounts.results ?? [],
    shares: shares.results ?? [],
    syncTargets: syncTargets.results ?? [],
    requests: requests.results ?? [],
    apiKeys: apiKeys.results ?? [],
    meta: meta.results ?? [],
    tags: tags.results ?? [],
  }
}

export function cloudDriveConfigBackupFilename(at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `clouddrive-config-${stamp}.json`
}
