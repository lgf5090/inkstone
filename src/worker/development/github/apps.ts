import { MAX_TRACKED_APPS } from '@shared/development/github/limits'
import type { GithubAssetPlatform, GithubTrackedApp } from '@shared/development/github/types'
import { ApiError } from '../../lib/errors'

interface AppRow {
  id: string
  repo_id: string
  full_name: string
  repo_url: string
  owner_avatar_url: string
  platform: string
  asset_pattern: string
  installed_tag: string
  installed_at: number
  latest_tag: string
  latest_asset_name: string
  latest_asset_url: string
  latest_published_at: string
  checked_at: number
  created_at: number
  updated_at: number
}

export interface TrackedAppUpsert {
  id: string
  repoId: string
  fullName: string
  repoUrl: string
  ownerAvatarUrl: string
  platform: GithubAssetPlatform
  assetPattern: string
  installedTag: string
  installedAt?: number
}

export interface TrackedAppCheckPatch {
  latestTag: string
  latestAssetName: string
  latestAssetUrl: string
  latestPublishedAt: string
  checkedAt: number
}

const APP_COLUMNS = `id, repo_id, full_name, repo_url, owner_avatar_url, platform, asset_pattern,
  installed_tag, installed_at, latest_tag, latest_asset_name, latest_asset_url, latest_published_at,
  checked_at, created_at, updated_at`

function toApp(row: AppRow): GithubTrackedApp {
  return {
    id: row.id,
    repoId: row.repo_id,
    fullName: row.full_name,
    repoUrl: row.repo_url,
    ownerAvatarUrl: row.owner_avatar_url,
    platform: row.platform as GithubAssetPlatform,
    assetPattern: row.asset_pattern,
    installedTag: row.installed_tag,
    installedAt: row.installed_at,
    latestTag: row.latest_tag,
    latestAssetName: row.latest_asset_name,
    latestAssetUrl: row.latest_asset_url,
    latestPublishedAt: row.latest_published_at,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listApps(db: D1Database, userId: string): Promise<GithubTrackedApp[]> {
  const { results } = await db
    .prepare(
      `SELECT ${APP_COLUMNS} FROM development_github_tracked_apps
        WHERE user_id = ?1
        ORDER BY updated_at DESC`,
    )
    .bind(userId)
    .all<AppRow>()
  return results.map(toApp)
}

export async function findApp(
  db: D1Database,
  userId: string,
  id: string,
): Promise<GithubTrackedApp | null> {
  const row = await db
    .prepare(`SELECT ${APP_COLUMNS} FROM development_github_tracked_apps WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, id)
    .first<AppRow>()
  return row ? toApp(row) : null
}

export async function countApps(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM development_github_tracked_apps WHERE user_id = ?1')
    .bind(userId)
    .first<{ count: number }>()
  return Number(row?.count ?? 0)
}

export async function upsertApp(
  db: D1Database,
  userId: string,
  input: TrackedAppUpsert,
): Promise<GithubTrackedApp> {
  const existing = await findApp(db, userId, input.id)
  if (!existing && (await countApps(db, userId)) >= MAX_TRACKED_APPS) {
    throw ApiError.badRequest(`Tracked apps are limited to ${MAX_TRACKED_APPS} per account`)
  }
  const now = Date.now()
  const createdAt = existing?.createdAt ?? now
  const installedAt = input.installedAt ?? existing?.installedAt ?? now
  await db
    .prepare(
      `INSERT INTO development_github_tracked_apps
         (user_id, id, repo_id, full_name, repo_url, owner_avatar_url, platform, asset_pattern,
          installed_tag, installed_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT (user_id, id) DO UPDATE SET
         repo_id = excluded.repo_id,
         full_name = excluded.full_name,
         repo_url = excluded.repo_url,
         owner_avatar_url = excluded.owner_avatar_url,
         platform = excluded.platform,
         asset_pattern = excluded.asset_pattern,
         installed_tag = excluded.installed_tag,
         installed_at = excluded.installed_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      input.id,
      input.repoId,
      input.fullName,
      input.repoUrl,
      input.ownerAvatarUrl,
      input.platform,
      input.assetPattern,
      input.installedTag,
      installedAt,
      createdAt,
      now,
    )
    .run()
  return {
    id: input.id,
    repoId: input.repoId,
    fullName: input.fullName,
    repoUrl: input.repoUrl,
    ownerAvatarUrl: input.ownerAvatarUrl,
    platform: input.platform,
    assetPattern: input.assetPattern,
    installedTag: input.installedTag,
    installedAt,
    latestTag: existing?.latestTag ?? '',
    latestAssetName: existing?.latestAssetName ?? '',
    latestAssetUrl: existing?.latestAssetUrl ?? '',
    latestPublishedAt: existing?.latestPublishedAt ?? '',
    checkedAt: existing?.checkedAt ?? 0,
    createdAt,
    updatedAt: now,
  }
}

export async function deleteApp(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM development_github_tracked_apps WHERE user_id = ?1 AND id = ?2')
    .bind(userId, id)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function recordAppCheck(
  db: D1Database,
  userId: string,
  id: string,
  patch: TrackedAppCheckPatch,
): Promise<GithubTrackedApp | null> {
  const now = Date.now()
  await db
    .prepare(
      `UPDATE development_github_tracked_apps SET
         latest_tag = ?3,
         latest_asset_name = ?4,
         latest_asset_url = ?5,
         latest_published_at = ?6,
         checked_at = ?7,
         updated_at = ?8
       WHERE user_id = ?1 AND id = ?2`,
    )
    .bind(
      userId,
      id,
      patch.latestTag,
      patch.latestAssetName,
      patch.latestAssetUrl,
      patch.latestPublishedAt,
      patch.checkedAt,
      now,
    )
    .run()
  return findApp(db, userId, id)
}
