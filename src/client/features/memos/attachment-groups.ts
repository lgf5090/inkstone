import type { MemoAttachment } from '@shared/memos/types'
import { MEMO_ATTACHMENT_SCOPES, type MemoAttachmentScope } from './api'
import { isAudioAttachment, isMediaAttachment } from './media'

export interface MemoAttachmentSource {
  id: string
  title: string
  snippet: string
}

export type MemoAttachmentWithSource = MemoAttachment & {
  memoId?: string | null
  memo?: MemoAttachmentSource | null
}

export interface AttachmentMonthGroup {
  key: string
  items: MemoAttachment[]
}

export interface AttachmentLibraryTotals {
  counts: Record<MemoAttachmentScope, number>
  totalBytes: number
  unusedBytes: number
}

export function readAttachmentScope(search: string): MemoAttachmentScope {
  const raw = new URLSearchParams(search).get('scope')
  return MEMO_ATTACHMENT_SCOPES.find((scope) => scope === raw) ?? 'all'
}

export function attachmentScopeSearch(search: string, scope: MemoAttachmentScope): string {
  const params = new URLSearchParams(search)
  if (scope === 'all') params.delete('scope')
  else params.set('scope', scope)
  return params.toString()
}

export function monthKey(createdAtSeconds: number): string {
  const date = new Date(createdAtSeconds * 1000)
  if (Number.isNaN(date.getTime())) return '0000-00'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function groupAttachmentsByMonth(items: readonly MemoAttachment[]): AttachmentMonthGroup[] {
  const groups = new Map<string, MemoAttachment[]>()
  for (const item of items) {
    const key = monthKey(item.createdAt)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return [...groups].map(([key, groupItems]) => ({ key, items: groupItems }))
}

export function summarizeAttachments(items: readonly MemoAttachment[]): AttachmentLibraryTotals {
  const counts: Record<MemoAttachmentScope, number> = {
    all: 0,
    media: 0,
    audio: 0,
    documents: 0,
    unused: 0,
  }
  let totalBytes = 0
  let unusedBytes = 0
  for (const item of items) {
    const size = Number.isFinite(item.size) ? item.size : 0
    counts.all += 1
    totalBytes += size
    if (isMediaAttachment(item)) counts.media += 1
    else if (isAudioAttachment(item)) counts.audio += 1
    else counts.documents += 1
    if (isUnusedAttachment(item)) {
      counts.unused += 1
      unusedBytes += size
    }
  }
  return { counts, totalBytes, unusedBytes }
}

export function attachmentSource(attachment: MemoAttachment): MemoAttachmentSource | null {
  const source = (attachment as MemoAttachmentWithSource).memo
  if (!source || typeof source.id !== 'string') return null
  if (typeof source.title !== 'string' || typeof source.snippet !== 'string') return null
  return source
}

export function isUnusedAttachment(attachment: MemoAttachment): boolean {
  return (attachment as MemoAttachmentWithSource).memoId === null
}
