import { Search, Star } from 'lucide-react'
import type { WebsshHost, WebsshHostGroup } from '@shared/webssh/types'
import { Button, Spinner } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { Input, Select } from '../../components/form'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'

export interface HostListProps {
  hosts: WebsshHost[]
  groups: WebsshHostGroup[]
  loading: boolean
  error: string | null
  query: string
  groupId: string
  favoriteOnly: boolean
  sort: 'manual' | 'name' | 'recent'
  selectedId: string | null
  page: number
  pageSize: number
  total: number
  onQueryChange: (value: string) => void
  onGroupChange: (value: string) => void
  onFavoriteToggle: () => void
  onSortChange: (value: 'manual' | 'name' | 'recent') => void
  onSelect: (id: string) => void
  onPageChange: (page: number) => void
  onNew: () => void
  onRetry: () => void
}

export function HostList(props: HostListProps) {
  const groupNames = new Map(props.groups.map((group) => [group.id, group.name]))
  const pageCount = Math.max(1, Math.ceil(props.total / props.pageSize))

  return (
    <section
      aria-label={t('webssh.list.title')}
      className="flex min-h-0 w-full flex-col border-[var(--border-subtle)] md:w-[320px] md:shrink-0 md:border-r"
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--border-subtle)] p-3">
        <div className="flex items-center gap-2">
          <Input
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={t('webssh.list.search_placeholder')}
            aria-label={t('webssh.list.search_placeholder')}
            leading={<Search size={14} aria-hidden="true" />}
            className="min-w-0 flex-1"
          />
          <Button
            variant={props.favoriteOnly ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={props.favoriteOnly}
            onClick={props.onFavoriteToggle}
            icon={<Star size={13} aria-hidden="true" />}
          >
            {t('webssh.list.favorites')}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={props.groupId}
            onChange={(event) => props.onGroupChange(event.target.value)}
            aria-label={t('webssh.host.group')}
            className="min-w-0 flex-1"
          >
            <option value="">{t('webssh.list.all_groups')}</option>
            {props.groups.map((group) => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </Select>
          <Select
            value={props.sort}
            onChange={(event) => props.onSortChange(event.target.value as 'manual' | 'name' | 'recent')}
            aria-label={t('webssh.list.sort')}
            className="w-[120px] shrink-0"
          >
            <option value="manual">{t('webssh.list.sort_manual')}</option>
            <option value="name">{t('webssh.list.sort_name')}</option>
            <option value="recent">{t('webssh.list.sort_recent')}</option>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('webssh.list.count', { count: props.total })}
          </span>
          <Button size="sm" variant="primary" onClick={props.onNew}>
            {t('webssh.actions.new_host')}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {props.error ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-[length:var(--text-12-5)] text-[var(--danger)]">{props.error}</p>
            <Button size="sm" onClick={props.onRetry}>{t('webssh.actions.retry')}</Button>
          </div>
        ) : props.loading && props.hosts.length === 0 ? (
          <div className="flex justify-center py-10"><Spinner size={18} /></div>
        ) : props.hosts.length === 0 ? (
          <Empty
            art={props.query || props.groupId || props.favoriteOnly ? 'search' : 'select'}
            title={props.query || props.groupId || props.favoriteOnly ? t('webssh.list.no_results') : t('webssh.list.empty_title')}
            description={props.query || props.groupId || props.favoriteOnly ? undefined : t('webssh.list.empty_description')}
            compact
          />
        ) : (
          <ul className="space-y-1">
            {props.hosts.map((host) => {
              const selected = host.id === props.selectedId
              return (
                <li key={host.id}>
                  <button
                    type="button"
                    onClick={() => props.onSelect(host.id)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'flex w-full flex-col gap-1 rounded-[var(--r-md)] border border-transparent px-2.5 py-2 text-left',
                      'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                      selected
                        ? 'border-[var(--border-default)] bg-[var(--bg-raised)]'
                        : 'hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {host.favorite && <Star size={12} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />}
                      <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{host.name}</span>
                    </span>
                    <span className="truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
                      {host.username}@{host.host}:{host.port}
                    </span>
                    {(host.groupId || host.tags.length > 0) && (
                      <span className="flex flex-wrap items-center gap-1">
                        {host.groupId && (
                          <span className="rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                            {groupNames.get(host.groupId) ?? t('webssh.list.group_ungrouped')}
                          </span>
                        )}
                        {host.tags.map((tag) => (
                          <span key={tag} className="rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
          <Button size="sm" variant="ghost" disabled={props.page <= 1} onClick={() => props.onPageChange(props.page - 1)}>
            {t('webssh.actions.previous')}
          </Button>
          <span className="text-[length:var(--text-11-5)] tabular text-[var(--text-tertiary)]">
            {t('webssh.list.page_of', { page: props.page, count: pageCount })}
          </span>
          <Button size="sm" variant="ghost" disabled={props.page >= pageCount} onClick={() => props.onPageChange(props.page + 1)}>
            {t('webssh.actions.next')}
          </Button>
        </div>
      )}
    </section>
  )
}
