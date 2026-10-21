import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MEMO_MAP_ATTRIBUTION, MEMO_MAP_MAX_ZOOM, MEMO_MAP_MIN_ZOOM, MEMO_MAP_TILE_URL } from './map-state'

export interface MemoLeafletMap {
  map: L.Map
  tiles: L.TileLayer
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function createMemoLeafletMap(container: HTMLElement): MemoLeafletMap {
  const animate = !prefersReducedMotion()
  const map = L.map(container, {
    zoomControl: false,
    minZoom: MEMO_MAP_MIN_ZOOM,
    maxZoom: MEMO_MAP_MAX_ZOOM,
    worldCopyJump: true,
    zoomAnimation: animate,
    fadeAnimation: animate,
    markerZoomAnimation: animate,
  })
  const tiles = L.tileLayer(MEMO_MAP_TILE_URL, {
    attribution: MEMO_MAP_ATTRIBUTION,
    maxZoom: MEMO_MAP_MAX_ZOOM,
  }).addTo(map)
  return { map, tiles }
}
