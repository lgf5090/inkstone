// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildRoutingRules,
  parseRoutingRules,
  pickRoutingTarget,
  routingCountriesFromText,
  routingCountriesToText,
} from '../src/shared/tools/shortlinks/routing'
import { RoutingRulesSchema } from '../src/shared/tools/shortlinks/schemas'

describe('Shortlinks routing rules', () => {
  it('prefers the device target over the country target and keeps the configured status', () => {
    const rules = parseRoutingRules(
      JSON.stringify({
        status: 301,
        devices: { mobile: 'https://m.example.com' },
        countries: { US: 'https://us.example.com' },
      }),
    )
    expect(pickRoutingTarget(rules, 'mobile', 'US')).toEqual({ target: 'https://m.example.com', status: 301 })
    expect(pickRoutingTarget(rules, 'desktop', 'US')).toEqual({ target: 'https://us.example.com', status: 301 })
    expect(pickRoutingTarget(rules, 'desktop', 'DE')).toEqual({ target: null, status: 301 })
    expect(pickRoutingTarget({}, 'desktop', null)).toEqual({ target: null, status: 302 })
  })

  it('ignores malformed JSON and unknown fields instead of failing the redirect', () => {
    expect(parseRoutingRules('not json')).toEqual({})
    expect(parseRoutingRules(JSON.stringify({ status: 307, countries: { us: 'https://lower.example.com' } }))).toEqual({})
  })

  it('round-trips country lines and builds rules only when a field is set', () => {
    const countries = routingCountriesFromText('US=https://us.example.com\n\nDE = https://de.example.com\nbad')
    expect(countries).toEqual({ US: 'https://us.example.com', DE: 'https://de.example.com' })
    expect(routingCountriesToText(countries)).toBe('US=https://us.example.com\nDE=https://de.example.com')
    expect(buildRoutingRules({ status: '', mobile: '', countries: '' })).toBeNull()
    expect(buildRoutingRules({ status: '301', mobile: '', countries: '' })).toEqual({ status: 301 })
  })

  it('validates the editor payload before it reaches D1', () => {
    expect(
      RoutingRulesSchema.safeParse({
        status: 301,
        devices: { mobile: 'https://m.example.com' },
        countries: { US: 'https://us.example.com' },
      }).success,
    ).toBe(true)
    expect(RoutingRulesSchema.safeParse({ countries: { us: 'https://us.example.com' } }).success).toBe(false)
    expect(RoutingRulesSchema.safeParse({ devices: { mobile: 'javascript:alert(1)' } }).success).toBe(false)
  })
})
