import { describe, expect, it } from 'vitest'
import type { GithubRepo } from '../src/shared/development/github/types'
import { STAR_SYNC_MAX_PAGES, syncStarredRepositories } from '../src/client/features/development/github/lib/star-sync'

function repo(id: number): GithubRepo {
  return {
    id,
    name: `repo-${id}`,
    fullName: `owner/repo-${id}`,
    url: `https://github.com/owner/repo-${id}`,
    description: null,
    homepage: null,
    owner: { login: 'owner', avatarUrl: '' },
    language: null,
    stargazersCount: 0,
    forksCount: 0,
    openIssuesCount: 0,
    topics: [],
    license: null,
    isArchived: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    defaultBranch: 'main',
    size: 0,
  }
}

describe('star sync pagination', () => {
  it('walks every page until the last one and saves only new repositories', async () => {
    const saved: number[] = []
    const pages: Array<{ items: GithubRepo[]; hasNext: boolean; expected: [number, number] }> = [
      { items: [repo(1), repo(2)], hasNext: true, expected: [1, 100] },
      { items: [repo(2), repo(3)], hasNext: false, expected: [2, 100] },
    ]
    const result = await syncStarredRepositories(
      new Set(['1']),
      (entry) => saved.push(entry.id),
      async (page, perPage) => {
        const entry = pages[page - 1]!
        expect(entry.expected).toEqual([page, perPage])
        return { items: entry.items, hasNext: entry.hasNext }
      },
    )
    expect(saved).toEqual([2, 3])
    expect(result).toEqual({ added: 2, scanned: 4, pages: 2, truncated: false })
  })

  it('stops when a page is empty even if the link header lied', async () => {
    const result = await syncStarredRepositories(
      new Set(),
      () => undefined,
      async (page) => page === 1
        ? { items: [repo(1)], hasNext: true }
        : { items: [], hasNext: true },
    )
    expect(result.pages).toBe(2)
    expect(result.added).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('reports truncation after the page cap instead of syncing forever', async () => {
    const result = await syncStarredRepositories(
      new Set(),
      () => undefined,
      async (page) => ({ items: [repo(page)], hasNext: true }),
    )
    expect(result.pages).toBe(STAR_SYNC_MAX_PAGES)
    expect(result.added).toBe(STAR_SYNC_MAX_PAGES)
    expect(result.truncated).toBe(true)
  })
})
