import { useEffect, useRef } from 'react'
import {
  ArrowUpDown,
  Download,
  Grid3x3,
  Images,
  List,
  Menu,
  Pin,
  RefreshCw,
  Rows3,
  Search,
  Settings2,
  SlidersHorizontal,
  Star,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { IconBootstrap } from '@shared/development/icons/types'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { Button, IconButton } from '../../../../components/primitives'
import { Input, Segmented, Slider } from '../../../../components/form'
import { SelectMenu } from '../../../../components/select-menu'
import { Tooltip } from '../../../../components/overlay'
import {
  activeFilterCount,
  clearFilters,
  type BrowseState,
  type IconDensity,
  type IconViewMode,
} from '../lib/browse'

const DENSITY_LABELS: Record<IconDensity, string> = {
  small: 'development.icons.toolbar.density.small',
  medium: 'development.icons.toolbar.density.medium',
  large: 'development.icons.toolbar.density.large',
}

const DENSITY_ORDER: readonly IconDensity[] = ['small', 'medium', 'large']

export interface ToolbarProps {
  bootstrap: IconBootstrap | null
  state: BrowseState
  total: number
  loading: boolean
  converting: boolean
  overQuota: boolean
  selectionCount: number
  onChange: (state: BrowseState) => void
  onOpenFilters: () => void
  onOpenSidebar: () => void
  onUpload: () => void
  onImport: () => void
  onExport: () => void
  onConvert: () => void
  onSettings: () => void
  onRefresh: () => void
  onClearSelection: () => void
  onBatchDelete: () => void
  onBatchFavorite: () => void
  onBatchPin: () => void
}

/**
 * Two rows, like a file browser: the first is how you find things, the second is what you do with
 * them. Keeping the verbs off the search row is what stops the toolbar from becoming a strip of
 * unlabeled glyphs at 1440px.
 */
export function Toolbar({
  bootstrap,
  state,
  total,
  loading,
  converting,
  overQuota,
  selectionCount,
  onChange,
  onOpenFilters,
  onOpenSidebar,
  onUpload,
  onImport,
  onExport,
  onConvert,
  onSettings,
  onRefresh,
  onClearSelection,
  onBatchDelete,
  onBatchFavorite,
  onBatchPin,
}: ToolbarProps) {
  const searchRef = useRef<HTMLInputElement>(null)
  const activeCount = activeFilterCount(state)

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const styleLabel = state.style ? t(`development.icons.style.${state.style}` as never) : ''

  const chips: { key: string; label: string; remove: () => void }[] = [
    ...state.collections.map((id) => ({
      key: `collection-${id}`,
      label: bootstrap?.collections.find((entry) => entry.id === id)?.name ?? id,
      remove: () => onChange({ ...state, collections: state.collections.filter((entry) => entry !== id) }),
    })),
    ...(state.style ? [{ key: 'style', label: styleLabel, remove: () => onChange({ ...state, style: '' as const }) }] : []),
    ...state.formats.map((format) => ({
      key: `format-${format}`,
      label: format.toUpperCase(),
      remove: () => onChange({ ...state, formats: state.formats.filter((entry) => entry !== format) }),
    })),
    ...state.tags.map((id) => ({
      key: `tag-${id}`,
      label: bootstrap?.tags.find((entry) => entry.id === id)?.name ?? id,
      remove: () => onChange({ ...state, tags: state.tags.filter((entry) => entry !== id) }),
    })),
    ...(state.colorMode ? [{ key: 'color', label: t(`development.icons.filter.${state.colorMode}` as never), remove: () => onChange({ ...state, colorMode: '' as const }) }] : []),
    ...(state.sizeMin || state.sizeMax ? [{
      key: 'size',
      label: `${state.sizeMin || '0'}–${state.sizeMax || '∞'} px`,
      remove: () => onChange({ ...state, sizeMin: '', sizeMax: '' }),
    }] : []),
    ...(state.from || state.to ? [{
      key: 'date',
      label: `${state.from || '…'} → ${state.to || '…'}`,
      remove: () => onChange({ ...state, from: '', to: '' }),
    }] : []),
  ]

  return (
    <header className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Tooltip label={t('development.icons.toolbar.sidebar')}>
          <IconButton label={t('development.icons.toolbar.sidebar')} size="sm" variant="secondary" className="h-8 w-8 shrink-0 lg:hidden" onClick={onOpenSidebar}><Menu size={15} /></IconButton>
        </Tooltip>

        <div className="min-w-[180px] flex-1 sm:max-w-md">
          <Input
            ref={searchRef}
            value={state.q}
            onChange={(event) => onChange({ ...state, q: event.target.value })}
            placeholder={t('development.icons.search.placeholder')}
            aria-label={t('development.icons.search.placeholder')}
            leading={<Search size={14} />}
            trailing={state.q ? (
              <button type="button" aria-label={t('development.icons.search.clear')} onClick={() => onChange({ ...state, q: '' })} className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                <X size={13} />
              </button>
            ) : undefined}
            className="h-8 md:h-8"
          />
        </div>

        <Button size="sm" variant={activeCount ? 'primary' : 'secondary'} className="gap-1" onClick={onOpenFilters}>
          <SlidersHorizontal size={13} />
          {t('development.icons.toolbar.filters')}
          {activeCount > 0 && <span className="rounded-[var(--r-full)] bg-[var(--bg-surface)] px-1.5 text-[length:var(--text-10)] tabular-nums text-[var(--text-primary)]">{activeCount}</span>}
        </Button>

        <SelectMenu
          label={t('development.icons.toolbar.sort')}
          value={state.sort}
          onChange={(value) => onChange({ ...state, sort: value as BrowseState['sort'] })}
          options={[
            { value: 'created', label: t('development.icons.toolbar.sort.created'), icon: <ArrowUpDown size={12} /> },
            { value: 'updated', label: t('development.icons.toolbar.sort.updated'), icon: <ArrowUpDown size={12} /> },
            { value: 'name', label: t('development.icons.toolbar.sort.name'), icon: <ArrowUpDown size={12} /> },
            { value: 'used', label: t('development.icons.toolbar.sort.used'), icon: <ArrowUpDown size={12} /> },
          ]}
          size="sm"
          className="w-32"
        />

        <Segmented
          value={state.view}
          onChange={(value) => onChange({ ...state, view: value as IconViewMode })}
          size="sm"
          label={t('development.icons.toolbar.view')}
          options={[
            { value: 'grid', label: <Grid3x3 size={13} />, title: t('development.icons.toolbar.view.grid') },
            { value: 'list', label: <List size={13} />, title: t('development.icons.toolbar.view.list') },
            { value: 'table', label: <Table2 size={13} />, title: t('development.icons.toolbar.view.table') },
          ]}
        />

        {state.view === 'grid' && (
          <div className="flex items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 py-1">
            <Grid3x3 size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            <Slider
              value={DENSITY_ORDER.indexOf(state.density)}
              min={0}
              max={2}
              onChange={(value) => onChange({ ...state, density: DENSITY_ORDER[value] ?? 'medium' })}
              label={t('development.icons.toolbar.density')}
              valueText={t(DENSITY_LABELS[state.density] as never)}
              showValue={false}
              className="w-24"
            />
            <span aria-hidden="true" className="w-12 shrink-0 text-[length:var(--text-10)] text-[var(--text-secondary)]">{t(DENSITY_LABELS[state.density] as never)}</span>
          </div>
        )}

        <SelectMenu
          label={t('development.icons.toolbar.page_size')}
          value={String(state.pageSize)}
          onChange={(value) => onChange({ ...state, pageSize: Number(value) })}
          options={[
            { value: '60', label: t('development.icons.toolbar.page_60'), icon: <Rows3 size={12} /> },
            { value: '120', label: t('development.icons.toolbar.page_120'), icon: <Rows3 size={12} /> },
          ]}
          size="sm"
          className="w-24"
        />

        <div className="ml-auto flex items-center gap-1">
          <Tooltip label={t('development.icons.toolbar.refresh')}>
            <IconButton label={t('development.icons.toolbar.refresh')} size="sm" className="h-8 w-8" onClick={onRefresh}>
              <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('development.icons.toolbar.settings')}>
            <IconButton label={t('development.icons.toolbar.settings')} size="sm" className="h-8 w-8" onClick={onSettings}><Settings2 size={14} /></IconButton>
          </Tooltip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border-subtle)] px-3 py-1.5">
        <Button size="sm" variant="secondary" onClick={onUpload} disabled={overQuota}><Upload size={13} />{t('development.icons.toolbar.upload')}</Button>
        <Button size="sm" variant="secondary" onClick={onImport} disabled={overQuota}><Images size={13} />{t('development.icons.toolbar.import')}</Button>
        <Button size="sm" variant="secondary" onClick={onExport} disabled={!total}><Download size={13} />{t('development.icons.toolbar.export')}</Button>
        <Button size="sm" variant="secondary" onClick={onConvert} disabled={!total || overQuota || converting}><Grid3x3 size={13} />{t('development.icons.toolbar.convert')}</Button>

        <span className="mx-1 h-4 w-px bg-[var(--border-subtle)]" aria-hidden="true" />

        {chips.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.remove}
                className="inline-flex h-6 max-w-40 items-center gap-1 rounded-[var(--r-full)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[length:var(--text-10)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                aria-label={`${t('development.icons.filter.remove')} ${chip.label}`}
              >
                <span className="truncate">{chip.label}</span>
                <X size={10} />
              </button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => onChange(clearFilters(state))}><X size={12} />{t('development.icons.filter.clear')}</Button>
          </div>
        ) : (
          <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('development.icons.toolbar.hint')}</span>
        )}

        <span className="ml-auto flex items-center gap-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {selectionCount > 0 ? (
            <>
              <span className="tabular-nums">{t('development.icons.toolbar.selected')} {selectionCount}</span>
              <Button size="sm" variant="secondary" onClick={onBatchFavorite}><Star size={12} />{t('development.icons.card.favorite')}</Button>
              <Button size="sm" variant="secondary" onClick={onBatchPin}><Pin size={12} />{t('development.icons.card.pin')}</Button>
              <Button size="sm" variant="secondary" onClick={onBatchDelete}><Trash2 size={12} />{t('development.icons.common.delete')}</Button>
              <Button size="sm" variant="ghost" onClick={onClearSelection}>{t('development.icons.common.cancel')}</Button>
            </>
          ) : (
            <span className="tabular-nums">{total.toLocaleString()} {t('development.icons.toolbar.count')}</span>
          )}
        </span>
      </div>
    </header>
  )
}
