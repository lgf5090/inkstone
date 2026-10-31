import { describe, expect, it } from 'vitest'
import type { GistItem, SavedGist, SavedGithubRepo } from '@shared/development/github/types'
import {
  filterGists,
  filterRepos,
  sortGists,
  sortSavedRepos,
} from '../src/client/features/development/github/lib/filters'

function savedRepo(
  id: string,
  patch: Partial<SavedGithubRepo> = {},
  data: Partial<SavedGithubRepo['data']> = {},
): SavedGithubRepo {
  return {
    id,
    fullName: `acme/${id}`,
    url: `https://github.com/acme/${id}`,
    data: {
      id: 1,
      name: id,
      fullName: `acme/${id}`,
      url: `https://github.com/acme/${id}`,
      description: `${id} description`,
      homepage: null,
      owner: { login: 'acme', avatarUrl: '' },
      language: 'TypeScript',
      stargazersCount: 0,
      forksCount: 0,
      openIssuesCount: 0,
      topics: [],
      license: null,
      isArchived: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      defaultBranch: 'main',
      size: 0,
      ...data,
    },
    tagIds: [],
    pinned: false,
    favorited: false,
    notes: '',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function gistItem(id: string, patch: Partial<GistItem> = {}): GistItem {
  return {
    id,
    description: `${id} description`,
    url: `https://gist.github.com/acme/${id}`,
    isPublic: true,
    owner: { login: 'acme', avatarUrl: '' },
    files: [{ filename: `${id}.md`, language: 'Markdown', content: `${id} body`, size: 6 }],
    fileCount: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...patch,
  }
}

function savedGist(
  id: string,
  patch: Partial<SavedGist> = {},
  data: Partial<GistItem> = {},
): SavedGist {
  return {
    id,
    description: `${id} description`,
    url: `https://gist.github.com/acme/${id}`,
    data: gistItem(id, data),
    tagIds: [],
    pinned: false,
    favorited: false,
    notes: '',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

describe('saved repository filters', () => {
  it('sorts pinned first, then favorited, then most recently updated', () => {
    const repos = [
      savedRepo('old', { updatedAt: 10 }),
      savedRepo('fav', { favorited: true, updatedAt: 20 }),
      savedRepo('pinned', { pinned: true, updatedAt: 5 }),
      savedRepo('new', { updatedAt: 30 }),
    ]
    expect(sortSavedRepos(repos).map((repo) => repo.id)).toEqual(['pinned', 'fav', 'new', 'old'])
    expect(repos.map((repo) => repo.id)).toEqual(['old', 'fav', 'pinned', 'new'])
  })

  it('filters by view, tag and searchable fields', () => {
    const repos = [
      savedRepo('alpha', { pinned: true, tagIds: ['t1'], favorited: true }, { topics: ['cli'] }),
      savedRepo('beta', { tagIds: ['t2'] }, { description: 'A searchable body' }),
      savedRepo('gamma', {}, { description: null }),
    ]
    expect(filterRepos(repos, 'all', '').map((repo) => repo.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(filterRepos(repos, 'pinned', '').map((repo) => repo.id)).toEqual(['alpha'])
    expect(filterRepos(repos, 'favorited', '').map((repo) => repo.id)).toEqual(['alpha'])
    expect(filterRepos(repos, 'tag:t2', '').map((repo) => repo.id)).toEqual(['beta'])
    expect(filterRepos(repos, 'all', 'BETA').map((repo) => repo.id)).toEqual(['beta'])
    expect(filterRepos(repos, 'all', 'searchable').map((repo) => repo.id)).toEqual(['beta'])
    expect(filterRepos(repos, 'all', 'cli').map((repo) => repo.id)).toEqual(['alpha'])
    expect(filterRepos(repos, 'tag:missing', '').map((repo) => repo.id)).toEqual([])
  })

  it('lists collection members in their saved order and filters them by query', () => {
    const repos = [
      savedRepo('alpha', { updatedAt: 30 }),
      savedRepo('beta', { updatedAt: 20 }),
      savedRepo('gamma', { updatedAt: 10 }),
    ]
    const collections = [
      { id: 'curated', name: 'Curated', description: '', repoIds: ['gamma', 'alpha'], createdAt: 1, updatedAt: 1 },
    ]
    expect(filterRepos(repos, 'collection:curated', '', collections).map((repo) => repo.id)).toEqual(['gamma', 'alpha'])
    expect(filterRepos(repos, 'collection:curated', 'BETA', collections)).toEqual([])
    expect(filterRepos(repos, 'collection:missing', '', collections)).toEqual([])
  })
})

describe('saved gist filters', () => {
  it('filters by view, tag, description and file content', () => {
    const gists = [
      savedGist('alpha', { pinned: true, favorited: true, tagIds: ['t1'] }),
      savedGist('beta', { tagIds: ['t2'] }, { files: [{ filename: 'notes.txt', language: 'Text', content: 'needle', size: 6 }] }),
      savedGist('gamma', {}, { description: 'Other text' }),
    ]
    expect(filterGists(gists, 'all', '').map((gist) => gist.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(filterGists(gists, 'pinned', '').map((gist) => gist.id)).toEqual(['alpha'])
    expect(filterGists(gists, 'favorited', '').map((gist) => gist.id)).toEqual(['alpha'])
    expect(filterGists(gists, 'tag:t2', '').map((gist) => gist.id)).toEqual(['beta'])
    expect(filterGists(gists, 'all', 'needle').map((gist) => gist.id)).toEqual(['beta'])
    expect(filterGists(gists, 'all', 'NOTES.TXT').map((gist) => gist.id)).toEqual(['beta'])
  })

  it('sorts pinned first except when sorting by description', () => {
    const gists = [
      savedGist('a', { pinned: true, updatedAt: 10, createdAt: 10 }, { fileCount: 3 }),
      savedGist('b', { updatedAt: 20, createdAt: 20 }, { fileCount: 1 }),
      savedGist('c', { updatedAt: 30, createdAt: 30 }, { fileCount: 2 }),
    ]
    expect(sortGists(gists, { sort: 'updated', order: 'desc' }).map((gist) => gist.id)).toEqual(['a', 'c', 'b'])
    expect(sortGists(gists, { sort: 'updated', order: 'asc' }).map((gist) => gist.id)).toEqual(['a', 'b', 'c'])
    expect(sortGists(gists, { sort: 'files', order: 'desc' }).map((gist) => gist.id)).toEqual(['a', 'c', 'b'])
    const byDescription = sortGists(gists, { sort: 'description', order: 'asc' })
    expect(byDescription.map((gist) => gist.id)).toEqual(['a', 'b', 'c'])
    expect(byDescription[0]!.pinned).toBe(true)
  })
})
