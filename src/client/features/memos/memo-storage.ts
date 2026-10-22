import {
  MEMO_DEFAULT_VISIBILITY,
  MEMO_DISPLAY_DEFAULTS,
  MEMO_DRAFT_DEBOUNCE_MS,
  MEMO_DRAFT_VERSION,
} from '@shared/memos/constants'
import {
  MEMO_ORDER_FIELDS,
  MEMO_VISIBILITIES,
  type MemoDisplayPreferences,
  type MemoDraft,
  type MemoLocation,
  type MemoOrderDirection,
  type MemoOrderField,
  type MemoVisibility,
} from '@shared/memos/types'

export const MEMO_DISPLAY_STORAGE_KEY = 'inkstone.memos.display'
export const MEMO_DRAFT_STORAGE_PREFIX = 'inkstone.memos.draft'

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
