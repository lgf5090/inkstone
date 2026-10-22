import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Minus, Plus } from 'lucide-react'
import L from 'leaflet'
import { Button, IconButton } from '../../../components/primitives'
import { t } from '../../../lib/i18n'
import { createMemoLeafletMap } from '../leaflet-map'
import { formatCoordinate } from '../location'
import { MEMO_MAP_FOCUS_ZOOM, MEMO_MAP_WORLD_VIEW } from '../map-state'

const LOCATION_PIN_SIZE = 22
const LOCATION_PIN_CLASS = [
  'block size-full rounded-full border-2 border-[var(--bg-surface)] bg-[var(--accent)]',
  'shadow-[var(--shadow-soft)]',
].join(' ')

export interface LocationPickerPoint {
  latitude: number
  longitude: number
}

export interface LocationPickerMapProps {
  point: LocationPickerPoint | null
  label: string
  onPick: (latitude: number, longitude: number) => void
}

function createLocationPinIcon(): L.DivIcon {
  const element = document.createElement('span')
  element.className = LOCATION_PIN_CLASS
  return L.divIcon({
    html: element,
    className: 'memo-location-pin',
    iconSize: L.point(LOCATION_PIN_SIZE, LOCATION_PIN_SIZE),
    iconAnchor: L.point(LOCATION_PIN_SIZE / 2, LOCATION_PIN_SIZE / 2),
  })
}

export function LocationPickerMap({ point, label, onPick }: LocationPickerMapProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tilesRef = useRef<L.TileLayer | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const [tileError, setTileError] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const { map, tiles } = createMemoLeafletMap(container)
    mapRef.current = map
    tilesRef.current = tiles
    const center = point
      ? { latitude: point.latitude, longitude: point.longitude, zoom: MEMO_MAP_FOCUS_ZOOM }
      : MEMO_MAP_WORLD_VIEW
    map.setView([center.latitude, center.longitude], center.zoom)
    const handleClick = (event: L.LeafletMouseEvent): void => {
      onPickRef.current(event.latlng.lat, event.latlng.lng)
    }
    const handleTileError = (): void => setTileError(true)
    map.on('click', handleClick)
    tiles.on('tileerror', handleTileError)
    return () => {
      tiles.off('tileerror', handleTileError)
      map.off('click', handleClick)
      map.remove()
      mapRef.current = null
      tilesRef.current = null
      markerRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!point) {
      markerRef.current?.remove()
      markerRef.current = null
      return
    }
    const latlng = L.latLng(point.latitude, point.longitude)
    if (markerRef.current) {
      markerRef.current.setLatLng(latlng)
    } else {
      markerRef.current = L.marker(latlng, {
        icon: createLocationPinIcon(),
        interactive: false,
        keyboard: false,
      }).addTo(map)
    }
    if (!map.getBounds().contains(latlng)) {
      map.setView(latlng, Math.max(map.getZoom(), MEMO_MAP_FOCUS_ZOOM))
    }
  }, [point])

  const retryTiles = (): void => {
    setTileError(false)
    tilesRef.current?.redraw()
  }

  return (
    <div className="relative h-full min-h-0 w-full">
      <div
        ref={containerRef}
        role="region"
        aria-label={label}
        className="absolute inset-0 isolate rounded-[var(--r-md)]"
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
      </div>
      {point ? (
        <p className="absolute bottom-2 left-2 z-[var(--z-sticky)] rounded-[var(--r-sm)] bg-[var(--bg-overlay)] px-2 py-1 text-[length:var(--text-11)] tabular text-[var(--text-secondary)] shadow-sm">
          {formatCoordinate(point.latitude)}, {formatCoordinate(point.longitude)}
        </p>
      ) : null}
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
