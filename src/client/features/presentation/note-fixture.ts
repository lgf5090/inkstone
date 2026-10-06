import type { NoteSummary } from '@shared/types'

/** A note summary with every field named, so a test that seeds the store states only what it cares
 * about. Lives with the presentation tests because the store's own shape is theirs to keep honest. */
export function noteSummary(id: string, overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    title: `Note ${id}`,
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
    createdAt: 1_000,
    updatedAt: 1_000,
    deletedAt: null,
    ...overrides,
  }
}
