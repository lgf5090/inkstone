/**
 * Per-link routing rules: a status code, device targets and country targets.
 *
 * The rules travel as JSON in one column so an edge redirect never needs a second table look-up.
 * Only the exact shapes the editor writes are accepted; anything else is treated as "no rules".
 */

import type { RoutingRules, RouteDevice } from './types'

const DEVICES: readonly RouteDevice[] = ['mobile', 'tablet', 'desktop']

export function parseRoutingRules(raw: unknown): RoutingRules {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const object = value as Record<string, unknown>
    const rules: RoutingRules = {}

    if (object.status === 301 || object.status === 302) rules.status = object.status

    if (object.devices && typeof object.devices === 'object' && !Array.isArray(object.devices)) {
      const devices: Partial<Record<RouteDevice, string>> = {}
      for (const key of DEVICES) {
        const target = (object.devices as Record<string, unknown>)[key]
        if (typeof target === 'string' && target.length > 0) devices[key] = target
      }
      if (Object.keys(devices).length > 0) rules.devices = devices
    }

    if (object.countries && typeof object.countries === 'object' && !Array.isArray(object.countries)) {
      const countries: Record<string, string> = {}
      for (const [code, target] of Object.entries(object.countries as Record<string, unknown>)) {
        if (/^[A-Z]{2}$/.test(code) && typeof target === 'string' && target.length > 0) countries[code] = target
      }
      if (Object.keys(countries).length > 0) rules.countries = countries
    }

    return rules
  } catch {
    return {}
  }
}

/** The device target wins over the country target, so a phone abroad still gets the mobile page. */
export function pickRoutingTarget(
  rules: RoutingRules,
  device: string,
  country: string | null,
): { target: string | null; status: 301 | 302 } {
  const status: 301 | 302 = rules.status === 301 ? 301 : 302
  const deviceTarget = rules.devices?.[device as RouteDevice]
  if (deviceTarget) return { target: deviceTarget, status }
  const countryTarget = country ? rules.countries?.[country.toUpperCase()] : undefined
  if (countryTarget) return { target: countryTarget, status }
  return { target: null, status }
}

/** Formats country targets as one `US=https://...` line per rule for the editor. */
export function routingCountriesToText(countries?: Record<string, string>): string {
  if (!countries) return ''
  return Object.entries(countries).map(([code, target]) => `${code}=${target}`).join('\n')
}

/** Reads the editor's line format back, ignoring blank lines and malformed entries. */
export function routingCountriesFromText(text: string): Record<string, string> {
  const countries: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const split = trimmed.indexOf('=')
    if (split <= 0) continue
    const code = trimmed.slice(0, split).trim().toUpperCase()
    const target = trimmed.slice(split + 1).trim()
    if (/^[A-Z]{2}$/.test(code) && target) countries[code] = target
  }
  return countries
}

/** Builds the rules object from the three editor fields, returning null when every field is empty. */
export function buildRoutingRules(input: { status: string; mobile: string; countries: string }): RoutingRules | null {
  const rules: RoutingRules = {}
  if (input.status === '301' || input.status === '302') rules.status = Number(input.status) as 301 | 302
  if (input.mobile.trim()) rules.devices = { mobile: input.mobile.trim() }
  const countries = routingCountriesFromText(input.countries)
  if (Object.keys(countries).length > 0) rules.countries = countries
  return Object.keys(rules).length > 0 ? rules : null
}
