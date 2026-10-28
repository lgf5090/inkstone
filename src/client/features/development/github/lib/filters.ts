import {
  DEFAULT_GIST_PREFS,
  GIST_FAV_VIEW,
  GIST_PINNED_VIEW,
  GITHUB_FAV_VIEW,
  GITHUB_PINNED_VIEW,
  type GistPrefs,
  type GistViewId,
  type GithubViewId,
  type SavedGist,
  type SavedGithubRepo,
} from '@shared/development/github/types'

function tagIdOf(view: string): string | null {
  return view.startsWith('tag:') ? view.slice(4) || null : null
}

function matchesRepo(repo: SavedGithubRepo, query: string): boolean {
  if (!query) return true
  return (
    repo.fullName.toLowerCase().includes(query) ||
    (repo.data.description ?? '').toLowerCase().includes(query) ||
    repo.data.topics.some((topic) => topic.toLowerCase().includes(query))
  )
}

function matchesGist(gist: SavedGist, query: string): boolean {
  if (!query) return true
  if (gist.description.toLowerCase().includes(query)) return true
  return gist.data.files.some(
    (file) => file.filename.toLowerCase().includes(query) || file.content.toLowerCase().includes(query),
  )
}

export function sortSavedRepos(repos: readonly SavedGithubRepo[]): SavedGithubRepo[] {
  return [...repos].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    if (left.favorited !== right.favorited) return left.favorited ? -1 : 1
    return right.updatedAt - left.updatedAt
  })
}

export function filterRepos(
  repos: readonly SavedGithubRepo[],
  view: GithubViewId,
  query: string,
): SavedGithubRepo[] {
  const normalized = query.trim().toLowerCase()
  const selectedTagId = tagIdOf(view)
  return repos.filter((repo) => {
    if (view === GITHUB_PINNED_VIEW && !repo.pinned) return false
    if (view === GITHUB_FAV_VIEW && !repo.favorited) return false
    if (selectedTagId && !repo.tagIds.includes(selectedTagId)) return false
    return matchesRepo(repo, normalized)
  })
}

export function filterGists(
  gists: readonly SavedGist[],
  view: GistViewId,
  query: string,
): SavedGist[] {
  const normalized = query.trim().toLowerCase()
  const selectedTagId = tagIdOf(view)
  return gists.filter((gist) => {
    if (view === GIST_PINNED_VIEW && !gist.pinned) return false
    if (view === GIST_FAV_VIEW && !gist.favorited) return false
    if (selectedTagId && !gist.tagIds.includes(selectedTagId)) return false
    return matchesGist(gist, normalized)
  })
}

export function sortGists(
  gists: readonly SavedGist[],
  prefs: GistPrefs = DEFAULT_GIST_PREFS,
): SavedGist[] {
  const direction = prefs.order === 'asc' ? 1 : -1
  return [...gists].sort((left, right) => {
    if (prefs.sort !== 'description' && left.pinned !== right.pinned) return left.pinned ? -1 : 1
    switch (prefs.sort) {
      case 'created':
        return (left.createdAt - right.createdAt) * direction
      case 'files':
        return (left.data.fileCount - right.data.fileCount) * direction
      case 'description':
        return left.description.localeCompare(right.description) * direction
      default:
        return (left.updatedAt - right.updatedAt) * direction
    }
  })
}
