import { describe, expect, it } from 'vitest'
import {
  attachmentScopeSearch,
  attachmentSource,
  groupAttachmentsByMonth,
  isUnusedAttachment,
  monthKey,
  readAttachmentScope,
  summarizeAttachments,
  type MemoAttachmentWithSource,
} from './attachment-groups'

let nextId = 0

function attachment(overrides: Partial<MemoAttachmentWithSource> = {}): MemoAttachmentWithSource {
  nextId += 1
  return {
    id: `attachment-${nextId}`,
    filename: `file-${nextId}`,
    mime: 'image/jpeg',
    size: 1000,
    width: null,
    height: null,
    url: `/api/memos/files/attachment-${nextId}`,
    thumbnailUrl: null,
    motion: null,
    mediaMetadata: null,
    createdAt: Math.floor(new Date(2024, 4, 12, 12).getTime() / 1000),
    ...overrides,
  }
}

describe('attachment scope URL state', () => {
  it('reads a known scope and falls back to all', () => {
    expect(readAttachmentScope('')).toBe('all')
    expect(readAttachmentScope('?scope=media')).toBe('media')
    expect(readAttachmentScope('?scope=unused')).toBe('unused')
    expect(readAttachmentScope('?scope=everything')).toBe('all')
    expect(readAttachmentScope('?scope=')).toBe('all')
  })

  it('writes the scope without dropping other parameters', () => {
    expect(attachmentScopeSearch('q=cat&scope=media', 'audio')).toBe('q=cat&scope=audio')
    expect(attachmentScopeSearch('scope=unused', 'all')).toBe('')
    expect(attachmentScopeSearch('q=cat', 'documents')).toBe('q=cat&scope=documents')
  })
})

describe('month grouping', () => {
  it('keys a timestamp by its local calendar month', () => {
    expect(monthKey(Math.floor(new Date(2024, 0, 31, 23, 30).getTime() / 1000))).toBe('2024-01')
    expect(monthKey(Math.floor(new Date(2024, 11, 1, 0, 5).getTime() / 1000))).toBe('2024-12')
    expect(monthKey(Number.NaN)).toBe('0000-00')
  })

  it('groups in the order the items arrive and keeps the items inside each group', () => {
    const mayFirst = attachment({ createdAt: Math.floor(new Date(2024, 4, 20, 12).getTime() / 1000) })
    const april = attachment({ createdAt: Math.floor(new Date(2024, 3, 2, 12).getTime() / 1000) })
    const maySecond = attachment({ createdAt: Math.floor(new Date(2024, 4, 3, 12).getTime() / 1000) })
    const groups = groupAttachmentsByMonth([mayFirst, april, maySecond])
    expect(groups.map((group) => group.key)).toEqual(['2024-05', '2024-04'])
    expect(groups[0]?.items.map((item) => item.id)).toEqual([mayFirst.id, maySecond.id])
    expect(groups[1]?.items.map((item) => item.id)).toEqual([april.id])
  })

  it('never mutates the incoming list', () => {
    const items = [attachment(), attachment()]
    const copy = [...items]
    groupAttachmentsByMonth(items)
    expect(items).toEqual(copy)
  })
})

describe('library totals', () => {
  it('counts server scopes and unused storage in one pass', () => {
    const usedPhoto = attachment({ size: 100, memoId: 'memo-1' })
    const unusedPhoto = attachment({ size: 200, memoId: null })
    const svg = attachment({ mime: 'image/svg+xml', size: 300, memoId: null })
    const audio = attachment({ mime: 'audio/mpeg', size: 400, memoId: 'memo-1' })
    const document = attachment({ mime: 'application/pdf', size: 500, memoId: null })
    const video = attachment({ mime: 'video/mp4', size: 600, memoId: 'memo-1' })
    const totals = summarizeAttachments([usedPhoto, unusedPhoto, svg, audio, document, video])
    expect(totals.counts).toEqual({ all: 6, media: 4, audio: 1, documents: 1, unused: 3 })
    expect(totals.totalBytes).toBe(2100)
    expect(totals.unusedBytes).toBe(1000)
  })

  it('treats a missing memoId as unknown rather than unused', () => {
    const totals = summarizeAttachments([attachment({ memoId: undefined })])
    expect(totals.counts.unused).toBe(0)
    expect(isUnusedAttachment(attachment({ memoId: undefined }))).toBe(false)
    expect(isUnusedAttachment(attachment({ memoId: null }))).toBe(true)
  })
})

describe('source memo summary', () => {
  it('reads the memo the API returns beside an attachment', () => {
    const source = { id: 'memo-1', title: 'May trip', snippet: 'A week away' }
    expect(attachmentSource(attachment({ memoId: 'memo-1', memo: source }))).toEqual(source)
    expect(attachmentSource(attachment({ memoId: null, memo: null }))).toBeNull()
  })
})
