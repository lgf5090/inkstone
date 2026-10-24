/**
 * The music app's own navigation rail: what to open, the shelves the reader already has, and the
 * assistant that can act on them. The page under it owns the h1; this rail is landmark navigation and
 * never repeats the title.
 */
import { useState, type ComponentType, type ReactElement } from 'react'
import { Cloud, Compass, Download, HardDrive, History, Library, ListMusic, ListOrdered, MoreHorizontal, Plus, Radio, Search, Settings, Sparkles, UserRound, Video } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Modal } from '../../../components/overlay'
import { navigateToAddress } from '../../../lib/app-history'
import { musicText } from './labels'
import { PlaylistMenu } from './PlaylistMenu'
import { useMusicLibrary } from '../store/library'
import type { MusicPlaylist } from '@shared/music/model'

interface NavItem {
  path: string
  labelKey: string
  icon: ComponentType<{ size?: number; className?: string }>
}

const PRIMARY: readonly NavItem[] = [
  { path: '/music', labelKey: 'music.nav.discover', icon: Compass },
  { path: '/music/search', labelKey: 'music.nav.search', icon: Search },
  { path: '/music/playlists', labelKey: 'music.page.playlists', icon: ListMusic },
  { path: '/music/albums', labelKey: 'music.page.albums', icon: Library },
  { path: '/music/toplists', labelKey: 'music.page.toplists', icon: ListOrdered },
  { path: '/music/mv', labelKey: 'music.page.mv', icon: Video },
  { path: '/music/podcast', labelKey: 'music.page.podcast', icon: Radio },
]

/** One shelf per question: saved songs, what was played, what was fetched, what is stored. */
const SHELF: readonly NavItem[] = [
  { path: '/music/favorites', labelKey: 'music.page.favorites', icon: ListMusic },
  { path: '/music/history', labelKey: 'music.page.history', icon: History },
  { path: '/music/downloads', labelKey: 'music.page.downloads', icon: Download },
  { path: '/music/cloud', labelKey: 'music.nav.drive', icon: Cloud },
  { path: '/music/local', labelKey: 'music.page.local', icon: HardDrive },
]

function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function active(pathname: string, path: string): boolean {
  const current = normalize(pathname)
  if (path === '/music') return current === '/music'
  return current === path || current.startsWith(`${path}/`)
}

function NavLink({ item, current }: { item: NavItem; current: string }): ReactElement {
  const Icon = item.icon
  const isActive = active(current, item.path)
  return (
    <a
      href={item.path}
      aria-current={isActive ? 'page' : undefined}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigateToAddress(item.path)
      }}
      className={cn(
        'flex min-h-9 items-center gap-2 rounded-[var(--r-md)] px-2.5 text-[length:var(--text-13)]',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
        isActive
          ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <Icon size={15} className="shrink-0" />
      <span className="truncate">{musicText(item.labelKey)}</span>
    </a>
  )
}

function PlaylistLink({ playlist, current }: { playlist: MusicPlaylist; current: string }): ReactElement {
  const path = `/music/playlist/${playlist.id}`
  const isActive = active(current, path)
  return (
    <PlaylistMenu
      playlist={playlist}
      onDeleted={() => {
        if (isActive) navigateToAddress('/music/playlists')
      }}
    >
      {(trigger) => (
        <div className="group/playlist relative flex min-w-0 items-center" onContextMenu={trigger.onContextMenu}>
          <a
            href={path}
            aria-current={isActive ? 'page' : undefined}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              navigateToAddress(path)
            }}
            className={cn(
              'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--r-sm)] px-2.5 pe-8 text-[length:var(--text-12)]',
              'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
              isActive
                ? 'bg-[var(--bg-hover)] font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <ListMusic size={13} className="shrink-0" />
            <span className="truncate">{playlist.name}</span>
          </a>
          <span className="absolute end-0.5 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover/playlist:opacity-100 group-focus-within/playlist:opacity-100">
            <IconButton label={musicText('music.playlist.more')} size="xs" {...trigger}>
              <MoreHorizontal size={13} />
            </IconButton>
          </span>
        </div>
      )}
    </PlaylistMenu>
  )
}

export function MusicSidebar({
  pathname,
  assistantOpen,
  onToggleAssistant,
}: {
  pathname: string
  assistantOpen: boolean
  onToggleAssistant: () => void
}): ReactElement {
  const status = useMusicLibrary((state) => state.status)
  const playlists = useMusicLibrary((state) => state.playlists)
  const createPlaylist = useMusicLibrary((state) => state.createPlaylist)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <aside className="flex h-full min-h-0 w-[232px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-3">
      <div className="px-2.5 pb-3">
        <p className="text-[length:var(--text-15)] font-semibold tracking-[var(--tracking-title)] text-[var(--text-primary)]">
          {musicText('music.page.home')}
        </p>
      </div>
      <nav aria-label={musicText('music.nav.label')} className="flex flex-col gap-0.5">
        {PRIMARY.map((item) => <NavLink key={item.path} item={item} current={pathname} />)}
      </nav>
      <div className="mt-4 flex flex-col gap-0.5">
        <p className="px-2.5 pb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
          {musicText('music.nav.library')}
        </p>
        {SHELF.map((item) => <NavLink key={item.path} item={item} current={pathname} />)}
      </div>
      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center justify-between pr-1">
          <p className="px-2.5 pb-1 text-[length:var(--text-10-5)] font-semibold uppercase tracking-[var(--tracking-section)] text-[var(--text-quaternary)]">
            {musicText('music.page.playlist')}
          </p>
          <IconButton label={musicText('music.playlist.create')} size="xs" onClick={() => setCreateOpen(true)}>
            <Plus size={13} />
          </IconButton>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain pr-1">
          {status === 'loading' && (
            <p className="px-2.5 py-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
              {musicText('common.loading')}
            </p>
          )}
          {status !== 'loading' && playlists.length === 0 && (
            <p className="px-2.5 py-2 text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
              {musicText('music.library.playlists_empty')}
            </p>
          )}
          {playlists.slice(0, 30).map((playlist) => (
            <PlaylistLink key={playlist.id} playlist={playlist} current={pathname} />
          ))}
        </div>
      </div>
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={musicText('music.playlist.create')} width={420} dismissible={!creating}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            const value = name.trim()
            if (!value) return
            setCreating(true)
            setError(null)
            void createPlaylist({ name: value }).then((playlist) => {
              if (playlist) navigateToAddress(`/music/playlist/${playlist.id}`)
              setCreateOpen(false)
              setName('')
            }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setCreating(false))
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} placeholder={musicText('music.playlist.name_placeholder')} aria-label={musicText('music.playlist.name')} />
          {error && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => setCreateOpen(false)} disabled={creating}>{musicText('common.cancel')}</Button>
            <Button variant="primary" size="sm" type="submit" loading={creating}>{musicText('music.playlist.create')}</Button>
          </div>
        </form>
      </Modal>
      <div className="mt-2 flex flex-col gap-0.5 border-t border-[var(--border-subtle)] pt-2">
        <NavLink item={{ path: '/music/user', labelKey: 'music.user.me', icon: UserRound }} current={pathname} />
        <button
          type="button"
          aria-pressed={assistantOpen}
          onClick={onToggleAssistant}
          className={cn(
            'flex min-h-9 items-center gap-2 rounded-[var(--r-md)] px-2.5 text-[length:var(--text-13)]',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
            assistantOpen
              ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          <Sparkles size={15} className="shrink-0" />
          <span className="truncate">{musicText('music.nav.assistant')}</span>
        </button>
        <NavLink item={{ path: '/music/settings', labelKey: 'music.nav.settings', icon: Settings }} current={pathname} />
      </div>
    </aside>
  )
}
