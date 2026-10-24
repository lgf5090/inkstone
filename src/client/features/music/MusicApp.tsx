/**
 * The music container's frame: a second navigation rail, the screen area and the play bar.
 *
 * This is a skeleton on purpose. The rail and the bar own the geometry the later panels will fill,
 * and the screen area says which address is open rather than pretending to be a page that has not
 * been written. Replacing the placeholder is a page task; the frame, the player restore and the
 * address mirror are what this file is for.
 */
import { useEffect, useId, useMemo, type ComponentType, type ReactElement } from 'react'
import { Compass, Library, Music, Search, Settings } from 'lucide-react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import type { MessageKey } from '@shared/locales/en-US'
import { cn } from '../../lib/cn'
import { navigateToAddress, usePathname, useSearch } from '../../lib/app-history'
import { t } from '../../lib/i18n'
import { parseMusicAddress, type MusicPage } from './music-address'
import { selectCurrentTrack, useMusicPlayer } from './store/player'
import { useMusicUi } from './store/ui'

/**
 * The music catalog arrives in its own locale fragment later. Until it does, `t` answers with the key
 * itself, which is readable in development and cannot drift into copy that would need translating
 * twice. The cast is the seam that fragment removes.
 */
function musicText(key: string): string {
  return t(key as MessageKey)
}

interface NavItem {
  path: string
  labelKey: string
  icon: ComponentType<{ size?: number; className?: string }>
}

const NAV_ITEMS: readonly NavItem[] = [
  { path: '/music', labelKey: 'music.nav.discover', icon: Compass },
  { path: '/music/search', labelKey: 'music.nav.search', icon: Search },
  { path: '/music/favorites', labelKey: 'music.nav.library', icon: Library },
  { path: '/music/settings', labelKey: 'music.nav.settings', icon: Settings },
]

const PAGE_TITLE_KEYS: Record<MusicPage['kind'], string> = {
  home: 'music.page.home',
  search: 'music.page.search',
  playlist: 'music.page.playlist',
  album: 'music.page.album',
  artist: 'music.page.artist',
  toplist: 'music.page.toplist',
  mv: 'music.page.mv',
  mvDetail: 'music.page.mv_detail',
  podcast: 'music.page.podcast',
  podcastDetail: 'music.page.podcast_detail',
  favorites: 'music.page.favorites',
  history: 'music.page.history',
  uploads: 'music.page.uploads',
  downloads: 'music.page.downloads',
  user: 'music.page.user',
  login: 'music.page.login',
  settings: 'music.page.settings',
  notFound: 'music.page.not_found',
}

function normalise(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function isNavActive(pathname: string, path: string): boolean {
  const current = normalise(pathname)
  if (path === '/music') return current === '/music'
  return current === path || current.startsWith(`${path}/`)
}

function MusicNavLink({ item, active }: { item: NavItem; active: boolean }): ReactElement {
  const Icon = item.icon
  return (
    <a
      href={item.path}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        // A modified press or a middle click belongs to the browser: let it open a new tab.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigateToAddress(item.path)
      }}
      className={cn(
        'flex shrink-0 items-center gap-2 rounded-[var(--r-md)] px-2.5 py-2 text-[length:var(--text-13)]',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
        active
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon size={15} className="shrink-0" />
      <span className="truncate">{musicText(item.labelKey)}</span>
    </a>
  )
}

export function MusicApp(): ReactElement {
  const pathname = usePathname()
  const search = useSearch()
  const page = useMemo(() => parseMusicAddress(pathname, search), [pathname, search])
  const current = useMusicPlayer(selectCurrentTrack)
  const awaitingGesture = useMusicPlayer((state) => state.awaitingGesture)
  const headingId = useId()

  // A restored queue is a promise the browser will not let us keep without a gesture: it comes back
  // paused, and the bar says so. Restore is idempotent, which is what makes the StrictMode second
  // call harmless.
  useEffect(() => {
    useMusicPlayer.getState().restore()
  }, [])

  // The address is the source of truth; the store mirrors it so panels can read one selector.
  useEffect(() => {
    useMusicUi.getState().setPage(page)
  }, [page])

  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3">
        <Music size={15} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <h1 id={headingId} className="min-w-0 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]">
          {musicText(PAGE_TITLE_KEYS[page.kind])}
        </h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] md:w-[var(--nav-w)] md:border-b-0 md:border-r">
          <nav
            aria-label={musicText('music.nav.label')}
            className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-visible"
          >
            {NAV_ITEMS.map((item) => (
              <MusicNavLink key={item.path} item={item} active={isNavActive(pathname, item.path)} />
            ))}
          </nav>
        </aside>

        <main aria-labelledby={headingId} className="min-h-0 min-w-0 flex-1 overflow-auto p-3 md:p-4">
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)] bg-[var(--bg-sunken)] px-6 py-10 text-center">
            <p className="text-[length:var(--text-13-5)] font-medium text-[var(--text-secondary)]">
              {musicText('music.placeholder.title')}
            </p>
            <p className="mt-1.5 max-w-[320px] text-[length:var(--text-12)] leading-relaxed text-[var(--text-quaternary)]">
              {musicText('music.placeholder.description')}
            </p>
          </div>
        </main>
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 pt-2 pb-[calc(var(--sp-2)+env(safe-area-inset-bottom))]">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-[var(--r-md)] bg-[var(--bg-raised)] text-[var(--text-quaternary)]"
          aria-hidden="true"
        >
          <Music size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
            {current ? current.title : musicText('music.playbar.empty')}
          </p>
          <p className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {current
              ? musicArtistNames(current)
              : musicText(awaitingGesture ? 'music.playbar.resume' : 'music.playbar.hint')}
          </p>
        </div>
        {current && (
          <span className="shrink-0 text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">
            {formatDuration(current.durationMs)}
          </span>
        )}
      </footer>
    </section>
  )
}
