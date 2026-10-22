import { LayoutGrid, RefreshCw, Search, Settings, Table2 } from 'lucide-react'
import type { MessageKey } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Input, Segmented } from '../../../components/form'
import { SelectMenu } from '../../../components/select-menu'
import { Tooltip } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { SHARE_SORT_KEYS, type ShareSortKey, type ShareViewMode } from './use-share-hub'

/**
 * The hub's list controls: find a link, order them, switch the layout, refresh.
 *
 * The search box filters the rows the hub already holds rather than issuing a query, because the
 * categories, folders and tags are all views over one fetch — and a search that re-queried would make
 * the sidebar's counts describe a different set than the list under them.
 */

const SORT_LABELS: Record<ShareSortKey, MessageKey> = {
  newest: 'share.hub_sort_newest',
  oldest: 'share.hub_sort_oldest',
  views: 'share.hub_sort_views',
  title: 'share.hub_sort_title',
}

export function HubToolbar(props: {
  search: string
  onSearch: (value: string) => void
  sort: ShareSortKey
  onSort: (value: ShareSortKey) => void
  view: ShareViewMode
  onView: (value: ShareViewMode) => void
  onRefresh: () => void
  onSettings: () => void
  /** Hidden while a category view of its own (the dashboard, the directories) is showing. */
  showLayout: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
      <div className="min-w-[180px] flex-1">
        <Input
          type="search"
          value={props.search}
          aria-label={t('share.hub_search_label')}
          placeholder={t('share.hub_search_label')}
          leading={<Search size={13} aria-hidden/>}
          onChange={(event) => props.onSearch(event.target.value)}
        />
      </div>

      {props.showLayout && (
        <>
          {/* `SelectMenu`'s trigger is `w-full`, so it needs a bounded box of its own or it claims the
              whole toolbar row and pushes every other control onto the next line. */}
          <div className="w-40 shrink-0">
            <SelectMenu
              label={t('share.hub_sort_label')}
              value={props.sort}
              size="sm"
              width={160}
              options={SHARE_SORT_KEYS.map((key) => ({ value: key, label: t(SORT_LABELS[key]) }))}
              onChange={props.onSort}
            />
          </div>

          <Segmented
            label={t('share.hub_view_label')}
            value={props.view}
            onChange={props.onView}
            options={[
              { value: 'table', label: <Table2 size={13} aria-hidden/>, title: t('share.hub_view_table') },
              { value: 'grid', label: <LayoutGrid size={13} aria-hidden/>, title: t('share.hub_view_grid') },
            ]}
          />
        </>
      )}

      <Tooltip label={t('share.hub_refresh')} side="bottom">
        <IconButton
          label={t('share.hub_refresh')}
          size="sm"
          onClick={props.onRefresh}
        >
          <RefreshCw size={13}/>
        </IconButton>
      </Tooltip>

      <Tooltip label={t('share.hub_settings')} side="bottom">
        <Button
          variant="ghost"
          size="sm"
          icon={<Settings size={13}/>}
          onClick={props.onSettings}
        >
          {t('share.hub_settings')}
        </Button>
      </Tooltip>
    </div>
  )
}
