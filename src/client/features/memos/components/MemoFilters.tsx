import { useRef, useState, type ReactElement } from 'react'
import { ArrowUpDown, LayoutGrid, Search, X } from 'lucide-react'
import type { MemoDisplayPreferences, MemoOrderDirection, MemoOrderField } from '@shared/memos/types'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { TagChip } from '../../../components/TagChip'
import { useFilterInput } from '../../../components/FilterInput'
import { Menu, Tooltip, type MenuItem } from '../../../components/overlay'
import { useDebouncedDraft } from '../../../lib/hooks'
import { t, type MessageKey } from '../../../lib/i18n'
import type { MemoUrlState } from '../url-state'

interface SortOption {
  id: string
  orderBy: MemoOrderField
  order: MemoOrderDirection
  labelKey: MessageKey
}

const SORT_OPTIONS: readonly SortOption[] = [
  { id: 'created-desc', orderBy: 'created', order: 'desc', labelKey: 'memos.feed.sort_created_desc' },
  { id: 'created-asc', orderBy: 'created', order: 'asc', labelKey: 'memos.feed.sort_created_asc' },
  { id: 'updated-desc', orderBy: 'updated', order: 'desc', labelKey: 'memos.feed.sort_updated_desc' },
  { id: 'updated-asc', orderBy: 'updated', order: 'asc', labelKey: 'memos.feed.sort_updated_asc' },
]

const COLUMN_OPTIONS: readonly (readonly [MemoDisplayPreferences['columns'], MessageKey])[] = [
  [1, 'memos.feed.columns_1'],
  [2, 'memos.feed.columns_2'],
  [3, 'memos.feed.columns_3'],
  ['auto', 'memos.feed.columns_auto'],
]

export interface MemoFiltersProps {
  query: Pick<MemoUrlState, 'q' | 'tag' | 'filter'>
  display: MemoDisplayPreferences
  onSearch: (value: string) => void
  onRemoveTag: () => void
  onRemoveFilter: () => void
  onClear: () => void
  onSortChange: (orderBy: MemoOrderField, order: MemoOrderDirection) => void
  onDisplayChange: (patch: Partial<Pick<MemoDisplayPreferences, 'columns' | 'compact' | 'linkPreview'>>) => void
}

export function MemoFilters({
  query,
  display,
  onSearch,
  onRemoveTag,
  onRemoveFilter,
  onClear,
  onSortChange,
  onDisplayChange,
}: MemoFiltersProps): ReactElement {
  const { draft, setDraft } = useDebouncedDraft(query.q, onSearch, 300)
  const { field, clear } = useFilterInput({
    value: draft,
    escapeWhenEmpty: 'blur',
    onClear: () => setDraft(''),
  })
  const [sortOpen, setSortOpen] = useState(false)
  const [displayOpen, setDisplayOpen] = useState(false)
  const sortRef = useRef<HTMLButtonElement>(null)
  const displayRef = useRef<HTMLButtonElement>(null)
  const hasFilters = query.q.trim() !== '' || query.tag !== null || query.filter.trim() !== ''

  const sortItems: MenuItem[] = SORT_OPTIONS.map((option) => ({
    id: option.id,
    label: t(option.labelKey),
    checked: display.timeBasis === option.orderBy && display.order === option.order,
    onSelect: () => onSortChange(option.orderBy, option.order),
  }))

  const displayItems: MenuItem[] = [
    ...COLUMN_OPTIONS.map(([columns, labelKey]) => ({
      id: `columns-${columns}`,
      label: t(labelKey),
      checked: display.columns === columns,
      onSelect: () => onDisplayChange({ columns }),
    })),
    {
      id: 'compact',
      label: t('memos.feed.compact'),
      checked: display.compact,
      separatorBefore: true,
      onSelect: () => onDisplayChange({ compact: !display.compact }),
    },
    {
      id: 'link-preview',
      label: t('memos.feed.link_preview'),
      checked: display.linkPreview,
      onSelect: () => onDisplayChange({ linkPreview: !display.linkPreview }),
    },
    {
      id: 'time-created',
      label: t('memos.feed.time_created'),
      checked: display.timeBasis === 'created',
      separatorBefore: true,
      onSelect: () => onSortChange('created', display.order),
    },
    {
      id: 'time-updated',
      label: t('memos.feed.time_updated'),
      checked: display.timeBasis === 'updated',
      onSelect: () => onSortChange('updated', display.order),
    },
  ]

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="w-full min-w-0 sm:w-60">
        <Input
          {...field}
          type="search"
          aria-label={t('memos.feed.search_label')}
          placeholder={t('memos.feed.search_placeholder')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          leading={<Search size={13} />}
          trailing={draft ? (
            <IconButton label={t('memos.feed.clear_search')} size="xs" onClick={clear}>
              <X size={12} />
            </IconButton>
          ) : undefined}
          className="h-9 text-[length:var(--text-12)] [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-results-button]:hidden md:h-7"
        />
      </div>
      {query.tag ? (
        <TagChip
          label={query.tag}
          sigil
          pressed
          onPress={onRemoveTag}
          ariaLabel={t('memos.feed.remove_tag', { tag: query.tag })}
          trailing={<X size={10} aria-hidden="true" />}
        />
      ) : null}
      {query.filter.trim() ? (
        <TagChip
          label={query.filter}
          pressed
          onPress={onRemoveFilter}
          ariaLabel={t('memos.feed.remove_filter')}
          className="max-w-[240px]"
          trailing={<X size={10} aria-hidden="true" />}
        />
      ) : null}
      {hasFilters ? (
        <Button size="sm" variant="ghost" className="h-9 md:h-7" onClick={onClear}>
          {t('memos.feed.clear_filters')}
        </Button>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip label={t('memos.feed.sort')} side="bottom">
          <IconButton
            ref={sortRef}
            label={t('memos.feed.sort')}
            size="sm"
            active={sortOpen}
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((value) => !value)}
          >
            <ArrowUpDown size={14} />
          </IconButton>
        </Tooltip>
        <Menu
          anchor={sortRef}
          open={sortOpen}
          onClose={() => setSortOpen(false)}
          items={sortItems}
          label={t('memos.feed.sort')}
          align="end"
          width={220}
        />
        <Tooltip label={t('memos.feed.display')} side="bottom">
          <IconButton
            ref={displayRef}
            label={t('memos.feed.display')}
            size="sm"
            active={displayOpen}
            aria-haspopup="menu"
            aria-expanded={displayOpen}
            onClick={() => setDisplayOpen((value) => !value)}
          >
            <LayoutGrid size={14} />
          </IconButton>
        </Tooltip>
        <Menu
          anchor={displayRef}
          open={displayOpen}
          onClose={() => setDisplayOpen(false)}
          items={displayItems}
          label={t('memos.feed.display')}
          align="end"
          width={220}
        />
      </div>
    </div>
  )
}
