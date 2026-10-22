/**
 * The client's half of a task's files.
 *
 * `POST /api/todos/:id/attachments` has carried the whole job since the attachment round: the same
 * storage every note file uses, with the account's hourly upload budget, the multipart ceiling, the
 * 25 MB limit, the MIME sniffing, the filename cleanup, the quota and the link row all read on the
 * server. What was missing was a caller (C12). This is that caller, and it adds nothing to the
 * contract — one multipart field named `file`, posted to the task it belongs to.
 *
 * The one judgement made here is a courtesy, not a boundary: a file already known to be over the limit
 * is refused before its bytes are sent, so the reader hears about it in the time it takes to let go of
 * the pointer rather than after an upload that was always going to be refused. Everything else — the
 * type, the content, the path, the quota, the budget — is the route's to decide, and its answer is what
 * reaches the reader. Nothing about a limit rides in the request, and no file is checked twice here.
 *
 * Files go one at a time. A hand of them fired together would race the hourly budget for the same
 * account and report a failure count nobody could tie to a file.
 */
import { request } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { LIMITS } from '@shared/constants'
import type { Attachment } from '@shared/types'

/** The limit the client may name before it asks, in the megabytes the reader counts in. */
const MAX_MB = Math.round(LIMITS.attachmentMaxBytes / (1024 * 1024))

/** Upload one file onto one task and hand back the row the server linked. */
export async function uploadTaskFile(taskId: string, file: File): Promise<Attachment> {
  const form = new FormData()
  form.set('file', file)
  const body = await request<{ attachment: Attachment }>(
    `/api/todos/${encodeURIComponent(taskId)}/attachments`,
    { method: 'POST', formData: form },
  )
  return body.attachment
}

/** The files a row may be given, split by the only limit the client is allowed to know about. */
export function splitBySize(files: readonly File[]): { accepted: File[]; refused: number } {
  const accepted = files.filter((entry) => entry.size <= LIMITS.attachmentMaxBytes)
  return { accepted, refused: files.length - accepted.length }
}

/**
 * Hands every accepted file to the task's own route and says, out loud, how many came back.
 *
 * The three states a reader is owed: what landed, what was refused before it was tried, and what the
 * server said no to — the last with the route's own reason beside it, because a count without a reason
 * is a failure the reader cannot act on.
 */
export async function attachFilesToTask(taskId: string, files: readonly File[]): Promise<void> {
  const { accepted, refused } = splitBySize(files)
  if (refused > 0) {
    useUi.getState().toast({
      title: t('todo.attach.too_large', { count: refused, limit: MAX_MB }),
      tone: 'danger',
    })
  }

  let uploaded = 0
  let failure: unknown = null
  for (const entry of accepted) {
    try {
      await uploadTaskFile(taskId, entry)
      uploaded += 1
    } catch (error) {
      // The first refusal is the one worth reading out; the rest are the same answer for the same file
      // the server already has.
      failure ??= error
    }
  }

  if (uploaded > 0) {
    useUi.getState().toast({
      title: t('attachments.uploaded_value0', { value0: uploaded }),
      tone: 'success',
    })
  }
  const rejected = accepted.length - uploaded
  if (rejected > 0) {
    useUi.getState().toast({
      title: t('attachments.upload_failed_value0', { value0: rejected }),
      description: failure instanceof Error ? failure.message : failure == null ? undefined : String(failure),
      tone: 'danger',
    })
  }
}
