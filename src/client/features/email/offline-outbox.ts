import { EMAIL_BODY_MAX_BYTES } from '@shared/email/model'
import { utf8ByteLength } from '@shared/text-utils'

const PREFIX = 'inkstone:email:offline-draft:v1:'

export interface EmailOfflineDraftFields {
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
}

export interface EmailOfflineDraft {
  key: string
  fields: EmailOfflineDraftFields
  threading: { inReplyTo: string | null, threadId: string | null }
  savedAt: number
}

function storageKey(key: string): string {
  return `${PREFIX}${key}`
}

function isFields(value: unknown): value is EmailOfflineDraftFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = value as Record<string, unknown>
  return ['to', 'cc', 'bcc', 'subject', 'body'].every((key) => typeof fields[key] === 'string')
}

export function readEmailOfflineDraft(key: string): EmailOfflineDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const draft = parsed as Partial<EmailOfflineDraft>
    if (draft.key !== key || !isFields(draft.fields) || typeof draft.savedAt !== 'number') return null
    if (utf8ByteLength(draft.fields.body) > EMAIL_BODY_MAX_BYTES) return null
    const threading = draft.threading
    if (!threading || typeof threading !== 'object') return null
    return {
      key,
      fields: draft.fields,
      threading: {
        inReplyTo: typeof threading.inReplyTo === 'string' ? threading.inReplyTo : null,
        threadId: typeof threading.threadId === 'string' ? threading.threadId : null,
      },
      savedAt: draft.savedAt,
    }
  } catch (error) {
    console.warn('[inkstone] Email offline draft could not be read:', error instanceof Error ? error.message : error)
    return null
  }
}

export function saveEmailOfflineDraft(key: string, fields: EmailOfflineDraftFields, threading: EmailOfflineDraft['threading']): void {
  if (utf8ByteLength(fields.body) > EMAIL_BODY_MAX_BYTES) throw new Error('email_offline_draft_too_large')
  const draft: EmailOfflineDraft = { key, fields, threading, savedAt: Date.now() }
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(draft))
  } catch (error) {
    console.error('[inkstone] Email offline draft could not be persisted:', error instanceof Error ? error.message : error)
    throw new Error('email_offline_draft_write_failed')
  }
}

export function removeEmailOfflineDraft(key: string): void {
  try {
    localStorage.removeItem(storageKey(key))
  } catch (error) {
    console.error('[inkstone] Email offline draft could not be removed:', error instanceof Error ? error.message : error)
  }
}

export function clearEmailOfflineDrafts(): void {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith(PREFIX)) keys.push(key)
  }
  let failed = false
  for (const key of keys) {
    try {
      localStorage.removeItem(key)
    } catch (error) {
      failed = true
      console.error('[inkstone] Email offline draft could not be cleared:', error instanceof Error ? error.message : error)
    }
  }
  if (failed) throw new Error('email_offline_draft_clear_failed')
}
