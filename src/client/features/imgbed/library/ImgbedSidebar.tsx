import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { ChevronRight, FileText, Film, Hash, Image, Music, Pin, Search, Star } from 'lucide-react'
import { t, useLocale } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { buildTagTree, flattenTagTree, type TagTreeNode } from '../../../lib/tag-tree'
import { treeIndent, treeItemProps, useTreeKeyboard } from '../../../lib/tree'
import { weekStartFor } from '../../../lib/time'
import { buildStripWeeks, heatCell } from '../../../components/activity-calendar'
import { SectionLabel } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { imgbedChannelDisplayName } from '@shared/imgbed/model'
import type { ImgbedSidebarResponse } from '../api'

export interface ImgbedFilters {
  quick: 'all' | 'favorite' | 'pinned'
  type: string
  channelName: string
  tag: string
}

const DEFAULT_FILTERS: ImgbedFilters = { quick: 'all', type: '', channelName: '', tag: '' }
const TAG_STORAGE_KEY = 'inkstone.imgbed.tagCollapsed'
const ACTIVITY_DAYS = 120
const CHART_STROKES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']
const TYPE_ROWS = [
  { key: 'image', label: 'imgbed.public.images', icon: Image },
  { key: 'video', label: 'imgbed.public.videos', icon: Film },
  { key: 'audio', label: 'imgbed.public.audio', icon: Music },
  { key: 'other', label: 'imgbed.public.other', icon: FileText },
] as const

function readCollapsed(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(TAG_STORAGE_KEY) || '[]') as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}

export function ImgbedSidebar({ data, loading, filters, onChange }: {
  data: ImgbedSidebarResponse | null
  loading: boolean
  filters: ImgbedFilters
  onChange: (patch: Partial<ImgbedFilters>) => void
}): ReactElement {
  const locale = useLocale()
  const [tagQuery, setTagQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const tree = useMemo(() => buildTagTree((data?.tags ?? []).map((entry, index) => ({
    id: `imgbed-tag:${entry.tag}`, name: entry.tag, color: null, count: entry.count, createdAt: index,
  }))), [data])
  const toggleExpanded = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      try { localStorage.setItem(TAG_STORAGE_KEY, JSON.stringify([...next])) } catch (error) { console.warn('[inkstone] Image bed tag tree preferences could not be saved', error) }
      return next
    })
  }
  const counts = data?.counts
  const channelRows = useMemo(() => [...(data?.channels ?? [])].sort((left, right) => right.count - left.count), [data])
  const activity = useMemo(() => {
    if (!data) return { weeks: [], total: 0 }
    const map = new Map(data.activity.map((entry) => [entry.date, entry.count]))
    const end = new Date()
    const start = new Date(end.getTime() - (ACTIVITY_DAYS - 1) * 86_400_000)
    return { weeks: buildStripWeeks(map, { range: { start, end }, weekStart: weekStartFor(locale) }), total: data.activity.reduce((sum, entry) => sum + entry.count, 0) }
  }, [data, locale])
  const todayKey = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }, [])
  const tagRows = useMemo(() => {
    if (!tagQuery.trim()) return []
    const query = tagQuery.trim().toLowerCase()
    const all = flattenTagTree(tree, new Set(flattenTagTree(tree, new Set()).map((node) => node.fullPath)))
    return all.filter((node) => node.fullPath.toLowerCase().includes(query))
  }, [tagQuery, tree])
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain p-2.5">
      <section aria-label={t('imgbed.library.activity' as never)}>
        <SectionLabel>{t('imgbed.library.activity' as never)}</SectionLabel>
        {loading && !data ? <div className="h-16 animate-pulse rounded-[var(--r-md)] bg-[var(--bg-inset)]" /> : (
          <>
            <p className="mb-1.5 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">{t('imgbed.library.activity_total' as never, { days: ACTIVITY_DAYS, count: activity.total })}</p>
            <div className="flex gap-[var(--sp-0-5)]" role="img" aria-label={t('imgbed.library.activity' as never)}>
              {activity.weeks.map((week, weekIndex) => (
                <div key={weekIndex} className="flex flex-col gap-[var(--sp-0-5)]">
                  {week.map((cell) => (
                    cell.key > todayKey
                      ? <span key={cell.key} aria-hidden="true" className="size-2.5" />
                      : <span key={cell.key} title={t('imgbed.library.day_uploads' as never, { date: cell.key, count: cell.count })} className={cn('size-2.5 rounded-[var(--r-2)] bg-[var(--bg-inset)]', cell.today && 'ring-1 ring-inset ring-[var(--accent)]')} style={cell.level ? heatCell(cell.level) : undefined} />
                  ))}
                </div>
              ))}
            </div>
            <ul className="sr-only">
              {(data?.activity ?? []).filter((entry) => entry.count > 0).map((entry) => (
                <li key={entry.date}>{t('imgbed.library.day_uploads' as never, { date: entry.date, count: entry.count })}</li>
              ))}
            </ul>
            <div className="mt-1.5 flex items-center justify-end gap-1 text-[length:var(--text-9)] text-[var(--text-quaternary)]">
              <span>{t('imgbed.library.heat_less' as never)}</span>
              {[0, 1, 2, 3, 4].map((level) => <span key={level} className="size-2 rounded-[var(--r-2)] bg-[var(--bg-inset)]" style={level ? heatCell(level) : undefined} />)}
              <span>{t('imgbed.library.heat_more' as never)}</span>
            </div>
          </>
        )}
      </section>

      <section aria-label={t('imgbed.library.filter_quick' as never)}>
        <SectionLabel>{t('imgbed.library.filter_quick' as never)}</SectionLabel>
        <p className="px-2 pb-1 text-[length:var(--text-9)] text-[var(--text-quaternary)]">{t('imgbed.library.counts_scope' as never)}</p>
        <div className="space-y-0.5">
          <SidebarRow icon={null} label={t('imgbed.public.all')} count={counts?.all} active={filters.quick === 'all' && !filters.type && !filters.channelName && !filters.tag} onClick={() => onChange({ quick: 'all', type: '', channelName: '', tag: '' })} />
          <SidebarRow icon={<Star size={13} className="text-[var(--warning)]" />} label={t('imgbed.library.favorite' as never)} count={counts?.favorite} active={filters.quick === 'favorite'} onClick={() => onChange({ quick: filters.quick === 'favorite' ? 'all' : 'favorite' })} />
          <SidebarRow icon={<Pin size={13} className="text-[var(--warning)]" />} label={t('imgbed.library.pinned' as never)} count={counts?.pinned} active={filters.quick === 'pinned'} onClick={() => onChange({ quick: filters.quick === 'pinned' ? 'all' : 'pinned' })} />
        </div>
      </section>

      <section aria-label={t('imgbed.library.filter_type' as never)}>
        <SectionLabel>{t('imgbed.library.filter_type' as never)}</SectionLabel>
        <div className="space-y-0.5">
          {TYPE_ROWS.map((row) => {
            const Icon = row.icon
            return <SidebarRow key={row.key} icon={<Icon size={13} />} label={t(row.label)} count={counts?.[row.key === 'image' ? 'images' : row.key === 'video' ? 'videos' : row.key === 'audio' ? 'audios' : 'other']} active={filters.type === row.key} onClick={() => onChange({ type: filters.type === row.key ? '' : row.key })} />
          })}
        </div>
      </section>

      <section aria-label={t('imgbed.library.filter_channels' as never)}>
        <SectionLabel>{t('imgbed.library.filter_channels' as never)}</SectionLabel>
        {channelRows.length === 0 ? <p className="px-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('imgbed.settings.no_data')}</p> : (
          <div className="space-y-0.5">
            {channelRows.map((row, index) => (
              <SidebarRow key={row.channelName} icon={<span className="size-2 rounded-full" style={{ background: CHART_STROKES[index % CHART_STROKES.length] }} />} label={imgbedChannelDisplayName(row.channelName)} count={row.count} active={filters.channelName === row.channelName} onClick={() => onChange({ channelName: filters.channelName === row.channelName ? '' : row.channelName })} />
            ))}
          </div>
        )}
      </section>

      <section aria-label={t('imgbed.library.tags_section' as never)}>
        <SectionLabel>{t('imgbed.library.tags_section' as never)}</SectionLabel>
        <Input leading={<Search size={12} />} value={tagQuery} onChange={(event) => setTagQuery(event.target.value)} placeholder={t('imgbed.library.tag_search' as never)} className="h-9 md:h-7" />
        <div className="mt-1">
          {tree.length === 0 ? <p className="px-2 py-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('imgbed.library.tags_empty' as never)}</p>
            : tagQuery.trim() ? (
              <ul className="space-y-px">{tagRows.map((node) => <li key={node.fullPath}><button type="button" onClick={() => onChange({ tag: filters.tag === node.fullPath ? '' : node.fullPath })} className={cn('flex min-h-9 w-full items-center gap-1.5 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12)]', filters.tag === node.fullPath ? 'bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}><Hash size={11} className="shrink-0 text-[var(--text-quaternary)]" /><span className="min-w-0 flex-1 truncate">{node.fullPath}</span><span className="text-[length:var(--text-10)] tabular text-[var(--text-quaternary)]">{node.totalCount}</span></button></li>)}</ul>
            ) : (
              <ul role="tree" aria-label={t('imgbed.library.tags_section' as never)} className="space-y-px">
                {tree.map((node, index) => <TagRow key={node.fullPath} node={node} collapsed={collapsed} active={filters.tag} setSize={tree.length} posInSet={index + 1} onToggle={toggleExpanded} onSelect={(path) => onChange({ tag: filters.tag === path ? '' : path })} />)}
              </ul>
            )}
        </div>
      </section>
      {filters.quick !== 'all' || filters.type || filters.channelName || filters.tag ? (
        <button type="button" onClick={() => onChange(DEFAULT_FILTERS)} className="flex min-h-10 items-center justify-center rounded-[var(--r-md)] border border-[var(--border-subtle)] text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">{t('imgbed.library.clear_filter' as never)}</button>
      ) : null}
    </div>
  )
}

function SidebarRow({ icon, label, count, active, onClick }: { icon: ReactNode; label: string; count?: number; active: boolean; onClick: () => void }): ReactElement {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cn('flex min-h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12)] transition-colors md:min-h-0 md:h-7', active ? 'bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')}>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className={cn('shrink-0 text-[length:var(--text-10)] tabular', active ? 'text-[var(--text-primary)]' : 'text-[var(--text-quaternary)]')}>{count}</span>}
    </button>
  )
}

function TagRow({ node, collapsed, active, setSize, posInSet, onToggle, onSelect }: {
  node: TagTreeNode
  collapsed: ReadonlySet<string>
  active: string
  setSize: number
  posInSet: number
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}): ReactElement {
  const onKeyDown = useTreeKeyboard()
  const hasChildren = node.children.length > 0
  const open = hasChildren && !collapsed.has(node.fullPath)
  const selected = node.fullPath === active
  return (
    <li {...treeItemProps({ level: node.depth + 1, expanded: hasChildren ? open : undefined, selected, setSize, posInSet })}>
      <div className={cn('flex min-h-10 items-center gap-0.5 rounded-[var(--r-md)] pr-1 md:min-h-0 md:h-7', selected ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')} style={{ paddingLeft: treeIndent(node.depth) }}>
        {hasChildren ? (
          <button type="button" data-tree-toggle aria-expanded={open} aria-label={t((open ? 'imgbed.library.collapse_tag' : 'imgbed.library.expand_tag') as never, { tag: node.fullPath })} onClick={() => onToggle(node.fullPath)} className="flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-quaternary)] hover:bg-[var(--bg-active)] md:size-5">
            <ChevronRight size={11} className={cn('transition-transform duration-[var(--dur-fast)]', open && 'rotate-90')} />
          </button>
        ) : <span className="size-6 shrink-0 md:size-5" />}
        <Hash size={11} className="shrink-0 text-[var(--text-quaternary)]" />
        <button type="button" data-tree-row aria-current={selected ? 'page' : undefined} onClick={() => onSelect(node.fullPath)} onKeyDown={onKeyDown} className="min-w-0 flex-1 self-stretch truncate py-1 text-left text-[length:var(--text-12)] font-medium">
          {node.name}
        </button>
        <span className="shrink-0 pr-1 text-[length:var(--text-10)] tabular text-[var(--text-quaternary)]">{node.totalCount}</span>
      </div>
      {open && node.children.map((child, index) => <ul key={child.fullPath} role="group" className="space-y-px"><TagRow node={child} collapsed={collapsed} active={active} setSize={node.children.length} posInSet={index + 1} onToggle={onToggle} onSelect={onSelect} /></ul>)}
    </li>
  )
}
