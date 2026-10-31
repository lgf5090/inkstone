import {
  GIST_REMOTE_PER_PAGE,
  type GistBatchPatch,
  type GistFile,
  type GistFilesPatch,
  type GistItem,
  type GistListResult,
  type GithubAccountView,
  type GithubBootstrap,
  type GithubExportFile,
  type GithubExportFormat,
  type GithubMirrorSource,
  type GithubRepoDetail,
  type GithubSearchParams,
  type GithubSearchResult,
  type GithubTag,
  type SavedGist,
  type SavedGithubRepo,
} from '@shared/development/github/types'
import { request, type RequestOptions } from '../../../lib/api'

const BASE = '/api/development/github'

interface Envelope<T> {
  ok: true
  data: T
}

function readData<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<Envelope<T>>(`${BASE}${path}`, options).then((response) => response.data)
}

function tagBody(tag: GithubTag) {
  return {
    name: tag.name,
    color: tag.color,
    parentId: tag.parentId,
    sortOrder: tag.sortOrder,
    createdAt: tag.createdAt,
  }
}

function repoBody(repo: SavedGithubRepo) {
  return {
    fullName: repo.fullName,
    url: repo.url,
    data: repo.data,
    tagIds: repo.tagIds,
    pinned: repo.pinned,
    favorited: repo.favorited,
    createdAt: repo.createdAt,
  }
}

function gistBody(gist: SavedGist) {
  return {
    description: gist.description,
    url: gist.url,
    data: gist.data,
    tagIds: gist.tagIds,
    pinned: gist.pinned,
    favorited: gist.favorited,
    notes: gist.notes,
    createdAt: gist.createdAt,
  }
}

export interface TagDeleteResult {
  removedTagIds: string[]
  updatedRepoIds: string[]
}

export interface GistTagDeleteResult {
  removedTagIds: string[]
  updatedGistIds: string[]
}

export interface CreateRemoteGistInput {
  description: string
  isPublic: boolean
  files: GistFile[]
}

export interface UpdateRemoteGistInput {
  description?: string
  files?: GistFilesPatch
}

export type RemoteGistType = 'public' | 'mine' | 'user'

export const githubApi = {
  bootstrap(signal?: AbortSignal): Promise<GithubBootstrap> {
    return readData('/bootstrap', { signal })
  },

  listTags(signal?: AbortSignal): Promise<GithubTag[]> {
    return readData<{ tags: GithubTag[] }>('/tags', { signal }).then((response) => response.tags)
  },

  upsertTag(tag: GithubTag, signal?: AbortSignal): Promise<GithubTag> {
    return readData<{ tag: GithubTag }>(`/tags/${encodeURIComponent(tag.id)}`, {
      method: 'PUT',
      body: tagBody(tag),
      signal,
    }).then((response) => response.tag)
  },

  deleteTag(id: string, signal?: AbortSignal): Promise<TagDeleteResult> {
    return readData<TagDeleteResult>(`/tags/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
  },

  listRepos(signal?: AbortSignal): Promise<SavedGithubRepo[]> {
    return readData<{ repos: SavedGithubRepo[] }>('/repos', { signal }).then((response) => response.repos)
  },

  upsertRepo(repo: SavedGithubRepo, signal?: AbortSignal): Promise<SavedGithubRepo> {
    return readData<{ repo: SavedGithubRepo }>(`/repos/${encodeURIComponent(repo.id)}`, {
      method: 'PUT',
      body: repoBody(repo),
      signal,
    }).then((response) => response.repo)
  },

  deleteRepo(id: string, signal?: AbortSignal): Promise<void> {
    return request<{ ok: true }>(`${BASE}/repos/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      .then(() => undefined)
  },

  listGistTags(signal?: AbortSignal): Promise<GithubTag[]> {
    return readData<{ tags: GithubTag[] }>('/gist/tags', { signal }).then((response) => response.tags)
  },

  upsertGistTag(tag: GithubTag, signal?: AbortSignal): Promise<GithubTag> {
    return readData<{ tag: GithubTag }>(`/gist/tags/${encodeURIComponent(tag.id)}`, {
      method: 'PUT',
      body: tagBody(tag),
      signal,
    }).then((response) => response.tag)
  },

  deleteGistTag(id: string, signal?: AbortSignal): Promise<GistTagDeleteResult> {
    return readData<GistTagDeleteResult>(`/gist/tags/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
  },

  listGists(signal?: AbortSignal): Promise<SavedGist[]> {
    return readData<{ gists: SavedGist[] }>('/gist/gists', { signal }).then((response) => response.gists)
  },

  upsertGist(gist: SavedGist, signal?: AbortSignal): Promise<SavedGist> {
    return readData<{ gist: SavedGist }>(`/gist/gists/${encodeURIComponent(gist.id)}`, {
      method: 'PUT',
      body: gistBody(gist),
      signal,
    }).then((response) => response.gist)
  },

  deleteGist(id: string, signal?: AbortSignal): Promise<void> {
    return request<{ ok: true }>(`${BASE}/gist/gists/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      .then(() => undefined)
  },

  batchDeleteGists(ids: string[], signal?: AbortSignal): Promise<{ count: number }> {
    return readData<{ count: number }>('/gist/gists/batch-delete', { method: 'POST', body: { ids }, signal })
  },

  batchUpdateGists(ids: string[], patch: GistBatchPatch, signal?: AbortSignal): Promise<{ count: number }> {
    return readData<{ count: number }>('/gist/gists/batch-update', { method: 'POST', body: { ids, patch }, signal })
  },

  getMirrors(signal?: AbortSignal): Promise<GithubMirrorSource[]> {
    return readData<{ mirrors: GithubMirrorSource[] }>('/mirrors', { signal }).then((response) => response.mirrors)
  },

  saveMirrors(mirrors: GithubMirrorSource[], signal?: AbortSignal): Promise<GithubMirrorSource[]> {
    return readData<{ mirrors: GithubMirrorSource[] }>('/mirrors', {
      method: 'PUT',
      body: { mirrors },
      signal,
    }).then((response) => response.mirrors)
  },

  getAccounts(signal?: AbortSignal): Promise<GithubAccountView[]> {
    return readData<{ accounts: GithubAccountView[] }>('/accounts', { signal }).then((response) => response.accounts)
  },

  addAccount(token: string, signal?: AbortSignal): Promise<GithubAccountView> {
    return readData<{ account: GithubAccountView }>('/accounts', {
      method: 'POST',
      body: { token },
      signal,
    }).then((response) => response.account)
  },

  deleteAccount(id: string, signal?: AbortSignal): Promise<void> {
    return request<{ ok: true }>(`${BASE}/accounts/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      .then(() => undefined)
  },

  search(params: GithubSearchParams, signal?: AbortSignal): Promise<GithubSearchResult> {
    const query = new URLSearchParams({
      q: params.q,
      range: params.range,
      sort: params.sort,
      order: params.order,
      language: params.language,
      per_page: String(params.perPage),
      page: String(params.page),
    })
    return readData(`/search?${query.toString()}`, { signal })
  },

  repoDetail(fullName: string, defaultBranch?: string | null, signal?: AbortSignal): Promise<GithubRepoDetail> {
    const query = new URLSearchParams({ repo: fullName })
    if (defaultBranch) query.set('defaultBranch', defaultBranch)
    return readData(`/repo-detail?${query.toString()}`, { signal })
  },

  gistDetail(id: string, signal?: AbortSignal): Promise<GistItem> {
    const query = new URLSearchParams({ gist: id })
    return readData(`/gist/detail?${query.toString()}`, { signal })
  },

  remoteGists(
    type: RemoteGistType,
    username: string | null,
    page: number,
    signal?: AbortSignal,
  ): Promise<GistListResult> {
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(GIST_REMOTE_PER_PAGE),
    })
    if (type === 'user') {
      return readData(`/gist/users/${encodeURIComponent(username ?? '')}/gists?${query.toString()}`, { signal })
    }
    return readData(`/gist/${type}?${query.toString()}`, { signal })
  },

  createRemoteGist(input: CreateRemoteGistInput, signal?: AbortSignal): Promise<GistItem> {
    return readData<{ gist: GistItem }>('/gist/github-gists', {
      method: 'POST',
      body: input,
      signal,
    }).then((response) => response.gist)
  },

  updateRemoteGist(id: string, input: UpdateRemoteGistInput, signal?: AbortSignal): Promise<GistItem> {
    return readData<{ gist: GistItem }>(`/gist/github-gists/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
      signal,
    }).then((response) => response.gist)
  },

  deleteRemoteGist(id: string, signal?: AbortSignal): Promise<void> {
    return request<{ ok: true }>(`${BASE}/gist/github-gists/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal,
    }).then(() => undefined)
  },

  createExport(gistId: string, format: GithubExportFormat, signal?: AbortSignal): Promise<GithubExportFile> {
    return readData<{ export: GithubExportFile }>(`/gists/${encodeURIComponent(gistId)}/exports`, {
      method: 'POST',
      body: { format },
      signal,
    }).then((response) => response.export)
  },

  listExports(signal?: AbortSignal): Promise<GithubExportFile[]> {
    return readData<{ exports: GithubExportFile[] }>('/exports', { signal }).then((response) => response.exports)
  },

  deleteExport(id: string, signal?: AbortSignal): Promise<void> {
    return request<{ ok: true }>(`${BASE}/exports/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      .then(() => undefined)
  },

  exportUrl(id: string): string {
    return `${BASE}/exports/${encodeURIComponent(id)}`
  },
}
