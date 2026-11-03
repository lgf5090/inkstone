/**
 * The reading app: a shelf, and one book at a time.
 *
 * The tab rail gives this container its own address, so a book gets a child of it. That is what makes
 * a `↩` in a reading note a normal link the app already knows how to follow, rather than a custom
 * scheme the note renderer would have to learn about.
 *
 * The assistant's column sits beside the shelf or the page, the way it does in the calendar: the reader
 * asks "what am I reading" or "what did I mark here" without leaving the book. What the dock is told is
 * the screen's own facts — the open filter on the shelf, the book, chapter, page and progress while
 * reading — because a dock that only knew it was "reading" would answer about the wrong book after a
 * tab switch.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSession } from '../../store/session'
import { usePathname } from '../../lib/app-history'
import { useBreakpoint } from '../../lib/hooks'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { useLibrary } from './store/library'
import { useReaderSettings } from './store/reader-settings'
import { useReadingPage } from './page-context'
import { LibraryView } from './LibraryView'
import { ReaderView } from './reader/ReaderView'
import { AssistantDock } from '../chat/AssistantDock'
import type { AssistantPageContext } from '@shared/assistant'

/** The book a path names, or null for the shelf itself. */
export function bookIdInPath(pathname: string): string | null {
  const match = /^\/reading\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return match[1]!
  }
}

const SHELF_FILTER_KEYS = {
  all: 'reading.filter_all',
  reading: 'reading.filter_reading',
  finished: 'reading.filter_finished',
  marked: 'reading.filter_marked',
} as const

export function ReadingApp() {
  const userId = useSession((state) => state.user?.id ?? null)
  const pathname = usePathname()
  const bookId = bookIdInPath(pathname)
  const status = useLibrary((state) => state.status)
  const bindUser = useLibrary((state) => state.bindUser)
  const loadFonts = useReaderSettings((state) => state.loadFonts)
  const [fontsLoaded, setFontsLoaded] = useState(false)
  const book = useLibrary((state) => (bookId ? state.books.find((one) => one.id === bookId) : undefined))
  const dockOpen = useUi((state) => state.assistantDockOpen)
  const isMobile = useBreakpoint() === 'mobile'
  const openBook = useReadingPage((state) => state.openBook)
  const shelfFilter = useReadingPage((state) => state.shelfFilter)
  const shelfSort = useReadingPage((state) => state.shelfSort)
  const shelfQuery = useReadingPage((state) => state.shelfQuery)
  const shelfGroupId = useReadingPage((state) => state.shelfGroupId)
  const groups = useLibrary((state) => state.groups)
  const bookCount = useLibrary((state) => state.books.length)

  useEffect(() => {
    void bindUser(userId)
  }, [userId, bindUser])

  useEffect(() => {
    if (fontsLoaded) return
    setFontsLoaded(true)
    void loadFonts()
  }, [fontsLoaded, loadFonts])

  // A path may name a book this device does not have — a link opened on another machine, or a book
  // deleted since. The shelf is the only honest answer, and the address goes back with it.
  useEffect(() => {
    if (!bookId || status !== 'ready') return
    if (book) return
    window.history.replaceState(null, '', '/reading')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [bookId, book, status])

  const pageContext = useMemo((): AssistantPageContext | null => {
    if (bookId && (openBook ?? book)) {
      const current = openBook ?? {
        id: book!.id,
        title: book!.title,
        author: book!.author,
        format: book!.format,
        chapter: 0,
        chapterCount: book!.unitCount,
        chapterTitle: null,
        page: 1,
        pages: 1,
        fraction: 0,
      }
      const facts = [
        `book: ${current.title}`,
        current.author ? `author: ${current.author}` : '',
        current.format === 'epub'
          ? `chapter: ${current.chapter + 1} of ${Math.max(1, current.chapterCount)}`
          : `page: ${current.page} of ${Math.max(1, current.pages)}`,
        current.chapterTitle ? `chapter title: ${current.chapterTitle}` : '',
        current.format === 'epub' ? `page in chapter: ${current.page} of ${Math.max(1, current.pages)}` : '',
        `progress: ${Math.round(Math.min(1, Math.max(0, current.fraction)) * 100)}%`,
        `format: ${current.format}`,
      ].filter(Boolean)
      return { surface: 'reading', label: current.title, facts }
    }
    const group = groups.find((one) => one.id === shelfGroupId)
    const facts = [
      `filter: ${t(SHELF_FILTER_KEYS[shelfFilter])}`,
      `sort: ${shelfSort}`,
      group ? `group: ${group.name}` : '',
      shelfQuery ? `search: ${shelfQuery}` : '',
      `books on shelf: ${bookCount}`,
    ].filter(Boolean)
    return { surface: 'reading', label: t('reading.shelf'), facts }
  }, [book, bookCount, bookId, groups, openBook, shelfFilter, shelfGroupId, shelfQuery, shelfSort])

  const content = useMemo(() => {
    if (status !== 'ready') {
      return (
        <div className="flex h-full items-center justify-center text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">
          {t('reading.loading_library')}
        </div>
      )
    }
    if (bookId && book) return <ReaderView book={book} />
    return <LibraryView />
  }, [book, bookId, status])

  return (
    <div className="flex h-full min-h-0 bg-[var(--bg-base)]">
      <section className="flex min-w-0 flex-1 flex-col" data-reading-app="">
        {content}
      </section>
      {dockOpen && !isMobile ? <AssistantDock surface="reading" pageContext={pageContext} /> : null}
    </div>
  )
}
