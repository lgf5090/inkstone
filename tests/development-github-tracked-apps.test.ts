import { describe, expect, it } from 'vitest'
import { buildTrackedApp, trackedAppStatus } from '../src/client/features/development/github/lib/apps'
import type { GithubRepo } from '../src/shared/development/github/types'

const repo: GithubRepo = {
  id: 42,
  name: 'app',
  fullName: 'owner/app',
  url: 'https://github.com/owner/app',
  description: null,
  homepage: null,
  owner: { login: 'owner', avatarUrl: 'https://avatar/owner' },
  language: 'TypeScript',
  stargazersCount: 1,
  forksCount: 0,
  openIssuesCount: 0,
  topics: [],
  license: null,
  isArchived: false,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  defaultBranch: 'main',
  size: 10,
}

describe('tracked app helpers', () => {
  it('builds a deterministic row per repository and platform', () => {
    const app = buildTrackedApp(repo, 'android', '  arm64 ', ' v1.0.0 ', 1000)
    expect(app.id).toBe('42-android')
    expect(app.repoId).toBe('42')
    expect(app.assetPattern).toBe('arm64')
    expect(app.installedTag).toBe('v1.0.0')
    expect(app.createdAt).toBe(1000)
    expect(app.latestTag).toBe('')
  })

  it('derives the update state from the stored tags and asset', () => {
    const app = buildTrackedApp(repo, 'windows', '', 'v1.0.0', 1000)
    expect(trackedAppStatus(app)).toEqual({ state: 'unknown', hasAsset: false })
    expect(trackedAppStatus({ ...app, latestTag: 'v1.1.0', latestAssetUrl: 'https://example.com/a.exe' }))
      .toEqual({ state: 'update-available', hasAsset: true })
    expect(trackedAppStatus({ ...app, latestTag: 'v1.0.0', latestAssetUrl: 'https://example.com/a.exe' }).state)
      .toBe('up-to-date')
  })
})
