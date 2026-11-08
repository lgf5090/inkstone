import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Info,
  Layers,
  Pin,
  Plus,
  Settings2,
  Shapes,
  Star,
  Tag as TagIcon,
} from 'lucide-react'
import type { IconBootstrap, IconCollection, IconTag } from '@shared/development/icons/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { IconButton } from '../../../../components/primitives'
import { Checkbox } from '../../../../components/form'
import { treeIndent } from '../../../../lib/tree/indent'
import type { BrowseState, IconStyleFilter } from '../lib/browse'

const GROUP_KEY = 'inkstone.icons.groups.v1'

interface GroupState {
  views: boolean
  collections: boolean
  styles: boolean
  tags: boolean
  recent: boolean
}

const DEFAULT_GROUPS: GroupState = { views: true, collections: true, styles: true, tags: true, recent: true }

function readGroups(): GroupState {
  if (typeof window === 'undefined') return DEFAULT_GROUPS
  try {
    const raw = window.localStorage.getItem(GROUP_KEY)
    return raw ? { ...DEFAULT_GROUPS, ...JSON.parse(raw) as Partial<GroupState> } : DEFAULT_GROUPS
  } catch {
    return DEFAULT_GROUPS
  }
}

const STYLE_OPTIONS: { id: Exclude<IconStyleFilter, ''>; label: string }[] = [
  { id: 'line', label: 'development.icons.style.line' },
  { id: 'fill', label: 'development.icons.style.fill' },
  { id: 'duotone', label: 'development.icons.style.duotone' },
  { id: 'brand', label: 'development.icons.style.brand' },
]

function tagDepth(tags: readonly IconTag[], tag: IconTag): number {
  let depth = 0
  let parent = tag.parentId
  const byId = new Map(tags.map((entry) => [entry.id, entry]))
  while (parent && depth < 8) {
    depth += 1
    parent = byId.get(parent)?.parentId ?? null
  }
  return depth
}

function Group({
  id,
  label,
  count,
  open,
  onToggle,
  children,
}: {
  id: string
  label: string
  count?: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section className="pb-1" aria-labelledby={`icons-group-${id}`}>
      <button
        type="button"
        id={`icons-group-${id}`}
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-10)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] focus-visible:shadow-[var(--shadow-ring-focus)] focus-visible:outline-none"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="ml-auto tabular-nums font-normal">{count}</span>}
      </button>
      {open && <div className="mt-0.5 space-y-0.5">{children}</div>}
    </section>
  )
}

function Row({
  active,
  label,
  count,
  onClick,
  icon,
  dot,
  depth = 0,
  trailing,
  checked,
  onCheck,
}: {
  active: boolean
  label: string
  count?: number
  onClick: () => void
  icon?: React.ReactNode
  dot?: string
  depth?: number
  trailing?: React.ReactNode
  checked?: boolean
  onCheck?: (checked: boolean) => void
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-[var(--r-sm)] pr-1',
        active ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
      )}
      style={{ paddingLeft: treeIndent(depth) }}
    >
      {onCheck && <Checkbox checked={Boolean(checked)} onChange={onCheck} ariaLabel={label} />}
      <button type="button" onClick={onClick} title={label} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-sm)] py-1.5 text-left text-[length:var(--text-12)] focus-visible:shadow-[var(--shadow-ring-focus)] focus-visible:outline-none">
        {icon}
        {dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} aria-hidden="true" />}
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="ml-auto shrink-0 tabular-nums text-[length:var(--text-10)] text-[var(--text-tertiary)]">{count}</span>}
      </button>
      {trailing}
    </div>
  )
}

export interface SidebarProps {
  bootstrap: IconBootstrap
  state: BrowseState
  onChange: (state: BrowseState) => void
  onManageCollections: () => void
  onManageTags: () => void
  onStats?: (collection: IconCollection) => void
  /** The mobile drawer already prints the title and the close button, so the rail drops its own. */
  embedded?: boolean
}

/**
 * The rail is a tree of filters, not a list of links: every row toggles a facet, carries the number
 * of icons behind it, and remembers which groups the reader folded away.
 */
export function Sidebar({ bootstrap, state, onChange, onManageCollections, onManageTags, onStats, embedded }: SidebarProps) {
  const [groups, setGroups] = useState<GroupState>(readGroups)
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set())

  useEffect(() => {
    try {
      window.localStorage.setItem(GROUP_KEY, JSON.stringify(groups))
    } catch {
      // Ignored: folding state is a convenience.
    }
  }, [groups])

  const counts = bootstrap.counts
  const toggleGroup = (key: keyof GroupState): void => setGroups((current) => ({ ...current, [key]: !current[key] }))

  const tagsByParent = useMemo(() => {
    const map = new Map<string | null, IconTag[]>()
    for (const tag of bootstrap.tags) {
      const key = tag.parentId ?? null
      map.set(key, [...map.get(key) ?? [], tag])
    }
    return map
  }, [bootstrap.tags])

  const toggleCollection = (id: string): void => {
    const has = state.collections.includes(id)
    onChange({
      ...state,
      state: 'all',
      collections: has ? state.collections.filter((entry) => entry !== id) : [...state.collections, id],
    })
  }

  const toggleTag = (id: string): void => {
    const has = state.tags.includes(id)
    onChange({
      ...state,
      state: 'all',
      tags: has ? state.tags.filter((entry) => entry !== id) : [...state.tags, id],
    })
  }

  const renderTag = (tag: IconTag): React.ReactNode => {
    const children = tagsByParent.get(tag.id) ?? []
    const depth = tagDepth(bootstrap.tags, tag)
    const open = expandedTags.has(tag.id)
    return (
      <div key={tag.id}>
        <Row
          active={state.tags.includes(tag.id)}
          checked={state.tags.includes(tag.id)}
          onCheck={() => toggleTag(tag.id)}
          label={tag.name}
          count={counts.tags[tag.id] ?? 0}
          dot={tag.color}
          depth={depth}
          onClick={() => toggleTag(tag.id)}
          trailing={children.length ? (
            <button
              type="button"
              aria-label={open ? t('development.icons.sidebar.collapse') : t('development.icons.sidebar.expand')}
              onClick={() => setExpandedTags((current) => {
                const next = new Set(current)
                if (next.has(tag.id)) next.delete(tag.id)
                else next.add(tag.id)
                return next
              })}
              className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-active)]"
            >
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          ) : undefined}
        />
        {open && children.map(renderTag)}
      </div>
    )
  }

  const recentCollections = useMemo(
    () => [...bootstrap.collections].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
    [bootstrap.collections],
  )

  const smartViews: { id: BrowseState['state']; label: string; icon: React.ReactNode; count: number }[] = [
    { id: 'all', label: t('development.icons.sidebar.all'), icon: <Shapes size={12} />, count: counts.all },
    { id: 'favorites', label: t('development.icons.sidebar.favorites'), icon: <Star size={12} />, count: counts.favorites },
    { id: 'pinned', label: t('development.icons.sidebar.pinned'), icon: <Pin size={12} />, count: counts.pinned },
    { id: 'recent', label: t('development.icons.sidebar.recent'), icon: <Clock size={12} />, count: counts.recent },
    { id: 'uncategorized', label: t('development.icons.sidebar.uncategorized'), icon: <Layers size={12} />, count: counts.uncategorized },
  ]

  return (
    <aside className={cn('flex h-full flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]', embedded ? 'w-full' : 'w-[264px] shrink-0')} aria-label={t('development.icons.sidebar.title')}>
      {!embedded && (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
          <Shapes size={16} className="text-[var(--accent)]" />
          <h2 className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('development.icons.sidebar.title')}</h2>
          <span className="rounded-[var(--r-full)] bg-[var(--bg-raised)] px-1.5 py-0.5 text-[length:var(--text-10)] tabular-nums text-[var(--text-tertiary)]">{counts.all}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <Group id="views" label={t('development.icons.sidebar.views')} count={counts.all} open={groups.views} onToggle={() => toggleGroup('views')}>
          {smartViews.map((view) => (
            <Row
              key={view.id}
              active={state.state === view.id && !state.collections.length && !state.tags.length && !state.style && !state.colorMode}
              label={view.label}
              icon={view.icon}
              count={view.count}
              onClick={() => onChange({ ...state, state: view.id, collections: [], tags: [], style: '', colorMode: '' })}
            />
          ))}
        </Group>

        <Group
          id="collections"
          label={t('development.icons.sidebar.collections')}
          count={bootstrap.collections.length}
          open={groups.collections}
          onToggle={() => toggleGroup('collections')}
        >
          <div className="flex items-center justify-end px-1 pb-0.5">
            <IconButton label={t('development.icons.sidebar.manage_collections')} size="sm" className="h-6 w-6" onClick={onManageCollections}><Settings2 size={11} /></IconButton>
            <IconButton label={t('development.icons.sidebar.new_collection')} size="sm" className="h-6 w-6" onClick={onManageCollections}><Plus size={11} /></IconButton>
          </div>
          {bootstrap.collections.length === 0 && <p className="px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.icons.collection.empty')}</p>}
          {bootstrap.collections.map((collection: IconCollection) => (
            <Row
              key={collection.id}
              active={state.collections.includes(collection.id)}
              checked={state.collections.includes(collection.id)}
              onCheck={() => toggleCollection(collection.id)}
              label={collection.name}
              count={counts.collections[collection.id] ?? 0}
              onClick={() => toggleCollection(collection.id)}
              trailing={onStats ? (
                <IconButton label={t('development.icons.collection.stats')} size="sm" className="h-6 w-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" onClick={() => onStats(collection)}><Info size={11} /></IconButton>
              ) : undefined}
            />
          ))}
        </Group>

        <Group id="styles" label={t('development.icons.sidebar.styles')} open={groups.styles} onToggle={() => toggleGroup('styles')}>
          {STYLE_OPTIONS.map((option) => (
            <Row
              key={option.id}
              active={state.style === option.id}
              label={t(option.label as never)}
              count={counts.styles[option.id] ?? 0}
              onClick={() => onChange({ ...state, style: state.style === option.id ? '' : option.id })}
            />
          ))}
        </Group>

        <Group id="tags" label={t('development.icons.sidebar.tags')} count={bootstrap.tags.length} open={groups.tags} onToggle={() => toggleGroup('tags')}>
          <div className="flex items-center justify-end px-1 pb-0.5">
            <IconButton label={t('development.icons.sidebar.manage_tags')} size="sm" className="h-6 w-6" onClick={onManageTags}><TagIcon size={11} /></IconButton>
          </div>
          {bootstrap.tags.length === 0 && <p className="px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.icons.tag.empty')}</p>}
          {(tagsByParent.get(null) ?? []).map(renderTag)}
        </Group>

        <Group id="recent" label={t('development.icons.sidebar.recent_imports')} open={groups.recent} onToggle={() => toggleGroup('recent')}>
          {recentCollections.length === 0 && <p className="px-2 py-1.5 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.icons.collection.empty')}</p>}
          {recentCollections.map((collection) => (
            <Row
              key={collection.id}
              active={state.collections.includes(collection.id)}
              label={collection.name}
              count={counts.collections[collection.id] ?? 0}
              onClick={() => toggleCollection(collection.id)}
            />
          ))}
        </Group>
      </div>

      <div className="shrink-0 border-t border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
        <div className="flex items-center justify-between">
          <span>{t('development.icons.sidebar.storage')}</span>
          <span className="tabular-nums">{Math.round((bootstrap.usage.usedBytes / (1024 * 1024)) * 10) / 10} {'MB'}</span>
        </div>
      </div>
    </aside>
  )
}
