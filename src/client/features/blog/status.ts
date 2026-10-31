import { create } from 'zustand'
import type { BlogPostStatus } from '@shared/blog/model'
import { api } from '../../lib/api'

interface BlogNoteStatusState {
  byNote: Record<string, BlogPostStatus>
  loading: boolean
  loaded: boolean
  load: () => Promise<void>
  reload: () => Promise<void>
}

let inflight: Promise<void> | null = null

export const useBlogNoteStatus = create<BlogNoteStatusState>((set, get) => ({
  byNote: {},
  loading: false,
  loaded: false,
  load: async () => {
    if (get().loaded || inflight) return inflight ?? Promise.resolve()
    set({ loading: true })
    inflight = api.blog.noteStatus()
      .then((response) => {
        const byNote: Record<string, BlogPostStatus> = {}
        for (const item of response.items) byNote[item.noteId] = item.status as BlogPostStatus
        set({ byNote, loaded: true, loading: false })
      })
      .catch((error) => {
        console.warn('[blog] note status unavailable', error)
        set({ loaded: true, loading: false })
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  },
  reload: async () => {
    set({ loaded: false })
    await get().load()
  },
}))

export function isBlogPublished(status: BlogPostStatus | undefined): boolean {
  return status === 'published' || status === 'scheduled'
}

export function blogStatusKey(status: BlogPostStatus): 'notes.blog_published' | 'notes.blog_scheduled' | 'notes.blog_pending' | 'notes.blog_draft' {
  switch (status) {
    case 'published': return 'notes.blog_published'
    case 'scheduled': return 'notes.blog_scheduled'
    case 'pending_snapshot': return 'notes.blog_pending'
    default: return 'notes.blog_draft'
  }
}
