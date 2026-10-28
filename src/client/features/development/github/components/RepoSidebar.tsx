import { memo, useMemo } from 'react'
import { ChevronDown, ChevronRight, Compass, FileText, Pin, Plus, Settings2, Star, Tag as TagIcon } from 'lucide-react'
import type { GithubTag, GithubViewId, SavedGithubRepo } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { Button, IconButton } from '../../../../components/primitives'
import { GITHUB_ALL_VIEW, GITHUB_EXPLORE_VIEW, GITHUB_FAV_VIEW, GITHUB_PINNED_VIEW } from '@shared/development/github/types'
import { buildTagTree, type TagTreeNode } from '../lib/tags'

function SidebarItem({ icon, label, count, active, onClick }: { icon: React.ReactNode; label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} data-active={active || undefined} className={cn('flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-12)] transition-colors', active ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {count !== undefined && <span className="shrink-0 rounded-full bg-[var(--bg-raised)] px-1.5 py-0.5 text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">{count}</span>}
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-2 pb-1 text-[length:var(--text-10)] font-medium tracking-wide text-[var(--text-quaternary)] uppercase">{children}</p>
}

function TagTreeItem({ node, selectedView, onSelect, expanded, onToggleExpand, countForTag, depth }: { node: TagTreeNode<GithubTag>; selectedView: GithubViewId; onSelect: (view: string) => void; expanded: Set<string>; onToggleExpand: (id: string) => void; countForTag: (id: string) => number; depth: number }) {
  const viewId = `tag:${node.id}`
  const active = selectedView === viewId
  const open = expanded.has(node.id)
  const hasChildren = node.children.length > 0
  return (
    <div>
      <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 12 + 4}px` }}>
        {hasChildren ? (
          <IconButton label={open ? t('development.github.common.collapse') : t('development.github.common.expand')} size="sm" onClick={() => onToggleExpand(node.id)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </IconButton>
        ) : <span className="w-6 shrink-0" />}
        <button type="button" onClick={() => onSelect(viewId)} data-active={active || undefined} className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-md)] px-1.5 py-1.5 text-[length:var(--text-12)] transition-colors', active ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: node.color }} />
          <span className="min-w-0 flex-1 truncate text-left">{node.name}</span>
          <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{countForTag(node.id)}</span>
        </button>
      </div>
      {hasChildren && open && node.children.map((child) => <TagTreeItem key={child.id} node={child} selectedView={selectedView} onSelect={onSelect} expanded={expanded} onToggleExpand={onToggleExpand} countForTag={countForTag} depth={depth + 1} />)}
    </div>
  )
}

export const RepoSidebar = memo(function RepoSidebar({ tags, savedRepos, selectedView, onSelect, expanded, onToggleExpand, onManageTags }: { tags: GithubTag[]; savedRepos: SavedGithubRepo[]; selectedView: GithubViewId; onSelect: (view: GithubViewId) => void; expanded: Set<string>; onToggleExpand: (id: string) => void; onManageTags: () => void }) {
  const tree = useMemo(() => buildTagTree(tags), [tags])
  const pinned = useMemo(() => savedRepos.filter((repo) => repo.pinned).length, [savedRepos])
  const favorite = useMemo(() => savedRepos.filter((repo) => repo.favorited).length, [savedRepos])
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const repo of savedRepos) {
      for (const tagId of repo.tagIds) counts.set(tagId, (counts.get(tagId) ?? 0) + 1)
    }
    return counts
  }, [savedRepos])
  const countForTag = (id: string) => tagCounts.get(id) ?? 0
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
          {tree.length > 0 ? tree.map((node) => <TagTreeItem key={node.id} node={node} selectedView={selectedView} onSelect={onSelect} expanded={expanded} onToggleExpand={onToggleExpand} countForTag={countForTag} depth={0} />) : (
            <button type="button" onClick={onManageTags} className="flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Plus size={12} />{t('development.github.tags.create_first')}</button>
          )}
        </div>
      </div>
    </aside>
  )
})
