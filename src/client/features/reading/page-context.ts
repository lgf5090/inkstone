/**
 * What the reading app is showing, for the assistant's page context.
 *
 * The dock needs two things this app already knows but keeps in two components: the shelf's open filter
 * and the reader's place in a book. They live here rather than being lifted into props, because the
 * shelf and the open book are different screens of one tab and both would otherwise have to thread a
 * callback up through `ReadingApp`. Nothing here is a source of truth for the UI: the shelf writes its
 * filter here, the reader writes its position, and `ReadingApp` reads both to describe the page.
 */
import { create } from 'zustand'

export type ShelfFilter = 'all' | 'reading' | 'finished' | 'marked'
export type ShelfSort = 'recent' | 'added' | 'title' | 'author' | 'progress'

/** Where the reader is, in the reader's terms rather than the position codec's. */
export interface OpenBookView {
  id: string
  title: string
  author: string
  format: string
  /** Zero-based spine index, the same number the reader's own marks carry. */
  chapter: number
  chapterCount: number
  chapterTitle: string | null
  /** The page inside the chapter, and its count, which is what the bottom bar reports. */
  page: number
  pages: number
  /** 0…1 across the whole book. */
  fraction: number
}

interface ReadingPageState {
  shelfFilter: ShelfFilter
  shelfSort: ShelfSort
  shelfQuery: string
  shelfGroupId: string | null
  setShelfFilter: (filter: ShelfFilter) => void
  setShelfSort: (sort: ShelfSort) => void
  setShelfQuery: (query: string) => void
  setShelfGroupId: (groupId: string | null) => void
  openBook: OpenBookView | null
  setOpenBook: (book: OpenBookView | null) => void
}

export const useReadingPage = create<ReadingPageState>((set) => ({
  shelfFilter: 'all',
  shelfSort: 'recent',
  shelfQuery: '',
  shelfGroupId: null,
  setShelfFilter: (shelfFilter) => set({ shelfFilter }),
  setShelfSort: (shelfSort) => set({ shelfSort }),
  setShelfQuery: (shelfQuery) => set({ shelfQuery }),
  setShelfGroupId: (shelfGroupId) => set({ shelfGroupId }),
  openBook: null,
  setOpenBook: (openBook) => set({ openBook }),
}))
