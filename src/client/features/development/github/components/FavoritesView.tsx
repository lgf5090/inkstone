import { Heart, PanelLeft, Star } from 'lucide-react'
import type { SavedGithubRepo } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Button, IconButton } from '../../../../components/primitives'
import { Empty } from '../../../../components/feedback'
import { formatNumber } from '../lib/format'
import { GithubAvatar } from './GithubAvatar'

export function FavoritesView({
  favorites,
  onOpenRepo,
  onToggleFavorite,
  onOpenSidebar,
  onDiscover,
}: {
  favorites: SavedGithubRepo[]
  onOpenRepo: (repo: SavedGithubRepo['data']) => void
  onToggleFavorite: (repo: SavedGithubRepo['data']) => void
  onOpenSidebar: () => void
  onDiscover: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="github-favorites">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" className="size-8 shrink-0 md:size-8" onClick={onOpenSidebar}><PanelLeft size={15} /></IconButton>
        <span className="text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{t('development.github.store.favorites')}</span>
        <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{t('development.github.store.favorites_count', { count: favorites.length })}</span>
      </div>
      {favorites.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty art="folder" title={t('development.github.store.favorites_empty_title')} description={t('development.github.store.favorites_empty_desc')} action={<Button size="sm" onClick={onDiscover}>{t('development.github.store.go_discover')}</Button>} />
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto overscroll-contain">
          {favorites.map((entry) => (
            <li key={entry.id} className="group flex items-start gap-2.5 px-2.5 py-2.5">
              <GithubAvatar src={entry.data.owner.avatarUrl} name={entry.data.owner.login} size={28} className="mt-0.5" />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenRepo(entry.data)}>
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
    </div>
  )
}
