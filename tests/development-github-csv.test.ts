import { describe, expect, it } from 'vitest'
import type { GithubRepo, GithubTag, SavedGithubRepo } from '../src/shared/development/github/types'
import { buildRepoCsv, REPO_CSV_HEADER } from '../src/client/features/development/github/lib/csv'

function repo(): GithubRepo {
  return {
    id: 1,
    name: 'repo',
    fullName: 'owner/repo',
    url: 'https://github.com/owner/repo',
    description: 'A repo, "quoted"',
    homepage: null,
    owner: { login: 'owner', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
    language: 'TypeScript',
    stargazersCount: 120,
    forksCount: 10,
    openIssuesCount: 3,
    topics: ['typescript', 'cli'],
    license: 'MIT',
    isArchived: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-02-01T00:00:00Z',
    defaultBranch: 'main',
    size: 12,
  }
}

function saved(): SavedGithubRepo {
  return {
    id: '1',
    fullName: 'owner/repo',
    url: 'https://github.com/owner/repo',
    data: repo(),
    tagIds: ['tag-1', 'tag-2'],
    pinned: true,
    favorited: false,
    notes: 'line one\nline two',
    createdAt: 1,
    updatedAt: 2,
  }
}

const tags: GithubTag[] = [
  { id: 'tag-1', name: 'Tools', color: '#112233', parentId: null, sortOrder: 0, createdAt: 1, updatedAt: 2 },
]

describe('repository CSV export', () => {
  it('writes a header row and one row per saved repository', () => {
    const csv = buildRepoCsv([saved()], tags)
    const lines = csv.trimEnd().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(REPO_CSV_HEADER.join(','))
    expect(lines[1]).toContain('owner/repo')
    expect(lines[1]).toContain('"A repo, ""quoted"""')
    expect(lines[1]).toContain('Tools | tag-2')
    expect(lines[1]).toContain('"line one\nline two"')
  })

  it('keeps a single trailing newline and no rows for an empty library', () => {
    const csv = buildRepoCsv([], [])
    expect(csv).toBe(`${REPO_CSV_HEADER.join(',')}\r\n`)
  })

  it('defuses spreadsheet formulas in exported cells', () => {
    const row = saved()
    row.notes = '=HYPERLINK("https://evil.example")'
    const csv = buildRepoCsv([row], [])
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"")"`)
  })
})
