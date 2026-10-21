import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Maximize2, Minus, Plus } from 'lucide-react'
import L from 'leaflet'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { Button, IconButton } from '../../../components/primitives'
import { t, useLocale } from '../../../lib/i18n'
import { createMemoLeafletMap } from '../leaflet-map'
import {
  MEMO_MAP_FOCUS_ZOOM,
  memoMapPinKind,
  type MemoMapPinGroup,
  type MemoMapPointSelection,
  type MemoMapView,
} from '../map-state'

const MAP_PIN_SIZE = 34
const MAP_CLUSTER_SIZE = 40
const MAP_FIT_PADDING = 36
const MAP_CLUSTER_RADIUS = 60
const MAP_PIN_VISUAL_CLASS = [
  'flex size-full items-center justify-center overflow-hidden rounded-full border-2',
  'border-[var(--bg-surface)] bg-[var(--accent)] text-[length:var(--text-12)] font-semibold',
  'text-[var(--accent-contrast)] shadow-[var(--shadow-raised)]',
].join(' ')
const MAP_PIN_DOT_CLASS = 'size-2.5 rounded-full bg-[var(--accent-contrast)]'
const MAP_CLUSTER_CLASS = [
  'flex size-full items-center justify-center rounded-full border border-[var(--bg-surface)]',
  'bg-[var(--accent)] text-[length:var(--text-12)] font-semibold tabular',
  'text-[var(--accent-contrast)] shadow-[var(--shadow-raised)]',
].join(' ')
const MAP_BADGE_CLASS = [
  'absolute -right-1 -top-1 inline-flex min-w-[18px] items-center justify-center rounded-full',
  'border border-[var(--border-default)] bg-[var(--bg-surface)] px-1 text-[length:var(--text-10)]',
  'font-semibold tabular text-[var(--text-primary)] shadow-sm',
].join(' ')

function pinLabel(group: MemoMapPinGroup): string {
  return t(group.count === 1 ? 'memos.map.pin_label_one' : 'memos.map.pin_label', {
    place: group.label,
    count: group.count,
  })
}

function appendPinFallback(visual: HTMLElement, group: MemoMapPinGroup): void {
  if (group.initial) {
    visual.textContent = group.initial
    return
  }
  const dot = document.createElement('span')
  dot.className = MAP_PIN_DOT_CLASS
  visual.append(dot)
}

function createPinElement(group: MemoMapPinGroup): HTMLElement {
  const root = document.createElement('span')
  root.className = 'relative block size-full'
  const visual = document.createElement('span')
  visual.className = MAP_PIN_VISUAL_CLASS
  visual.setAttribute('aria-hidden', 'true')
  if (memoMapPinKind(group) === 'photo' && group.photoUrl) {
    const image = document.createElement('img')
    image.src = group.photoUrl
    image.alt = ''
    image.loading = 'lazy'
    image.decoding = 'async'
    image.className = 'size-full object-cover'
    image.addEventListener('error', () => {
      image.remove()
      appendPinFallback(visual, group)
    })
    visual.append(image)
  } else {
    appendPinFallback(visual, group)
  }
  const spoken = document.createElement('span')
  spoken.className = 'sr-only'
  spoken.textContent = pinLabel(group)
  root.append(visual, spoken)
  if (group.count > 1) {
    const badge = document.createElement('span')
    badge.className = MAP_BADGE_CLASS
    badge.textContent = String(group.count)
    badge.setAttribute('aria-hidden', 'true')
    root.append(badge)
  }
  return root
}

function createPinIcon(group: MemoMapPinGroup): L.DivIcon {
  return L.divIcon({
    html: createPinElement(group),
    className: 'memo-map-pin',
    iconSize: L.point(MAP_PIN_SIZE, MAP_PIN_SIZE),
    iconAnchor: L.point(MAP_PIN_SIZE / 2, MAP_PIN_SIZE / 2),
  })
}

function createClusterIcon(cluster: L.MarkerCluster): L.DivIcon {
  const count = cluster.getChildCount()
  const root = document.createElement('span')
  root.className = MAP_CLUSTER_CLASS
  const visual = document.createElement('span')
  visual.setAttribute('aria-hidden', 'true')
  visual.textContent = String(count)
  const spoken = document.createElement('span')
  spoken.className = 'sr-only'
  spoken.textContent = t(count === 1 ? 'memos.map.cluster_label_one' : 'memos.map.cluster_label', { count })
  root.append(visual, spoken)
  return L.divIcon({
    html: root,
    className: 'memo-map-cluster',
    iconSize: L.point(MAP_CLUSTER_SIZE, MAP_CLUSTER_SIZE),
    iconAnchor: L.point(MAP_CLUSTER_SIZE / 2, MAP_CLUSTER_SIZE / 2),
  })
}

export interface MemoMapProps {
  groups: readonly MemoMapPinGroup[]
  initialView: MemoMapView | null
  label: string
  onSelect: (selection: MemoMapPointSelection) => void
  onBlankClick: () => void
  onViewChange: (view: MemoMapView) => void
}

export function MemoMap({
  groups,
  initialView,
  label,
  onSelect,
  onBlankClick,
  onViewChange,
}: MemoMapProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tilesRef = useRef<L.TileLayer | null>(null)
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null)
  const markerGroupsRef = useRef(new Map<L.Marker, MemoMapPinGroup>())
  const groupsRef = useRef<readonly MemoMapPinGroup[]>(groups)
  groupsRef.current = groups
  const callbacksRef = useRef({ onSelect, onBlankClick, onViewChange })
  callbacksRef.current = { onSelect, onBlankClick, onViewChange }
  const didInitialView = useRef(false)
  const [tileError, setTileError] = useState(false)
  const locale = useLocale()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const { map, tiles } = createMemoLeafletMap(container)
    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: MAP_CLUSTER_RADIUS,
      chunkedLoading: true,
      iconCreateFunction: createClusterIcon,
    })
    mapRef.current = map
    tilesRef.current = tiles
    clusterRef.current = cluster
    didInitialView.current = false
    map.addLayer(cluster)

    const handleBlankClick = (): void => {
      callbacksRef.current.onBlankClick()
    }
    const handleViewChange = (): void => {
      const center = map.getCenter()
      callbacksRef.current.onViewChange({
        latitude: center.lat,
        longitude: center.lng,
        zoom: map.getZoom(),
      })
    }
    const handleClusterClick = (event: L.LeafletEvent): void => {
      const layer = (event as L.LeafletEvent & { layer?: L.MarkerCluster }).layer
      if (!layer) return
      const memoIds = new Set<string>()
      for (const marker of layer.getAllChildMarkers()) {
        const group = markerGroupsRef.current.get(marker)
        if (!group) continue
        for (const id of group.memoIds) memoIds.add(id)
      }
      if (memoIds.size === 0) return
      const center = layer.getLatLng()
      callbacksRef.current.onSelect({
        latitude: center.lat,
        longitude: center.lng,
        memoIds: [...memoIds],
      })
    }
    const handleTileError = (): void => setTileError(true)

    map.on('click', handleBlankClick)
    map.on('moveend', handleViewChange)
    cluster.on('clusterclick', handleClusterClick)
    tiles.on('tileerror', handleTileError)

    return () => {
      tiles.off('tileerror', handleTileError)
      cluster.off('clusterclick', handleClusterClick)
      map.off('moveend', handleViewChange)
      map.off('click', handleBlankClick)
      map.remove()
      mapRef.current = null
      tilesRef.current = null
      clusterRef.current = null
      markerGroupsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const cluster = clusterRef.current
    if (!cluster) return
    cluster.clearLayers()
    markerGroupsRef.current.clear()
    const markers = groups.map((group) => {
      const marker = L.marker([group.latitude, group.longitude], {
        icon: createPinIcon(group),
        keyboard: true,
        title: group.label,
        alt: group.label,
        riseOnHover: true,
        bubblingMouseEvents: false,
      })
      marker.on('click', () => {
        callbacksRef.current.onSelect({
          latitude: group.latitude,
          longitude: group.longitude,
          memoIds: [...group.memoIds],
        })
      })
      markerGroupsRef.current.set(marker, group)
      return marker
    })
    cluster.addLayers(markers)
  }, [groups, locale])

  const fitAll = useCallback((): void => {
    const map = mapRef.current
    const current = groupsRef.current
    if (!map || current.length === 0) return
    if (current.length === 1) {
      map.setView([current[0].latitude, current[0].longitude], MEMO_MAP_FOCUS_ZOOM)
      return
    }
    map.fitBounds(
      L.latLngBounds(current.map((group) => [group.latitude, group.longitude] as L.LatLngTuple)),
      { padding: [MAP_FIT_PADDING, MAP_FIT_PADDING], maxZoom: MEMO_MAP_FOCUS_ZOOM },
    )
  }, [])

  useEffect(() => {
    if (didInitialView.current) return
    const map = mapRef.current
    if (!map) return
    if (initialView) {
      map.setView([initialView.latitude, initialView.longitude], initialView.zoom)
      didInitialView.current = true
      return
    }
    if (groups.length === 0) return
    fitAll()
    didInitialView.current = true
  }, [fitAll, groups, initialView])

  const retryTiles = (): void => {
    setTileError(false)
    tilesRef.current?.redraw()
  }

  return (
    <div className="relative h-full min-h-0 w-full" data-memo-map="">
      <div
        ref={containerRef}
        role="application"
        aria-label={label}
        className="absolute inset-0 isolate"
      />
      <div className="absolute left-2 top-2 z-[var(--z-sticky)] flex flex-col gap-1">
        <IconButton
          label={t('memos.map.zoom_in')}
          size="sm"
          variant="secondary"
          className="bg-[var(--bg-surface)] shadow-sm"
          onClick={() => mapRef.current?.zoomIn()}
        >
          <Plus size={15} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t('memos.map.zoom_out')}
          size="sm"
          variant="secondary"
          className="bg-[var(--bg-surface)] shadow-sm"
          onClick={() => mapRef.current?.zoomOut()}
        >
          <Minus size={15} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t('memos.map.fit_all')}
          size="sm"
          variant="secondary"
          className="bg-[var(--bg-surface)] shadow-sm"
          onClick={fitAll}
        >
          <Maximize2 size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {tileError ? (
        <div
          role="alert"
          className="absolute inset-x-2 bottom-2 z-[var(--z-sticky)] flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2.5 py-2 shadow-[var(--shadow-modal)]"
        >
          <span className="min-w-0 flex-1 text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
            {t('memos.map.tiles_failed')}
          </span>
          <Button size="sm" variant="secondary" onClick={retryTiles}>
            {t('memos.map.retry_tiles')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
