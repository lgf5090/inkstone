import type { HubAttachmentWithUsage } from '@shared/attachment-hub'
import { AssistantStore } from '../assistant/store'
import { saveChatUpload } from '../assistant/chat-files'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { saveMemoAttachment } from '../memos/attachments'
import type { Env } from '../env'
import { getHubAttachment, patchHubRow } from './hub-rows'
import { persistAttachmentWithinQuota, persistEmailAttachment } from './storage'
import type { AttachmentHubScope } from '@shared/attachment-hub'

/**
 * Writing one file into whichever application asked for it.
 *
 * Each application already owns a careful upload path — memos takes a thumbnail and a motion role
 * and stamps its clock in seconds, chat sniffs an image from a document and caps them
 * differently, notes and todos share the quota lease and the magic-number downgrade. The hub does
 * not reimplement any of that: it calls the door the application already guards, then reads the
 * row back through the hub's own reader so the caller sees one shape regardless.
 *
 * Re-reading rather than reshaping the writer's return is deliberate. Three different row types
 * would otherwise have to be mapped by hand here and kept in step with three tables forever, where
 * one read through the listing path is the same projection the listing itself uses.
 */
export interface HubUploadInput {
  userId: string
  scope: AttachmentHubScope
  bytes: Uint8Array
  filename: string
  mime: string
  folderId: string | null
}

export async function uploadHubFile(
  env: Env,
  input: HubUploadInput,
): Promise<HubAttachmentWithUsage> {
  // Chat names its own row: `saveChatUpload` mints the id inside the same call that writes the
  // object, so the hub cannot pre-declare it. The others take the id chosen here.
  let id = newId()
  switch (input.scope) {
    case 'notes':
    case 'todos':
      await persistAttachmentWithinQuota(env, {
        id,
        userId: input.userId,
        scope: input.scope,
        noteId: null,
        filename: input.filename,
        reportedMime: input.mime,
        bytes: input.bytes,
        createdAt: Date.now(),
      })
      break
    case 'memos':
      await saveMemoAttachment(env, {
        id,
        userId: input.userId,
        memoId: null,
        filename: input.filename,
        reportedMime: input.mime,
        bytes: input.bytes,
        thumbnail: null,
        mediaMetadata: null,
        motionGroupId: null,
        motionRole: null,
        // Memos stamps seconds; the hub's reader widens it on the way out rather than asking this
        // table to carry a second clock.
        createdAt: Math.floor(Date.now() / 1000),
      })
      break
    case 'chat': {
      const created = await saveChatUpload(new AssistantStore(env.DB, input.userId, env), env, {
        bytes: input.bytes,
        mime: input.mime,
        filename: input.filename,
      })
      id = created.id
      break
    }
    case 'email':
      await persistEmailAttachment(env, {
        id,
        userId: input.userId,
        accountId: null,
        emailId: null,
        filename: input.filename,
        reportedMime: input.mime,
        bytes: input.bytes,
        locked: false,
        createdAt: Date.now(),
      })
      break
  }

  if (input.folderId) {
    await patchHubRow(env.DB, input.userId, input.scope, id, { folderId: input.folderId })
  }

  const stored = await getHubAttachment(env.DB, input.userId, input.scope, id)
  if (!stored) throw new ApiError(503, 'storage_unavailable', 'The upload did not record a file')
  return stored
}
