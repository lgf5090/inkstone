import type { Context } from 'hono'
import { deleteAttachmentObjects } from '../attachments/backend'
import type { AttachmentObjectStorage } from '../attachments/keys'
import type { AppBindings, Env } from '../env'
import type { MemoAttachmentObjectRef } from './store'

const OBJECT_DELETE_BATCH = 500

export async function deleteMemoObjects(
  env: Env,
  refs: readonly MemoAttachmentObjectRef[],
): Promise<void> {
  const grouped = new Map<AttachmentObjectStorage, string[]>()
  for (const ref of refs) {
    const keys = grouped.get(ref.storage)
    if (keys) keys.push(ref.key)
    else grouped.set(ref.storage, [ref.key])
  }
  for (const [storage, keys] of grouped) {
    for (let offset = 0; offset < keys.length; offset += OBJECT_DELETE_BATCH) {
      try {
        await deleteAttachmentObjects(env, storage, keys.slice(offset, offset + OBJECT_DELETE_BATCH))
      } catch (error) {
        console.warn('[inkstone] Memo attachment objects could not be deleted:', error)
      }
    }
  }
}

export function scheduleMemoObjectCleanup(
  c: Context<AppBindings>,
  refs: readonly MemoAttachmentObjectRef[],
): void {
  const cleanup = deleteMemoObjects(c.env, refs)
  try {
    c.executionCtx.waitUntil(cleanup)
  } catch (error) {
    console.warn('[inkstone] Memo attachment cleanup has no execution context:', error)
    void cleanup
  }
}
