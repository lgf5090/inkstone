import { describe, expect, it, vi } from 'vitest'
import {
  coordinateLabel,
  formatCoordinate,
  isValidLatitude,
  isValidLongitude,
  memoPlaceLabel,
  nominatimReverseUrl,
  normalizeMemoLocation,
  parseCoordinateInput,
  reverseGeocodePlace,
  reverseGeocodePlaceName,
} from './location'

describe('coordinate validation', () => {
  it('accepts decimal latitudes inside the range', () => {
    expect(parseCoordinateInput('37.7749', 'latitude')).toBe(37.7749)
    expect(parseCoordinateInput('  -0.5  ', 'latitude')).toBe(-0.5)
    expect(parseCoordinateInput('+12', 'latitude')).toBe(12)
    expect(parseCoordinateInput('.5', 'latitude')).toBe(0.5)
    expect(parseCoordinateInput('90', 'latitude')).toBe(90)
    expect(parseCoordinateInput('-90', 'latitude')).toBe(-90)
  })

  it('rejects non-numeric and out-of-range latitudes', () => {
    expect(parseCoordinateInput('', 'latitude')).toBeNull()
    expect(parseCoordinateInput('abc', 'latitude')).toBeNull()
    expect(parseCoordinateInput('NaN', 'latitude')).toBeNull()
    expect(parseCoordinateInput('Infinity', 'latitude')).toBeNull()
    expect(parseCoordinateInput('1e2', 'latitude')).toBeNull()
    expect(parseCoordinateInput('90.0001', 'latitude')).toBeNull()
    expect(parseCoordinateInput('-90.0001', 'latitude')).toBeNull()
  })

  it('accepts longitudes inside the range only', () => {
    expect(parseCoordinateInput('180', 'longitude')).toBe(180)
    expect(parseCoordinateInput('-180', 'longitude')).toBe(-180)
    expect(parseCoordinateInput('180.0001', 'longitude')).toBeNull()
    expect(parseCoordinateInput('-180.0001', 'longitude')).toBeNull()
    expect(parseCoordinateInput('12.5.5', 'longitude')).toBeNull()
  })

  it('guards values from storage or the API', () => {
    expect(isValidLatitude(90)).toBe(true)
    expect(isValidLatitude(-90)).toBe(true)
    expect(isValidLatitude(90.1)).toBe(false)
    expect(isValidLatitude(Number.NaN)).toBe(false)
    expect(isValidLatitude('12')).toBe(false)
    expect(isValidLongitude(180)).toBe(true)
    expect(isValidLongitude(-180)).toBe(true)
    expect(isValidLongitude(180.1)).toBe(false)
    expect(isValidLongitude(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('coordinate labels', () => {
  it('formats without trailing zeros and without negative zero', () => {
    expect(formatCoordinate(37.774929)).toBe('37.774929')
    expect(formatCoordinate(12.5)).toBe('12.5')
    expect(formatCoordinate(-0.0000001)).toBe('0')
    expect(formatCoordinate(0)).toBe('0')
  })

  it('pairs latitude and longitude', () => {
    expect(coordinateLabel(37.774929, -122.419416)).toBe('37.774929, -122.419416')
  })

  it('uses the place text and falls back to coordinates', () => {
    expect(memoPlaceLabel({ placeholder: '  Home  ', latitude: 1, longitude: 2 })).toBe('Home')
    expect(memoPlaceLabel({ placeholder: '   ', latitude: 1.5, longitude: 2.5 })).toBe('1.5, 2.5')
    expect(memoPlaceLabel(null)).toBe('')
  })
})

describe('location normalization', () => {
  it('trims the placeholder and keeps valid coordinates', () => {
    expect(normalizeMemoLocation({ placeholder: '  Home ', latitude: 1, longitude: 2 }))
      .toEqual({ placeholder: 'Home', latitude: 1, longitude: 2 })
    expect(normalizeMemoLocation({ placeholder: '', latitude: 1, longitude: 2 }))
      .toEqual({ placeholder: '', latitude: 1, longitude: 2 })
  })

  it('refuses invalid coordinates and non-object values', () => {
    expect(normalizeMemoLocation(null)).toBeNull()
    expect(normalizeMemoLocation({ placeholder: 'x', latitude: 91, longitude: 0 })).toBeNull()
    expect(normalizeMemoLocation({ placeholder: 'x', latitude: 0, longitude: 181 })).toBeNull()
    expect(normalizeMemoLocation({ placeholder: 'x', latitude: Number.NaN, longitude: 0 })).toBeNull()
  })
})

describe('nominatim reverse geocoding', () => {
  it('builds an encoded reverse request', () => {
    const url = new URL(nominatimReverseUrl(37.774929, -122.419416))
    expect(url.origin).toBe('https://nominatim.openstreetmap.org')
    expect(url.pathname).toBe('/reverse')
    expect(url.searchParams.get('format')).toBe('jsonv2')
    expect(url.searchParams.get('lat')).toBe('37.774929')
    expect(url.searchParams.get('lon')).toBe('-122.419416')
    expect(url.searchParams.get('zoom')).toBe('18')
  })

  it('reads a display name and ignores malformed payloads', () => {
    expect(reverseGeocodePlace({ display_name: '  Ferry Building, San Francisco  ' }))
      .toBe('Ferry Building, San Francisco')
    expect(reverseGeocodePlace({ display_name: '   ' })).toBeNull()
    expect(reverseGeocodePlace({})).toBeNull()
    expect(reverseGeocodePlace(null)).toBeNull()
    expect(reverseGeocodePlace('Ferry Building')).toBeNull()
  })

  it('sends the reader language and omits credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ display_name: 'Home' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const name = await reverseGeocodePlaceName({
      latitude: 1,
      longitude: 2,
      language: 'zh-CN',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(name).toBe('Home')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('nominatim.openstreetmap.org/reverse')
    expect(init.headers).toEqual({ 'Accept-Language': 'zh-CN' })
    expect(init.credentials).toBe('omit')
  })

  it('throws on an unsuccessful response', async () => {
    const fetchImpl = vi.fn(async () => new Response('busy', { status: 429 }))
    await expect(reverseGeocodePlaceName({
      latitude: 1,
      longitude: 2,
      language: 'en-US',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('429')
  })
})
