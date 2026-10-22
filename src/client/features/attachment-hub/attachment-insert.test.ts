import { describe, expect, it } from 'vitest'
import type { HubAttachmentWithUsage } from '@shared/attachment-hub'
import { attachmentInsertMarkdown } from './attachment-insert'

function file(over: Partial<HubAttachmentWithUsage>): HubAttachmentWithUsage {
  return {
    id: '01m5hvmm6xx6q3a8txx54nbeyy',
    scope: 'notes',
    filename: 'report.pdf',
    mime: 'application/pdf',
    size: 10,
    width: null,
    height: null,
    url: '/api/files/01m5hvmm6xx6q3a8txx54nbeyy',
    thumbnailUrl: null,
    folderId: null,
    isStarred: false,
    isPinned: false,
    tags: [],
    ownerId: null,
    createdAt: 1,
    references: 0,
    ...over,
  }
}

describe('attachmentInsertMarkdown', () => {
  it('names an image with its filename so the alt text is not empty', () => {
    expect(attachmentInsertMarkdown(file({ filename: 'cat.png', mime: 'image/png' })))
      .toBe('![cat.png](/api/files/01m5hvmm6xx6q3a8txx54nbeyy)')
  })

  it('puts a document link on its own line so it cannot glue onto a sentence', () => {
    expect(attachmentInsertMarkdown(file({}))).toBe(
      '\n[report.pdf](/api/files/01m5hvmm6xx6q3a8txx54nbeyy)\n',
    )
  })

  it('escapes the brackets a filename may carry', () => {
    expect(attachmentInsertMarkdown(file({ filename: 'a[b]c.txt', mime: 'text/plain' })))
      .toBe('\n[a\\[b\\]c.txt](/api/files/01m5hvmm6xx6q3a8txx54nbeyy)\n')
  })

  it('escapes a backslash before the brackets, not after', () => {
    expect(attachmentInsertMarkdown(file({ filename: 'back\\slash.md', mime: 'text/markdown' })))
      .toBe('\n[back\\\\slash.md](/api/files/01m5hvmm6xx6q3a8txx54nbeyy)\n')
  })
})
