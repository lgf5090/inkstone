import { useMemo, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { GithubTag, GithubViewId } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { IconButton } from '../../../../components/primitives'
import { buildTagTree, tagCountsWithAncestors, type TagTreeNode } from '../lib/tags'

export function SidebarItem({ icon, label, count, active, onClick, badge }: { icon: ReactNode; label: string; count?: number; active: boolean; onClick: () => void; badge?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} data-active={active || undefined} className={cn('flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-[length:var(--text-12)] transition-colors', active ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {badge}
      {count !== undefined && <span className="shrink-0 rounded-full bg-[var(--bg-raised)] px-1.5 py-0.5 text-[length:var(--text-11)] tabular text-[var(--text-tertiary)]">{count}</span>}
    </button>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1 text-[length:var(--text-11)] font-medium tracking-wide text-[var(--text-quaternary)] uppercase">{children}</p>
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
          <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{countForTag(node.id)}</span>
        </button>
      </div>
      {hasChildren && open && node.children.map((child) => <TagTreeItem key={child.id} node={child} selectedView={selectedView} onSelect={onSelect} expanded={expanded} onToggleExpand={onToggleExpand} countForTag={countForTag} depth={depth + 1} />)}
    </div>
  )
}

export function TagTreeList({ tags, items, selectedView, onSelect, expanded, onToggleExpand, emptyAction }: { tags: GithubTag[]; items: readonly { tagIds: readonly string[] }[]; selectedView: GithubViewId; onSelect: (view: string) => void; expanded: Set<string>; onToggleExpand: (id: string) => void; emptyAction: () => void }) {
  const tree = useMemo(() => buildTagTree(tags), [tags])
  const counts = useMemo(() => tagCountsWithAncestors(tags, items), [tags, items])
  const countForTag = (id: string) => counts.get(id) ?? 0
  if (tree.length === 0) {
    return <button type="button" onClick={emptyAction} className="flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Plus size={12} />{t('development.github.tags.create_first')}</button>
  }
  return <>{tree.map((node) => <TagTreeItem key={node.id} node={node} selectedView={selectedView} onSelect={onSelect} expanded={expanded} onToggleExpand={onToggleExpand} countForTag={countForTag} depth={0} />)}</>
}
