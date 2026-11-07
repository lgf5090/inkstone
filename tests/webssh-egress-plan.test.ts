// @vitest-environment node
// Region planning is the part of the egress work that can be proven without a second data centre:
// inheritance, remembered placements, manual overrides and the one-retry candidate order.

import { describe, expect, it } from 'vitest'
import {
  defaultEgressSettings,
  defaultHostEgress,
  nextRegionCandidate,
  normalizeEgressSettingsInput,
  normalizeHostEgressInput,
  parseHostEgress,
  resolveEgressPlan,
  type WebsshEgressSettings,
} from '../src/worker/webssh/egress'

function host(overrides: Partial<ReturnType<typeof defaultHostEgress>> = {}): ReturnType<typeof defaultHostEgress> {
  return { ...defaultHostEgress(), ...overrides }
}

function settings(overrides: Partial<WebsshEgressSettings> = {}): WebsshEgressSettings {
  return { ...defaultEgressSettings(), ...overrides }
}

describe('host egress parsing', () => {
  it('keeps a malformed or older row usable', () => {
    expect(parseHostEgress(null)).toEqual(defaultHostEgress())
    expect(parseHostEgress('{oops')).toEqual(defaultHostEgress())
    expect(parseHostEgress('{"region":"weur","mode":"direct"}')).toMatchObject({
      region: 'weur',
      mode: 'direct',
    })
  })

  it('drops an unknown region or mode instead of trusting it', () => {
    expect(parseHostEgress('{"region":"mars","mode":"teleport"}')).toMatchObject({
      region: '',
      mode: '',
    })
  })

  it('validates an input draft', () => {
    const input = normalizeHostEgressInput({ region: 'apac' })
    expect(input.region).toBe('apac')
    expect(() => normalizeHostEgressInput({ region: 'mars' })).toThrow('region must be auto')
    expect(() => normalizeHostEgressInput({ mode: 'socks5' })).toThrow('proxy host and port')
  })
})

describe('region plan', () => {
  it('uses the host region first and does not fail over from a manual choice', () => {
    const plan = resolveEgressPlan(host({ region: 'weur' }), settings({ defaultRegion: 'enam' }))
    expect(plan).toMatchObject({
      regionHint: 'weur',
      regionSource: 'host',
      regionFailoverAllowed: false,
      mode: 'direct',
      available: true,
    })
  })

  it('inherits the account default when the host says nothing', () => {
    const plan = resolveEgressPlan(host(), settings({ defaultRegion: 'enam' }))
    expect(plan).toMatchObject({ regionHint: 'enam', regionSource: 'global' })
  })

  it('prefers the remembered region in automatic mode', () => {
    const plan = resolveEgressPlan(
      host({ region: 'auto', regionResolved: { region: 'apac', at: 1, failures: 0 } }),
      settings({ regionCandidates: ['weur', 'enam'] }),
    )
    expect(plan).toMatchObject({
      regionHint: 'apac',
      regionSource: 'resolved',
      regionFailoverAllowed: true,
    })
    expect(plan.regionCandidates[0]).toBe('apac')
  })

  it('forgets a remembered region after two failures', () => {
    const plan = resolveEgressPlan(
      host({ region: 'auto', regionResolved: { region: 'apac', at: 1, failures: 2 } }),
      settings({ regionCandidates: ['weur', 'enam'] }),
    )
    expect(plan).toMatchObject({ regionHint: 'weur', regionSource: 'auto' })
  })

  it('honours a client override and never fails over again on the retry', () => {
    const plan = resolveEgressPlan(host({ region: 'auto' }), settings(), {
      regionOverride: 'wnam',
      retryFrom: 'apac',
    })
    expect(plan).toMatchObject({
      regionHint: 'wnam',
      regionSource: 'request',
      regionFailoverAllowed: false,
    })
  })

  it('reports relay modes as unavailable instead of silently falling back', () => {
    const plan = resolveEgressPlan(host({ mode: 'socks5' }), settings())
    expect(plan).toMatchObject({
      mode: 'socks5',
      available: false,
      unavailableReason: 'relay_requires_node',
    })
  })

  it('chooses the next candidate in order', () => {
    const plan = resolveEgressPlan(host({ region: 'auto' }), settings({ regionCandidates: ['apac', 'weur', 'enam'] }))
    expect(nextRegionCandidate(plan, 'apac')).toBe('weur')
    expect(nextRegionCandidate(plan, 'enam')).toBeNull()
  })
})

describe('egress settings', () => {
  it('rejects relay default modes with a readable code', () => {
    expect(() => normalizeEgressSettingsInput({ defaultMode: 'jump' }, defaultEgressSettings()))
      .toThrow('Relay egress modes need a relay node')
  })

  it('validates candidate hints and deduplicates them', () => {
    const next = normalizeEgressSettingsInput(
      { defaultRegion: 'weur', regionCandidates: ['apac', 'apac', 'enam'] },
      defaultEgressSettings(),
    )
    expect(next.defaultRegion).toBe('weur')
    expect(next.regionCandidates).toEqual(['apac', 'enam'])
    expect(() => normalizeEgressSettingsInput({ regionCandidates: ['mars'] }, defaultEgressSettings()))
      .toThrow('unsupported hint')
  })
})
