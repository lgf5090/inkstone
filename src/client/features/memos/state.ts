import { useEffect } from 'react'
import { create } from 'zustand'
import {
  MEMO_DEFAULT_VISIBILITY,
  MEMO_DISPLAY_DEFAULTS,
  MEMO_DRAFT_DEBOUNCE_MS,
  MEMO_DRAFT_VERSION,
  MEMO_PAGE_SIZE,
} from '@shared/memos/constants'
import {
  MEMO_ORDER_FIELDS,
  MEMO_VISIBILITIES,
  type Memo,
  type MemoCreateInput,
  type MemoDisplayPreferences,
  type MemoDraft,
  type MemoListQuery,
  type MemoLocation,
  type MemoOrderDirection,
  type MemoOrderField,
  type MemoPatchInput,
  type MemoState,
  type MemoVisibility,
} from '@shared/memos/types'
import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'
import { randomLocalId } from '../../lib/random-id'
import { memosApi } from './api'
import { bump, isMemoDomain, type MemoDomain } from './events'

export interface MemoQuery {
  state: MemoState
  spaceId: string | null
  tag: string | null
  filter: string
  orderBy: MemoOrderField
  order: MemoOrderDirection
}

export const MEMO_QUERY_DEFAULTS: MemoQuery = {
  state: 'normal',
  spaceId: null,
  tag: null,
  filter: '',
  orderBy: 'created',
  order: 'desc',
}

export type MemoListStatus = 'idle' | 'loading' | 'loadingMore' | 'ready' | 'error'
export type MemoDetailStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface MemoConflict {
  memoId: string
  memo: Memo | null
  message: string
}

export interface MemoDraftInput {
  content: string
  attachmentIds?: string[]
  location?: MemoLocation | null
  spaceId?: string | null
  visibility?: MemoVisibility
}

export interface MemoDraftDebouncer<T> {
  schedule: (value: T) => void
  flush: () => void
  cancel: () => void
}

interface MemosState {
  query: MemoQuery
  items: Memo[]
  cursor: string | null
  hasMore: boolean
  status: MemoListStatus
  error: string | null
  detail: Memo | null
  detailStatus: MemoDetailStatus
  detailError: string | null
  selectedId: string | null
  mutationError: string | null
  conflict: MemoConflict | null

  load: () => Promise<void>
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
  openDetail: (id: string | null) => Promise<void>
  create: (input: MemoCreateInput) => Promise<Memo | null>
  patch: (id: string, input: MemoPatchInput) => Promise<Memo | null>
  remove: (id: string) => Promise<boolean>
  restore: (id: string) => Promise<Memo | null>
  setQuery: (patch: Partial<MemoQuery>) => void
  reset: () => void
  clearConflict: () => void
}

export const MEMO_DISPLAY_STORAGE_KEY = 'inkstone.memos.display'
export const MEMO_DRAFT_STORAGE_PREFIX = 'inkstone.memos.draft'

const MEMO_LIST_WRITE_DOMAINS: readonly MemoDomain[] = ['list', 'detail', 'stats']
const MEMO_DELETE_WRITE_DOMAINS: readonly MemoDomain[] = ['list', 'detail', 'stats', 'attachments']
const MEMO_FOCUS_DOMAINS: readonly MemoDomain[] = ['list', 'detail', 'stats']
const MEMO_CHANNEL_NAME = 'inkstone.memos'
const MEMO_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function displayColumns(value: unknown): MemoDisplayPreferences['columns'] {
  return value === 1 || value === 2 || value === 3 || value === 'auto'
    ? value
    : MEMO_DISPLAY_DEFAULTS.columns
}

function displayOrderField(value: unknown): MemoOrderField {
  return (MEMO_ORDER_FIELDS as readonly unknown[]).includes(value)
    ? value as MemoOrderField
    : MEMO_DISPLAY_DEFAULTS.timeBasis
}

function displayDirection(value: unknown): MemoOrderDirection {
  if (value === 'asc' || value === 'desc') return value
  return MEMO_DISPLAY_DEFAULTS.order
}

export function loadMemoDisplayPrefs(storage: Storage | null = readStorage()): MemoDisplayPreferences {
  const fallback = { ...MEMO_DISPLAY_DEFAULTS }
  if (!storage) return fallback
  try {
    const raw = storage.getItem(MEMO_DISPLAY_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<MemoDisplayPreferences> | null
    if (parsed === null || typeof parsed !== 'object') return fallback
    return {
      columns: displayColumns(parsed.columns),
      compact: typeof parsed.compact === 'boolean' ? parsed.compact : fallback.compact,
      linkPreview: typeof parsed.linkPreview === 'boolean' ? parsed.linkPreview : fallback.linkPreview,
      timeBasis: displayOrderField(parsed.timeBasis),
      order: displayDirection(parsed.order),
    }
  } catch (error) {
    console.warn('[inkstone] Ignoring unreadable memo display preferences', error)
    return fallback
  }
}

export function saveMemoDisplayPrefs(
  prefs: MemoDisplayPreferences,
  storage: Storage | null = readStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(MEMO_DISPLAY_STORAGE_KEY, JSON.stringify(prefs))
  } catch (error) {
    console.warn('[inkstone] Memo display preferences could not be saved', error)
  }
}

export function memoDraftStorageKey(userId: string, scope: string): string {
  return `${MEMO_DRAFT_STORAGE_PREFIX}:${userId}:${scope}`
}

function draftVisibility(value: unknown): MemoVisibility {
  return (MEMO_VISIBILITIES as readonly unknown[]).includes(value)
    ? value as MemoVisibility
    : MEMO_DEFAULT_VISIBILITY
}

function draftLocation(value: unknown): MemoLocation | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return null
  const location = value as Partial<MemoLocation>
  if (
    typeof location.placeholder !== 'string'
    || typeof location.latitude !== 'number'
    || typeof location.longitude !== 'number'
    || !Number.isFinite(location.latitude)
    || !Number.isFinite(location.longitude)
  ) return null
  return {
    placeholder: location.placeholder,
    latitude: location.latitude,
    longitude: location.longitude,
  }
}

export function loadMemoDraft(
  userId: string,
  scope: string,
  storage: Storage | null = readStorage(),
): MemoDraft | null {
  if (!storage) return null
  const key = memoDraftStorageKey(userId, scope)
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MemoDraft> | null
    if (parsed === null || typeof parsed !== 'object') return null
    if (parsed.version !== MEMO_DRAFT_VERSION || typeof parsed.content !== 'string') return null
    const attachmentIds = Array.isArray(parsed.attachmentIds)
      ? parsed.attachmentIds.filter((id): id is string => typeof id === 'string')
      : []
    const updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
      ? parsed.updatedAt
      : Math.floor(Date.now() / 1000)
    return {
      version: MEMO_DRAFT_VERSION,
      content: parsed.content,
      attachmentIds,
      location: draftLocation(parsed.location),
      spaceId: typeof parsed.spaceId === 'string' ? parsed.spaceId : null,
      visibility: draftVisibility(parsed.visibility),
      updatedAt,
    }
  } catch (error) {
    console.warn('[inkstone] Ignoring an unreadable memo draft', key, error)
    return null
  }
}

export function saveMemoDraft(
  userId: string,
  scope: string,
  input: MemoDraftInput,
  storage: Storage | null = readStorage(),
): MemoDraft {
  const draft: MemoDraft = {
    version: MEMO_DRAFT_VERSION,
    content: input.content,
    attachmentIds: [...(input.attachmentIds ?? [])],
    location: input.location ?? null,
    spaceId: input.spaceId ?? null,
    visibility: input.visibility ?? MEMO_DEFAULT_VISIBILITY,
    updatedAt: Math.floor(Date.now() / 1000),
  }
  if (!storage) return draft
  try {
    storage.setItem(memoDraftStorageKey(userId, scope), JSON.stringify(draft))
  } catch (error) {
    console.warn('[inkstone] Memo draft could not be saved', error)
  }
  return draft
}

export function clearMemoDraft(
  userId: string,
  scope: string,
  storage: Storage | null = readStorage(),
): void {
  if (!storage) return
  try {
    storage.removeItem(memoDraftStorageKey(userId, scope))
  } catch (error) {
    console.warn('[inkstone] Memo draft could not be cleared', error)
  }
}

export function createMemoDraftDebouncer<T>(
  write: (value: T) => void,
  delay = MEMO_DRAFT_DEBOUNCE_MS,
): MemoDraftDebouncer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null
  const run = (): void => {
    const next = pending
    pending = null
    if (next) write(next.value)
  }
  return {
    schedule(value) {
      pending = { value }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        run()
      }, delay)
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      run()
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pending = null
    },
  }
}

function newMemoId(): string {
  const bytes = new Uint8Array(26)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => MEMO_ID_ALPHABET[byte & 31]).join('')
}

function combinedFilter(query: MemoQuery): string | undefined {
  const filter = query.filter.trim()
  const tag = query.tag?.trim()
  if (!tag) return filter || undefined
  const tagClause = `tag == ${JSON.stringify(tag)}`
  return filter ? `(${filter}) && ${tagClause}` : tagClause
}

function toListQuery(query: MemoQuery, cursor: string | null): MemoListQuery {
  const result: MemoListQuery = {
    state: query.state,
    filter: combinedFilter(query),
    orderBy: query.orderBy,
    order: query.order,
    cursor,
    limit: MEMO_PAGE_SIZE,
  }
  if (query.spaceId) result.spaceId = query.spaceId
  return result
}

function matchesQuery(memo: Memo, query: MemoQuery): boolean {
  if (memo.parentId !== null) return false
  if (memo.state !== query.state) return false
  if (query.spaceId !== null && memo.spaceId !== query.spaceId) return false
  return true
}

function syncMemo(items: Memo[], memo: Memo, query: MemoQuery): Memo[] {
  const index = items.findIndex((entry) => entry.id === memo.id)
  const visible = matchesQuery(memo, query)
  if (!visible) return index < 0 ? items : items.filter((entry) => entry.id !== memo.id)
  if (index < 0) return [memo, ...items]
  return items.map((entry) => (entry.id === memo.id ? memo : entry))
}

function restoreRemovedMemo(current: Memo[], previous: Memo[], id: string): Memo[] {
  if (current.some((entry) => entry.id === id)) return current
  const index = previous.findIndex((entry) => entry.id === id)
  if (index < 0) return current
  const restored = previous[index]!
  const next = [...current]
  next.splice(Math.min(index, next.length), 0, restored)
  return next
}

function appendUnique(items: Memo[], incoming: Memo[]): Memo[] {
  const seen = new Set(items.map((entry) => entry.id))
  const next = [...items]
  for (const memo of incoming) {
    if (seen.has(memo.id)) continue
    seen.add(memo.id)
    next.push(memo)
  }
  return next
}

function applyOptimisticPatch(memo: Memo, input: MemoPatchInput): Memo {
  return {
    ...memo,
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    ...(input.spaceId !== undefined ? { spaceId: input.spaceId } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
  }
}

function optimisticMemo(input: MemoCreateInput, id: string): Memo {
  const now = Math.floor(Date.now() / 1000)
  return {
    id,
    content: input.content,
    title: '',
    snippet: '',
    tags: [],
    visibility: input.visibility ?? MEMO_DEFAULT_VISIBILITY,
    state: 'normal',
    pinned: false,
    spaceId: input.spaceId ?? null,
    parentId: input.parentId ?? null,
    location: input.location ?? null,
    properties: {
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: Boolean(input.location),
    },
    attachments: [],
    reactions: [],
    relations: [],
    commentCount: 0,
    rev: 0,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('api.error.unknown')
}

const MEMO_TAB_ID = randomLocalId('memo-tab')

interface MemoMutationMessage {
  type: 'memo-mutation'
  sourceId: string
  domains: MemoDomain[]
}

let memoChannel: BroadcastChannel | null = null
let memoChannelBlocked = false

function channel(): BroadcastChannel | null {
  if (memoChannelBlocked || typeof BroadcastChannel === 'undefined') return null
  if (memoChannel) return memoChannel
  try {
    memoChannel = new BroadcastChannel(MEMO_CHANNEL_NAME)
    memoChannel.onmessage = (event: MessageEvent) => {
      const data = event.data as Partial<MemoMutationMessage> | null
      if (!data || data.type !== 'memo-mutation' || data.sourceId === MEMO_TAB_ID) return
      if (!Array.isArray(data.domains)) return
      for (const domain of data.domains) {
        if (isMemoDomain(domain)) bump(domain)
      }
    }
  } catch (error) {
    memoChannelBlocked = true
    console.warn('[inkstone] Memo cross-tab channel is unavailable', error)
  }
  return memoChannel
}

function publishMemoMutation(domains: readonly MemoDomain[]): void {
  const bus = channel()
  if (!bus) return
  try {
    bus.postMessage({ type: 'memo-mutation', sourceId: MEMO_TAB_ID, domains: [...domains] })
  } catch (error) {
    console.warn('[inkstone] Memo change broadcast failed', error)
  }
}

function afterMutation(domains: readonly MemoDomain[]): void {
  for (const domain of domains) bump(domain)
  publishMemoMutation(domains)
}

export const useMemos = create<MemosState>()((set, get) => {
  let listController: AbortController | null = null
  let listTicket = 0
  let detailController: AbortController | null = null
  let detailTicket = 0

  const runLoad = async (resetItems: boolean): Promise<void> => {
    listController?.abort()
    const controller = new AbortController()
    listController = controller
    const ticket = ++listTicket
    const query = get().query
    set({
      status: 'loading',
      error: null,
      ...(resetItems ? { items: [], cursor: null, hasMore: false } : {}),
    })
    try {
      const page = await memosApi.list(toListQuery(query, null), controller.signal)
      if (ticket !== listTicket) return
      set({
        items: page.items,
        cursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        status: 'ready',
      })
    } catch (error) {
      if (ticket !== listTicket || isAbortError(error)) return
      set({ status: 'error', error: failureMessage(error) })
    } finally {
      if (listController === controller) listController = null
    }
  }

  return {
    query: { ...MEMO_QUERY_DEFAULTS },
    items: [],
    cursor: null,
    hasMore: false,
    status: 'idle',
    error: null,
    detail: null,
    detailStatus: 'idle',
    detailError: null,
    selectedId: null,
    mutationError: null,
    conflict: null,

    load: () => runLoad(true),

    refresh: () => runLoad(false),

    async loadMore() {
      const state = get()
      if (state.status !== 'ready' && state.status !== 'error') return
      if (!state.hasMore || !state.cursor) return
      listController?.abort()
      const controller = new AbortController()
      listController = controller
      const ticket = ++listTicket
      const query = state.query
      const cursor = state.cursor
      set({ status: 'loadingMore', error: null })
      try {
        const page = await memosApi.list(toListQuery(query, cursor), controller.signal)
        if (ticket !== listTicket) return
        set({
          items: appendUnique(get().items, page.items),
          cursor: page.nextCursor,
          hasMore: page.nextCursor !== null,
          status: 'ready',
        })
      } catch (error) {
        if (ticket !== listTicket || isAbortError(error)) return
        set({ status: 'error', error: failureMessage(error) })
      } finally {
        if (listController === controller) listController = null
      }
    },

    async openDetail(id) {
      detailController?.abort()
      detailController = null
      const ticket = ++detailTicket
      if (!id) {
        set({ selectedId: null, detail: null, detailStatus: 'idle', detailError: null })
        return
      }
      const known = get().detail?.id === id
        ? get().detail
        : get().items.find((entry) => entry.id === id) ?? null
      set({ selectedId: id, detail: known, detailStatus: 'loading', detailError: null })
      const controller = new AbortController()
      detailController = controller
      try {
        const memo = await memosApi.get(id, controller.signal)
        if (ticket !== detailTicket) return
        set((state) => ({
          detail: memo,
          detailStatus: 'ready',
          items: syncMemo(state.items, memo, state.query),
        }))
      } catch (error) {
        if (ticket !== detailTicket || isAbortError(error)) return
        set({ detailStatus: 'error', detailError: failureMessage(error) })
      } finally {
        if (detailController === controller) detailController = null
      }
    },

    async create(input) {
      const query = get().query
      const id = input.id ?? newMemoId()
      const optimistic = optimisticMemo(input, id)
      set((state) => ({
        items: matchesQuery(optimistic, query) && !state.items.some((entry) => entry.id === id)
          ? [optimistic, ...state.items]
          : state.items,
        mutationError: null,
      }))
      try {
        const saved = await memosApi.create({ ...input, id })
        set((state) => ({
          items: syncMemo(state.items.filter((entry) => entry.id !== id), saved, state.query),
          detail: state.detail?.id === id ? saved : state.detail,
          selectedId: state.selectedId === id ? saved.id : state.selectedId,
        }))
        afterMutation(input.attachmentIds
          ? [...MEMO_LIST_WRITE_DOMAINS, 'attachments']
          : MEMO_LIST_WRITE_DOMAINS)
        return saved
      } catch (error) {
        set((state) => ({
          items: state.items.filter((entry) => entry.id !== id),
          mutationError: failureMessage(error),
        }))
        return null
      }
    },

    async patch(id, input) {
      const beforeItem = get().items.find((entry) => entry.id === id) ?? null
      const beforeDetail = get().detail?.id === id ? get().detail : null
      if (beforeItem) {
        set((state) => ({
          items: state.items.map((entry) => (entry.id === id ? applyOptimisticPatch(entry, input) : entry)),
          mutationError: null,
        }))
      }
      if (beforeDetail) {
        set((state) => ({
          detail: state.detail?.id === id ? applyOptimisticPatch(state.detail, input) : state.detail,
        }))
      }
      try {
        const saved = await memosApi.patch(id, input)
        set((state) => ({
          items: syncMemo(state.items, saved, state.query),
          detail: state.detail?.id === id ? saved : state.detail,
          conflict: state.conflict?.memoId === id ? null : state.conflict,
        }))
        afterMutation(input.attachmentIds
          ? [...MEMO_LIST_WRITE_DOMAINS, 'attachments']
          : MEMO_LIST_WRITE_DOMAINS)
        return saved
      } catch (error) {
        const message = t('api.error.conflict')
        if (error instanceof ApiError && error.isConflict) {
          let current: Memo | null = null
          try {
            current = await memosApi.get(id)
          } catch (readError) {
            console.warn('[inkstone] Could not read the server copy of a conflicted memo', readError)
          }
          if (current) {
            set((state) => ({
              items: syncMemo(state.items, current, state.query),
              detail: state.detail?.id === id ? current : state.detail,
              conflict: { memoId: id, memo: current, message },
              mutationError: message,
            }))
            afterMutation(['list', 'detail'])
          } else {
            set((state) => ({
              items: beforeItem
                ? state.items.map((entry) => (entry.id === id ? beforeItem : entry))
                : state.items,
              detail: beforeDetail && state.detail?.id === id ? beforeDetail : state.detail,
              conflict: { memoId: id, memo: null, message },
              mutationError: message,
            }))
          }
          return null
        }
        set((state) => ({
          items: beforeItem
            ? state.items.map((entry) => (entry.id === id ? beforeItem : entry))
            : state.items,
          detail: beforeDetail && state.detail?.id === id ? beforeDetail : state.detail,
          mutationError: failureMessage(error),
        }))
        return null
      }
    },

    async remove(id) {
      const state = get()
      const beforeItems = state.items
      const beforeDetail = state.detail?.id === id ? state.detail : null
      const wasSelected = state.selectedId === id
      set({
        items: state.items.filter((entry) => entry.id !== id),
        detail: state.detail?.id === id ? null : state.detail,
        selectedId: wasSelected ? null : state.selectedId,
        mutationError: null,
      })
      try {
        await memosApi.remove(id)
        afterMutation(MEMO_DELETE_WRITE_DOMAINS)
        return true
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          afterMutation(MEMO_DELETE_WRITE_DOMAINS)
          return true
        }
        set((current) => ({
          items: restoreRemovedMemo(current.items, beforeItems, id),
          detail: beforeDetail && current.detail === null && current.selectedId === null
            ? beforeDetail
            : current.detail,
          selectedId: wasSelected && current.selectedId === null ? id : current.selectedId,
          mutationError: failureMessage(error),
        }))
        return false
      }
    },

    async restore(id) {
      try {
        const memo = await memosApi.restore(id)
        set((state) => ({
          items: syncMemo(state.items, memo, state.query),
          detail: state.detail?.id === id ? memo : state.detail,
          mutationError: null,
        }))
        afterMutation(MEMO_LIST_WRITE_DOMAINS)
        return memo
      } catch (error) {
        set({ mutationError: failureMessage(error) })
        return null
      }
    },

    setQuery(patch) {
      listController?.abort()
      listController = null
      listTicket += 1
      set((state) => ({
        query: { ...state.query, ...patch },
        items: [],
        cursor: null,
        hasMore: false,
        status: 'idle',
        error: null,
      }))
    },

    reset() {
      listController?.abort()
      listController = null
      listTicket += 1
      detailController?.abort()
      detailController = null
      detailTicket += 1
      set({
        query: { ...MEMO_QUERY_DEFAULTS },
        items: [],
        cursor: null,
        hasMore: false,
        status: 'idle',
        error: null,
        detail: null,
        detailStatus: 'idle',
        detailError: null,
        selectedId: null,
        mutationError: null,
        conflict: null,
      })
    },

    clearConflict() {
      set((state) => ({
        conflict: null,
        mutationError: state.conflict && state.mutationError === state.conflict.message
          ? null
          : state.mutationError,
      }))
    },
  }
})

export function useRefreshOnFocus(domains: readonly MemoDomain[] = MEMO_FOCUS_DOMAINS): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    let hidden = document.visibilityState === 'hidden'
    const refresh = (): void => {
      for (const domain of domains) bump(domain)
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        hidden = true
        return
      }
      if (!hidden) return
      hidden = false
      refresh()
    }
    const onFocus = (): void => {
      refresh()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [domains])
}

export function useMemoSync(): void {
  useRefreshOnFocus()
  useEffect(() => {
    channel()
  }, [])
}
