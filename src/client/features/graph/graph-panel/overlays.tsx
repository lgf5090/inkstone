import { useRef, useState } from 'react'
import { List } from 'lucide-react'
import type { GraphNode, GraphResponse } from '@shared/types'
import { truncateText } from '@shared/text-utils'
import { Button, IconButton } from '../../../components/primitives'
import { Menu, type MenuItem } from '../../../components/overlay'
import { Empty } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { GRAPH_NEIGHBOUR_LIST_MAX, GRAPH_PREVIEW_CARD_HEIGHT } from './constants'
import { graphNeighbourGroups, graphNeighbours } from './scene'
import type { ColorLegendItem } from './scene'
import type { CanvasNode } from './types'

export interface GraphPreviewCard {
  node: CanvasNode
  x: number
  y: number
  excerpt: string | null
}

export interface GraphOverlaysProps {
  data: GraphResponse
  hover: CanvasNode | null
  selected: GraphNode | null
  hint: string
  hintBrief: string
  legend: ColorLegendItem[]
  legendActive: (item: ColorLegendItem) => boolean
  onLegendSelect: (item: ColorLegendItem) => void
  unresolvedCount?: number
  onOpenNote: (id: string) => void
  onFocusNode: (id: string) => void
  preview: GraphPreviewCard | null
  announcement?: string
}

export function GraphOverlays({
  data, hover, selected, hint, hintBrief, legend, legendActive, onLegendSelect,
  onOpenNote, onFocusNode, preview, announcement, unresolvedCount = 0,
}: GraphOverlaysProps) {
  const shown = hover ?? selected
  return <>
    {data.meta.truncated && <GraphTruncatedBadge shown={data.nodes.length} total={data.meta.totalNodes}/>}
    <div className="pointer-events-none absolute inset-x-4 bottom-4 z-[1] flex flex-col items-center gap-2">
      <GraphLegend items={legend} isActive={legendActive} onSelect={onLegendSelect} unresolvedCount={unresolvedCount}/>
      {shown && <GraphNodeBadge node={shown} data={data} onOpenNote={onOpenNote} onFocusNode={onFocusNode}/>}
    </div>
    <GraphHint hint={hint} hintBrief={hintBrief}/>
    {preview && <GraphPreviewCardView card={preview}/>}
    <div aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>
  </>
}

export function GraphTruncatedBadge({ shown, total }: { shown: number; total: number }) {
  return <div role="status" className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-1 text-[11px] text-[var(--text-secondary)] shadow-sm">
    {t('graph.showing_limit', { shown, total })}
  </div>
}

export function GraphHint({ hint, hintBrief }: { hint: string; hintBrief: string }) {
  return <div className="pointer-events-none absolute top-3 left-4 text-[11px] text-[var(--text-tertiary)]">
    <span className="hidden md:block">{hint}</span>
    <span aria-hidden="true" className="md:hidden">{hintBrief}</span>
  </div>
}

export function GraphLegend({ items, isActive, onSelect, unresolvedCount = 0 }: {
  items: ColorLegendItem[]
  isActive: (item: ColorLegendItem) => boolean
  onSelect: (item: ColorLegendItem) => void
  unresolvedCount?: number
}) {
  if (!items.length && !unresolvedCount) return null
  return <div role="list" aria-label={t('graph.legend')}
    className="pointer-events-auto flex max-h-36 max-w-[min(100%,224px)] flex-col gap-0.5 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1.5 text-[11px] text-[var(--text-secondary)] shadow-[var(--shadow-pop)]">
    {items.map((item) => <div key={`${item.kind}:${item.value}`} role="listitem" className="min-w-0">
      <Button variant="ghost" size="sm" className="w-full justify-start gap-1.5 px-1 text-[11px] aria-pressed:bg-[var(--bg-active)] aria-pressed:text-[var(--accent)]"
        aria-pressed={isActive(item)} title={t('graph.legend_filter')}
        onClick={() => onSelect(item)}>
        <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: item.color }}/>
        <span className="min-w-0 truncate">{item.label}</span>
      </Button>
    </div>)}
    {unresolvedCount > 0 && <div role="listitem" className="flex min-w-0 items-center gap-1.5 px-1 py-0.5">
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full border-[1.5px] border-[var(--graph-node)]"/>
      <span className="min-w-0 truncate">{t('graph.unresolved_legend')}</span>
    </div>}
  </div>
}

export function GraphNodeBadge({ node, data, onOpenNote, onFocusNode }: {
  node: CanvasNode | GraphNode
  data: GraphResponse
  onOpenNote: (id: string) => void
  onFocusNode: (id: string) => void
}) {
  return <div data-graph-detail="" className="pointer-events-auto flex max-w-[80vw] items-center rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] py-1.5 pr-2 pl-3.5 text-[12px] shadow-[var(--shadow-pop)]">
    <span className="max-w-[50vw] truncate">{node.title || t('common.untitled_note')}</span>
    <span className="ml-2 shrink-0 text-[var(--text-tertiary)]">
      {t('graph.direction_counts', { incoming: node.inDegree, outgoing: node.outDegree })}
    </span>
    <GraphNeighborList node={node} data={data} onOpenNote={onOpenNote} onFocusNode={onFocusNode}/>
  </div>
}

function GraphNeighborList({ node, data, onOpenNote, onFocusNode }: {
  node: CanvasNode | GraphNode
  data: GraphResponse
  onOpenNote: (id: string) => void
  onFocusNode: (id: string) => void
}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const groups = graphNeighbourGroups(graphNeighbours(data, node.id), GRAPH_NEIGHBOUR_LIST_MAX)
  if (!groups.length) return null
  const items: MenuItem[] = groups.flatMap((group) => {
    const heading = group.key === 'incoming' ? t('graph.neighbors_incoming') : t('graph.neighbors_outgoing')
    const rows = group.nodes.map((neighbour) => ({
      id: `${group.key}:${neighbour.id}`,
      label: neighbour.title || t('common.untitled_note'),
      onSelect: () => {
        if (neighbour.kind === 'note') onOpenNote(neighbour.id)
        else onFocusNode(neighbour.id)
        setOpen(false)
      },
    }))
    const hidden = group.hidden
      ? [{ id: `${group.key}:hidden`, label: t('graph.neighbors_hidden', { hidden: group.hidden }), disabled: true }]
      : []
    return [
      { id: `group-${group.key}`, label: heading, disabled: true, separatorBefore: true },
      ...rows,
      ...hidden,
    ]
  })
  return <>
    <IconButton ref={anchorRef} size="sm" label={t('graph.neighbors')} aria-expanded={open}
      className="ml-1 shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
      onClick={() => setOpen(true)}>
      <List size={12}/>
    </IconButton>
    <Menu anchor={anchorRef} open={open} onClose={() => setOpen(false)} items={items} label={t('graph.node_actions')} width={240}/>
  </>
}

export function GraphPreviewCardView({ card }: { card: GraphPreviewCard }) {
  const width = Math.min(260, window.innerWidth * 0.7)
  const left = Math.min(Math.max(card.x, width / 2 + 8), window.innerWidth - width / 2 - 8)
  const flipUp = card.y + GRAPH_PREVIEW_CARD_HEIGHT > window.innerHeight
  return <div data-graph-preview="" role="tooltip"
    className="pointer-events-none fixed z-[240] w-[min(260px,70vw)] rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-2 shadow-[var(--shadow-pop)]"
    style={{ left, top: card.y, transform: `translate(-50%, ${flipUp ? `-${GRAPH_PREVIEW_CARD_HEIGHT}px` : '12px'})` }}>
    <div className="truncate text-[12px] font-medium">{card.node.title || t('common.untitled_note')}</div>
    <p className="mt-1 line-clamp-4 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
      {card.excerpt ?? t('graph.building_graph')}
    </p>
  </div>
}

export function GraphPaintError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <div data-graph-paint-error="" role="alert" className="absolute inset-0 z-[3] flex items-center justify-center bg-[var(--bg-base)] p-6">
    <Empty art="notes" title={t('graph.could_not_draw')} description={describeError(error)}
      action={<Button size="sm" variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>}/>
  </div>
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return truncateText(message, 200)
}
