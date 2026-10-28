import { useRef, useState } from 'react'
import { Calendar, Check, ChevronLeft, ChevronRight, Download, FileCode, Globe, LayoutGrid, List, Lock, PanelLeft, PanelRight, Pin, Plus, RefreshCw, Settings2, Star, Tag as TagIcon, Trash2, X } from 'lucide-react'
import type { GithubTag, GistPrefs, SavedGist } from '@shared/development/github/types'
import { GIST_SORT_OPTIONS } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { copyText } from '../../../../lib/clipboard'
import { useUi } from '../../../../store/ui'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Checkbox, Input } from '../../../../components/form'
import { Empty } from '../../../../components/feedback'
import { Menu, type MenuItem } from '../../../../components/overlay'
import { formatDate } from '../lib/format'
import { AssignedTagChips, TagAssign } from './TagAssign'

function GistRow({ gist, tags, selected, checked, remote, savedRemote, onCheck, onSelect, onTogglePin, onToggleFav, onToggleTag, onSaveToLocal }: { gist: SavedGist; tags: GithubTag[]; selected: boolean; checked: boolean; remote: boolean; savedRemote: boolean; onCheck: (id: string, checked: boolean) => void; onSelect: () => void; onTogglePin: () => void; onToggleFav: () => void; onToggleTag: (tagId: string) => void; onSaveToLocal: () => void }) {
  const toast = useUi((state) => state.toast)
  const assigned = tags.filter((tag) => gist.tagIds.includes(tag.id))
  const first = gist.data.files[0]
  const title = gist.description || first?.filename || gist.id
  const copy = async () => {
    const ok = await copyText(gist.url || gist.data.url)
    toast({ title: ok ? t('development.github.gists.url_copied') : t('development.github.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }
  return (
    <li role="option" aria-selected={selected} tabIndex={0} data-slot="github-gist-row" onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }} className={cn('group cursor-pointer border-l-2 px-3 py-3 transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none', selected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-transparent')}>
      <div className="flex gap-2">
        {!remote && <Checkbox checked={checked} onChange={(next) => onCheck(gist.id, next)} ariaLabel={t('development.github.gists.select_all')} className="mt-1 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {gist.data.isPublic ? <Globe size={13} className="shrink-0 text-[var(--success)]" /> : <Lock size={13} className="shrink-0 text-[var(--warning)]" />}
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-medium" title={title}>{title}</span>
            <div className="flex shrink-0 items-center gap-0.5 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100">
              {remote ? (
                <>
                  <IconButton label={savedRemote ? t('development.github.gists.saved_local') : t('development.github.gists.save_local')} size="sm" onClick={(event) => { event.stopPropagation(); if (!savedRemote) onSaveToLocal() }}>{savedRemote ? <Check size={13} className="text-[var(--success)]" /> : <Download size={13} />}</IconButton>
                  <IconButton label={t('development.github.gists.copy_url')} size="sm" onClick={(event) => { event.stopPropagation(); void copy() }}><FileCode size={13} /></IconButton>
                </>
              ) : (
                <>
                  <IconButton label={gist.pinned ? t('development.github.repos.unpin') : t('development.github.repos.pin')} size="sm" onClick={(event) => { event.stopPropagation(); onTogglePin() }}><Pin size={13} className={cn(gist.pinned && 'fill-current text-[var(--warning)]')} /></IconButton>
                  <IconButton label={gist.favorited ? t('development.github.repos.unfavorite') : t('development.github.repos.favorite')} size="sm" onClick={(event) => { event.stopPropagation(); onToggleFav() }}><Star size={13} className={cn(gist.favorited && 'fill-current text-[var(--warning)]')} /></IconButton>
                  <IconButton label={t('development.github.gists.copy_url')} size="sm" onClick={(event) => { event.stopPropagation(); void copy() }}><FileCode size={13} /></IconButton>
                </>
              )}
            </div>
          </div>
          {gist.data.files.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{gist.data.files.slice(0, 4).map((file, index) => <span key={`${file.filename}-${index}`} className="inline-flex items-center gap-1 rounded bg-[var(--bg-raised)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]"><FileCode size={9} />{file.filename}</span>)}{gist.data.files.length > 4 && <span className="text-[length:var(--text-10)] text-[var(--text-quaternary)]">+{gist.data.files.length - 4}</span>}</div>}
          {!remote && <div className="mt-1.5 flex flex-wrap items-center gap-1"><AssignedTagChips tags={assigned} /><TagAssign assignedTags={assigned} allTags={tags} onToggle={onToggleTag} /></div>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
            <span className="inline-flex items-center gap-0.5"><FileCode size={10} />{t('development.github.gists.file_count', { count: gist.data.fileCount })}</span>
            {gist.data.owner && <span>{gist.data.owner.login}</span>}
            <span className="inline-flex items-center gap-0.5"><Calendar size={10} />{formatDate(gist.data.updatedAt)}</span>
          </div>
        </div>
      </div>
    </li>
  )
}

function GistCard({ gist, tags, selected, checked, onCheck, onSelect, onTogglePin, onToggleFav, onToggleTag }: { gist: SavedGist; tags: GithubTag[]; selected: boolean; checked: boolean; onCheck: (id: string, checked: boolean) => void; onSelect: () => void; onTogglePin: () => void; onToggleFav: () => void; onToggleTag: (tagId: string) => void }) {
  const assigned = tags.filter((tag) => gist.tagIds.includes(tag.id))
  const first = gist.data.files[0]
  return (
    <div role="option" aria-selected={selected} tabIndex={0} data-slot="github-gist-card" onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }} className={cn('group flex cursor-pointer flex-col rounded-[var(--r-lg)] border p-3 transition-all focus-visible:outline-none', selected ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border-subtle)] hover:shadow-[var(--shadow-pop)]')}>
      <div className="flex items-center gap-2">
        <Checkbox checked={checked} onChange={(next) => onCheck(gist.id, next)} ariaLabel={t('development.github.gists.select_all')} className="shrink-0" />
        {gist.data.isPublic ? <Globe size={13} className="shrink-0 text-[var(--success)]" /> : <Lock size={13} className="shrink-0 text-[var(--warning)]" />}
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-medium">{gist.description || first?.filename || gist.id}</span>
        <IconButton label={gist.pinned ? t('development.github.repos.unpin') : t('development.github.repos.pin')} size="sm" onClick={(event) => { event.stopPropagation(); onTogglePin() }}><Pin size={13} className={cn(gist.pinned && 'fill-current text-[var(--warning)]')} /></IconButton>
        <IconButton label={gist.favorited ? t('development.github.repos.unfavorite') : t('development.github.repos.favorite')} size="sm" onClick={(event) => { event.stopPropagation(); onToggleFav() }}><Star size={13} className={cn(gist.favorited && 'fill-current text-[var(--warning)]')} /></IconButton>
      </div>
      {first && <pre className="mt-2 max-h-24 overflow-hidden rounded bg-[var(--bg-inset)] p-2 text-[length:var(--text-10)] leading-relaxed text-[var(--text-tertiary)]"><code className="line-clamp-4 font-mono">{first.content.slice(0, 200) || t('development.github.gists.empty_file')}</code></pre>}
      <div className="mt-2 flex flex-wrap gap-1">{gist.data.files.slice(0, 3).map((file, index) => <span key={`${file.filename}-${index}`} className="inline-flex items-center gap-0.5 rounded bg-[var(--bg-raised)] px-1.5 py-0.5 text-[length:var(--text-10)] text-[var(--text-tertiary)]"><FileCode size={9} />{file.filename}</span>)}</div>
      <div className="mt-2 flex items-center gap-2"><div className="flex min-w-0 flex-1 flex-wrap items-center gap-1"><AssignedTagChips tags={assigned.slice(0, 3)} /><TagAssign assignedTags={assigned} allTags={tags} onToggle={onToggleTag} /></div><span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{gist.data.fileCount} · {formatDate(gist.data.updatedAt)}</span></div>
    </div>
  )
}

export function GistList({
  query,
  onQueryChange,
  onClear,
  totalCount,
  viewMode,
  onViewModeChange,
  prefs,
  onUpdatePrefs,
  onRefresh,
  items,
  tags,
  selectedGistId,
  onSelectGist,
  onTogglePin,
  onToggleFav,
  onToggleTag,
  selectedIds,
  onCheck,
  onSelectAll,
  onBatchDelete,
  onBatchPin,
  onBatchFav,
  onBatchTag,
  onCreate,
  onImport,
  loading,
  error,
  remote,
  savedRemoteIds,
  onSaveToLocal,
  hasNextPage,
  currentPage,
  onLoadPage,
  remoteTitle,
  toggleSidebar,
  toggleDetail,
  detailDisabled,
}: {
  query: string
  onQueryChange: (value: string) => void
  onClear: () => void
  totalCount: number
  viewMode: 'list' | 'card'
  onViewModeChange: (mode: 'list' | 'card') => void
  prefs: GistPrefs
  onUpdatePrefs: (patch: Partial<GistPrefs>) => void
  onRefresh: () => void
  items: SavedGist[]
  tags: GithubTag[]
  selectedGistId: string | null
  onSelectGist: (gist: SavedGist) => void
  onTogglePin: (gist: SavedGist) => void
  onToggleFav: (gist: SavedGist) => void
  onToggleTag: (gist: SavedGist, tagId: string) => void
  selectedIds: Set<string>
  onCheck: (id: string, checked: boolean) => void
  onSelectAll: () => void
  onBatchDelete: () => void
  onBatchPin: (pinned: boolean) => void
  onBatchFav: (favorited: boolean) => void
  onBatchTag: (tagId: string) => void
  onCreate: () => void
  onImport: () => void
  loading: boolean
  error: string | null
  remote: boolean
  savedRemoteIds?: Set<string>
  onSaveToLocal?: (gist: SavedGist) => void
  hasNextPage: boolean
  currentPage: number
  onLoadPage: (page: number) => void
  remoteTitle?: string
  toggleSidebar: () => void
  toggleDetail: () => void
  detailDisabled: boolean
}) {
  const sortAnchor = useRef<HTMLButtonElement>(null)
  const tagAnchor = useRef<HTMLButtonElement>(null)
  const [sortOpen, setSortOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const allSelected = items.length > 0 && items.every((gist) => selectedIds.has(gist.id))
  const sortItems: MenuItem[] = [
    ...GIST_SORT_OPTIONS.map((option) => ({ id: option.value, label: t(option.labelKey), checked: prefs.sort === option.value, onSelect: () => onUpdatePrefs({ sort: option.value }) })),
    { id: 'order', label: prefs.order === 'desc' ? t('development.github.gists.current_desc') : t('development.github.gists.current_asc'), separatorBefore: true, onSelect: () => onUpdatePrefs({ order: prefs.order === 'desc' ? 'asc' : 'desc' }) },
    { id: 'refresh', label: t('development.github.common.refresh'), icon: <RefreshCw size={13} />, separatorBefore: true, onSelect: onRefresh },
  ]
  const tagItems: MenuItem[] = tags.length > 0 ? tags.map((tag) => ({ id: tag.id, label: tag.name, icon: <span className="size-2.5 rounded-full" style={{ backgroundColor: tag.color }} />, onSelect: () => onBatchTag(tag.id) })) : [{ id: 'none', label: t('development.github.tags.no_tags'), disabled: true }]
  return (
    <div className="flex h-full min-w-0 flex-col border-r border-[var(--border-subtle)]" data-slot="gist-list">
      <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
        <div className="flex items-center gap-1.5 px-2 py-2">
          <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" onClick={toggleSidebar}><PanelLeft size={15} /></IconButton>
          {!remote && <Checkbox checked={allSelected} onChange={onSelectAll} ariaLabel={t('development.github.gists.select_all')} className="shrink-0" />}
          <div className="min-w-0 flex-1"><Input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t('development.github.gists.search_placeholder')} aria-label={t('development.github.gists.search_placeholder')} title={remote ? t('development.github.gists.page_search_hint') : undefined} className="h-8 pr-7 text-[length:var(--text-12)]" trailing={query ? <IconButton label={t('common.clear')} size="sm" onClick={onClear}><X size={12} /></IconButton> : undefined} /></div>
          <div className="flex shrink-0 items-center rounded-[var(--r-sm)] border border-[var(--border-default)]">
            <IconButton label={t('development.github.gists.list_view')} size="sm" variant={viewMode === 'list' ? 'subtle' : 'ghost'} onClick={() => onViewModeChange('list')}><List size={13} /></IconButton>
            <IconButton label={t('development.github.gists.card_view')} size="sm" variant={viewMode === 'card' ? 'subtle' : 'ghost'} onClick={() => onViewModeChange('card')}><LayoutGrid size={13} /></IconButton>
          </div>
          <Button ref={sortAnchor} variant="secondary" size="sm" className="size-8 px-0" onClick={() => setSortOpen(true)} title={t('development.github.gists.sort_by')} aria-label={t('development.github.gists.sort_by')}><Settings2 size={14} /></Button>
          <Button variant="primary" size="sm" className="shrink-0" onClick={onCreate}><Plus size={13} />{t('development.github.gists.create')}</Button>
          <IconButton label={t('development.github.common.toggle_detail')} size="sm" onClick={toggleDetail} disabled={detailDisabled}><PanelRight size={15} /></IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          <span>{t('development.github.gists.count', { count: totalCount })}</span>
          {!remote && selectedIds.size > 0 && <>
            <span className="font-medium text-[var(--accent)]">{t('development.github.gists.selected', { count: selectedIds.size })}</span>
            <Button variant="ghost" size="sm" onClick={() => onBatchPin(true)}><Pin size={11} />{t('development.github.repos.pinned')}</Button>
            <Button variant="ghost" size="sm" onClick={() => onBatchFav(true)}><Star size={11} />{t('development.github.repos.favorited')}</Button>
            <Button ref={tagAnchor} variant="ghost" size="sm" onClick={() => setTagOpen(true)}><TagIcon size={11} />{t('development.github.tags.section')}</Button>
            <Button variant="ghost" size="sm" onClick={onBatchDelete}><Trash2 size={11} />{t('common.delete')}</Button>
          </>}
        </div>
      </div>
      <Menu anchor={sortAnchor} open={sortOpen} onClose={() => setSortOpen(false)} items={sortItems} align="end" width={240} label={t('development.github.gists.sort_by')} />
      <Menu anchor={tagAnchor} open={tagOpen} onClose={() => setTagOpen(false)} items={tagItems} align="start" width={220} label={t('development.github.tags.section')} />
      {remote && <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]"><Globe size={12} className="text-[var(--accent)]" /><span className="min-w-0 flex-1 truncate font-medium">{remoteTitle || t('development.github.gists.explore_github')}</span><span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">{t('development.github.gists.current_page_only')}</span>{savedRemoteIds && savedRemoteIds.size > 0 && <span className="text-[var(--success)]">{t('development.github.gists.saved_count', { count: savedRemoteIds.size })}</span>}</div>}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {error ? <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"><p className="text-[length:var(--text-12)] font-medium">{t('development.github.common.load_failed')}</p><p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{error}</p><Button variant="secondary" size="sm" onClick={onRefresh}><RefreshCw size={12} />{t('development.github.common.retry')}</Button></div>
        : items.length === 0 && !loading ? <Empty art={remote ? 'search' : 'notes'} title={remote ? t('development.github.gists.empty_remote') : query ? t('development.github.gists.no_match') : t('development.github.gists.empty')} action={!remote && !query ? <div className="flex gap-2"><Button variant="secondary" size="sm" onClick={onCreate}><Plus size={12} />{t('development.github.gists.create')}</Button><Button variant="secondary" size="sm" onClick={onImport}>{t('development.github.gists.import')}</Button></div> : undefined} />
        : viewMode === 'list' ? <div className="absolute inset-0 overflow-y-auto overscroll-contain"><ul role="listbox" aria-label={t('development.github.gists.title')} className="divide-y divide-[var(--border-subtle)]">{items.map((gist) => <GistRow key={gist.id} gist={gist} tags={tags} selected={selectedGistId === gist.id} checked={selectedIds.has(gist.id)} remote={remote} savedRemote={savedRemoteIds?.has(gist.id) ?? false} onCheck={onCheck} onSelect={() => onSelectGist(gist)} onTogglePin={() => onTogglePin(gist)} onToggleFav={() => onToggleFav(gist)} onToggleTag={(tagId) => onToggleTag(gist, tagId)} onSaveToLocal={() => onSaveToLocal?.(gist)} />)}{loading && <li className="flex items-center justify-center gap-2 py-10 text-[length:var(--text-11)] text-[var(--text-tertiary)]"><Spinner size={14} />{t('development.github.common.loading')}</li>}</ul></div>
        : <div className="absolute inset-0 overflow-y-auto overscroll-contain"><div className="grid grid-cols-1 gap-2 p-3 xl:grid-cols-2">{items.map((gist) => <GistCard key={gist.id} gist={gist} tags={tags} selected={selectedGistId === gist.id} checked={selectedIds.has(gist.id)} onCheck={onCheck} onSelect={() => onSelectGist(gist)} onTogglePin={() => onTogglePin(gist)} onToggleFav={() => onToggleFav(gist)} onToggleTag={(tagId) => onToggleTag(gist, tagId)} />)}</div></div>}
      </div>
      {remote && items.length > 0 && <div className="flex shrink-0 items-center justify-between border-t border-[var(--border-subtle)] px-3 py-2"><span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.common.page', { page: currentPage })}</span><div className="flex gap-1"><Button variant="secondary" size="sm" disabled={currentPage <= 1 || loading} onClick={() => onLoadPage(currentPage - 1)}><ChevronLeft size={12} />{t('development.github.common.prev_page')}</Button>{hasNextPage && <Button variant="secondary" size="sm" disabled={loading} onClick={() => onLoadPage(currentPage + 1)}>{t('development.github.common.next_page')}<ChevronRight size={12} /></Button>}</div></div>}
    </div>
  )
}
