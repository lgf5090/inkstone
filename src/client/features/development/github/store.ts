import { create } from 'zustand'
import type {
  GistBatchPatch,
  GistMetaPatch,
  GithubAccountView,
  GithubBootstrap,
  GithubCapabilities,
  GithubMirrorProbeResult,
  GithubMirrorSource,
  GithubTag,
  RepoBatchPatch,
  SavedGist,
  SavedGithubRepo,
} from '@shared/development/github/types'
import { useUi } from '../../../store/ui'
import { t } from '../../../lib/i18n'
import { githubApi } from './api'
import { clearGithubCache } from './cache'
import { collectTagDescendants } from './lib/tags'
import { loadActiveAccountId, saveActiveAccountId } from './prefs'

export type GithubLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface GithubStore {
  status: GithubLoadStatus
  error: string | null
  tags: GithubTag[]
  repos: SavedGithubRepo[]
  gistTags: GithubTag[]
  gists: SavedGist[]
  mirrors: GithubMirrorSource[]
  accounts: GithubAccountView[]
  activeAccountId: string | null
  capabilities: GithubCapabilities
  load: () => Promise<void>
  reload: () => Promise<void>
  refresh: () => Promise<void>
  upsertTag: (tag: GithubTag) => Promise<void>
  deleteTag: (id: string) => Promise<void>
  upsertGistTag: (tag: GithubTag) => Promise<void>
  deleteGistTag: (id: string) => Promise<void>
  upsertRepo: (repo: SavedGithubRepo) => Promise<void>
  deleteRepo: (id: string) => Promise<void>
  batchDeleteRepos: (ids: string[]) => Promise<void>
  batchUpdateRepos: (ids: string[], patch: RepoBatchPatch) => Promise<void>
  upsertGist: (gist: SavedGist) => Promise<void>
  patchGist: (id: string, patch: GistMetaPatch) => Promise<void>
  deleteGist: (id: string) => Promise<void>
  batchDeleteGists: (ids: string[]) => Promise<void>
  batchUpdateGists: (ids: string[], patch: GistBatchPatch) => Promise<void>
  saveMirrors: (mirrors: GithubMirrorSource[]) => Promise<void>
  probeMirrors: (mirrors: readonly GithubMirrorSource[]) => Promise<GithubMirrorProbeResult[]>
  addAccount: (token: string) => Promise<GithubAccountView>
  deleteAccount: (id: string) => Promise<void>
  setActiveAccount: (id: string | null) => void
}

type CollectionKey = 'tags' | 'repos' | 'gistTags' | 'gists' | 'mirrors' | 'accounts'

const DEFAULT_CAPABILITIES: GithubCapabilities = { exports: false }
const writeQueues = new Map<string, Promise<void>>()
let loadPromise: Promise<void> | null = null
let bootstrapSequence = 0

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  const tracked = next.then(() => undefined, (error) => {
    console.warn('[inkstone] GitHub write queue failed:', error)
  })
  writeQueues.set(key, tracked)
  void tracked.finally(() => {
    if (writeQueues.get(key) === tracked) writeQueues.delete(key)
  })
  return next
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function notifyFailure(error: unknown): void {
  const description = errorText(error)
  useUi.getState().toast({
    title: t('development.github.errors.unknown'),
    ...(description ? { description } : {}),
    tone: 'danger',
  })
}

function upsertById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  const present = items.some((entry) => entry.id === item.id)
  if (!present) return [item, ...items]
  return items.map((entry) => (entry.id === item.id ? item : entry))
}

function stripTags<T extends { tagIds: string[]; updatedAt: number }>(
  items: readonly T[],
  removed: ReadonlySet<string>,
): T[] {
  return items.map((item) => {
    if (!item.tagIds.some((tagId) => removed.has(tagId))) return item
    return {
      ...item,
      tagIds: item.tagIds.filter((tagId) => !removed.has(tagId)),
      updatedAt: Date.now(),
    }
  })
}

function applyBatchPatch<T extends { pinned: boolean; favorited: boolean; tagIds: string[]; updatedAt: number }>(
  item: T,
  patch: GistBatchPatch | RepoBatchPatch,
): T {
  const next = { ...item }
  if (patch.pinned !== undefined) next.pinned = patch.pinned
  if (patch.favorited !== undefined) next.favorited = patch.favorited
  if (patch.addTagIds?.length) next.tagIds = [...new Set([...next.tagIds, ...patch.addTagIds])]
  if (patch.removeTagIds?.length) {
    const removed = new Set(patch.removeTagIds)
    next.tagIds = next.tagIds.filter((tagId) => !removed.has(tagId))
  }
  next.updatedAt = Date.now()
  return next
}

function applyGistMeta(gist: SavedGist, patch: GistMetaPatch): SavedGist {
  const next = { ...gist }
  if (patch.description !== undefined) next.description = patch.description
  if (patch.tagIds !== undefined) next.tagIds = patch.tagIds
  if (patch.pinned !== undefined) next.pinned = patch.pinned
  if (patch.favorited !== undefined) next.favorited = patch.favorited
  if (patch.notes !== undefined) next.notes = patch.notes
  next.updatedAt = Date.now()
  return next
}

export const useGithubStore = create<GithubStore>((set, get) => {
  const revisions = new Map<CollectionKey, number>()

  const bump = (collection: CollectionKey): number => {
    const next = (revisions.get(collection) ?? 0) + 1
    revisions.set(collection, next)
    return next
  }

  const isCurrent = (collection: CollectionKey, revision: number): boolean =>
    revisions.get(collection) === revision

  const reloadCollection = async (collection: CollectionKey): Promise<void> => {
    try {
      switch (collection) {
        case 'tags':
          set({ tags: await githubApi.listTags() })
          return
        case 'repos':
          set({ repos: await githubApi.listRepos() })
          return
        case 'gistTags':
          set({ gistTags: await githubApi.listGistTags() })
          return
        case 'gists':
          set({ gists: await githubApi.listGists() })
          return
        case 'mirrors':
          set({ mirrors: await githubApi.getMirrors() })
          return
        case 'accounts': {
          const accounts = await githubApi.getAccounts()
          set((state) => {
            const activeAccountId = accounts.some((account) => account.id === state.activeAccountId)
              ? state.activeAccountId
              : accounts[0]?.id ?? null
            if (activeAccountId !== state.activeAccountId) saveActiveAccountId(activeAccountId)
            return { accounts, activeAccountId }
          })
        }
      }
    } catch (error) {
      console.warn('[inkstone] GitHub collection reload failed', collection, error)
    }
  }

  const reconcile = async (collections: readonly CollectionKey[]): Promise<void> => {
    await Promise.all(collections.map(reloadCollection))
  }

  const applyBootstrap = (data: GithubBootstrap, sequence: number): void => {
    if (sequence !== bootstrapSequence) return
    const accounts = data.accounts ?? []
    const current = get().activeAccountId
    const activeAccountId = accounts.some((account) => account.id === current)
      ? current
      : accounts[0]?.id ?? null
    if (activeAccountId !== current) saveActiveAccountId(activeAccountId)
    set({
      status: 'ready',
      error: null,
      tags: data.tags ?? [],
      repos: data.repos ?? [],
      gistTags: data.gistTags ?? [],
      gists: data.gists ?? [],
      mirrors: data.mirrors ?? [],
      accounts,
      activeAccountId,
      capabilities: { exports: data.capabilities?.exports === true },
    })
  }

  const runBootstrap = async (quiet = false): Promise<void> => {
    const sequence = ++bootstrapSequence
    if (!quiet) set({ status: 'loading', error: null })
    try {
      applyBootstrap(await githubApi.bootstrap(), sequence)
    } catch (error) {
      if (sequence !== bootstrapSequence) return
      if (quiet) {
        notifyFailure(error)
        return
      }
      set({ status: 'error', error: errorText(error) })
    }
  }

  return {
    status: 'idle',
    error: null,
    tags: [],
    repos: [],
    gistTags: [],
    gists: [],
    mirrors: [],
    accounts: [],
    activeAccountId: loadActiveAccountId(),
    capabilities: DEFAULT_CAPABILITIES,

    load: async () => {
      if (get().status === 'ready') return
      if (loadPromise) return loadPromise
      const pending = runBootstrap().finally(() => {
        loadPromise = null
      })
      loadPromise = pending
      return pending
    },

    reload: async () => {
      loadPromise = null
      await runBootstrap()
    },

    refresh: async () => {
      await runBootstrap(true)
    },

    upsertTag: async (tag) => {
      const next = { ...tag, updatedAt: Date.now() }
      const revision = bump('tags')
      set((state) => ({ tags: upsertById(state.tags, next) }))
      await enqueue(`tag:${tag.id}`, async () => {
        try {
          const saved = await githubApi.upsertTag(next)
          if (isCurrent('tags', revision)) set((state) => ({ tags: upsertById(state.tags, saved) }))
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('tags', revision)) await reconcile(['tags'])
        }
      })
    },

    deleteTag: async (id) => {
      const removed = new Set(collectTagDescendants(get().tags, id))
      const tagRevision = bump('tags')
      const repoRevision = bump('repos')
      set((state) => ({
        tags: state.tags.filter((tag) => !removed.has(tag.id)),
        repos: stripTags(state.repos, removed),
      }))
      await enqueue(`tag:${id}`, async () => {
        try {
          await githubApi.deleteTag(id)
        } catch (error) {
          notifyFailure(error)
          const pending: CollectionKey[] = []
          if (isCurrent('tags', tagRevision)) pending.push('tags')
          if (isCurrent('repos', repoRevision)) pending.push('repos')
          await reconcile(pending)
        }
      })
    },

    upsertGistTag: async (tag) => {
      const next = { ...tag, updatedAt: Date.now() }
      const revision = bump('gistTags')
      set((state) => ({ gistTags: upsertById(state.gistTags, next) }))
      await enqueue(`gist-tag:${tag.id}`, async () => {
        try {
          const saved = await githubApi.upsertGistTag(next)
          if (isCurrent('gistTags', revision)) set((state) => ({ gistTags: upsertById(state.gistTags, saved) }))
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('gistTags', revision)) await reconcile(['gistTags'])
        }
      })
    },

    deleteGistTag: async (id) => {
      const removed = new Set(collectTagDescendants(get().gistTags, id))
      const tagRevision = bump('gistTags')
      const gistRevision = bump('gists')
      set((state) => ({
        gistTags: state.gistTags.filter((tag) => !removed.has(tag.id)),
        gists: stripTags(state.gists, removed),
      }))
      await enqueue(`gist-tag:${id}`, async () => {
        try {
          await githubApi.deleteGistTag(id)
        } catch (error) {
          notifyFailure(error)
          const pending: CollectionKey[] = []
          if (isCurrent('gistTags', tagRevision)) pending.push('gistTags')
          if (isCurrent('gists', gistRevision)) pending.push('gists')
          await reconcile(pending)
        }
      })
    },

    upsertRepo: async (repo) => {
      const next = { ...repo, updatedAt: Date.now() }
      const revision = bump('repos')
      set((state) => ({ repos: upsertById(state.repos, next) }))
      await enqueue(`repo:${repo.id}`, async () => {
        try {
          const saved = await githubApi.upsertRepo(next)
          if (isCurrent('repos', revision)) set((state) => ({ repos: upsertById(state.repos, saved) }))
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('repos', revision)) await reconcile(['repos'])
        }
      })
    },

    deleteRepo: async (id) => {
      const revision = bump('repos')
      set((state) => ({ repos: state.repos.filter((repo) => repo.id !== id) }))
      await enqueue(`repo:${id}`, async () => {
        try {
          await githubApi.deleteRepo(id)
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('repos', revision)) await reconcile(['repos'])
        }
      })
    },

    batchDeleteRepos: async (ids) => {
      const removed = new Set(ids)
      if (removed.size === 0) return
      const revision = bump('repos')
      set((state) => ({ repos: state.repos.filter((repo) => !removed.has(repo.id)) }))
      await enqueue('repos:batch', async () => {
        try {
          await githubApi.batchDeleteRepos(Array.from(removed))
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('repos', revision)) await reconcile(['repos'])
        }
      })
    },

    batchUpdateRepos: async (ids, patch) => {
      const targets = new Set(ids)
      if (targets.size === 0) return
      const revision = bump('repos')
      set((state) => ({
        repos: state.repos.map((repo) => (targets.has(repo.id) ? applyBatchPatch(repo, patch) : repo)),
      }))
      await enqueue('repos:batch', async () => {
        try {
          await githubApi.batchUpdateRepos(Array.from(targets), patch)
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('repos', revision)) await reconcile(['repos'])
        }
      })
    },

    upsertGist: async (gist) => {
      const next = { ...gist, updatedAt: Date.now() }
      const revision = bump('gists')
      set((state) => ({ gists: upsertById(state.gists, next) }))
      await enqueue(`gist:${gist.id}`, async () => {
        try {
          const saved = await githubApi.upsertGist(next)
          if (isCurrent('gists', revision)) set((state) => ({ gists: upsertById(state.gists, saved) }))
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('gists', revision)) await reconcile(['gists'])
        }
      })
    },

    deleteGist: async (id) => {
      const revision = bump('gists')
      set((state) => ({ gists: state.gists.filter((gist) => gist.id !== id) }))
      await enqueue(`gist:${id}`, async () => {
        try {
          await githubApi.deleteGist(id)
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('gists', revision)) await reconcile(['gists'])
        }
      })
    },

    patchGist: async (id, patch) => {
      const revision = bump('gists')
      set((state) => ({ gists: state.gists.map((gist) => (gist.id === id ? applyGistMeta(gist, patch) : gist)) }))
      await enqueue(`gist:${id}`, async () => {
        try {
          const saved = await githubApi.patchSavedGist(id, patch)
          if (isCurrent('gists', revision)) {
            set((state) => ({
              gists: state.gists.map((gist) =>
                gist.id === id ? { ...applyGistMeta(gist, patch), updatedAt: saved.updatedAt } : gist,
              ),
            }))
          }
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('gists', revision)) await reconcile(['gists'])
        }
      })
    },

    batchDeleteGists: async (ids) => {
      const removed = new Set(ids)
      if (removed.size === 0) return
      const revision = bump('gists')
      set((state) => ({ gists: state.gists.filter((gist) => !removed.has(gist.id)) }))
      await enqueue('gists:batch', async () => {
        try {
          await githubApi.batchDeleteGists(Array.from(removed))
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('gists', revision)) await reconcile(['gists'])
        }
      })
    },

    batchUpdateGists: async (ids, patch) => {
      const targets = new Set(ids)
      if (targets.size === 0) return
      const revision = bump('gists')
      set((state) => ({
        gists: state.gists.map((gist) => (targets.has(gist.id) ? applyBatchPatch(gist, patch) : gist)),
      }))
      await enqueue('gists:batch', async () => {
        try {
          await githubApi.batchUpdateGists(Array.from(targets), patch)
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('gists', revision)) await reconcile(['gists'])
        }
      })
    },

    probeMirrors: async (mirrors) => {
      return await githubApi.probeMirrors(mirrors.map((mirror) => ({ id: mirror.id, url: mirror.url })))
    },

    saveMirrors: async (mirrors) => {
      const next = mirrors.map((mirror) => ({ ...mirror }))
      const revision = bump('mirrors')
      set({ mirrors: next })
      await enqueue('mirrors', async () => {
        try {
          const saved = await githubApi.saveMirrors(next)
          if (isCurrent('mirrors', revision)) set({ mirrors: saved })
          clearGithubCache()
        } catch (error) {
          notifyFailure(error)
          if (isCurrent('mirrors', revision)) await reconcile(['mirrors'])
        }
      })
    },

    addAccount: async (token) => {
      const revision = bump('accounts')
      return enqueue('accounts', async () => {
        try {
          const account = await githubApi.addAccount(token.trim())
          if (isCurrent('accounts', revision)) {
            set((state) => {
              const existing = state.accounts.find((entry) => entry.id === account.id || entry.username === account.username)
              const accounts = existing
                ? state.accounts.map((entry) => (entry.id === existing.id ? account : entry))
                : [...state.accounts, account]
              return { accounts }
            })
          }
          if (!get().activeAccountId) get().setActiveAccount(account.id)
          clearGithubCache()
          return account
        } catch (error) {
          if (isCurrent('accounts', revision)) await reconcile(['accounts'])
          throw error
        }
      })
    },

    deleteAccount: async (id) => {
      const revision = bump('accounts')
      set((state) => ({ accounts: state.accounts.filter((account) => account.id !== id) }))
      if (get().activeAccountId === id) {
        get().setActiveAccount(get().accounts[0]?.id ?? null)
      }
      await enqueue('accounts', async () => {
        try {
          await githubApi.deleteAccount(id)
          clearGithubCache()
        } catch (error) {
          if (isCurrent('accounts', revision)) await reconcile(['accounts'])
          throw error
        }
      })
    },

    setActiveAccount: (id) => {
      set({ activeAccountId: id })
      saveActiveAccountId(id)
    },
  }
})
