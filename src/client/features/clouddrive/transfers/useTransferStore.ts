/**
 * Client-side transfer queue for CloudDrive.
 *
 * Uploads and downloads are browser transfers rather than server tasks, so they live here and not in
 * `CloudDrive_tasks`. Active items hold a live `File`/stream and are deliberately not persisted; only
 * terminal history is written, capped at the last 100 entries per account on this device.
 */
import { create } from 'zustand'
import { CLIENT_HEADER } from '@shared/constants'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { useSession } from '../../../store/session'
import { CloudDriveApiError, clouddriveApi, cloudDriveErrorKey } from '../api'

export type TransferKind = 'upload' | 'download'
export type TransferStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled'

export interface TransferItem {
  id: string
  kind: TransferKind
  name: string
  mime: string
  size: number
  transferred: number
  status: TransferStatus
  errorKey: string | null
  createdAt: number
  finishedAt: number | null
  mountId: string
  parentPath: string | null
  entryId: string | null
  sessionId: string | null
  /** Present until the page reloads; a retry after that needs the reader to pick the file again. */
  file?: File
}

export interface TransferTarget {
  mountId: string
  parentPath: string
}

interface TransferState {
  items: TransferItem[]
  enqueueUpload(files: File[], target: TransferTarget): string[]
  enqueueDownload(entry: CloudDriveEntry): string
  cancel(id: string): void
  retry(id: string): void
  clearFinished(): void
  remove(id: string): void
  /** Load history for an account. Safe to call more than once for the same id. */
  hydrate(userId: string): void
}

const HISTORY_VERSION = 'v1'
const HISTORY_LIMIT = 100
const MAX_CONCURRENT = 2

const controllers = new Map<string, AbortController>()
let historyUserId: string | null = null
let transferSequence = 0

class TransferError extends Error {
  constructor(readonly key: string) {
    super(key)
    this.name = 'TransferError'
  }
}

function transferId(): string {
  transferSequence += 1
  return `tr-${Date.now().toString(36)}-${transferSequence.toString(36)}`
}

function historyKey(userId: string): string {
  return `inkstone.clouddrive.transfers.${HISTORY_VERSION}.${userId}`
}

function currentHistoryOwner(): string {
  return historyUserId ?? useSession.getState().user?.id ?? 'anonymous'
}

function isTerminal(status: TransferStatus): boolean {
  return status !== 'queued' && status !== 'running'
}

function patchItem(id: string, patch: Partial<TransferItem>): void {
  useTransferStore.setState((state) => ({
    items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  }))
}

function persistHistory(): void {
  if (typeof localStorage === 'undefined') return
  const history = useTransferStore.getState().items
    .filter((item) => isTerminal(item.status))
    .sort((left, right) => (right.finishedAt ?? right.createdAt) - (left.finishedAt ?? left.createdAt))
    .slice(0, HISTORY_LIMIT)
    .map(({ file: _file, sessionId: _sessionId, ...item }) => item)
  try {
    localStorage.setItem(historyKey(currentHistoryOwner()), JSON.stringify(history))
  } catch (error) {
    // Losing history only costs the record; the transfer itself is unaffected.
    console.warn('[inkstone] CloudDrive transfer history could not be saved', error)
  }
}

function readHistory(userId: string): TransferItem[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(historyKey(userId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const record = value as Record<string, unknown>
      const status = record.status
      if (status !== 'success' && status !== 'error' && status !== 'cancelled') return []
      if (record.kind !== 'upload' && record.kind !== 'download') return []
      if (typeof record.id !== 'string' || typeof record.name !== 'string') return []
      return [{
        id: record.id,
        kind: record.kind as TransferKind,
        name: record.name,
        mime: typeof record.mime === 'string' ? record.mime : '',
        size: typeof record.size === 'number' ? record.size : 0,
        transferred: typeof record.transferred === 'number' ? record.transferred : 0,
        status: status as TransferStatus,
        errorKey: typeof record.errorKey === 'string' ? record.errorKey : null,
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        finishedAt: typeof record.finishedAt === 'number' ? record.finishedAt : null,
        mountId: typeof record.mountId === 'string' ? record.mountId : 'primary',
        parentPath: typeof record.parentPath === 'string' ? record.parentPath : null,
        entryId: typeof record.entryId === 'string' ? record.entryId : null,
        sessionId: null,
      }]
    }).slice(0, HISTORY_LIMIT)
  } catch (error) {
    console.warn('[inkstone] CloudDrive transfer history could not be read', error)
    return []
  }
}

function schedule(): void {
  const state = useTransferStore.getState()
  const running = state.items.filter((item) => item.status === 'running').length
  if (running >= MAX_CONCURRENT) return
  const next = state.items.find((item) => item.status === 'queued')
  if (!next) return
  void runTransfer(next.id)
}

function abortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

async function putBytes(url: string, body: Blob, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    body,
    credentials: 'same-origin',
    signal,
    headers: { [CLIENT_HEADER]: '1', 'Content-Type': 'application/octet-stream' },
  })
  if (response.ok) return
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
  throw new CloudDriveApiError(
    payload?.error?.code ?? 'internal',
    payload?.error?.message ?? response.statusText,
    response.status,
  )
}

async function runUpload(item: TransferItem, signal: AbortSignal): Promise<void> {
  const file = item.file
  if (!file) throw new TransferError('clouddrive.transfers.file_unavailable')
  if (signal.aborted) throw abortError()

  const init = await clouddriveApi.initUpload({
    mountId: item.mountId,
    parentPath: item.parentPath ?? '/',
    name: item.name,
    size: item.size,
    mime: item.mime || 'application/octet-stream',
    conflict: 'rename',
  })
  patchItem(item.id, { sessionId: init.session.id })
  if (signal.aborted) {
    await clouddriveApi.abortUpload(init.session.id).catch((error) => {
      console.warn('[inkstone] CloudDrive upload session could not be aborted', error)
    })
    throw abortError()
  }

  if (init.session.strategy === 'direct') {
    await putBytes(`/api/clouddrive/uploads/${encodeURIComponent(init.session.id)}/content`, file, signal)
    patchItem(item.id, { transferred: file.size })
  } else {
    const { partSize, totalParts } = init.session
    let transferred = 0
    for (let part = 1; part <= totalParts; part += 1) {
      if (signal.aborted) throw abortError()
      const start = (part - 1) * partSize
      const chunk = file.slice(start, Math.min(file.size, start + partSize))
      await putBytes(`/api/clouddrive/uploads/${encodeURIComponent(init.session.id)}/parts/${part}`, chunk, signal)
      transferred += chunk.size
      patchItem(item.id, { transferred: Math.min(file.size, transferred) })
    }
  }

  if (signal.aborted) throw abortError()
  await clouddriveApi.completeUpload(init.session.id)
  patchItem(item.id, { transferred: file.size })
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function runDownload(item: TransferItem, signal: AbortSignal): Promise<void> {
  if (!item.entryId) throw new TransferError('clouddrive.error.not_found')
  const response = await fetch(clouddriveApi.contentUrl(item.entryId, true), {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new CloudDriveApiError(
      payload?.error?.code ?? 'internal',
      payload?.error?.message ?? response.statusText,
      response.status,
    )
  }

  const total = Number(response.headers.get('content-length')) || item.size
  if (total > 0 && total !== item.size) patchItem(item.id, { size: total })
  const reader = response.body?.getReader()
  if (!reader) throw new CloudDriveApiError('internal', 'The download stream is unavailable', 0)

  const chunks: BlobPart[] = []
  let received = 0
  let lastReport = 0
  for (;;) {
    if (signal.aborted) throw abortError()
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.byteLength
      const now = Date.now()
      if (now - lastReport > 200) {
        lastReport = now
        patchItem(item.id, { transferred: received })
      }
    }
  }
  patchItem(item.id, { transferred: received })
  saveBlob(new Blob(chunks, { type: response.headers.get('content-type') ?? item.mime }), item.name)
}

async function runTransfer(id: string): Promise<void> {
  const item = useTransferStore.getState().items.find((candidate) => candidate.id === id)
  if (!item || item.status !== 'queued') return
  const controller = new AbortController()
  controllers.set(id, controller)
  patchItem(id, { status: 'running', transferred: 0, errorKey: null, finishedAt: null })
  try {
    if (item.kind === 'upload') await runUpload(item, controller.signal)
    else await runDownload(item, controller.signal)
    patchItem(id, { status: 'success', transferred: item.size, finishedAt: Date.now() })
  } catch (error) {
    if (controller.signal.aborted || isAbort(error)) {
      patchItem(id, { status: 'cancelled', finishedAt: Date.now() })
    } else {
      patchItem(id, {
        status: 'error',
        errorKey: error instanceof TransferError ? error.key : cloudDriveErrorKey(error),
        finishedAt: Date.now(),
      })
    }
  } finally {
    controllers.delete(id)
    persistHistory()
    schedule()
  }
}

export const useTransferStore = create<TransferState>((set, get) => ({
  items: [],

  enqueueUpload(files, target) {
    if (files.length === 0) return []
    const now = Date.now()
    const items: TransferItem[] = files.map((file) => ({
      id: transferId(),
      kind: 'upload',
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      transferred: 0,
      status: 'queued',
      errorKey: null,
      createdAt: now,
      finishedAt: null,
      mountId: target.mountId,
      parentPath: target.parentPath,
      entryId: null,
      sessionId: null,
      file,
    }))
    set((state) => ({ items: [...state.items, ...items] }))
    schedule()
    return items.map((item) => item.id)
  },

  enqueueDownload(entry) {
    if (entry.kind !== 'file') {
      // A folder has no single content response; the caller should queue each file instead.
      console.warn('[inkstone] CloudDrive folder downloads are not queued as one transfer')
      return ''
    }
    const item: TransferItem = {
      id: transferId(),
      kind: 'download',
      name: entry.name,
      mime: entry.mime,
      size: entry.size,
      transferred: 0,
      status: 'queued',
      errorKey: null,
      createdAt: Date.now(),
      finishedAt: null,
      mountId: entry.mountId,
      parentPath: null,
      entryId: entry.id,
      sessionId: null,
    }
    set((state) => ({ items: [...state.items, item] }))
    schedule()
    return item.id
  },

  cancel(id) {
    const item = get().items.find((candidate) => candidate.id === id)
    if (!item) return
    if (item.status === 'queued') {
      patchItem(id, { status: 'cancelled', finishedAt: Date.now() })
      persistHistory()
      schedule()
      return
    }
    if (item.status !== 'running') return
    controllers.get(id)?.abort()
    if (item.sessionId) {
      void clouddriveApi.abortUpload(item.sessionId).catch((error) => {
        console.warn('[inkstone] CloudDrive upload session could not be aborted', error)
      })
    }
  },

  retry(id) {
    const item = get().items.find((candidate) => candidate.id === id)
    if (!item || (item.status !== 'error' && item.status !== 'cancelled')) return
    if (item.kind === 'upload' && !item.file) {
      patchItem(id, {
        status: 'error',
        errorKey: 'clouddrive.transfers.file_unavailable',
        finishedAt: Date.now(),
      })
      persistHistory()
      return
    }
    patchItem(id, {
      status: 'queued',
      transferred: 0,
      errorKey: null,
      finishedAt: null,
      sessionId: null,
    })
    schedule()
  },

  clearFinished() {
    set((state) => ({ items: state.items.filter((item) => !isTerminal(item.status)) }))
    persistHistory()
  },

  remove(id) {
    const item = get().items.find((candidate) => candidate.id === id)
    if (!item || !isTerminal(item.status)) return
    set((state) => ({ items: state.items.filter((candidate) => candidate.id !== id) }))
    persistHistory()
  },

  hydrate(userId) {
    if (historyUserId === userId) return
    historyUserId = userId
    const history = readHistory(userId)
    set((state) => {
      const merged = new Map(state.items.map((item) => [item.id, item]))
      for (const record of history) {
        if (!merged.has(record.id)) merged.set(record.id, record)
      }
      return { items: [...merged.values()] }
    })
  },
}))
