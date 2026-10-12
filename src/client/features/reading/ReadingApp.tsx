/**
 * The reading app: a shelf, and one book at a time.
 *
 * The tab rail gives this container its own address, so a book gets a child of it. That is what makes
 * a `↩` in a reading note a normal link the app already knows how to follow, rather than a custom
 * scheme the note renderer would have to learn about.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSession } from '../../store/session'
import { usePathname } from '../../lib/app-history'
import { useLibrary } from './store/library'
import { useReaderSettings } from './store/reader-settings'
import { LibraryView } from './LibraryView'
import { ReaderView } from './reader/ReaderView'
import { t } from '../../lib/i18n'

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

export function ReadingApp() {
  const userId = useSession((state) => state.user?.id ?? null)
  const pathname = usePathname()
  const bookId = bookIdInPath(pathname)
  const status = useLibrary((state) => state.status)
  const bindUser = useLibrary((state) => state.bindUser)
  const loadFonts = useReaderSettings((state) => state.loadFonts)
  const [fontsLoaded, setFontsLoaded] = useState(false)
  const book = useLibrary((state) => (bookId ? state.books.find((one) => one.id === bookId) : undefined))

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

  const content = useMemo(() => {
    if (status !== 'ready') {
      return (
        <div className="flex h-full items-center justify-center text-[12.5px] text-[var(--text-quaternary)]">
          {t('reading.loading_library')}
        </div>
      )
    }
    if (bookId && book) return <ReaderView book={book} />
    return <LibraryView />
  }, [book, bookId, status])

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-reading-app="">
      {content}
    </section>
  )
}
