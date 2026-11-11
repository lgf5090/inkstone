import type { GithubRepo, SavedGithubRepo } from '@shared/development/github/types'

export function savedRepoFrom(
  repo: GithubRepo,
  existing: SavedGithubRepo | undefined,
  patch: Partial<SavedGithubRepo> = {},
): SavedGithubRepo {
  const now = Date.now()
  if (existing) return { ...existing, ...patch, updatedAt: now }
  return {
    id: String(repo.id),
    fullName: repo.fullName,
    url: repo.url,
    data: repo,
    tagIds: [],
    pinned: false,
    favorited: false,
    notes: '',
    createdAt: now,
    updatedAt: now,
    ...patch,
  }
}
