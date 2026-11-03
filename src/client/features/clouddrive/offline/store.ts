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

/**
 * Which ceiling a save of `incoming` bytes would break, given the rows already kept. A re-save of the
 * same entry replaces its own copy, so that copy is not counted against it.
 */
export function offlineRefusal(
  existing: readonly OfflineMeta[],
  entryId: string,
  incoming: number,
  limits: { file: number; total: number } = { file: MAX_FILE_BYTES, total: MAX_TOTAL_BYTES },
): 'offline_too_large' | 'offline_quota' | null {
  if (incoming > limits.file) return 'offline_too_large'
  const total = existing.reduce((sum, record) => (record.id === entryId ? sum : sum + record.size), 0)
  return total + incoming > limits.total ? 'offline_quota' : null
}

/** The two ceilings the offline cache honours, checked against the size a save is about to take. */
async function assertOfflineRoom(entry: CloudDriveEntry, incoming: number): Promise<void> {
  const refusal = offlineRefusal(await listOffline(), entry.id, incoming)
  if (refusal) throw new Error(refusal)
}

export async function putOffline(entry: CloudDriveEntry, blob: Blob): Promise<void> {
  await assertOfflineRoom(entry, blob.size)
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

/**
 * Reads the response while it arrives so an over-ceiling file is refused mid-stream instead of being
 * buffered whole. `assertRoom` is passed in because the ceiling check needs the rows in IndexedDB,
 * and the streaming limit itself must not wait for them.
 */
export async function readOfflineResponse(
  response: Response,
  mime: string,
  assertRoom: (bytes: number) => Promise<void>,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<Blob> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isSafeInteger(declared) && declared > 0) await assertRoom(declared)
  if (!response.body) return response.blob()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let seen = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    seen += value.byteLength
    if (seen > maxBytes) {
      await reader.cancel()
      throw new Error('offline_too_large')
    }
    chunks.push(value)
  }
  return new Blob(chunks as BlobPart[], { type: mime || response.headers.get('content-type') || '' })
}

export async function fetchAndSaveOffline(entry: CloudDriveEntry): Promise<void> {
  // `entry.size` is known before the request: a 2 GB save used to be streamed into memory in full and
  // only then refused, which on a phone kills the tab instead of showing a message.
  await assertOfflineRoom(entry, entry.size)
  const response = await fetch(`/api/clouddrive/files/${encodeURIComponent(entry.id)}/content`, {
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(`offline_fetch_${response.status}`)
  const blob = await readOfflineResponse(response, entry.mime, (bytes) => assertOfflineRoom(entry, bytes))
  await putOffline(entry, blob)
}
