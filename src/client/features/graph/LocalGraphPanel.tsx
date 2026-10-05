import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, ImageDown, Maximize2, Waypoints, X } from 'lucide-react'
import type { GraphQuery, GraphResponse } from '@shared/types'
import { api } from '../../lib/api'
import { IconButton } from '../../components/primitives'
import { Select } from '../../components/form'
import { Tooltip } from '../../components/overlay'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useNotes } from '../../store/notes'
import { t } from '../../lib/i18n'
import { GRAPH_DEPTHS, loadPreferences, type GraphPreferences } from '../../lib/graph-settings'
import { createGraphState, GraphCanvas } from './graph-panel/canvas'
import { normalizedResponse, readPalette } from './graph-panel/scene'
import { useGraphExport } from './graph-panel/use-graph-export'
import type { CanvasState, GraphCanvasControls } from './graph-panel/types'

export interface LocalGraphPanelProps {
  noteId: string
  onClose: () => void
  onOpenFullGraph: () => void
}

export function LocalGraphPanel({ noteId, onClose, onOpenFullGraph }: LocalGraphPanelProps) {
  const stateRef = useRef<CanvasState>(createGraphState())
  const controlsRef = useRef<GraphCanvasControls | null>(null)
  const stored = useMemo(() => loadPreferences(), [])
  const prefs = useMemo<GraphPreferences>(() => ({ ...stored, mode: 'local' }), [stored])
  const [depth, setDepth] = useState(stored.depth)
  const [data, setData] = useState<GraphResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const openNote = useNotes((state) => state.openNote)
  const createNote = useNotes((state) => state.createNote)
  const exportActions = useGraphExport(stateRef, prefs, readPalette)

  const request: GraphQuery = useMemo(() => ({
    mode: 'local',
    center: noteId,
    depth,
    includeOrphans: prefs.includeOrphans,
    includeUnresolved: prefs.includeUnresolved,
    showTagNodes: prefs.showTagNodes,
    direction: prefs.direction,
    excluded: prefs.excludedNoteIds.length ? prefs.excludedNoteIds : undefined,
    limit: prefs.limit,
  }), [
    depth, noteId, prefs.direction, prefs.excludedNoteIds, prefs.includeOrphans,
    prefs.includeUnresolved, prefs.limit, prefs.showTagNodes,
  ])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setData(null)
    setLoadError(null)
    api.graph(request, controller.signal).then((response) => {
      if (cancelled) return
      setData(normalizedResponse(response))
    }).catch((error) => {
      if (cancelled || (error as Error)?.name === 'AbortError') return
      setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [request, reload])

  return <section className="flex h-64 shrink-0 flex-col border-t border-[var(--border-subtle)] bg-[var(--bg-base)]"
    aria-label={t('graph.local_graph')}>
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 text-[11px] font-semibold tracking-[.04em] text-[var(--text-tertiary)]">
      <div className="flex min-w-0 items-center gap-1.5">
        <Waypoints size={12} aria-hidden="true"/>
        <span className="truncate">{t('graph.local_graph')}</span>
        {data && <span className="tabular shrink-0 text-[10.5px]">· {data.nodes.length}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip label={t('graph.depth')}>
          <Select aria-label={t('graph.depth')} value={String(depth)} className="h-6 max-w-16 text-[10.5px]"
            onChange={(event) => setDepth(Number(event.target.value))}>
            {GRAPH_DEPTHS.map((option) => <option key={option} value={String(option)}>{option}</option>)}
          </Select>
        </Tooltip>
        <Tooltip label={t('graph.fit')}>
          <IconButton label={t('graph.fit')} size="sm" disabled={!data?.nodes.length}
            onClick={() => controlsRef.current?.fit()}>
            <Maximize2 size={12}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t('graph.export_png')}>
          <IconButton label={t('graph.export_png')} size="sm" disabled={!data?.nodes.length || exportActions.isExporting}
            onClick={exportActions.exportPng}>
            <ImageDown size={12}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t('graph.open_full_graph')}>
          <IconButton label={t('graph.open_full_graph')} size="sm" onClick={onOpenFullGraph}>
            <ExternalLink size={12}/>
          </IconButton>
        </Tooltip>
        <Tooltip label={t('common.close')}>
          <IconButton label={t('common.close')} size="sm" onClick={onClose}>
            <X size={13}/>
          </IconButton>
        </Tooltip>
      </div>
    </div>
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {loadError ? <Empty art="notes" title={t('graph.could_not_load_graph')} description={loadError}
        action={<button type="button" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</button>}/>
        : !data ? <LoadingBlock label={t('graph.building_graph')}/>
        : data.nodes.length === 0 ? <Empty art="notes" title={t('graph.nothing_to_graph_yet')} compact
          description={t('graph.connect_notes_with_wiki_links_and_their_graph_will_appear_here')}/>
        : <GraphCanvas
          data={data}
          prefs={prefs}
          activeNoteId={noteId}
          searchHits={null}
          pinnedIds={prefs.pinnedNodeIds}
          callbacks={{
            onOpenNote: (id) => { void openNote(id) },
            onCreateNote: (title) => { void createNote?.({ title, open: true }) },
          }}
          controlsRef={controlsRef}
          stateRef={stateRef}
        />}
    </div>
  </section>
}
