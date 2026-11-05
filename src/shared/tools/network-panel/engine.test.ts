/**
 * The arithmetic the panel shows: units, addresses, forecasts, the capped bandwidth and the series
 * that thins itself. Each case is a number a reader could check by hand.
 */
import { describe, expect, it } from 'vitest'
import {
  SpeedSeries,
  capWaitMs,
  clampDownloadBytes,
  formatBandwidth,
  formatBytes,
  formatDuration,
  formatSpeed,
  nodeLabelFromUrl,
  parseNodeUrl,
  predictUsage,
} from './engine'
import { NETWORK_PANEL_LIMITS } from './types'

describe('unit formatting', () => {
  it('scales a byte count through the 1024 ladder', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(999)).toBe('999B')
    expect(formatBytes(1024)).toBe('1KB')
    expect(formatBytes(1024 ** 2 * 1.5)).toBe('1.50MB')
    expect(formatBytes(1024 ** 4)).toBe('1.00TB')
  })

  it('prints a rate and a bandwidth with their own units', () => {
    expect(formatSpeed(1024 * 1024)).toBe('1.00MB/s')
    expect(formatSpeed(0)).toBe('0B/s')
    expect(formatBandwidth(1024 * 1024)).toBe('8.00Mbps')
    expect(formatBandwidth(0)).toBe('0bps')
  })

  it('says a duration the way a person reads it', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(59_499)).toBe('59s')
    expect(formatDuration(61_000)).toBe('1m 01s')
    expect(formatDuration(3_600_000)).toBe('60m 00s')
  })
})

describe('node addresses', () => {
  it('keeps a same-origin path relative', () => {
    expect(parseNodeUrl('/api/tools/network-panel/download')).toEqual({
      ok: true,
      url: '/api/tools/network-panel/download',
    })
    expect(parseNodeUrl('  /x?y=1  ')).toEqual({ ok: true, url: '/x?y=1' })
  })

  it('refuses a protocol-relative path and a non-http scheme', () => {
    expect(parseNodeUrl('//evil.example/file')).toEqual({ ok: false, problem: 'invalid' })
    expect(parseNodeUrl('javascript:alert(1)')).toEqual({ ok: false, problem: 'scheme' })
    expect(parseNodeUrl('data:text/plain,x')).toEqual({ ok: false, problem: 'scheme' })
    expect(parseNodeUrl('not a url')).toEqual({ ok: false, problem: 'invalid' })
    expect(parseNodeUrl('')).toEqual({ ok: false, problem: 'empty' })
  })

  it('normalizes an http address and refuses embedded credentials', () => {
    expect(parseNodeUrl('  https://example.com/a  ')).toEqual({
      ok: true,
      url: 'https://example.com/a',
    })
    expect(parseNodeUrl('https://user:pass@example.com/a')).toEqual({ ok: false, problem: 'invalid' })
  })

  it('labels a pasted address by its host, never by the whole string', () => {
    expect(nodeLabelFromUrl('https://cdn.example.com/a/b')).toBe('cdn.example.com')
    expect(nodeLabelFromUrl('/api/tools/network-panel/download?v=1')).toBe('api/tools/network-panel/download')
    expect(nodeLabelFromUrl('http://localhost')).toBe('localhost')
  })
})

describe('usage forecast', () => {
  it('multiplies one second of speed into the four windows', () => {
    expect(predictUsage(1024)).toEqual({
      minute: 1024 * 60,
      hour: 1024 * 3600,
      day: 1024 * 3600 * 24,
      month: 1024 * 3600 * 24 * 30,
    })
    expect(predictUsage(Number.NaN)).toEqual({ minute: 0, hour: 0, day: 0, month: 0 })
    expect(predictUsage(-5)).toEqual({ minute: 0, hour: 0, day: 0, month: 0 })
  })
})

describe('bandwidth ceiling', () => {
  it('waits only once the shared budget is spent', () => {
    expect(capWaitMs(0, 1_000_000, 1000)).toBe(0)
    expect(capWaitMs(1000, 500, 1000)).toBe(0)
    expect(capWaitMs(1000, 2000, 1000)).toBe(1000)
    expect(capWaitMs(1000, 1500, 1000)).toBe(500)
  })
})

describe('the series', () => {
  it('keeps one point per second below the ceiling', () => {
    const series = new SpeedSeries()
    for (let index = 0; index < 10; index += 1) series.push(index, index)
    expect(series.snapshot()).toHaveLength(10)
    expect(series.snapshot()[9]).toEqual({ t: 9, v: 9 })
  })

  it('halves the resolution once the ceiling is reached and keeps the range', () => {
    const series = new SpeedSeries()
    for (let index = 0; index < 420; index += 1) series.push(index, index)
    const points = series.snapshot()
    expect(points.length).toBeLessThan(200)
    expect(points.length).toBeGreaterThan(0)
    expect(points[points.length - 1]!.t).toBeGreaterThan(300)
  })

  it('keeps a zero reading as a zero', () => {
    const series = new SpeedSeries()
    series.push(1, 100)
    series.push(2, 0)
    expect(series.snapshot().map((point) => point.v)).toEqual([100, 0])
    series.reset()
    expect(series.snapshot()).toHaveLength(0)
  })
})

describe('download bounds', () => {
  it('clamps a hand-edited byte request into the range the route accepts', () => {
    expect(clampDownloadBytes(null)).toBe(NETWORK_PANEL_LIMITS.downloadBytesPreferred)
    expect(clampDownloadBytes(Number.NaN)).toBe(NETWORK_PANEL_LIMITS.downloadBytesPreferred)
    expect(clampDownloadBytes(0)).toBe(1)
    expect(clampDownloadBytes(-5)).toBe(1)
    expect(clampDownloadBytes(10_000_000_000)).toBe(NETWORK_PANEL_LIMITS.downloadBytesMax)
    expect(clampDownloadBytes(1500)).toBe(1500)
  })
})
