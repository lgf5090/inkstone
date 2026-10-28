import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { SvgFlow } from './SvgFlow'
import { layoutExplainTree, type ExplainPlanRow } from './flow-layout'

export type { ExplainPlanRow }

type NodeKind = 'scan' | 'search' | 'temp' | 'routine' | 'subquery' | 'other'

const KIND_LABEL: Record<NodeKind, string> = {
  scan: 'SCAN',
  search: 'SEARCH',
  temp: 'TEMP',
  routine: 'CO-ROUTINE',
  subquery: 'SUBQUERY',
  other: 'STEP',
}

const KIND_CLASS: Record<NodeKind, string> = {
  scan: 'border-[var(--accent)]/50 bg-[var(--accent-soft)] text-[var(--accent)]',
  search: 'border-[var(--success)]/50 bg-[var(--success-soft)] text-[var(--success)]',
  temp: 'border-[var(--warning)]/50 bg-[var(--warning-soft)] text-[var(--warning)]',
  routine: 'border-[var(--accent)]/50 bg-[var(--accent-soft)] text-[var(--accent)]',
  subquery: 'border-[var(--danger)]/40 bg-[var(--danger-soft)] text-[var(--danger)]',
  other: 'border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[var(--text-tertiary)]',
}

function classify(detail: string): NodeKind {
  const text = detail.toUpperCase()
  if (text.includes('SCAN')) return 'scan'
  if (text.includes('SEARCH')) return 'search'
  if (text.includes('USE TEMP') || text.includes('TEMP B-TREE') || text.includes('TEMP BUFFER')) return 'temp'
  if (text.includes('CO-ROUTINE')) return 'routine'
  if (text.includes('SUBQUERY') || text.includes('SCALAR') || text.includes('CORRELATED')) return 'subquery'
  return 'other'
}

export function isExplainPlanResult(columns: string[]): boolean {
  const lower = columns.map((column) => column.toLowerCase())
  return lower.includes('id') && lower.includes('parent') && lower.includes('notused') && lower.includes('detail')
}

export function toExplainPlanRows(rows: unknown[][]): ExplainPlanRow[] {
  return rows
    .map((row) => ({
      id: Number(row[0]),
      parent: Number(row[1]),
      notused: Number(row[2]),
      detail: String(row[3] ?? ''),
    }))
    .filter((row) => Number.isFinite(row.id))
}

export function ExplainPlanView({ rows, className }: { rows: ExplainPlanRow[]; className?: string }) {
  const layout = useMemo(() => layoutExplainTree(rows), [rows])
  const [nodes, setNodes] = useState(layout.nodes)
  useEffect(() => { setNodes(layout.nodes) }, [layout])
  const move = (id: string, x: number, y: number) => {
    setNodes((current) => current.map((node) => node.id === id ? { ...node, x, y } : node))
  }
  const exportNode = (id: string) => {
    const row = rows.find((entry) => String(entry.id) === id)
    if (!row) return null
    const kind = classify(row.detail)
    return { title: KIND_LABEL[kind], lines: [row.detail] }
  }
  return (
    <div className={cn('h-full w-full', className)}>
      <SvgFlow
        nodes={nodes}
        edges={layout.edges}
        onNodesChange={move}
        renderNode={(id) => {
          const row = rows.find((entry) => String(entry.id) === id)
          if (!row) return null
          const kind = classify(row.detail)
          return (
            <div className={cn('min-w-full rounded-[var(--r-md)] border bg-[var(--bg-overlay)] px-2.5 py-1.5 shadow-[var(--shadow-pop)]', KIND_CLASS[kind])}>
              <span className="mb-1 inline-block rounded px-1 py-0.5 font-mono text-[length:var(--text-9)] font-semibold tracking-wide">
                {KIND_LABEL[kind]}
              </span>
              <div className="font-mono text-[length:var(--text-11)] leading-snug break-words">{row.detail}</div>
            </div>
          )
        }}
        nodeLabel={(id) => t('development.database.explain.node_label', { id })}
        exportNode={exportNode}
        exportName="inkstone-explain-plan"
        onError={(message) => {
          console.warn('[inkstone] explain plan export failed:', message)
        }}
        className="h-full w-full"
      />
    </div>
  )
}
