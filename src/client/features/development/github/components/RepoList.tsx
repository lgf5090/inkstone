import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, CircleDot, Download, Globe, PanelLeft, PanelRight, RefreshCw, Settings2, Star, X } from 'lucide-react'
import type { GithubMirrorSource, GithubPrefs, GithubRepo, GithubTag, SavedGithubRepo } from '@shared/development/github/types'
import { GITHUB_PER_PAGE, GITHUB_RANGE_OPTIONS, GITHUB_SORT_OPTIONS } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { cn } from '../../../../lib/cn'
import { Button, IconButton, Spinner } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Empty } from '../../../../components/feedback'
import { Menu, type MenuItem } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { getLanguageColor, fuzzyMatchLanguages } from '../lib/languages'
import { buildMirrorDownloadUrl, formatNumber } from '../lib/format'
import { RepoRow } from './RepoRow'

function LanguageMenu({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const items: MenuItem[] = fuzzyMatchLanguages('').map((language) => ({
    id: language.name,
    label: language.name,
    icon: <span className="size-2.5 rounded-full" style={{ backgroundColor: language.color }} />,
    checked: value === language.name,
    onSelect: () => onChange(language.name),
  }))
  items.unshift({ id: '__clear__', label: t('development.github.repos.clear_language'), onSelect: () => onChange('') })
  return (
    <>
      <Button ref={anchor} variant="secondary" size="sm" className="h-7 max-w-32 gap-1.5" onClick={() => setOpen(true)}>
        {value ? <><span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: getLanguageColor(value) }} /><span className="truncate">{value}</span></> : <>{t('development.github.repos.language')}<ChevronDown size={11} /></>}
      </Button>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={items} searchable searchPlaceholder={t('development.github.repos.language')} width={240} label={t('development.github.repos.language')} />
    </>
  )
}

export function RepoList({
  isExplore,
  query,
  onQueryChange,
  onCommitSearch,
  onClear,
  onGoDiscover,
  loading,
  error,
  prefs,
  onUpdatePrefs,
  mirrors,
  currentMirrorId,
  onCurrentMirrorChange,
  onManageMirrors,
  onRefresh,
  items,
  totalCount,
  page,
  onPageChange,
  repoMap,
  tags,
  selectedRepoId,
  onSelectRepo,
  onTogglePin,
  onToggleFav,
  onToggleTag,
  onRemoveRepo,
  onSyncStars,
  syncingStars,
  onExportLibrary,
  toggleSidebar,
  toggleDetail,
  detailDisabled,
}: {
  isExplore: boolean
  query: string
  onQueryChange: (value: string) => void
  onCommitSearch: (query: string) => void
  onClear: () => void
  onGoDiscover: () => void
  loading: boolean
  error: string | null
  prefs: GithubPrefs
  onUpdatePrefs: (patch: Partial<GithubPrefs>, query?: string) => void
  mirrors: GithubMirrorSource[]
  currentMirrorId: string
  onCurrentMirrorChange: (id: string) => void
  onManageMirrors: () => void
  onRefresh: () => void
  items: GithubRepo[]
  totalCount: number
  page: number
  onPageChange: (page: number) => void
  repoMap: Map<string, SavedGithubRepo>
  tags: GithubTag[]
  selectedRepoId: string | null
  onSelectRepo: (repo: GithubRepo) => void
  onTogglePin: (repo: GithubRepo) => void
  onToggleFav: (repo: GithubRepo) => void
  onToggleTag: (repo: GithubRepo, tagId: string) => void
  onRemoveRepo: (repo: GithubRepo) => void
  onSyncStars: () => void
  syncingStars: boolean
  onExportLibrary: () => void
  toggleSidebar: () => void
  toggleDetail: () => void
  detailDisabled: boolean
}) {
  const settingsAnchor = useRef<HTMLButtonElement>(null)
  const mirrorAnchor = useRef<HTMLButtonElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mirrorOpen, setMirrorOpen] = useState(false)
  const [draft, setDraft] = useState(query)
  useEffect(() => setDraft(query), [query])
  const currentMirror = mirrors.find((mirror) => mirror.id === currentMirrorId) ?? mirrors[0]
  const hasMore = isExplore && items.length === GITHUB_PER_PAGE && page * GITHUB_PER_PAGE < Math.min(totalCount, 1000)
  const hasPrev = page > 1
  const settingsItems: MenuItem[] = [
    { id: 'sort-header', label: t('development.github.repos.sort_by'), disabled: true },
    ...GITHUB_SORT_OPTIONS.map((option) => ({
      id: `sort-${option.value}`,
      label: t(option.labelKey),
      checked: prefs.sort === option.value,
      onSelect: () => onUpdatePrefs({ sort: option.value }, draft),
    })),
    { id: 'order', label: prefs.order === 'desc' ? t('development.github.repos.current_desc') : t('development.github.repos.current_asc'), icon: prefs.order === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />, onSelect: () => onUpdatePrefs({ order: prefs.order === 'desc' ? 'asc' : 'desc' }, draft) },
    { id: 'refresh', label: t('development.github.common.refresh'), icon: <RefreshCw size={13} className={cn(loading && 'animate-spin')} />, separatorBefore: true, onSelect: onRefresh },
    { id: 'sync-stars', label: syncingStars ? t('development.github.repos.syncing_stars') : t('development.github.repos.sync_stars'), icon: <Star size={13} />, disabled: syncingStars, onSelect: onSyncStars },
    { id: 'export-library', label: t('development.github.repos.export_library'), icon: <Download size={13} />, onSelect: onExportLibrary },
  ]
  const mirrorItems: MenuItem[] = [
    ...mirrors.filter((mirror) => mirror.enabled).map((mirror) => ({ id: `mirror-${mirror.id}`, label: mirror.name, icon: <Globe size={13} />, checked: currentMirrorId === mirror.id, onSelect: () => onCurrentMirrorChange(mirror.id) })),
    { id: 'mirror-manage', label: t('development.github.mirrors.manage'), icon: <Settings2 size={13} />, separatorBefore: true, onSelect: onManageMirrors },
  ]
  return (
    <div className="flex h-full min-w-0 flex-col border-r border-[var(--border-subtle)]" data-slot="repo-list">
      <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
        <div className="flex items-center gap-1.5 px-2 py-2">
          <IconButton label={t('development.github.common.toggle_sidebar')} size="sm" onClick={toggleSidebar}><PanelLeft size={15} /></IconButton>
          <div className="min-w-0 flex-1">
            <Input
              type="search"
              value={draft}
              onChange={(event) => {
                const next = event.target.value
                setDraft(next)
                if (!isExplore) onQueryChange(next)
              }}
              onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter' && isExplore) { event.preventDefault(); onCommitSearch(draft) } }}
              placeholder={isExplore ? t('development.github.repos.search_placeholder') : t('development.github.repos.filter_placeholder')}
              aria-label={t('development.github.repos.search')}
              className="h-8 pr-7 text-[length:var(--text-12)]"
              trailing={draft ? <IconButton label={t('common.clear')} size="sm" onClick={() => { setDraft(''); onClear() }}><X size={12} /></IconButton> : undefined}
            />
          </div>
          <Button ref={mirrorAnchor} variant="secondary" size="sm" className="size-8 px-0" title={t('development.github.mirrors.section')} aria-label={t('development.github.mirrors.section')} onClick={() => setMirrorOpen(true)}><Globe size={14} /></Button>
          <Button ref={settingsAnchor} variant="secondary" size="sm" className="size-8 px-0" title={t('development.github.repos.more_settings')} aria-label={t('development.github.repos.more_settings')} onClick={() => setSettingsOpen(true)}><Settings2 size={14} /></Button>
          <IconButton label={t('development.github.common.toggle_detail')} size="sm" onClick={toggleDetail} disabled={detailDisabled}><PanelRight size={15} /></IconButton>
        </div>
        {isExplore ? (
          <div className="flex items-center gap-1.5 px-2 pb-2">
            <div className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex">
              {GITHUB_RANGE_OPTIONS.map((option) => {
                const active = prefs.range === option.value
                return <button key={option.value} type="button" onClick={() => onUpdatePrefs({ range: option.value }, draft)} data-active={active || undefined} className={cn('shrink-0 rounded-full px-2.5 py-1 text-[length:var(--text-11)] font-medium transition-colors', active ? 'bg-[var(--accent)] text-[var(--accent-contrast)]' : 'bg-[var(--bg-raised)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]')}>{t(option.labelKey)}</button>
              })}
              <LanguageMenu value={prefs.language} onChange={(language) => onUpdatePrefs({ language }, draft)} />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-1.5 md:hidden">
              <SelectMenu
                value={prefs.range}
                options={GITHUB_RANGE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                onChange={(range) => onUpdatePrefs({ range }, draft)}
                label={t('development.github.repos.range_filter')}
                size="sm"
                className="h-7"
                width={180}
              />
              <LanguageMenu value={prefs.language} onChange={(language) => onUpdatePrefs({ language }, draft)} />
            </div>
            <span className="ml-auto shrink-0 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.repos.result_count', { count: formatNumber(totalCount) })}</span>
          </div>
        ) : (
          <div className="px-2 pb-2 text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.github.repos.repo_count', { count: totalCount })}</div>
        )}
      </div>
      <Menu anchor={settingsAnchor} open={settingsOpen} onClose={() => setSettingsOpen(false)} items={settingsItems} align="end" width={250} label={t('development.github.repos.more_settings')} />
      <Menu anchor={mirrorAnchor} open={mirrorOpen} onClose={() => setMirrorOpen(false)} items={mirrorItems} align="end" width={220} label={t('development.github.mirrors.section')} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <CircleDot size={22} className="text-[var(--danger)]" />
            <p className="text-[length:var(--text-13)] font-medium">{t('development.github.common.load_failed')}</p>
            <p className="max-w-xs text-[length:var(--text-11)] text-[var(--text-tertiary)]">{error}</p>
            <Button variant="secondary" size="sm" onClick={onRefresh} disabled={loading}><RefreshCw size={12} />{t('development.github.common.retry')}</Button>
          </div>
        ) : items.length === 0 && !loading ? (
          <Empty
            art="search"
            title={isExplore ? t('development.github.repos.no_results') : t('development.github.repos.no_repos')}
            action={query
              ? <Button variant="secondary" size="sm" onClick={onClear}>{t('common.clear')}</Button>
              : !isExplore
                ? <Button variant="secondary" size="sm" onClick={onGoDiscover}>{t('development.github.repos.discover')}</Button>
                : undefined}
          />
        ) : (
          <div className="absolute inset-0 overflow-y-auto overscroll-contain">
            <ul className="divide-y divide-[var(--border-subtle)]">
              {items.map((repo, index) => (
                <RepoRow key={repo.id} repo={repo} rank={isExplore ? (page - 1) * GITHUB_PER_PAGE + index + 1 : index + 1} saved={repoMap.get(String(repo.id))} tags={tags} selected={selectedRepoId === String(repo.id)} mirrorUrl={currentMirror ? buildMirrorDownloadUrl(currentMirror.url, repo.url) : repo.url} onSelect={onSelectRepo} onTogglePin={onTogglePin} onToggleFav={onToggleFav} onToggleTag={onToggleTag} onRemove={onRemoveRepo} />
              ))}
              {loading && <li className="flex items-center justify-center gap-2 py-10 text-[length:var(--text-12)] text-[var(--text-tertiary)]"><Spinner size={14} />{t('development.github.common.loading')}</li>}
            </ul>
          </div>
        )}
      </div>
      {isExplore && (hasPrev || hasMore) && items.length > 0 && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--border-subtle)] p-2">
          <Button variant="secondary" size="sm" disabled={!hasPrev || loading} onClick={() => onPageChange(Math.max(1, page - 1))}><ChevronLeft size={12} />{t('development.github.common.prev_page')}</Button>
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('development.github.common.page', { page })}</span>
          <Button variant="secondary" size="sm" disabled={!hasMore || loading} onClick={() => onPageChange(page + 1)}>{t('development.github.common.next_page')}<ChevronRight size={12} /></Button>
        </div>
      )}
    </div>
  )
}
