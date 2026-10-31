import { memo, useMemo } from 'react'
import { Compass, FileText, Pin, Settings2, Star, Tag as TagIcon } from 'lucide-react'
import type { GithubTag, GithubViewId, SavedGithubRepo } from '@shared/development/github/types'
import { GITHUB_ALL_VIEW, GITHUB_EXPLORE_VIEW, GITHUB_FAV_VIEW, GITHUB_PINNED_VIEW } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { Button } from '../../../../components/primitives'
import { SidebarItem, SectionLabel, TagTreeList } from './TagSidebarParts'

export const RepoSidebar = memo(function RepoSidebar({ tags, savedRepos, selectedView, onSelect, expanded, onToggleExpand, onManageTags }: { tags: GithubTag[]; savedRepos: SavedGithubRepo[]; selectedView: GithubViewId; onSelect: (view: GithubViewId) => void; expanded: Set<string>; onToggleExpand: (id: string) => void; onManageTags: () => void }) {
  const pinned = useMemo(() => savedRepos.filter((repo) => repo.pinned).length, [savedRepos])
  const favorite = useMemo(() => savedRepos.filter((repo) => repo.favorited).length, [savedRepos])
  return (
    <aside className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-sunken)]" data-slot="repo-sidebar">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-1 p-2">
          <SidebarItem icon={<Compass size={14} className="text-[var(--accent)]" />} label={t('development.github.repos.discover')} active={selectedView === GITHUB_EXPLORE_VIEW} onClick={() => onSelect(GITHUB_EXPLORE_VIEW)} />
          <div className="my-2 border-t border-[var(--border-subtle)]" />
          <SectionLabel>{t('development.github.repos.my_repos')}</SectionLabel>
          <SidebarItem icon={<FileText size={14} />} label={t('development.github.repos.all')} count={savedRepos.length} active={selectedView === GITHUB_ALL_VIEW} onClick={() => onSelect(GITHUB_ALL_VIEW)} />
          <SidebarItem icon={<Pin size={14} className="text-[var(--warning)]" />} label={t('development.github.repos.pinned')} count={pinned} active={selectedView === GITHUB_PINNED_VIEW} onClick={() => onSelect(GITHUB_PINNED_VIEW)} />
          <SidebarItem icon={<Star size={14} className="text-[var(--warning)]" />} label={t('development.github.repos.favorited')} count={favorite} active={selectedView === GITHUB_FAV_VIEW} onClick={() => onSelect(GITHUB_FAV_VIEW)} />
          <div className="my-2 border-t border-[var(--border-subtle)]" />
          <div className="flex items-center gap-1 px-2 pb-1">
            <TagIcon size={12} className="text-[var(--text-tertiary)]" />
            <SectionLabel>{t('development.github.tags.section')}</SectionLabel>
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5" onClick={onManageTags} title={t('development.github.tags.manage')} aria-label={t('development.github.tags.manage')}><Settings2 size={12} /></Button>
          </div>
          <TagTreeList tags={tags} items={savedRepos} selectedView={selectedView} onSelect={onSelect} expanded={expanded} onToggleExpand={onToggleExpand} emptyAction={onManageTags} />
        </div>
      </div>
    </aside>
  )
})
