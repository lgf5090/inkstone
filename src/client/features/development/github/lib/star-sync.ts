import type { GithubRepo } from '@shared/development/github/types'
import { githubApi } from '../api'

export const STAR_SYNC_PAGE_SIZE = 100
export const STAR_SYNC_MAX_PAGES = 100

export interface StarSyncResult {
  added: number
  scanned: number
  pages: number
  truncated: boolean
}

export type StarSyncPageLoader = (
  page: number,
  perPage: number,
) => Promise<{ items: GithubRepo[]; hasNext: boolean }>

export async function syncStarredRepositories(
  existingIds: ReadonlySet<string>,
  save: (repo: GithubRepo) => void,
  loadPage: StarSyncPageLoader = (page, perPage) => githubApi.starred(page, perPage),
): Promise<StarSyncResult> {
  const seen = new Set(existingIds)
  let added = 0
  let scanned = 0
  let pages = 0
  for (let page = 1; page <= STAR_SYNC_MAX_PAGES; page += 1) {
    const result = await loadPage(page, STAR_SYNC_PAGE_SIZE)
    pages = page
    for (const repo of result.items) {
      scanned += 1
      const id = String(repo.id)
      if (seen.has(id)) continue
      seen.add(id)
      save(repo)
      added += 1
    }
    if (!result.hasNext || result.items.length === 0) {
      return { added, scanned, pages, truncated: false }
    }
  }
  return { added, scanned, pages, truncated: true }
}
