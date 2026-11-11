import type { GithubDiscoverRelease, GithubRelease } from './types'

export type GithubAssetPlatform = 'android' | 'windows' | 'macos' | 'linux'

export const GITHUB_ASSET_PLATFORMS: readonly GithubAssetPlatform[] = ['android', 'windows', 'macos', 'linux']

export type GithubPlatformFilter = 'all' | GithubAssetPlatform

export const GITHUB_PLATFORM_FILTERS: readonly GithubPlatformFilter[] = ['all', ...GITHUB_ASSET_PLATFORMS]

export const GITHUB_PLATFORM_TOPICS: Record<GithubPlatformFilter, string | null> = {
  all: null,
  android: 'android',
  windows: 'desktop',
  macos: 'macos',
  linux: 'linux',
}

const PLATFORM_SUFFIXES: readonly { platform: GithubAssetPlatform; suffixes: readonly string[] }[] = [
  { platform: 'android', suffixes: ['.apk', '.aab', '.apks'] },
  { platform: 'windows', suffixes: ['.exe', '.msi', '.msix', '.msixbundle'] },
  { platform: 'macos', suffixes: ['.dmg', '.pkg', '.mpkg'] },
  { platform: 'linux', suffixes: ['.appimage', '.deb', '.rpm', '.pkg.tar.zst', '.flatpak', '.snap'] },
]

export function assetPlatform(name: string): GithubAssetPlatform | null {
  const lower = name.trim().toLowerCase()
  if (!lower) return null
  for (const entry of PLATFORM_SUFFIXES) {
    if (entry.suffixes.some((suffix) => lower.endsWith(suffix))) return entry.platform
  }
  return null
}

export function assetMatchesPlatform(name: string, platform: GithubAssetPlatform): boolean {
  return assetPlatform(name) === platform
}

export function releasePlatforms(names: readonly string[]): GithubAssetPlatform[] {
  const found = new Set<GithubAssetPlatform>()
  for (const name of names) {
    const platform = assetPlatform(name)
    if (platform) found.add(platform)
  }
  return GITHUB_ASSET_PLATFORMS.filter((platform) => found.has(platform))
}

export function pickReleaseAsset<T extends { name: string }>(
  assets: readonly T[],
  platform: GithubAssetPlatform | 'all',
  pattern = '',
): T | null {
  const normalized = pattern.trim().toLowerCase()
  const candidates = normalized
    ? assets.filter((asset) => asset.name.toLowerCase().includes(normalized))
    : assets
  if (platform === 'all') return candidates[0] ?? null
  return candidates.find((asset) => assetMatchesPlatform(asset.name, platform)) ?? null
}

const PLAIN_VERSION = /^v?(\d+(?:\.\d+){0,3})$/i

export function normalizeVersionTag(tag: string): string {
  return tag.trim().replace(/^v/i, '')
}

export function compareVersions(left: string, right: string): number | null {
  const leftMatch = PLAIN_VERSION.exec(left.trim())
  const rightMatch = PLAIN_VERSION.exec(right.trim())
  if (!leftMatch || !rightMatch) return null
  const leftParts = leftMatch[1]!.split('.').map((part) => Number(part))
  const rightParts = rightMatch[1]!.split('.').map((part) => Number(part))
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0
    const rightValue = rightParts[index] ?? 0
    if (leftValue > rightValue) return 1
    if (leftValue < rightValue) return -1
  }
  return 0
}

export type GithubUpdateState = 'update-available' | 'up-to-date' | 'unknown'

export function updateState(latestTag: string, installedTag: string): GithubUpdateState {
  if (!latestTag.trim() || !installedTag.trim()) return 'unknown'
  if (normalizeVersionTag(latestTag).toLowerCase() === normalizeVersionTag(installedTag).toLowerCase()) {
    return 'up-to-date'
  }
  const result = compareVersions(latestTag, installedTag)
  if (result === null) return 'unknown'
  return result > 0 ? 'update-available' : 'up-to-date'
}

export function summarizeRelease(release: GithubRelease, platform: GithubPlatformFilter): GithubDiscoverRelease {
  const platforms = releasePlatforms(release.assets.map((asset) => asset.name))
  const recommended = platform === 'all'
    ? release.assets.find((asset) => assetPlatform(asset.name) !== null) ?? release.assets[0] ?? null
    : pickReleaseAsset(release.assets, platform)
  return {
    tagName: release.tagName,
    name: release.name,
    publishedAt: release.publishedAt,
    htmlUrl: release.htmlUrl,
    assetCount: release.assets.length,
    downloadCount: release.assets.reduce((sum, asset) => sum + asset.downloadCount, 0),
    platforms,
    recommendedAsset: recommended,
  }
}
