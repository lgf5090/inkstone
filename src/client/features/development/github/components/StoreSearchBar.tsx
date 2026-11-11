import { useRef, useState } from 'react'
import { History, Search, SlidersHorizontal, X } from 'lucide-react'
import type { GithubSortKey } from '@shared/development/github/types'
import { GITHUB_SORT_OPTIONS } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Menu, type MenuItem } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'

export function StoreSearchBar({
  draft,
  onDraftChange,
  onSubmit,
  onClear,
  history,
  onPickHistory,
  sort,
  onSortChange,
  onOpenFilters,
  activeFilterCount,
}: {
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (value: string) => void
  onClear: () => void
  history: readonly string[]
  onPickHistory: (value: string) => void
  sort: GithubSortKey
  onSortChange: (value: GithubSortKey) => void
  onOpenFilters: () => void
  activeFilterCount: number
}) {
  const historyAnchor = useRef<HTMLButtonElement>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyItems: MenuItem[] = history.map((entry) => ({
    id: entry,
    label: entry,
    icon: <History size={12} />,
    onSelect: () => {
      onPickHistory(entry)
      setHistoryOpen(false)
    },
  }))

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <form
        className="min-w-0 flex-1 basis-full sm:basis-0"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(draft)
        }}
      >
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
          <Input
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={t('development.github.store.search_placeholder')}
            aria-label={t('development.github.store.search')}
            className="h-8 pl-8 pr-8 text-[length:var(--text-12)]"
            trailing={draft
              ? <IconButton label={t('common.clear')} size="sm" onClick={onClear}><X size={12} /></IconButton>
              : undefined}
          />
        </div>
      </form>
      <IconButton
        variant="secondary"
        size="sm"
        className="size-8 shrink-0 md:size-8"
        label={t('development.github.store.filters.open')}
        onClick={onOpenFilters}
      >
        <SlidersHorizontal size={14} />
        {activeFilterCount > 0 && <span className="ml-0.5 text-[length:var(--text-10)] tabular">{activeFilterCount}</span>}
      </IconButton>
      <SelectMenu
        label={t('development.github.store.sort')}
        value={sort}
        size="sm"
        width={190}
        align="end"
        options={GITHUB_SORT_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
        onChange={onSortChange}
        className="w-auto shrink-0"
      />
      <IconButton
        ref={historyAnchor}
        variant="secondary"
        size="sm"
        className="size-8 md:size-8"
        label={t('development.github.repos.search_history')}
        disabled={history.length === 0}
        onClick={() => setHistoryOpen(true)}
      >
        <History size={14} />
      </IconButton>
      <Menu anchor={historyAnchor} open={historyOpen} onClose={() => setHistoryOpen(false)} items={historyItems} align="end" width={240} label={t('development.github.repos.search_history')} />
    </div>
  )
}
