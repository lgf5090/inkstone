/**
 * Project writes that failed on the network are kept in the account's IndexedDB outbox and replayed
 * in order. The queued row's write id becomes the server's Idempotency-Key, so a create whose answer
 * was lost cannot be repeated by the replay. A permanent refusal is announced and then dropped —
 * keeping it forever would retry a request the server has already rejected.
 */
import { ApiError, CLIENT_ID, request as baseRequest } from '../../lib/api'
import { localDb, type OutboxItem } from '../../lib/db'
import { t } from '../../lib/i18n'
import { randomLocalId } from '../../lib/random-id'
import {
  PROJECT_OUTBOX_CHANGED_EVENT, PROJECT_OUTBOX_FLUSHED_EVENT, PROJECT_OUTBOX_SYNC_TAG,
} from '../../lib/runtime'
import { useUi } from '../../store/ui'

interface ProjectOutboxPayload {
  path: string
  method: string
  body?: unknown
}

export type ProjectOutboxOutcome = { status: 'done' } | { status: 'retry' } | { status: 'offline' }

function isProjectOutboxPayload(payload: unknown): payload is ProjectOutboxPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const value = payload as Record<string, unknown>
  return typeof value.path === 'string' && value.path.startsWith('/api/project/')
    && typeof value.method === 'string'
    && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(value.method)
}

function emit(name: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(name))
}

function boardIdOf(path: string): string {
  return /^\/api\/project\/boards\/([^/]+)/.exec(path)?.[1] ?? ''
}

/** Ask the service worker for a Background Sync pass in case the tab is closed before it reconnects. */
export async function requestProjectOutboxSync(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const registration = await navigator.serviceWorker.ready
    const sync = (registration as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> }
    }).sync
    await sync?.register(PROJECT_OUTBOX_SYNC_TAG)
  } catch (error) {
    console.warn('[inkstone] project background sync registration failed:', error)
  }
}

export async function enqueueProjectWrite(path: string, method: string, body: unknown): Promise<void> {
  const writeId = randomLocalId('pw')
  const item: OutboxItem = {
    id: writeId,
    clientId: CLIENT_ID,
    writeId,
    entity: 'project',
    entityId: boardIdOf(path),
    payload: { path, method, ...(body === undefined ? {} : { body }) },
    attempts: 0,
    createdAt: Date.now(),
  }
  await localDb.enqueueOutbox(item)
  emit(PROJECT_OUTBOX_CHANGED_EVENT)
  await requestProjectOutboxSync()
}

export async function pendingProjectWrites(): Promise<number> {
  const items = await localDb.getOutbox()
  return items.filter((item) => item.entity === 'project').length
}

export async function replayProjectOutboxItem(item: OutboxItem): Promise<ProjectOutboxOutcome> {
  const payload = item.payload
  if (!isProjectOutboxPayload(payload)) {
    await localDb.markOutboxFailure(item.id, item.writeId, 'invalid offline project write').catch((error: unknown) => {
      console.warn('[inkstone] project outbox row could not be marked:', error)
    })
    return { status: 'retry' }
  }
  try {
    await baseRequest(payload.path, {
      method: payload.method,
      ...(payload.body === undefined ? {} : { body: payload.body }),
      idempotencyKey: item.writeId,
    })
  } catch (error) {
    if (error instanceof ApiError && (error.isOffline || error.status >= 500)) {
      await localDb.markOutboxFailure(item.id, item.writeId, error.message).catch((cause: unknown) => {
        console.warn('[inkstone] project outbox retry could not be recorded:', cause)
      })
      return { status: 'offline' }
    }
    useUi.getState().toast({
      title: t('project.offline.replay_failed', { message: error instanceof Error ? error.message : String(error) }),
      tone: 'danger',
    })
  }
  emit(PROJECT_OUTBOX_FLUSHED_EVENT)
  return { status: 'done' }
}
