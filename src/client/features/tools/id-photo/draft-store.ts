import type { IdPhotoAdjustOptions } from '@shared/tools/id-photo/types'

const DB_NAME = 'inkstone-id-photo-draft'
const DB_VERSION = 1
const STORE = 'drafts'
const META_PREFIX = 'inkstone.idphoto.draft'
const MAX_DRAFT_CHARS = 12_000_000

// A draft is a portrait, so two accounts sharing a browser must not share one.
function rowId(scope: string): string {
  return `current:${scope || 'anon'}`
}

function metaKey(scope: string): string {
  return `${META_PREFIX}.${scope || 'anon'}`
}

export interface IdPhotoDraft {
  id: string
  savedAt: number
  src: string
  specId: string
  options: IdPhotoAdjustOptions
}

export interface IdPhotoDraftMeta {
  savedAt: number
  bytes: number
  specId: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('draft_unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('draft_unavailable'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = work(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('draft_unavailable'))
    })
  } finally {
    db.close()
  }
}

export function readDraftMeta(scope = ''): IdPhotoDraftMeta | null {
  try {
    const raw = localStorage.getItem(metaKey(scope))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<IdPhotoDraftMeta>
    if (typeof parsed?.savedAt !== 'number' || typeof parsed?.bytes !== 'number') return null
    return { savedAt: parsed.savedAt, bytes: parsed.bytes, specId: String(parsed.specId ?? '') }
  } catch {
    // A torn write in localStorage must not look like a crash: the draft simply is not there.
    return null
  }
}

function writeDraftMeta(scope: string, meta: IdPhotoDraftMeta): void {
  localStorage.setItem(metaKey(scope), JSON.stringify(meta))
}

function dropDraftMeta(scope: string): void {
  localStorage.removeItem(metaKey(scope))
}

export function draftSource(src: string | null): string | null {
  if (!src || !src.startsWith('data:')) return null
  return src
}

export async function saveDraft(input: {
  src: string
  specId: string
  options: IdPhotoAdjustOptions
  scope?: string
}): Promise<{ ok: boolean; reason?: 'too_large' }> {
  if (input.src.length > MAX_DRAFT_CHARS) return { ok: false, reason: 'too_large' }
  const savedAt = Date.now()
  const scope = input.scope ?? ''
  await withStore('readwrite', (store) =>
    store.put({ id: rowId(scope), savedAt, src: input.src, specId: input.specId, options: input.options }),
  )
  writeDraftMeta(scope, { savedAt, bytes: Math.round(input.src.length * 0.75), specId: input.specId })
  return { ok: true }
}

export async function loadDraft(scope = ''): Promise<{ src: string; specId: string; options: IdPhotoAdjustOptions } | null> {
  const row = await withStore<IdPhotoDraft | undefined>(
    'readonly',
    (store) => store.get(rowId(scope)) as IDBRequest<IdPhotoDraft | undefined>,
  )
  if (!row?.src) return null
  return { src: row.src, specId: row.specId, options: row.options }
}

export async function clearDraft(scope = ''): Promise<void> {
  dropDraftMeta(scope)
  if (typeof indexedDB === 'undefined') return
  await withStore('readwrite', (store) => store.delete(rowId(scope)))
}

export const DRAFT_LIMIT_CHARS = MAX_DRAFT_CHARS
