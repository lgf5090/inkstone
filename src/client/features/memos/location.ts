import { NOMINATIM_REVERSE_ENDPOINT } from '@shared/memos/map-endpoints'
import type { MemoLocation } from '@shared/memos/types'

export { NOMINATIM_REVERSE_ENDPOINT }

export const NOMINATIM_REVERSE_ZOOM = 18

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

export type MemoCoordinateAxis = 'latitude' | 'longitude'

export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180
}

export function parseCoordinateInput(raw: string, axis: MemoCoordinateAxis): number | null {
  const text = raw.trim()
  if (!DECIMAL_NUMBER.test(text)) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return axis === 'latitude'
    ? (isValidLatitude(value) ? value : null)
    : (isValidLongitude(value) ? value : null)
}

export function normalizeMemoLocation(value: MemoLocation | null | undefined): MemoLocation | null {
  if (!value) return null
  if (typeof value.placeholder !== 'string') return null
  if (!isValidLatitude(value.latitude) || !isValidLongitude(value.longitude)) return null
  return {
    placeholder: value.placeholder.trim(),
    latitude: value.latitude,
    longitude: value.longitude,
  }
}

export function formatCoordinate(value: number): string {
  const rounded = Math.round(value * 1_000_000) / 1_000_000
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

export function coordinateLabel(latitude: number, longitude: number): string {
  return `${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}`
}

export function memoPlaceLabel(location: MemoLocation | null | undefined): string {
  if (!location) return ''
  const placeholder = location.placeholder.trim()
  return placeholder || coordinateLabel(location.latitude, location.longitude)
}

export function nominatimReverseUrl(latitude: number, longitude: number): string {
  const url = new URL(NOMINATIM_REVERSE_ENDPOINT)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('lat', formatCoordinate(latitude))
  url.searchParams.set('lon', formatCoordinate(longitude))
  url.searchParams.set('zoom', String(NOMINATIM_REVERSE_ZOOM))
  return url.toString()
}

export function reverseGeocodePlace(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const displayName = (payload as { display_name?: unknown }).display_name
  if (typeof displayName !== 'string') return null
  const label = displayName.trim()
  return label || null
}

export interface ReverseGeocodeOptions {
  latitude: number
  longitude: number
  language: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export async function reverseGeocodePlaceName(options: ReverseGeocodeOptions): Promise<string | null> {
  const request = options.fetchImpl ?? fetch
  const response = await request(nominatimReverseUrl(options.latitude, options.longitude), {
    signal: options.signal,
    headers: { 'Accept-Language': options.language },
    credentials: 'omit',
    referrerPolicy: 'strict-origin-when-cross-origin',
  })
  if (!response.ok) {
    throw new Error(`Reverse geocoding failed with status ${response.status}`)
  }
  return reverseGeocodePlace(await response.json())
}
