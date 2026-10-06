import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  CornerDownRight,
  CircleDot,
  Download,
  Filter,
  FolderOpen,
  ImageDown,
  Maximize2,
  Minimize,
  Expand,
  Minus,
  PanelRightClose,
  Plus,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import type { GraphQuery, GraphResponse } from '@shared/types'
import { deriveExcerpt } from '@shared/markdown-utils'
import { api } from '../../lib/api'
import { Button, IconButton } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { Menu, Tooltip, useDialogFocus, useEscape, useLockScroll, type MenuItem } from '../../components/overlay'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import {
  DEFAULT_PREFERENCES,
  GRAPH_PINNED_MAX,
  loadPreferences,
  persistPreferences,
  toggleListItem,
  type GraphPreferences,
} from '../../lib/graph-settings'
import {
  GRAPH_LEGEND_MAX,
  GRAPH_PREFS_DEBOUNCE_MS,
  GRAPH_PREVIEW_SHOW_MS,
  GRAPH_SEARCH_DEBOUNCE_MS,
} from './graph-panel/constants'
import { GraphCanvas } from './graph-panel/canvas'
import { createGraphState } from './graph-panel/canvas'
import { useGraphExport } from './graph-panel/use-graph-export'
import { GraphPaintError, GraphOverlays, type GraphPreviewCard } from './graph-panel/overlays'
import { GraphSettingsPanel } from './graph-panel/settings'
import {
  colorLegends,
  graphCounts,
  graphSearchHits,
  normalizedResponse,
  readPalette,
  type ColorLegendItem,
} from './graph-panel/scene'
import type { CanvasNode, CanvasState, GraphCanvasControls } from './graph-panel/types'

export { pickDirectional } from './graph-panel/scene'
export type { CanvasNode } from './graph-panel/types'

export function GraphPanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const stateRef = useRef<CanvasState>(createGraphState())
  const controlsRef = useRef<GraphCanvasControls | null>(null)
  const [prefs, setPrefs] = useState(loadPreferences)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [data, setData] = useState<GraphResponse | null>(null)
  const [pending, setPending] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [hover, setHover] = useState<CanvasNode | null>(null)
  const [hoverAnchor, setHoverAnchor] = useState<{ x: number; y: number } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [context, setContext] = useState<{ x: number; y: number; node: CanvasNode } | null>(null)
  const [paintError, setPaintError] = useState<unknown>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [previewExcerpt, setPreviewExcerpt] = useState<string | null>(null)
  const [touch] = useState(() => matchMedia('(pointer: coarse)').matches)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const openNote = useNotes((state) => state.openNote)
  const createNote = useNotes((state) => state.createNote)
  const folderList = useNotes((state) => state.folders)
  const tagList = useNotes((state) => state.tags)
  const folders = useMemo(() => folderList ?? [], [folderList])
  const tags = useMemo(() => tagList ?? [], [tagList])
  const hydrated = useNotes((state) => state.hydrated)
  const activeNoteId = useUi((state) => state.activeNoteId)
  const showBacklinks = useUi((state) => state.showBacklinks)

  useEscape(true, onClose)
  useEscape(settingsOpen, () => setSettingsOpen(false))
  useLockScroll(true)
  useDialogFocus(true, panelRef)

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), GRAPH_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    const timer = window.setTimeout(() => persistPreferences(prefs), GRAPH_PREFS_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [prefs])

  useEffect(() => () => { persistPreferences(prefsRef.current) }, [])

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const folderFilter = prefs.folderId && (!hydrated || folders.some((folder) => folder.id === prefs.folderId))
    ? prefs.folderId
    : ''
  const tagFilter = useMemo(() => (hydrated
    ? prefs.tags.filter((name) => tags.some((tag) => tag.name === name))
    : prefs.tags), [hydrated, prefs.tags, tags])

  const centerId = prefs.mode === 'local' ? activeNoteId ?? undefined : undefined
  const request: GraphQuery = useMemo(() => ({
    mode: prefs.mode,
    center: centerId,
    depth: prefs.depth,
    q: query || undefined,
    folderId: folderFilter || undefined,
    tags: tagFilter.length ? tagFilter : undefined,
    tagsMatch: tagFilter.length > 1 ? prefs.tagsMatch : undefined,
    includeOrphans: prefs.includeOrphans,
    includeUnresolved: prefs.includeUnresolved,
    showTagNodes: prefs.showTagNodes,
    excluded: prefs.excludedNoteIds.length ? prefs.excludedNoteIds : undefined,
    direction: prefs.mode === 'local' ? prefs.direction : undefined,
    limit: prefs.limit,
  }), [
    centerId, folderFilter, prefs.direction, prefs.depth, prefs.excludedNoteIds,
    prefs.includeOrphans, prefs.includeUnresolved, prefs.limit, prefs.mode,
    prefs.showTagNodes, prefs.tagsMatch, query, tagFilter,
  ])

  const localBlocked = request.mode === 'local' && !request.center
  const filtersActive = Boolean(query || folderFilter || tagFilter.length
    || !prefs.includeOrphans || prefs.excludedNoteIds.length)

  useEffect(() => {
    if (localBlocked) {
      setData(null)
      setPending(false)
      setLoadError(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    setPending(true)
    setLoadError(null)
    api.graph(request, controller.signal).then((response) => {
      if (cancelled) return
      setPending(false)
      setData(normalizedResponse(response))
    }).catch((error) => {
      if (cancelled || (error as Error)?.name === 'AbortError') return
      setPending(false)
      setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [request, reload, localBlocked])

  const searchHits = useMemo(
    () => (data && query ? graphSearchHits(data.nodes, query) : null),
    [data, query],
  )
  const legend = useMemo(
    () => (data ? colorLegends(data.nodes, prefs.groupBy, prefs.colorGroups, GRAPH_LEGEND_MAX) : []),
    [data, prefs.groupBy, prefs.colorGroups],
  )
  const counts = useMemo(() => graphCounts(data), [data])
  const selected = data?.nodes.find((node) => node.id === selectedId) ?? null

  const changePref = useCallback(<K extends keyof GraphPreferences>(key: K, value: GraphPreferences[K]) => {
    setPrefs((current) => ({ ...current, [key]: value }))
  }, [])

  const togglePin = useCallback((id: string) => {
    setPrefs((current) => ({
      ...current,
      pinnedNodeIds: toggleListItem(current.pinnedNodeIds, id).slice(-GRAPH_PINNED_MAX),
    }))
  }, [])

  const toggleExclude = useCallback((id: string) => {
    setPrefs((current) => ({ ...current, excludedNoteIds: toggleListItem(current.excludedNoteIds, id) }))
  }, [])

  const clearFilters = useCallback(() => {
    setSearch('')
    setQuery('')
    changePref('folderId', '')
    changePref('tags', [])
    changePref('excludedNoteIds', [])
    changePref('includeOrphans', DEFAULT_PREFERENCES.includeOrphans)
  }, [changePref])

  const legendActive = useCallback((item: ColorLegendItem) => {
    if (item.kind === 'folder') return folderFilter === item.value
    if (item.kind === 'tag') return tagFilter.includes(item.value)
    return false
  }, [folderFilter, tagFilter])

  const onLegendSelect = useCallback((item: ColorLegendItem) => {
    if (item.kind === 'folder') changePref('folderId', folderFilter === item.value ? '' : item.value)
    else if (item.kind === 'tag') changePref('tags', toggleListItem(tagFilter, item.value))
  }, [changePref, folderFilter, tagFilter])

  const exportActions = useGraphExport(stateRef, prefs, readPalette)

  useEffect(() => {
    if (!hover || hover.kind !== 'note') {
      setPreviewExcerpt(null)
      return
    }
    const noteId = hover.id
    let cancelled = false
    const timer = window.setTimeout(() => {
      const cached = useNotes.getState().notes[noteId]
      const apply = (excerpt: string | null) => { if (!cancelled) setPreviewExcerpt(excerpt) }
      if (cached) {
        apply(cached.excerpt || null)
        return
      }
      api.notes.get(noteId).then((note) => {
        apply(note.excerpt || deriveExcerpt(note.content))
      }).catch(() => { apply(null) })
    }, GRAPH_PREVIEW_SHOW_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [hover])

  const preview: GraphPreviewCard | null = hover && hoverAnchor && hover.kind !== 'unresolved'
    ? { node: hover, x: hoverAnchor.x, y: hoverAnchor.y, excerpt: previewExcerpt }
    : null

  const openNoteFromGraph = useCallback((id: string) => {
    void openNote(id)
    onClose()
  }, [onClose, openNote])

  const createNoteFromGraph = useCallback((title: string) => {
    void createNote?.({ title, open: true })
    onClose()
  }, [createNote, onClose])

  const openNode = useCallback((node: CanvasNode) => {
    if (node.kind === 'unresolved') createNoteFromGraph(node.title)
    else openNoteFromGraph(node.id)
  }, [createNoteFromGraph, openNoteFromGraph])

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!context) return []
    const node = context.node
    const isNote = node.kind === 'note'
    const isTag = node.kind === 'tag'
    const items: MenuItem[] = [isTag
      ? {
        id: 'open',
        label: t('graph.filter_by_tag', { value: node.title }),
        icon: <Filter size={14}/>,
        onSelect: () => changePref('tags', toggleListItem(tagFilter, node.title)),
      }
      : {
        id: 'open',
        label: isNote ? t('graph.open_note') : t('graph.create_note'),
        icon: <FolderOpen size={14}/>,
        onSelect: () => openNode(node),
      }]
    if (isNote) {
      items.push({
        id: 'right',
        label: t('graph.open_to_right'),
        icon: <PanelRightClose size={14}/>,
        onSelect: () => { void openNote(node.id, { pane: 'secondary' }) },
      })
      items.push({
        id: 'backlinks',
        label: t('graph.show_backlinks'),
        icon: <ArrowRight size={14}/>,
        separatorBefore: true,
        onSelect: () => {
          showBacklinks()
          void openNote(node.id)
          onClose()
        },
      })
    }
    for (const tag of isTag ? [] : node.tags.slice(0, 3)) {
      items.push({
        id: `tag:${tag.name}`,
        label: t('graph.filter_by_tag', { value: tag.name }),
        icon: <Filter size={14}/>,
        separatorBefore: !isNote,
        onSelect: () => changePref('tags', toggleListItem(tagFilter, tag.name)),
      })
    }
    items.push({
      id: 'pin',
      label: node.pinned ? t('graph.unpin') : t('graph.pin'),
      icon: <CircleDot size={14}/>,
      separatorBefore: true,
      onSelect: () => togglePin(node.id),
    })
    if (isNote) {
      items.push({
        id: 'local',
        label: t('graph.make_local_center'),
        icon: <CircleDot size={14}/>,
        onSelect: () => {
          void openNote(node.id)
          changePref('mode', 'local')
        },
      })
      items.push({
        id: 'exclude',
        label: t('graph.exclude_note'),
        icon: <X size={14}/>,
        tone: 'danger',
        onSelect: () => toggleExclude(node.id),
      })
    }
    return items
  }, [changePref, context, onClose, openNote, showBacklinks, tagFilter, toggleExclude, togglePin])

  const toggleFullscreen = useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    if (document.fullscreenElement) { void document.exitFullscreen?.() ; return }
    void panel.requestFullscreen?.().catch(() => { setIsFullscreen(false) })
  }, [])

  const hasGraph = Boolean(data?.nodes.length)
  const announcement = query
    ? (searchHits ? t('graph.matching_notes', { count: searchHits.size }) : t('graph.no_matching_notes'))
    : undefined
  const firstHit = searchHits ? data?.nodes.find((node) => searchHits.has(node.id))?.id ?? null : null

  return createPortal(<div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
    className="app-viewport-fixed fixed z-[230] flex flex-col bg-[var(--bg-base)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none md:py-0">
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 md:px-4">
      <div className="mr-1 flex min-w-0 items-baseline gap-2.5">
        <h2 id={titleId} className="text-[14px] font-semibold tracking-[-0.014em]">{t('common.graph')}</h2>
        {data && <span className="whitespace-nowrap text-[11.5px] text-[var(--text-tertiary)]">
          {counts.unresolved
            ? t('graph.stats_with_unresolved', { notes: counts.notes, links: counts.links, unresolved: counts.unresolved })
            : t('graph.stats', { notes: counts.notes, links: counts.links })}
          {counts.tags > 0 && ` · ${t('graph.stats_tags', { count: counts.tags })}`}
        </span>}
      </div>
      <Segmented
        size="sm"
        label={t('graph.scope')}
        value={prefs.mode}
        onChange={(value) => changePref('mode', value)}
        options={[
          { value: 'global', label: t('graph.global') },
          { value: 'local', label: t('graph.local') },
        ]}
      />
      {filtersActive && <div role="group" aria-label={t('graph.filters')} className="flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto">
        {query && <FilterChip label={`${t('graph.search_notes')} ${query}`} onClear={() => setSearch('')}/>}
        {folderFilter && <FilterChip label={`${t('graph.folder')} ${folders.find((folder) => folder.id === folderFilter)?.name ?? ''}`} onClear={() => changePref('folderId', '')}/>}
        {tagFilter.map((name) => <FilterChip key={name} label={`${t('graph.tag')} ${name}`} onClear={() => changePref('tags', tagFilter.filter((item) => item !== name))}/>)}
        {!prefs.includeOrphans && <FilterChip label={t('graph.show_orphans')} onClear={() => changePref('includeOrphans', true)}/>}
        {prefs.excludedNoteIds.length > 0 && <FilterChip label={t('graph.excluded_notes', { value: prefs.excludedNoteIds.length })} onClear={() => changePref('excludedNoteIds', [])}/>}
      </div>}
      <label className="flex h-8 min-w-[150px] flex-1 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2.5 md:max-w-[320px]">
        <Search size={13} className="shrink-0 text-[var(--text-tertiary)]"/>
        <span className="sr-only">{t('graph.search_notes')}</span>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('graph.search_notes')}
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--text-tertiary)]"/>
        {search && <button type="button" aria-label={t('common.clear')} onClick={() => setSearch('')}><X size={12}/></button>}
      </label>
      {query && <div className="flex shrink-0 items-center gap-1">
        <span role="status" data-graph-search-status="" className="whitespace-nowrap text-[11.5px] text-[var(--text-tertiary)]">
          {announcement}
        </span>
        {firstHit && <Tooltip label={t('graph.jump_to_first_match')}>
          <IconButton label={t('graph.jump_to_first_match')} size="sm" onClick={() => controlsRef.current?.selectNode(firstHit)}>
            <CornerDownRight size={13}/>
          </IconButton>
        </Tooltip>}
      </div>}
      <div className="ml-auto flex items-center gap-1">
        <Tooltip label={t('common.zoom_out')}><IconButton label={t('common.zoom_out')} size="sm" disabled={!hasGraph} onClick={() => controlsRef.current?.zoomOut()}><Minus size={14}/></IconButton></Tooltip>
        <Tooltip label={t('graph.fit')}><IconButton label={t('graph.fit')} size="sm" disabled={!hasGraph} onClick={() => controlsRef.current?.fit()}><Maximize2 size={13}/></IconButton></Tooltip>
        <Tooltip label={t('common.zoom_in')}><IconButton label={t('common.zoom_in')} size="sm" disabled={!hasGraph} onClick={() => controlsRef.current?.zoomIn()}><Plus size={14}/></IconButton></Tooltip>
        <Tooltip label={t('graph.export_png')}><IconButton label={t('graph.export_png')} size="sm" disabled={!hasGraph || exportActions.isExporting} onClick={exportActions.exportPng}><ImageDown size={14}/></IconButton></Tooltip>
        <Tooltip label={t('graph.export_svg')}><IconButton label={t('graph.export_svg')} size="sm" disabled={!hasGraph || exportActions.isExporting} onClick={exportActions.exportSvg}><Download size={14}/></IconButton></Tooltip>
        <Tooltip label={isFullscreen ? t('graph.exit_fullscreen') : t('graph.fullscreen')}>
          <IconButton label={isFullscreen ? t('graph.exit_fullscreen') : t('graph.fullscreen')} size="sm" active={isFullscreen} onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize size={13}/> : <Expand size={13}/>}
          </IconButton>
        </Tooltip>
        <Tooltip label={t('graph.settings')}><IconButton label={t('graph.settings')} size="sm" active={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={14}/></IconButton></Tooltip>
        <Tooltip label={t('common.close')} combo="escape" side="left"><IconButton label={t('common.close')} size="sm" onClick={onClose} className="ml-1"><X size={16}/></IconButton></Tooltip>
      </div>
    </header>

    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <main aria-busy={pending} className="relative min-w-0 flex-1">
        {pending && <div role="status" className="absolute inset-x-0 top-0 h-0.5 bg-[var(--accent)] opacity-60">
          <span className="sr-only">{t('graph.building_graph')}</span>
        </div>}
        {localBlocked ? <Empty art="notes" title={t('graph.local_requires_note')}
          description={t('graph.open_a_note_to_see_its_neighbourhood')}
          action={<Button size="sm" variant="secondary" onClick={() => changePref('mode', 'global')}>{t('graph.use_global')}</Button>}/>
        : loadError ? <Empty art="notes" title={t('graph.could_not_load_graph')} description={loadError}
          action={<Button size="sm" variant="secondary" onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</Button>}/>
        : !data ? <LoadingBlock label={t('graph.building_graph')}/>
        : data.nodes.length === 0 ? (filtersActive
          ? <Empty art="notes" title={t('graph.filtered_empty')} description={t('graph.filtered_empty_hint')}
            action={<Button size="sm" variant="secondary" onClick={clearFilters}>{t('graph.clear_filters')}</Button>}/>
          : <Empty art="notes" title={t('graph.nothing_to_graph_yet')} description={t('graph.connect_notes_with_wiki_links_and_their_graph_will_appear_here')}/>)
        : <>
          <GraphCanvas
            data={data}
            prefs={prefs}
            activeNoteId={activeNoteId}
            searchHits={searchHits}
            pinnedIds={prefs.pinnedNodeIds}
            callbacks={{
              onOpenNote: openNoteFromGraph,
              onCreateNote: createNoteFromGraph,
              onPinChange: togglePin,
              onFilterByTag: (name) => changePref('tags', toggleListItem(tagFilter, name)),
            }}
            controlsRef={controlsRef}
            stateRef={stateRef}
            onHoverChange={(node, x, y) => {
              setHover(node)
              setHoverAnchor(node && x !== undefined && y !== undefined ? { x, y } : null)
            }}
            onSelectChange={setSelectedId}
            onContextNode={(node, x, y) => setContext({ x, y, node })}
            onPaintError={setPaintError}
          />
          <GraphOverlays
            data={data}
            hover={hover}
            selected={selected}
            hint={touch ? t('graph.interaction_hint_touch') : t('graph.interaction_hint')}
            hintBrief={touch ? t('graph.interaction_hint_touch_brief') : t('graph.interaction_hint_brief')}
            legend={legend}
            legendActive={legendActive}
            onLegendSelect={onLegendSelect}
            onOpenNote={openNoteFromGraph}
            onFocusNode={(id) => controlsRef.current?.selectNode(id)}
            preview={preview}
            announcement={announcement}
            unresolvedCount={counts.unresolved}
          />
          {paintError && <GraphPaintError error={paintError} onRetry={() => {
            setPaintError(null)
            stateRef.current.schedule?.()
          }}/>}
        </>}
      </main>

      <GraphSettingsPanel
        prefs={prefs}
        onPref={changePref}
        folders={folders}
        tags={tags}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onRestoreDefaults={() => setPrefs((current) => ({ ...DEFAULT_PREFERENCES, mode: current.mode }))}
      />
    </div>
    <Menu anchor={context ?? { x: 0, y: 0 }} open={Boolean(context)} onClose={() => setContext(null)} items={menuItems} label={t('graph.node_actions')}/>
  </div>, document.body)
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return <button type="button" onClick={onClear} className="flex h-6 max-w-[42vw] shrink-0 items-center gap-1 rounded-full border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
    <span className="min-w-0 truncate">{label}</span>
    <X size={10} className="shrink-0"/>
  </button>
}

export type { GraphPreferences }
