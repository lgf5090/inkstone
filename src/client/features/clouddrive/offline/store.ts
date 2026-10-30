import type { CloudDriveEntry } from '@shared/clouddrive/model'

const DB_NAME = 'inkstone-clouddrive-offline'
const DB_VERSION = 1
const STORE = 'files'
const MAX_FILE_BYTES = 200 * 1024 * 1024
const MAX_TOTAL_BYTES = 500 * 1024 * 1024

export interface OfflineRecord {
  id: string
  name: string
  mime: string
  size: number
  savedAt: number
  mountId: string
  path: string
  blob: Blob
}

export interface OfflineMeta {
  id: string
  name: string
  mime: string
  size: number
  savedAt: number
  mountId: string
  path: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('offline_unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('offline_unavailable'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = work(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('offline_unavailable'))
    })
  } finally {
    db.close()
  }
}

function metaOf(record: OfflineRecord): OfflineMeta {
  const { blob: _blob, ...meta } = record
  return meta
}

export async function listOffline(): Promise<OfflineMeta[]> {
  const rows = await withStore<OfflineRecord[]>('readonly', (store) => store.getAll() as IDBRequest<OfflineRecord[]>)
  return rows.map(metaOf).sort((left, right) => right.savedAt - left.savedAt)
}

export async function getOffline(id: string): Promise<OfflineRecord | null> {
  const row = await withStore<OfflineRecord | undefined>('readonly', (store) => store.get(id) as IDBRequest<OfflineRecord | undefined>)
  return row ?? null
}

export async function putOffline(entry: CloudDriveEntry, blob: Blob): Promise<void> {
  if (blob.size > MAX_FILE_BYTES) throw new Error('offline_too_large')
  const existing = await listOffline()
  const others = existing.filter((record) => record.id !== entry.id)
  const total = others.reduce((sum, record) => sum + record.size, 0)
  if (total + blob.size > MAX_TOTAL_BYTES) throw new Error('offline_quota')
  const record: OfflineRecord = {
    id: entry.id,
    name: entry.name,
    mime: entry.mime || blob.type || 'application/octet-stream',
    size: blob.size,
    savedAt: Date.now(),
    mountId: entry.mountId,
    path: entry.path,
    blob,
  }
  await withStore<IDBValidKey>('readwrite', (store) => store.put(record))
}

export async function removeOffline(id: string): Promise<void> {
  await withStore<undefined>('readwrite', (store) => store.delete(id) as IDBRequest<undefined>)
}

export async function fetchAndSaveOffline(entry: CloudDriveEntry): Promise<void> {
  const response = await fetch(`/api/clouddrive/files/${encodeURIComponent(entry.id)}/content`, {
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(`offline_fetch_${response.status}`)
  const blob = await response.blob()
  await putOffline(entry, blob)
}
