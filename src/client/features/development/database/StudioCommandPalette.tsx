import { useEffect, useMemo, useRef, useState } from 'react'
import { Database, FileCode2, KeyRound, Table2, Zap } from 'lucide-react'
import type { DatabaseConnectionView, SchemaModel } from '@shared/development/database/types'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { Modal } from '../../../components/overlay'
import { FilterInput } from '../../../components/FilterInput'
import { compileQuery } from '../../../lib/query-match'
import { isImeComposing } from '../../../lib/ime'

export interface PaletteCommand {
  id: string
  label: string
  hint: string
  group: string
  icon: 'connection' | 'table' | 'column' | 'view' | 'trigger' | 'action'
  run: () => void
}

export interface StudioCommandPaletteProps {
  open: boolean
  onClose: () => void
  connections: DatabaseConnectionView[]
  hasLocal: boolean
  schema: SchemaModel | null
  onSelectSaved: (id: string) => void
  onSelectLocal: () => void
  onOpenData: (table: string) => void
  onOpenSchema: (table: string) => void
  onViewSql: (definition: { kind: 'view' | 'trigger'; name: string; sql: string }) => void
  onNewQuery: () => void
  onExportSchema: () => void
  onRefreshSchema: () => void
}

export function StudioCommandPalette({
  open, onClose, connections, hasLocal, schema,
  onSelectSaved, onSelectLocal, onOpenData, onOpenSchema, onViewSql,
  onNewQuery, onExportSchema, onRefreshSchema,
}: StudioCommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<PaletteCommand[]>(() => {
    if (!open) return []
    const list: PaletteCommand[] = []
    for (const connection of connections) {
      list.push({
        id: `conn-${connection.id}`,
        label: connection.name,
        hint: connection.type === 'd1' ? 'D1' : connection.tursoUrl || 'Turso',
        group: t('development.database.palette.group_connections'),
        icon: 'connection',
        run: () => onSelectSaved(connection.id),
      })
    }
    if (hasLocal) {
      list.push({ id: 'conn-local', label: t('development.database.app.local_file'), hint: 'SQLite', group: t('development.database.palette.group_connections'), icon: 'connection', run: onSelectLocal })
    }
    for (const table of schema?.tables ?? []) {
      list.push({ id: `table-${table.name}`, label: table.name, hint: t('development.database.palette.hint_data'), group: t('development.database.palette.group_tables'), icon: 'table', run: () => onOpenData(table.name) })
      list.push({ id: `schema-${table.name}`, label: table.name, hint: t('development.database.palette.hint_schema'), group: t('development.database.palette.group_tables'), icon: 'table', run: () => onOpenSchema(table.name) })
      for (const column of table.columns) {
        list.push({ id: `col-${table.name}-${column.name}`, label: `${table.name}.${column.name}`, hint: column.type || t('development.database.palette.group_columns'), group: t('development.database.palette.group_columns'), icon: 'column', run: () => onOpenData(table.name) })
      }
    }
    for (const view of schema?.views ?? []) {
      list.push({ id: `view-${view.name}`, label: view.name, hint: 'VIEW', group: t('development.database.palette.group_objects'), icon: 'view', run: () => onViewSql({ kind: 'view', name: view.name, sql: view.sql }) })
    }
    for (const trigger of schema?.triggers ?? []) {
      list.push({ id: `trigger-${trigger.name}`, label: trigger.name, hint: 'TRIGGER', group: t('development.database.palette.group_objects'), icon: 'trigger', run: () => onViewSql({ kind: 'trigger', name: trigger.name, sql: trigger.sql }) })
    }
    list.push({ id: 'action-new-query', label: t('development.database.palette.action_new_query'), hint: 'Ctrl/Cmd+Enter', group: t('development.database.palette.group_actions'), icon: 'action', run: onNewQuery })
    list.push({ id: 'action-export-schema', label: t('development.database.palette.action_export_schema'), hint: '.schema.sql', group: t('development.database.palette.group_actions'), icon: 'action', run: onExportSchema })
    list.push({ id: 'action-refresh-schema', label: t('development.database.palette.action_refresh_schema'), hint: 'PRAGMA', group: t('development.database.palette.group_actions'), icon: 'action', run: onRefreshSchema })
    return list
  }, [open, connections, hasLocal, onExportSchema, onNewQuery, onOpenData, onOpenSchema, onRefreshSchema, onSelectLocal, onSelectSaved, onViewSql, schema])

  const compiledQuery = useMemo(() => compileQuery(query), [query])

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    const matched = text ? commands.filter((command) => command.label.toLowerCase().includes(text) || command.group.toLowerCase().includes(text)) : commands
    return matched.slice(0, 60)
  }, [commands, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
  }, [open])

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const runAt = (index: number) => {
    const command = filtered[index]
    if (!command) return
    onClose()
    command.run()
  }

  const icon = (kind: PaletteCommand['icon']) => {
    if (kind === 'connection') return <Zap size={13} />
    if (kind === 'column') return <KeyRound size={13} />
    if (kind === 'view' || kind === 'trigger') return <FileCode2 size={13} />
    if (kind === 'table') return <Table2 size={13} />
    return <Database size={13} />
  }

  return (
    <Modal open={open} onClose={onClose} title={t('development.database.palette.title')} width={560} footer={<span className="text-[length:var(--text-10)] text-[var(--text-tertiary)]">{t('development.database.palette.hint_keys')}</span>}>
      <FilterInput
        data-autofocus
        size="panel"
        value={query}
        onChange={(next) => { setQuery(next); setCursor(0) }}
        query={compiledQuery}
        label={t('development.database.palette.placeholder')}
        placeholder={t('development.database.palette.placeholder')}
        escapeWhenEmpty="release"
        className="mt-0"
        onKeyDown={(event) => {
          if (isImeComposing(event)) return
          if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((current) => Math.min(current + 1, filtered.length - 1)) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((current) => Math.max(current - 1, 0)) }
          else if (event.key === 'Enter') { event.preventDefault(); runAt(cursor) }
        }}
      />
      <div ref={listRef} className="mt-2 max-h-80 overflow-y-auto" role="listbox" aria-label={t('development.database.palette.title')}>
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('development.database.palette.no_results')}</p>
        ) : filtered.map((command, index) => (
          <button
            key={command.id}
            type="button"
            role="option"
            aria-selected={index === cursor}
            data-index={index}
            onMouseEnter={() => setCursor(index)}
            onClick={() => runAt(index)}
            className={cn(
              'flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left',
              index === cursor ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'text-[var(--text-primary)]',
            )}
          >
            <span className="shrink-0 text-[var(--text-tertiary)]">{icon(command.icon)}</span>
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)]">{command.label}</span>
            <span className="shrink-0 text-[length:var(--text-10)] text-[var(--text-tertiary)]">{command.hint}</span>
            <span className="shrink-0 text-[length:var(--text-9)] text-[var(--text-quaternary)]">{command.group}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
