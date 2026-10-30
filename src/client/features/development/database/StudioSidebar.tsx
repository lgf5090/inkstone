import { useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  Download,
  FileCode2,
  GripVertical,
  KeyRound,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  Plus,
  Search,
  Star,
  Table2,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import type { DatabaseConnectionView, SchemaModel } from '@shared/development/database/types'
import { cn } from '../../../lib/cn'
import { isImeComposing } from '../../../lib/ime'
import { t } from '../../../lib/i18n'
import { Button, IconButton } from '../../../components/primitives'
import { Input } from '../../../components/form'
import { Tooltip } from '../../../components/overlay'
import { GuardPanel } from './GuardPanel'
import type { ConnectionGuard } from './guards'
import type { StudioSelection } from './types'

export type ConnectionFilter = 'all' | 'pinned' | 'favorite'

export interface StudioSidebarProps {
  collapsed?: boolean
  connections: DatabaseConnectionView[]
  loading: boolean
  connectionsError?: string | null
  onRetryConnections?: () => void
  selection: StudioSelection | null
  localName?: string
  schema: SchemaModel | null
  schemaError?: string | null
  schemaLoading: boolean
  onRetrySchema?: () => void
  tableSearch: string
  onTableSearch: (value: string) => void
  connSearch: string
  onConnSearch: (value: string) => void
  connFilter: ConnectionFilter
  onConnFilter: (value: ConnectionFilter) => void
  onSelectSaved: (id: string) => void
  onSelectLocal: () => void
  onDownloadLocal?: () => void
  onNew: () => void
  onEdit: (connection: DatabaseConnectionView) => void
  onDelete: (connection: DatabaseConnectionView) => void
  onToggleFavorite: (connection: DatabaseConnectionView) => void
  onTogglePinned: (connection: DatabaseConnectionView) => void
  onReorder: (sourceId: string, targetId: string) => void
  onMove: (id: string, direction: 'up' | 'down') => void
  onOpenData: (table: string) => void
  onOpenSchema: (table: string) => void
  guard?: ConnectionGuard
  unlockedUntil?: number
  onGuardChange?: (patch: Partial<ConnectionGuard>) => void
  onLockNow?: () => void
  onExportSchema?: () => void
  onSearchData?: () => void
  onExportDatabase?: () => void
  onViewSql: (definition: { kind: 'view' | 'trigger'; name: string; sql: string }) => void
  onCollapse?: () => void
  onExpand?: () => void
  collapsible?: boolean
}

function connectionSub(connection: DatabaseConnectionView): string {
  if (connection.type === 'd1') return connection.d1DatabaseName || 'D1'
  return connection.tursoUrl || 'Turso'
}

function ConnectionIcon({ type }: { type: DatabaseConnectionView['type'] }) {
  return type === 'd1'
    ? <Zap size={14} className="shrink-0" />
    : <Database size={14} className="shrink-0" />
}

function ConnectionItem({
  connection,
  active,
  onSelect,
  onEdit,
  onDelete,
  onToggleFavorite,
  onTogglePinned,
  onReorder,
  onMove,
}: {
  connection: DatabaseConnectionView
  active: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete: () => void
  onToggleFavorite: () => void
  onTogglePinned: () => void
  onReorder: (sourceId: string, targetId: string) => void
  onMove: (direction: 'up' | 'down') => void
}) {
  const dragId = useRef<string | null>(null)
  return (
    <div
      className={cn('group flex items-center rounded-[var(--r-md)]', active && 'bg-[var(--accent-soft)]')}
      draggable
      onDragStart={(event) => {
        dragId.current = connection.id
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', connection.id)
      }}
      onDragOver={(event) => {
        if (dragId.current && dragId.current !== connection.id) event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        const source = dragId.current ?? event.dataTransfer.getData('text/plain')
        dragId.current = null
        if (source && source !== connection.id) onReorder(source, connection.id)
      }}
      onDragEnd={() => {
        dragId.current = null
      }}
    >
      <button
        type="button"
        aria-label={t('development.database.app.drag_to_reorder')}
        title={t('development.database.app.drag_to_reorder')}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        className="flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-[var(--text-quaternary)] opacity-0 focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
        onKeyDown={(event) => {
          if (!event.altKey) return
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            onMove('up')
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            onMove('down')
          }
        }}
      >
        <GripVertical size={12} />
      </button>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-md)] px-1.5 py-1 text-left text-[length:var(--text-12)]"
      >
        <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
          <ConnectionIcon type={connection.type} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            {connection.isPinned && <Pin size={10} className="shrink-0 fill-[var(--accent)] text-[var(--accent)]" />}
            {connection.isFavorite && <Star size={10} className="shrink-0 fill-[var(--warning)] text-[var(--warning)]" />}
            <span className={cn('block truncate', active ? 'font-medium text-[var(--accent-on-soft)]' : 'text-[var(--text-primary)]')} title={connection.name}>
              {connection.name}
            </span>
          </span>
          <span className="block truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]">
            {connectionSub(connection)}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center opacity-0 focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
        <Tooltip label={connection.isFavorite ? t('development.database.app.unfavorite') : t('development.database.app.favorite')}>
          <IconButton
            label={connection.isFavorite ? t('development.database.app.unfavorite') : t('development.database.app.favorite')}
            size="sm"
            onClick={onToggleFavorite}
            className={connection.isFavorite ? 'text-[var(--warning)]' : undefined}
          >
            <Star size={12} />
          </IconButton>
        </Tooltip>
        <Tooltip label={connection.isPinned ? t('development.database.app.unpin') : t('development.database.app.pin')}>
          <IconButton
            label={connection.isPinned ? t('development.database.app.unpin') : t('development.database.app.pin')}
            size="sm"
            onClick={onTogglePinned}
            className={connection.isPinned ? 'text-[var(--accent)]' : undefined}
          >
            <Pin size={12} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('development.database.app.edit_connection')}>
          <IconButton label={t('development.database.app.edit_connection')} size="sm" onClick={onEdit}>
            <Pencil size={12} />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('development.database.app.delete_connection')}>
          <IconButton
            label={t('development.database.app.delete_connection')}
            size="sm"
            onClick={onDelete}
            className="hover:text-[var(--danger)]"
          >
            <Trash2 size={12} />
          </IconButton>
        </Tooltip>
      </div>
    </div>
  )
}

function SchemaGroup({
  title,
  icon,
  items,
  kind,
  onOpen,
}: {
  title: string
  icon: ReactNode
  items: Array<{ name: string; sql: string }>
  kind: 'view' | 'trigger'
  onOpen: (definition: { kind: 'view' | 'trigger'; name: string; sql: string }) => void
}) {
  return (
    <div>
      <div className="px-1.5 pb-0.5 text-[length:var(--text-10)] font-medium text-[var(--text-tertiary)]">{title}</div>
      <div className="space-y-0.5">
        {items.map((item) => (
          <button
            key={item.name}
            type="button"
            onClick={() => onOpen({ kind, name: item.name, sql: item.sql })}
            title={item.name}
            className="flex min-h-8 w-full items-center gap-1.5 rounded-[var(--r-sm)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <span className="shrink-0 text-[var(--text-tertiary)]">{icon}</span>
            <span className="truncate">{item.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function StudioSidebar(props: StudioSidebarProps) {
  const {
    collapsed = false,
    connections,
    loading,
    connectionsError,
    onRetryConnections,
    selection,
    localName,
    schema,
    schemaError,
    schemaLoading,
    onRetrySchema,
    tableSearch,
    onTableSearch,
    connSearch,
    onConnSearch,
    connFilter,
    onConnFilter,
    onSelectSaved,
    onSelectLocal,
    onDownloadLocal,
    onNew,
    onEdit,
    onDelete,
    onToggleFavorite,
    onTogglePinned,
    onReorder,
    onMove,
    onOpenData,
    onOpenSchema,
    guard,
    onGuardChange,
    onLockNow,
    unlockedUntil,
    onExportSchema,
    onSearchData,
    onExportDatabase,
    onViewSql,
    onCollapse,
    onExpand,
    collapsible = true,
  } = props

  const activeSavedId = selection?.kind === 'saved' ? selection.id : null
  const localSelected = selection?.kind === 'local'
  const [expandedTables, setExpandedTables] = useState<ReadonlySet<string>>(new Set())
  const [guardOpen, setGuardOpen] = useState(false)
  const toggleTable = (name: string) => {
    setExpandedTables((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }
  const counts = {
    all: connections.length + (localName ? 1 : 0),
    pinned: connections.filter((connection) => connection.isPinned).length,
    favorite: connections.filter((connection) => connection.isFavorite).length,
  }
  const visible = connections.filter((connection) => {
    if (connFilter === 'pinned' && !connection.isPinned) return false
    if (connFilter === 'favorite' && !connection.isFavorite) return false
    const query = connSearch.trim().toLowerCase()
    if (!query) return true
    return connection.name.toLowerCase().includes(query)
  })
  const tableQuery = tableSearch.trim().toLowerCase()
  const filteredTables = (schema?.tables ?? []).filter((table) =>
    tableQuery
      ? table.name.toLowerCase().includes(tableQuery)
        || table.columns.some((column) => column.name.toLowerCase().includes(tableQuery))
      : true,
  )
  const renderedTables = filteredTables.length > 60 && !tableQuery ? filteredTables.slice(0, 60) : filteredTables

  if (collapsed) {
    return (
      <aside
        aria-label={t('development.database.app.title')}
        className="flex h-full min-h-0 w-12 shrink-0 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
      >
        <div className="flex h-11 w-full items-center justify-center border-b border-[var(--border-subtle)]">
          <Tooltip label={t('development.database.app.expand_sidebar')} side="right">
            <IconButton label={t('development.database.app.expand_sidebar')} size="sm" onClick={onExpand}>
              <PanelLeftOpen size={16} />
            </IconButton>
          </Tooltip>
        </div>
        <div className="flex w-full flex-col items-center gap-1 overflow-y-auto py-2">
          {localName && (
            <Tooltip label={localName} side="right">
              <IconButton label={localName} size="sm" active={localSelected} onClick={onSelectLocal}>
                <FileCode2 size={16} />
              </IconButton>
            </Tooltip>
          )}
          {connections.map((connection) => (
            <Tooltip key={connection.id} label={connection.name} side="right">
              <IconButton
                label={connection.name}
                size="sm"
                active={activeSavedId === connection.id}
                onClick={() => onSelectSaved(connection.id)}
              >
                <ConnectionIcon type={connection.type} />
              </IconButton>
            </Tooltip>
          ))}
          <Tooltip label={t('development.database.app.new_connection')} side="right">
            <IconButton label={t('development.database.app.new_connection')} size="sm" onClick={onNew}>
              <Plus size={16} />
            </IconButton>
          </Tooltip>
        </div>
      </aside>
    )
  }

  return (
    <aside
      aria-label={t('development.database.app.title')}
      className="flex h-full min-h-0 w-full flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
    >
      {collapsible && (
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Database size={16} className="shrink-0 text-[var(--accent)]" />
            <span className="truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('development.database.app.title')}
            </span>
          </div>
          <Tooltip label={t('development.database.app.collapse_sidebar')}>
            <IconButton label={t('development.database.app.collapse_sidebar')} size="sm" onClick={onCollapse}>
              <PanelLeftClose size={15} />
            </IconButton>
          </Tooltip>
        </header>
      )}

      <div className="flex max-h-[52%] shrink-0 flex-col border-b border-[var(--border-subtle)] p-2">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[length:var(--text-10)] font-medium tracking-wide text-[var(--text-tertiary)] uppercase">
            {t('development.database.app.connections')}
          </span>
          <div className="flex items-center gap-0.5">
            {guard?.production && (
              <span className="rounded bg-[var(--warning-soft)] px-1 text-[length:var(--text-9)] font-semibold text-[var(--warning)]">{t('development.database.guard.prod_badge')}</span>
            )}
            {guard && onGuardChange && onLockNow && (
              <GuardPanel
                open={guardOpen}
                onOpenChange={setGuardOpen}
                guard={guard}
                onChange={onGuardChange}
                unlockedUntil={unlockedUntil}
                onLockNow={onLockNow}
                disabled={!selection}
              />
            )}
            <Tooltip label={t('development.database.app.new_connection')}>
              <IconButton label={t('development.database.app.new_connection')} size="sm" onClick={onNew}>
                <Plus size={14} />
              </IconButton>
            </Tooltip>
          </div>
        </div>

        <div className="relative mb-1.5 shrink-0">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
          <Input
            value={connSearch}
            onChange={(event) => onConnSearch(event.target.value)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return
              if (event.key === 'Escape') onConnSearch('')
            }}
            placeholder={t('development.database.app.search_connections')}
            aria-label={t('development.database.app.search_connections')}
            className="h-8 pl-7 pr-7 text-[length:var(--text-12)]"
          />
          {connSearch && (
            <button
              type="button"
              onClick={() => onConnSearch('')}
              aria-label={t('development.database.common.clear')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="mb-1.5 flex shrink-0 items-center gap-1 px-0.5">
          {([
            ['all', t('development.database.app.filter_all'), counts.all],
            ['pinned', t('development.database.app.filter_pinned'), counts.pinned],
            ['favorite', t('development.database.app.filter_favorite'), counts.favorite],
          ] as const).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              aria-pressed={connFilter === id}
              onClick={() => onConnFilter(id)}
              className={cn(
                'flex h-7 flex-1 items-center justify-center gap-1 rounded-full px-1.5 text-[length:var(--text-11)] font-medium whitespace-nowrap transition-colors',
                connFilter === id
                  ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              {label}
              <span className={cn('text-[length:var(--text-10)] tabular-nums', connFilter === id ? 'opacity-80' : 'opacity-60')}>
                {count}
              </span>
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {connectionsError && (
            <div role="alert" className="mx-1 mb-2 rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2 text-[length:var(--text-11)] leading-relaxed text-[var(--danger)]">
              <p className="break-words">{connectionsError}</p>
              {onRetryConnections && (
                <Button variant="secondary" size="sm" className="mt-2" onClick={onRetryConnections}>
                  {t('common.retry')}
                </Button>
              )}
            </div>
          )}
          {loading ? (
            <div className="flex justify-center py-3">
              <Loader2 size={15} className="animate-spin text-[var(--text-tertiary)]" />
            </div>
          ) : visible.length === 0 && !(connFilter === 'all' && localName) ? (
            <div className="px-1.5 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {connections.length === 0 && !localName
                ? t('development.database.app.no_connections')
                : t('development.database.app.no_matching_connections')}
            </div>
          ) : (
            <div className="space-y-0.5">
              {localName && connFilter === 'all' && (
                <div className="group flex items-center">
                  <button
                    type="button"
                    onClick={onSelectLocal}
                    aria-current={localSelected ? 'true' : undefined}
                    className={cn(
                      'flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-md)] px-1.5 py-1 text-left text-[length:var(--text-12)]',
                      localSelected ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <FileCode2 size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{localName}</span>
                      <span className="block truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                        {t('development.database.app.local_file_memory')}
                      </span>
                    </span>
                  </button>
                  {onDownloadLocal && localSelected && (
                    <Tooltip label={t('development.database.app.download_sqlite')}>
                      <IconButton
                        label={t('development.database.app.download_sqlite')}
                        size="sm"
                        onClick={onDownloadLocal}
                        className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                      >
                        <Download size={12} />
                      </IconButton>
                    </Tooltip>
                  )}
                </div>
              )}
              {visible.map((connection) => (
                <ConnectionItem
                  key={connection.id}
                  connection={connection}
                  active={activeSavedId === connection.id}
                  onSelect={() => onSelectSaved(connection.id)}
                  onEdit={() => onEdit(connection)}
                  onDelete={() => onDelete(connection)}
                  onToggleFavorite={() => onToggleFavorite(connection)}
                  onTogglePinned={() => onTogglePinned(connection)}
                  onReorder={onReorder}
                  onMove={(direction) => onMove(connection.id, direction)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-2">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[length:var(--text-10)] font-medium tracking-wide text-[var(--text-tertiary)] uppercase">
            {t('development.database.app.schema')}
          </span>
          {schema && (
            <span className="flex items-center gap-1">
              <span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">
                {tableSearch.trim()
                  ? t('development.database.app.table_count_filtered', { shown: filteredTables.length, total: schema.tables.length })
                  : t('development.database.app.table_count', { count: schema.tables.length })}
              </span>
              {onSearchData && schema.tables.length > 0 && (
                <Tooltip label={t('development.database.search.title')}>
                  <IconButton label={t('development.database.search.title')} size="sm" onClick={onSearchData}>
                    <Search size={12} />
                  </IconButton>
                </Tooltip>
              )}
              {onExportSchema && (schema.tables.length > 0 || schema.views.length > 0) && (
                <Tooltip label={t('development.database.app.export_schema')}>
                  <IconButton label={t('development.database.app.export_schema')} size="sm" onClick={onExportSchema}>
                    <Download size={12} />
                  </IconButton>
                </Tooltip>
              )}
              {onExportDatabase && schema.tables.length > 0 && (
                <Tooltip label={t('development.database.dump.title')}>
                  <IconButton label={t('development.database.dump.title')} size="sm" onClick={onExportDatabase}>
                    <Database size={12} />
                  </IconButton>
                </Tooltip>
              )}
            </span>
          )}
        </div>

        {schema && schema.tables.length > 0 && (
          <div className="relative mb-1.5 shrink-0">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <Input
              value={tableSearch}
              onChange={(event) => onTableSearch(event.target.value)}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return
                if (event.key === 'Escape') onTableSearch('')
              }}
              placeholder={t('development.database.app.search_tables')}
              aria-label={t('development.database.app.search_tables')}
              className="h-8 pl-7 pr-7 text-[length:var(--text-12)]"
            />
            {tableSearch && (
              <button
                type="button"
                onClick={() => onTableSearch('')}
                aria-label={t('development.database.common.clear')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {schemaLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 size={15} className="animate-spin text-[var(--text-tertiary)]" />
            </div>
          ) : !selection ? (
            <div className="px-1.5 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('development.database.app.select_connection')}
            </div>
          ) : schemaError ? (
            <div className="mx-1.5 rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-2 text-[length:var(--text-11)] leading-relaxed text-[var(--danger)]">
              <p className="break-words">{schemaError}</p>
              {onRetrySchema && (
                <Button variant="secondary" size="sm" className="mt-2" onClick={onRetrySchema}>
                  {t('common.retry')}
                </Button>
              )}
            </div>
          ) : schema ? (
            <div className="space-y-3">
              {schema.truncated && (
                <p role="status" className="mx-1.5 rounded-[var(--r-md)] border border-[var(--warning)]/30 bg-[var(--warning-soft)] p-2 text-[length:var(--text-10)] leading-relaxed text-[var(--warning)]">
                  {t('development.database.app.schema_truncated')}
                </p>
              )}
              {renderedTables.map((table) => {
                const expanded = expandedTables.has(table.name)
                return (
                  <div key={table.name} className="group">
                    <div className="flex items-center">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={expanded ? t('development.database.app.collapse_columns') : t('development.database.app.expand_columns', { count: table.columns.length })}
                        onClick={() => toggleTable(table.name)}
                        className="flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      >
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenData(table.name)}
                        title={table.name}
                        className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-sm)] px-1.5 py-1 text-left text-[length:var(--text-12)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      >
                        <Table2 size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                        <span className="truncate">{table.name}</span>
                        {tableQuery && !table.name.toLowerCase().includes(tableQuery) && (
                          <span className="shrink-0 rounded bg-[var(--accent-soft)] px-1 text-[length:var(--text-9)] text-[var(--accent)]">
                            {t('development.database.app.column_match')}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-[length:var(--text-10)] text-[var(--text-quaternary)]">
                          {table.columns.length ? t('development.database.app.column_count_short', { count: table.columns.length }) : '?'}
                        </span>
                      </button>
                      <Tooltip label={t('development.database.app.edit_schema')}>
                        <IconButton
                          label={t('development.database.app.edit_schema')}
                          size="sm"
                          onClick={() => onOpenSchema(table.name)}
                          className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                        >
                          <Pencil size={12} />
                        </IconButton>
                      </Tooltip>
                    </div>
                    {expanded && (
                      <ul className="mt-0.5 mb-1 ml-[13px] space-y-0.5 border-l border-[var(--border-subtle)] pl-2.5">
                        {table.columns.map((column) => (
                          <li key={column.name} className="flex items-center gap-1.5 text-[length:var(--text-11)]">
                            <span className="truncate font-mono text-[var(--text-secondary)]" title={column.name}>{column.name}</span>
                            {column.pk && (
                              <KeyRound size={9} className="shrink-0 text-[var(--warning)]" aria-label={t('development.database.app.primary_key')} />
                            )}
                            <span className="ml-auto shrink-0 font-mono text-[length:var(--text-10)] text-[var(--text-tertiary)]">{column.type || '—'}</span>
                          </li>
                        ))}
                        {table.columns.length === 0 && (
                          <li className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.schema.no_columns')}</li>
                        )}
                      </ul>
                    )}
                  </div>
                )
              })}
              {renderedTables.length < filteredTables.length && (
                <div className="px-1.5 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {t('development.database.app.tables_truncated', { shown: renderedTables.length, total: filteredTables.length })}
                </div>
              )}
              {filteredTables.length === 0 && tableQuery && (
                <div className="px-1.5 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {t('development.database.app.no_matching_tables')}
                </div>
              )}
              {!tableSearch.trim() && schema.tables.length === 0 && schema.views.length === 0 && (
                <div className="px-1.5 py-2 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  {t('development.database.app.no_objects')}
                </div>
              )}
              {schema.views.length > 0 && (
                <SchemaGroup
                  title={t('development.database.app.views', { count: schema.views.length })}
                  icon={<Code2 size={13} />}
                  items={schema.views}
                  kind="view"
                  onOpen={onViewSql}
                />
              )}
              {schema.triggers.length > 0 && (
                <SchemaGroup
                  title={t('development.database.app.triggers', { count: schema.triggers.length })}
                  icon={<Zap size={13} />}
                  items={schema.triggers}
                  kind="trigger"
                  onOpen={onViewSql}
                />
              )}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
