import { describe, expect, it } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { updateNoteSummaryRecord } from './note-summary-record'

function summary(id: string): NoteSummary {
  return {
    id,
    title: id,
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
}

describe('note summary record', () => {
  it('publishes keyed updates without enumerating the vault again', () => {
    let enumerations = 0
    const source = new Proxy(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`note-${index}`, summary(`note-${index}`)])), {
      ownKeys(target) {
        enumerations += 1
        return Reflect.ownKeys(target)
      },
    })
    const first = updateNoteSummaryRecord(source, 'note-0', { ...summary('note-0'), excerpt: 'changed' })
    expect(enumerations).toBe(1)

    enumerations = 0
    let current = first
    for (let index = 1; index < 100; index += 1) {
      current = updateNoteSummaryRecord(current, `note-${index}`, { ...summary(`note-${index}`), excerpt: 'changed' })
    }
    expect(enumerations).toBe(0)
    expect(Object.values(current)).toHaveLength(100)
    expect(Object.values(current).every((note) => note.excerpt === 'changed')).toBe(true)
  })
})
