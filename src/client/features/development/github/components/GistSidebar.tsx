import { memo, useMemo } from 'react'
import { FileText, Globe, Pin, Plus, Settings2, Star, Tag as TagIcon } from 'lucide-react'
import type { GithubAccountView, GithubTag, GistViewId, SavedGist } from '@shared/development/github/types'
import { GIST_ALL_VIEW, GIST_EXPLORE_VIEW, GIST_FAV_VIEW, GIST_MY_GITHUB_VIEW, GIST_PINNED_VIEW } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Badge, Button, IconButton } from '../../../../components/primitives'
import { GithubIcon } from './GithubIcon'
import { GithubAvatar } from './GithubAvatar'
import { SidebarItem, SectionLabel, TagTreeList } from './TagSidebarParts'

export const GistSidebar = memo(function GistSidebar({ tags, savedGists, selectedView, onSelect, expanded, onToggleExpand, onManageTags, onCreate, onImport, accounts }: { tags: GithubTag[]; savedGists: SavedGist[]; selectedView: GistViewId; onSelect: (view: GistViewId) => void; expanded: Set<string>; onToggleExpand: (id: string) => void; onManageTags: () => void; onCreate: () => void; onImport: () => void; accounts: GithubAccountView[] }) {
  const pinned = useMemo(() => savedGists.filter((gist) => gist.pinned).length, [savedGists])
  const favorite = useMemo(() => savedGists.filter((gist) => gist.favorited).length, [savedGists])
  return (
    <aside className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-sunken)]" data-slot="gist-sidebar">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-1 p-2">
          <div className="mb-2 flex items-center gap-1.5">
            <Button variant="secondary" size="sm" className="min-w-0 flex-1 border-dashed" onClick={onCreate}><Plus size={12} />{t('development.github.gists.create_sync')}</Button>
            <IconButton label={t('development.github.gists.import')} size="sm" variant="secondary" onClick={onImport}><Plus size={13} /></IconButton>
          </div>
          <SectionLabel>{t('development.github.gists.explore_github')}</SectionLabel>
          <SidebarItem icon={<Globe size={14} className="text-[var(--accent)]" />} label={t('development.github.gists.public_gists')} active={selectedView === GIST_EXPLORE_VIEW} onClick={() => onSelect(GIST_EXPLORE_VIEW)} />
          <SidebarItem icon={<GithubIcon className="size-3.5" />} label={t('development.github.gists.my_github')} active={selectedView === GIST_MY_GITHUB_VIEW} onClick={() => onSelect(GIST_MY_GITHUB_VIEW)} badge={accounts.length === 0 ? <Badge tone="warning">{t('development.github.accounts.not_configured')}</Badge> : <Badge tone="success">{accounts.length}</Badge>} />
          {accounts.map((account) => <SidebarItem key={account.id} icon={<GithubAvatar src={account.avatarUrl} name={account.username} size={14} />} label={account.username} active={selectedView === `user:${account.username}`} onClick={() => onSelect(`user:${account.username}`)} />)}
          <div className="my-2 border-t border-[var(--border-subtle)]" />
          <SectionLabel>{t('development.github.gists.my_gists')}</SectionLabel>
          <SidebarItem icon={<FileText size={14} />} label={t('development.github.repos.all')} count={savedGists.length} active={selectedView === GIST_ALL_VIEW} onClick={() => onSelect(GIST_ALL_VIEW)} />
          <SidebarItem icon={<Pin size={14} className="text-[var(--warning)]" />} label={t('development.github.repos.pinned')} count={pinned} active={selectedView === GIST_PINNED_VIEW} onClick={() => onSelect(GIST_PINNED_VIEW)} />
          <SidebarItem icon={<Star size={14} className="text-[var(--warning)]" />} label={t('development.github.repos.favorited')} count={favorite} active={selectedView === GIST_FAV_VIEW} onClick={() => onSelect(GIST_FAV_VIEW)} />
          <div className="my-2 border-t border-[var(--border-subtle)]" />
          <div className="flex items-center gap-1 px-2 pb-1">
            <TagIcon size={12} className="text-[var(--text-tertiary)]" />
            <SectionLabel>{t('development.github.tags.section')}</SectionLabel>
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5" onClick={onManageTags} title={t('development.github.tags.manage')} aria-label={t('development.github.tags.manage')}><Settings2 size={12} /></Button>
          </div>
          <TagTreeList tags={tags} items={savedGists} selectedView={selectedView} onSelect={onSelect} expanded={expanded} onToggleExpand={onToggleExpand} emptyAction={onManageTags} />
        </div>
      </div>
    </aside>
  )
})
