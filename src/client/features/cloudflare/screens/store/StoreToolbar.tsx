import { Star } from 'lucide-react'
import { Button } from '../../../../components/primitives'
import { SelectMenu } from '../../../../components/select-menu'
import { SearchField } from '../../components/SearchField'
import { useCfT } from '../../i18n'
import type { StoreSort } from './helpers'

export function StoreToolbar({
  search,
  sort,
  favoritesOnly,
  hasFilters,
  onSearchChange,
  onSortChange,
  onFavoritesOnlyChange,
  onClear,
}: {
  search: string
  sort: StoreSort
  favoritesOnly: boolean
  hasFilters: boolean
  onSearchChange: (value: string) => void
  onSortChange: (sort: StoreSort) => void
  onFavoritesOnlyChange: (value: boolean) => void
  onClear: () => void
}) {
  const t = useCfT()
  const sortOptions = [
    { value: 'newest', label: t('templates.community_sort_newest') },
    { value: 'name', label: t('cloudflare.store_toolbar.sort_name') },
    { value: 'version', label: t('cloudflare.store_toolbar.sort_version') },
  ] as const

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchField
        value={search}
        onChange={onSearchChange}
        label={t('cloudflare.store_toolbar.search_placeholder')}
        placeholder={t('cloudflare.store_toolbar.search_placeholder')}
        className="w-full sm:w-60"
      />
      <SelectMenu
        label={t('preview.kanban_sort')}
        value={sort}
        options={sortOptions}
        onChange={onSortChange}
        size="sm"
        width={200}
        className="w-44"
      />
      <Button
        size="sm"
        variant={favoritesOnly ? 'primary' : 'secondary'}
        aria-pressed={favoritesOnly}
        icon={<Star size={13} className={favoritesOnly ? 'fill-current' : undefined} />}
        onClick={() => onFavoritesOnlyChange(!favoritesOnly)}
      >
        {favoritesOnly ? t('cloudflare.store_toolbar.fav_only') : t('cloudflare.store_toolbar.favorites')}
      </Button>
      {hasFilters ? (
        <Button size="sm" variant="ghost" onClick={onClear}>
          {t('cloudflare.store_toolbar.clear_filter')}
        </Button>
      ) : null}
    </div>
  )
}
