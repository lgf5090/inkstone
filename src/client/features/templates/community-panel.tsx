import { useMemo, useState } from 'react'
import { ChevronDown, Download, FilePlus2, Globe, RotateCw, Trash2 } from 'lucide-react'
import type { CommunityTemplate } from '@shared/types'
import { Button, IconButton } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { Tooltip } from '../../components/overlay'
import { t, useLocale } from '../../lib/i18n'
import { sortCommunityItems, templateMatchesQuery, type CommunitySort } from './gallery-derived'

export function CommunityPanel({ items, query, loading, isError, hasMore, myId, onRefresh, onLoadMore, onUse, onImport, onUnpublish }: {
  items: CommunityTemplate[]
  query: string
  loading: boolean
  isError: boolean
  hasMore: boolean
  myId: string | undefined
  onRefresh: () => void
  onLoadMore: () => void
  onUse: (item: CommunityTemplate) => void
  onImport: (item: CommunityTemplate) => void
  onUnpublish: (item: CommunityTemplate) => void
}) {
  useLocale()
  const [sort, setSort] = useState<CommunitySort>('newest')
  const [mineOnly, setMineOnly] = useState(false)
  const scoped = useMemo(() => (mineOnly && myId ? items.filter((item) => item.authorId === myId) : items), [items, mineOnly, myId])
  const visible = useMemo(() => sortCommunityItems(scoped.filter((item) => templateMatchesQuery(item, query)), sort), [scoped, query, sort])
  const searching = query.trim() !== ''
  if (loading && items.length === 0)
    return (<div className='grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3'>
      {[0, 1, 2].map((index) => (<div key={index} className='min-h-33 animate-pulse rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-raised)]'/>))}
    </div>)
  if (isError && items.length === 0)
    return (<div className='flex h-full min-h-60 flex-col items-center justify-center gap-3 text-center'>
      <Globe size={26} className='text-[var(--text-quaternary)]'/>
      <p className='text-[13px] font-medium text-[var(--text-secondary)]'>{t('templates.community_load_failed')}</p>
      <Button size='sm' variant='secondary' icon={<RotateCw size={13}/>} onClick={onRefresh}>{t('common.refresh')}</Button>
    </div>)
  if (visible.length === 0)
    return (<div className='flex h-full min-h-60 flex-col items-center justify-center gap-2 text-center'>
      <Globe size={26} className='text-[var(--text-quaternary)]'/>
      <p className='text-[13px] font-medium text-[var(--text-secondary)]'>
        {searching ? t('templates.no_matching_templates') : t('templates.community_empty')}
      </p>
      <p className='text-[11.5px] text-[var(--text-quaternary)]'>
        {searching ? t('templates.no_templates_hint') : t('templates.community_empty_hint')}
      </p>
      {searching && hasMore && (<Button size='sm' variant='secondary' disabled={loading} icon={<RotateCw size={13}/>} onClick={onLoadMore}>{t('templates.community_load_more')}</Button>)}
    </div>)
  return (<div className='space-y-2.5'>
    <div className='flex items-center justify-between gap-2'>
      <p className='text-[11.5px] text-[var(--text-quaternary)]'>
        {searching
          ? t('templates.community_count_hits_value0_total_value1', { value0: visible.length, value1: items.length })
          : t('templates.community_count_value0', { value0: items.length })}
      </p>
      <Button size='sm' variant='ghost' icon={<RotateCw size={13}/>} disabled={loading} onClick={onRefresh}>{t('common.refresh')}</Button>
    </div>
    <div className='flex flex-wrap items-center justify-between gap-2'>
      <Segmented
        size='sm'
        label={t('templates.community_sort_label')}
        value={sort}
        onChange={setSort}
        options={[
          { value: 'newest', label: t('templates.community_sort_newest') },
          { value: 'name', label: t('templates.community_sort_name') },
          { value: 'author', label: t('templates.community_sort_author') },
        ]}/>
      {myId && items.some((item) => item.authorId === myId) && (<Button
        size='sm'
        variant={mineOnly ? 'primary' : 'ghost'}
        aria-pressed={mineOnly}
        onClick={() => setMineOnly((current) => !current)}>
        {t('templates.community_only_mine')}
      </Button>)}
    </div>
    <div className='grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3'>
      {visible.map((item) => (<CommunityCard key={item.id} item={item} mine={item.authorId === myId} onUse={() => onUse(item)} onImport={() => onImport(item)} onUnpublish={() => onUnpublish(item)}/>))}
    </div>
    {hasMore && (<Button size='sm' variant='secondary' block loading={loading} icon={<ChevronDown size={13}/>} disabled={loading} onClick={onLoadMore}>
      {t('templates.community_load_more')}
    </Button>)}
  </div>)
}

function CommunityCard({ item, mine, onUse, onImport, onUnpublish }: {
  item: CommunityTemplate
  mine: boolean
  onUse: () => void
  onImport: () => void
  onUnpublish: () => void
}) {
  const locale = useLocale()
  const lineCount = useMemo(
    () => item.content.split('\n').filter((line) => line.trim()).length,
    [item.content],
  )
  const date = useMemo(
    () => new Date(item.createdAt).toLocaleDateString(locale),
    [item.createdAt, locale],
  )
  return (<div className='group relative flex min-h-33 flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3.5 transition-[border-color,box-shadow] duration-[var(--dur-fast)] hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-sm)]'>
    <div className='flex min-w-0 items-center gap-1.5'>
      <h3 className='min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]'>{item.name}</h3>
      {mine && <span className='shrink-0 rounded-full bg-[var(--accent-soft)] px-1.5 py-px text-[10px] font-medium text-[var(--accent)]'>{t('templates.community_mine')}</span>}
    </div>
    {item.description && <p className='mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]'>{item.description}</p>}
    {item.tags.length > 0 && (<div className='mt-1.5 flex min-w-0 flex-wrap items-center gap-1'>
      {item.tags.map((tag) => (<span key={tag} className='rounded-full bg-[var(--bg-raised)] px-1.5 py-px text-[10px] text-[var(--text-tertiary)]'>#{tag}</span>))}
    </div>)}
    <div className='relative z-10 mt-auto flex items-center gap-2 pt-2.5'>
      <span className='truncate text-[10.5px] text-[var(--text-quaternary)]'>{item.authorName}</span>
      {item.category && <span className='shrink-0 text-[10.5px] text-[var(--text-quaternary)]'>· {item.category}</span>}
      <span className='shrink-0 text-[10.5px] text-[var(--text-quaternary)]'>· {t('templates.lines_count', { value0: lineCount })} · {date}</span>
    </div>
    <div className='mt-2 flex items-center gap-1.5'>
      <Button size='sm' variant='primary' icon={<FilePlus2 size={13}/>} onClick={onUse} className='min-w-0 flex-1'>{t('templates.use_template')}</Button>
      <Tooltip label={t('templates.community_import')}>
        <IconButton label={t('templates.community_import')} size='sm' onClick={onImport}>
          <Download size={13}/>
        </IconButton>
      </Tooltip>
      {mine && (<Tooltip label={t('templates.community_unpublish')}>
        <IconButton label={t('templates.community_unpublish')} size='sm' onClick={onUnpublish} className='text-[var(--text-tertiary)] hover:text-[var(--danger)]'>
          <Trash2 size={13}/>
        </IconButton>
      </Tooltip>)}
    </div>
  </div>)
}
