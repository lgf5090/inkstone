import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch, KeyRound, Link2, Pencil, Table2 } from 'lucide-react'
import type { ParsedTable } from '@shared/development/database/types'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { Menu, type MenuItem } from '../../../components/overlay'
import {
  buildErdLayout,
  ERD_NODE_HEADER_HEIGHT,
  ERD_NODE_ROW_HEIGHT,
  type FlowNodeLayout,
} from './flow-layout'
import { SvgFlow, type FlowExportNode } from './SvgFlow'

export interface ErdViewProps {
  tables: ParsedTable[]
  className?: string
  onOpenData?: (table: string) => void
  onOpenSchema?: (table: string) => void
}

interface ErdMenuState {
  table: string
  x: number
  y: number
}

export function ErdView({ tables, className, onOpenData, onOpenSchema }: ErdViewProps) {
  const layout = useMemo(() => buildErdLayout(tables), [tables])
  const tableByName = useMemo(() => new Map(tables.map((table) => [table.name, table])), [tables])
  const [nodes, setNodes] = useState<FlowNodeLayout[]>(layout.nodes)
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<ErdMenuState | null>(null)

  useEffect(() => {
    setNodes(layout.nodes)
  }, [layout])

  const moveNode = useCallback((id: string, x: number, y: number) => {
    setNodes((previous) => previous.map((node) => (node.id === id ? { ...node, x, y } : node)))
  }, [])

  const exportNode = useCallback(
    (id: string): FlowExportNode | null => {
      const table = tableByName.get(id)
      if (!table) return null
      const foreignColumns = layout.fkColumns.get(id) ?? new Set<string>()
      const lines: string[] = []
      const highlightLines = new Set<number>()
      for (const column of table.columns) {
        lines.push(`${column.pk ? 'PK ' : ''}${column.name} ${column.type}`)
        if (foreignColumns.has(column.name)) highlightLines.add(lines.length - 1)
      }
      if (lines.length === 0) lines.push(t('development.database.erd.no_columns'))
      return { title: table.name, lines, highlightLines }
    },
    [layout, tableByName],
  )

  const openMenu = useCallback((id: string, point: { x: number; y: number }) => {
    setSelected(id)
    setMenu({ table: id, x: point.x, y: point.y })
  }, [])

  const menuItems: MenuItem[] = []
  if (menu) {
    const table = menu.table
    if (onOpenData) {
      menuItems.push({
        id: 'view-data',
        label: t('development.database.erd.view_data'),
        icon: <Table2 size={13} aria-hidden="true" />,
        onSelect: () => {
          onOpenData(table)
          setMenu(null)
        },
      })
    }
    if (onOpenSchema) {
      menuItems.push({
        id: 'edit-schema',
        label: t('development.database.erd.edit_schema'),
        icon: <Pencil size={13} aria-hidden="true" />,
        onSelect: () => {
          onOpenSchema(table)
          setMenu(null)
        },
      })
    }
  }

  return (
    <div className={cn('relative h-full w-full', className)}>
      <SvgFlow
        nodes={nodes}
        edges={layout.edges}
        selectedId={selected}
        onSelect={setSelected}
        onNodesChange={moveNode}
        onNodeContextMenu={openMenu}
        nodeLabel={(id) => t('development.database.erd.node_label', { table: id })}
        exportNode={exportNode}
        exportName="inkstone-erd"
        onError={(message) => useUi.getState().toast({ title: message, tone: 'danger' })}
        renderNode={(id) => {
          const table = tableByName.get(id)
          if (!table) return null
          const foreignColumns = layout.fkColumns.get(id) ?? new Set<string>()
          return (
            <div className="flex h-full w-full flex-col overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-raised)] shadow-[var(--shadow-pop)]">
              <div
                className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-hover)] px-2.5"
                style={{ height: ERD_NODE_HEADER_HEIGHT }}
              >
                <Table2 size={12} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-11)] font-semibold text-[var(--text-primary)]">
                  {table.name}
                </span>
              </div>
              <div className="min-h-0 flex-1">
                {table.columns.map((column) => {
                  const foreign = foreignColumns.has(column.name)
                  return (
                    <div
                      key={column.name}
                      data-fk={foreign ? 'true' : undefined}
                      className={cn(
                        'flex items-center gap-1.5 px-2.5 font-mono text-[length:var(--text-11)]',
                        foreign && 'bg-[var(--accent-soft)]',
                      )}
                      style={{ height: ERD_NODE_ROW_HEIGHT }}
                    >
                      <span className="flex w-3 shrink-0 justify-center text-[var(--accent)]">
                        {column.pk && (
                          <KeyRound
                            size={10}
                            role="img"
                            aria-label={t('development.database.erd.primary_key')}
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{column.name}</span>
                      <span className="max-w-[42%] shrink-0 truncate text-[length:var(--text-9-5)] text-[var(--text-tertiary)]">
                        {column.type}
                      </span>
                      {foreign && (
                        <Link2
                          size={9}
                          role="img"
                          aria-label={t('development.database.erd.foreign_key')}
                          className="shrink-0 text-[var(--accent)]"
                        />
                      )}
                    </div>
                  )
                })}
                {table.columns.length === 0 && (
                  <div
                    className="flex items-center px-2.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]"
                    style={{ height: ERD_NODE_ROW_HEIGHT }}
                  >
                    {t('development.database.erd.no_columns')}
                  </div>
                )}
              </div>
            </div>
          )
        }}
      />

      <div
        data-erd-stats="true"
        data-tables={tables.length}
        data-foreign-keys={layout.edges.length}
        className="pointer-events-none absolute top-3 left-1/2 z-[var(--z-sticky)] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-1 text-[length:var(--text-11)] text-[var(--text-tertiary)] shadow-[var(--shadow-sm)]"
      >
        <GitBranch size={12} aria-hidden="true" />
        {t('development.database.erd.stats', { tables: tables.length, foreignKeys: layout.edges.length })}
      </div>

      {tables.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[length:var(--text-13)] text-[var(--text-tertiary)]">
          {t('development.database.erd.empty')}
        </div>
      )}

      <Menu
        anchor={{ x: menu?.x ?? 0, y: menu?.y ?? 0 }}
        open={menu !== null}
        onClose={() => setMenu(null)}
        items={menuItems}
        label={t('development.database.erd.actions')}
        width={192}
      />
    </div>
  )
}
