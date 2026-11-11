import { useState } from 'react'
import { Copy, ExternalLink, Heart, PackagePlus, PanelLeft, Star } from 'lucide-react'
import type { SavedGithubRepo } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { copyText } from '../../../../lib/clipboard'
import { Button, IconButton } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { Menu, useContextMenu, type MenuItem } from '../../../../components/overlay'
import { useUi } from '../../../../store/ui'
import { formatNumber } from '../lib/format'
import type { GithubSectionView } from '../prefs'
import { GithubAvatar } from './GithubAvatar'
import { ViewToggle } from './ViewToggle'

const ORIGIN = { x: 0, y: 0 }

export function FavoritesView({
  favorites,
  view,
  onViewChange,
  onOpenRepo,
  onToggleFavorite,
  onTrack,
  onOpenSidebar,
  onDiscover,
}: {
  favorites: SavedGithubRepo[]
  view: GithubSectionView
  onViewChange: (view: GithubSectionView) => void
  onOpenRepo: (repo: SavedGithubRepo['data']) => void
  onToggleFavorite: (repo: SavedGithubRepo['data']) => void
  onTrack: (repo: SavedGithubRepo['data']) => void
  onOpenSidebar: () => void
  onDiscover: () => void
}) {
  const toast = useUi((state) => state.toast)
  const menu = useContextMenu()
  const [target, setTarget] = useState<SavedGithubRepo | null>(null)
  const copy = async (value: string) => {
    const ok = await copyText(value)
    toast({ title: ok ? t('development.github.sidebar.copied') : t('development.github.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }
  const openMenu = (entry: SavedGithubRepo, event: React.MouseEvent) => {
    setTarget(entry)
    const row = event.currentTarget as HTMLElement
    row.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    menu.onContextMenu(event)
  }
  const openMenuAt = (entry: SavedGithubRepo, event: React.KeyboardEvent) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    setTarget(entry)
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    menu.openAt({ x: rect.left + 12, y: rect.top + 12 })
  }
  const items: MenuItem[] = target ? [
    { id: 'open', label: t('development.github.store.menu.open_detail'), icon: <ExternalLink size={13} />, onSelect: () => onOpenRepo(target.data) },
    { id: 'github', label: t('development.github.store.menu.open_github'), icon: <ExternalLink size={13} />, onSelect: () => window.open(target.data.url, '_blank', 'noopener,noreferrer') },
    { id: 'copy-name', label: t('development.github.store.menu.copy_name'), icon: <Copy size={13} />, separatorBefore: true, onSelect: () => void copy(target.fullName) },
    { id: 'copy-link', label: t('development.github.store.menu.copy_link'), icon: <Copy size={13} />, onSelect: () => void copy(target.data.url) },
    { id: 'track', label: t('development.github.store.menu.track'), icon: <PackagePlus size={13} />, separatorBefore: true, onSelect: () => onTrack(target.data) },
    { id: 'unfavorite', label: t('development.github.store.unfavorite'), icon: <Heart size={13} />, tone: 'danger', onSelect: () => onToggleFavorite(target.data) },
  ] : []

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="github-favorites">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" className="size-8 shrink-0 md:size-8" onClick={onOpenSidebar}><PanelLeft size={15} /></IconButton>
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('development.github.store.favorites')}</span>
        <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{t('development.github.store.favorites_count', { count: favorites.length })}</span>
        <span className="ml-auto"><ViewToggle value={view} onChange={onViewChange} /></span>
      </div>
      {favorites.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty art="folder" title={t('development.github.store.favorites_empty_title')} description={t('development.github.store.favorites_empty_desc')} action={<Button size="sm" onClick={onDiscover}>{t('development.github.store.go_discover')}</Button>} />
        </div>
      ) : view === 'grid' ? (
        <ul className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] content-start gap-2 overflow-y-auto overscroll-contain p-3" data-slot="github-favorite-grid">
          {favorites.map((entry) => (
            <li
              key={entry.id}
              onContextMenu={(event) => openMenu(entry, event)}
              className="group relative flex min-h-[124px] flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 pr-9 hover:border-[var(--border-strong)] hover:bg-[var(--bg-raised)]"
            >
              <button
                type="button"
                onClick={() => onOpenRepo(entry.data)}
                onKeyDown={(event) => openMenuAt(entry, event)}
                aria-label={entry.fullName}
                className="absolute inset-0 rounded-[var(--r-md)] focus-visible:shadow-[var(--shadow-ring-focus)] focus-visible:outline-none"
              />
              <span className="flex items-start gap-2">
                <GithubAvatar src={entry.data.owner.avatarUrl} name={entry.data.owner.login} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[length:var(--text-12)] font-medium leading-tight text-[var(--text-primary)] group-hover:text-[var(--accent)]">{entry.fullName}</span>
                  <span className="mt-1 line-clamp-2 min-h-[2.2em] text-[length:var(--text-11)] leading-snug text-[var(--text-tertiary)]">{entry.data.description || t('development.github.store.no_description')}</span>
                </span>
              </span>
              <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                <span className="inline-flex items-center gap-1 tabular-nums"><Star size={10} />{formatNumber(entry.data.stargazersCount)}</span>
                {entry.data.language && <span>{entry.data.language}</span>}
              </span>
              <IconButton
                label={t('development.github.store.unfavorite')}
                size="sm"
                className="absolute right-1.5 top-1.5 z-10 bg-[var(--bg-surface)]"
                onClick={() => onToggleFavorite(entry.data)}
              >
                <Heart size={13} className="fill-[var(--accent)] text-[var(--accent)]" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto overscroll-contain" data-slot="github-favorite-list">
          {favorites.map((entry) => (
            <li key={entry.id} className="group flex items-start gap-2.5 px-2.5 py-2.5" onContextMenu={(event) => openMenu(entry, event)}>
              <GithubAvatar src={entry.data.owner.avatarUrl} name={entry.data.owner.login} size={28} className="mt-0.5" />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenRepo(entry.data)} onKeyDown={(event) => openMenuAt(entry, event)}>
                <span className="block truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)] hover:text-[var(--accent)]">{entry.fullName}</span>
                {entry.data.description && <span className="mt-0.5 block truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">{entry.data.description}</span>}
                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                  <span className="inline-flex items-center gap-1 tabular-nums"><Star size={10} />{formatNumber(entry.data.stargazersCount)}</span>
                  {entry.data.language && <span>{entry.data.language}</span>}
                </span>
              </button>
              <IconButton label={t('development.github.store.unfavorite')} size="sm" onClick={() => onToggleFavorite(entry.data)}>
                <Heart size={13} className="fill-[var(--accent)] text-[var(--accent)]" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Menu anchor={menu.point ?? ORIGIN} open={menu.point !== null && target !== null} onClose={() => { menu.close(); setTarget(null) }} items={items} align="start" width={230} label={t('development.github.common.menu')} />
    </div>
  )
}
