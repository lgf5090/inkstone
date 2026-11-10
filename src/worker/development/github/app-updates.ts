import { GITHUB_DETAIL_TIMEOUT_MS } from '@shared/development/github/limits'
import { pickReleaseAsset } from '@shared/development/github/platforms'
import type { GithubTrackedApp } from '@shared/development/github/types'
import { ApiError } from '../../lib/errors'
import type { TrackedAppCheckPatch } from './apps'
import { githubJson } from './github-http'
import { normalizeLatestStableRelease } from './github-repos'

export interface AppCheckOutcome {
  id: string
  patch: TrackedAppCheckPatch | null
  error: ApiError | null
}

async function checkOne(app: GithubTrackedApp, token: string | null): Promise<AppCheckOutcome> {
  const parts = app.fullName.split('/')
  if (parts.length !== 2) {
    return { id: app.id, patch: null, error: ApiError.badRequest('A tracked app needs a valid repository name') }
  }
  try {
    const { data } = await githubJson<unknown[]>(
      `/repos/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}/releases?per_page=10`,
      { token, timeoutMs: GITHUB_DETAIL_TIMEOUT_MS },
    )
    const release = normalizeLatestStableRelease(Array.isArray(data) ? data : [])
    if (!release) {
      return { id: app.id, patch: null, error: new ApiError(404, 'github_not_found', 'This repository has no stable release') }
    }
    const asset = pickReleaseAsset(release.assets, app.platform, app.assetPattern)
    return {
      id: app.id,
      patch: {
        latestTag: release.tagName,
        latestAssetName: asset?.name ?? '',
        latestAssetUrl: asset?.downloadUrl ?? '',
        latestPublishedAt: release.publishedAt,
        checkedAt: Date.now(),
      },
      error: null,
    }
  } catch (error) {
    if (error instanceof ApiError) return { id: app.id, patch: null, error }
    return { id: app.id, patch: null, error: new ApiError(502, 'github_upstream', 'The update check failed') }
  }
}

export async function checkAppUpdates(
  apps: readonly GithubTrackedApp[],
  token: string | null,
  limit = 4,
): Promise<AppCheckOutcome[]> {
  const results = new Array<AppCheckOutcome>(apps.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, apps.length) }, async () => {
    while (cursor < apps.length) {
      const index = cursor
      cursor += 1
      results[index] = await checkOne(apps[index]!, token)
    }
  })
  await Promise.all(workers)
  return results
}
