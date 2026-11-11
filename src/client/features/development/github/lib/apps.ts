import { updateState } from '@shared/development/github/platforms'
import type { GithubAssetPlatform, GithubRepo, GithubTrackedApp, GithubUpdateState } from '@shared/development/github/types'

export interface TrackedAppStatus {
  state: GithubUpdateState
  hasAsset: boolean
  suppressed: 'ignored' | 'skipped' | null
}

export function buildTrackedApp(
  repo: GithubRepo,
  platform: GithubAssetPlatform,
  assetPattern: string,
  installedTag: string,
  now = Date.now(),
): GithubTrackedApp {
  return {
    id: `${repo.id}-${platform}`,
    repoId: String(repo.id),
    fullName: repo.fullName,
    repoUrl: repo.url,
    ownerAvatarUrl: repo.owner.avatarUrl,
    platform,
    assetPattern: assetPattern.trim(),
    installedTag: installedTag.trim(),
    installedAt: now,
    updateCheckEnabled: true,
    skippedTag: '',
    latestTag: '',
    latestAssetName: '',
    latestAssetUrl: '',
    latestPublishedAt: '',
    checkedAt: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export function trackedAppStatus(app: GithubTrackedApp): TrackedAppStatus {
  return {
    state: updateState(app.latestTag, app.installedTag),
    hasAsset: Boolean(app.latestAssetUrl),
    suppressed: !app.updateCheckEnabled ? 'ignored' : app.skippedTag && app.skippedTag === app.latestTag ? 'skipped' : null,
  }
}
