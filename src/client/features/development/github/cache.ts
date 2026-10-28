import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GistItem,
  GistListResult,
  GithubRepoDetail,
  GithubSearchParams,
  GithubSearchResult,
} from '@shared/development/github/types'
import { githubApi, type RemoteGistType } from './api'

const SEARCH_TTL_MS = 5 * 60_000
const DETAIL_TTL_MS = 10 * 60_000
const REMOTE_TTL_MS = 2 * 60_000
const MAX_CACHE_ENTRIES = 30

interface CacheEntry {
  data: unknown
  storedAt: number
}

const cache = new Map<string, CacheEntry>()

function cacheKey(...parts: (string | number)[]): string {
  return JSON.stringify(parts)
}

function readCache<T>(key: string, ttl: number, now = Date.now()): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (now - entry.storedAt > ttl) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry.data as T
}

function writeCache(key: string, data: unknown): void {
  cache.delete(key)
  cache.set(key, { data, storedAt: Date.now() })
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function clearGithubCache(): void {
  cache.clear()
}

export interface GithubQuery<T> {
  data: T | null
  loading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

interface QueryState<T> {
  data: T | null
  loading: boolean
  error: Error | null
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function useGithubQuery<T>(
  key: string | null,
  ttl: number,
  enabled: boolean,
  load: (signal: AbortSignal) => Promise<T>,
): GithubQuery<T> {
  const loadRef = useRef(load)
  loadRef.current = load
  const controllerRef = useRef<AbortController | null>(null)
  const [state, setState] = useState<QueryState<T>>(() => {
    const cached = enabled && key ? readCache<T>(key, ttl) : undefined
    return {
      data: cached ?? null,
      loading: enabled && key !== null && cached === undefined,
      error: null,
    }
  })

  const run = useCallback(async (force: boolean): Promise<void> => {
    if (!enabled || !key) {
      setState({ data: null, loading: false, error: null })
      return
    }
    const cached = readCache<T>(key, ttl)
    if (!force && cached !== undefined) {
      setState({ data: cached, loading: false, error: null })
      return
    }
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setState({ data: cached ?? null, loading: true, error: null })
    try {
      const data = await loadRef.current(controller.signal)
      if (controller.signal.aborted) return
      writeCache(key, data)
      setState({ data, loading: false, error: null })
    } catch (error) {
      if (controller.signal.aborted) return
      setState({ data: cached ?? null, loading: false, error: asError(error) })
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [enabled, key, ttl])

  useEffect(() => {
    void run(false)
    return () => {
      controllerRef.current?.abort()
    }
  }, [run])

  const refetch = useCallback(() => run(true), [run])

  return { ...state, refetch }
}

export function useGithubSearch(params: GithubSearchParams, enabled = true): GithubQuery<GithubSearchResult> {
  const key = cacheKey(
    'search',
    params.q,
    params.range,
    params.sort,
    params.order,
    params.language,
    params.perPage,
    params.page,
  )
  return useGithubQuery(key, SEARCH_TTL_MS, enabled, (signal) => githubApi.search(params, signal))
}

export function useRepoDetail(
  fullName: string | null | undefined,
  defaultBranch?: string | null,
): GithubQuery<GithubRepoDetail> {
  const key = fullName ? cacheKey('repo-detail', fullName, defaultBranch ?? '') : null
  return useGithubQuery(key, DETAIL_TTL_MS, Boolean(fullName), (signal) =>
    githubApi.repoDetail(fullName!, defaultBranch, signal))
}

export function useRemoteGists(
  type: RemoteGistType,
  username: string | null,
  page: number,
  enabled = true,
): GithubQuery<GistListResult> {
  const active = enabled && (type !== 'user' || Boolean(username))
  const key = active ? cacheKey('remote-gists', type, username ?? '', page) : null
  return useGithubQuery(key, REMOTE_TTL_MS, active, (signal) =>
    githubApi.remoteGists(type, username, page, signal))
}

export function useGistDetailRemote(id: string | null | undefined): GithubQuery<GistItem> {
  const key = id ? cacheKey('gist-detail', id) : null
  return useGithubQuery(key, DETAIL_TTL_MS, Boolean(id), (signal) => githubApi.gistDetail(id!, signal))
}
