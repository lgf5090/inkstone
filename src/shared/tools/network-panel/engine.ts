/**
 * The arithmetic behind the network panel, kept away from the browser so it can be measured directly.
 *
 * Three things live here: how a node address is read, how a byte count becomes a sentence, and the
 * series the chart draws. The measurement itself — fetch, reader, stop, discard — is the client's,
 * because those are browser objects with no meaning in a test.
 */
import {
  NETWORK_PANEL_LIMITS,
  type NodeUrlParseResult,
  type SpeedSeriesPoint,
} from './types'

const MAX_SERIES_POINTS = 200

/**
 * One node address, from what the reader typed.
 *
 * A same-origin path is the form a deployment can offer without changing its own security policy, so
 * a leading `/` is accepted and kept relative. Anything else has to parse as http(s): `javascript:`
 * and `data:` are exactly the strings a protocol check exists to stop, and a relative `//host` would
 * quietly become another origin under the page's own scheme.
 */
export function parseNodeUrl(raw: string): NodeUrlParseResult {
  const text = raw.trim()
  if (!text) return { ok: false, problem: 'empty' }
  if (text.startsWith('/')) {
    if (text.startsWith('//')) return { ok: false, problem: 'invalid' }
    if (/\s/.test(text)) return { ok: false, problem: 'invalid' }
    return { ok: true, url: text }
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, problem: 'invalid' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, problem: 'scheme' }
  if (parsed.username || parsed.password) return { ok: false, problem: 'invalid' }
  return { ok: true, url: parsed.toString() }
}

const UNIT_KINDS = ['bytes', 'rate', 'bitrate'] as const

const UNIT_LABELS: Readonly<Record<(typeof UNIT_KINDS)[number], readonly string[]>> = {
  bytes: ['B', 'KB', 'MB', 'GB', 'TB', 'PB'],
  rate: ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s'],
  bitrate: ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps', 'Pbps'],
}

/**
 * A byte count or a rate, in the unit a person reads it in.
 *
 * The reference panel printed a different number of decimals per unit (`0` for B, `2` for MB), which
 * is why the precision is a callback rather than one fixed number: a count of five bytes is not
 * `5.00 B`, and a speed of 12.5 MB/s is not `13 MB/s`.
 */
export function formatUnit(
  value: number,
  kind: (typeof UNIT_KINDS)[number],
  precision: (unitIndex: number) => number = () => (kind === 'bytes' ? 0 : 1),
): string {
  if (!Number.isFinite(value) || value <= 0) return `0${UNIT_LABELS[kind][0]}`
  const labels = UNIT_LABELS[kind]
  let scaled = value
  let index = 0
  while (scaled >= 1024 && index < labels.length - 1) {
    scaled /= 1024
    index += 1
  }
  return `${scaled.toFixed(precision(index))}${labels[index]}`
}

export function formatBytes(value: number): string {
  return formatUnit(value, 'bytes', (index) => (index === 0 ? 0 : index === 1 ? 0 : 2))
}

export function formatSpeed(bytesPerSecond: number): string {
  return formatUnit(bytesPerSecond, 'rate', (index) => (index === 0 ? 0 : index === 1 ? 1 : 2))
}

export function formatBandwidth(bytesPerSecond: number): string {
  return formatUnit(bytesPerSecond * 8, 'bitrate', (index) => (index <= 1 ? 0 : index === 2 ? 2 : 2))
}

/** A duration as a person says it: seconds under a minute, then minutes and seconds. */
export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${String(rest).padStart(2, '0')}s`
}

/** What the present speed would move over the four windows the panel predicts. */
export function predictUsage(bytesPerSecond: number): {
  minute: number
  hour: number
  day: number
  month: number
} {
  const safe = Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? bytesPerSecond : 0
  const hour = safe * 60 * 60
  return {
    minute: safe * 60,
    hour,
    day: hour * 24,
    month: hour * 24 * 30,
  }
}

/**
 * A capped bandwidth, the reference panel's way.
 *
 * The browser decides when bytes arrive, so a hard per-frame limit is not possible; what is possible
 * is letting a thread wait until the shared budget has caught up. The wait is computed against the
 * whole test's bytes rather than one thread's, which is what keeps eight threads from each taking a
 * full share of the cap.
 */
export function capWaitMs(capBps: number, bytesUsed: number, elapsedMs: number): number {
  if (capBps <= 0) return 0
  const budget = (capBps * Math.max(elapsedMs, 0)) / 1000
  if (bytesUsed <= budget) return 0
  return Math.min(1000, Math.ceil(((bytesUsed - budget) / capBps) * 1000))
}

/**
 * The chart's series, thinned as it grows.
 *
 * One point per second would be ten thousand points after three hours, which a line chart cannot draw
 * usefully and a reader cannot read anyway. Past the ceiling the oldest pairs are averaged in place
 * and every later pair is added the same way, so the series keeps its whole time range while its
 * resolution halves — the reference panel's own behaviour, spelled out here so it can be tested.
 */
export class SpeedSeries {
  private points: SpeedSeriesPoint[] = []
  private pairWidth = 1
  private pending: number[] = []

  push(t: number, value: number): void {
    this.pending.push(value)
    while (this.pending.length >= this.pairWidth) {
      const bucket = this.pending.splice(0, this.pairWidth)
      const average = bucket.includes(0) ? 0 : bucket.reduce((total, entry) => total + entry, 0) / bucket.length
      this.points.push({ t, v: average })
    }
    while (this.points.length >= MAX_SERIES_POINTS) {
      const next: SpeedSeriesPoint[] = []
      const usable = this.points.length % 2 === 0 ? this.points.length : this.points.length - 1
      for (let index = 0; index < usable; index += 2) {
        const left = this.points[index]!
        const right = this.points[index + 1]!
        next.push({ t: right.t, v: (left.v + right.v) / 2 })
      }
      this.points = next
      this.pairWidth *= 2
    }
  }

  reset(): void {
    this.points = []
    this.pending = []
    this.pairWidth = 1
  }

  /** A copy, so a store subscriber cannot mutate the series in place. */
  snapshot(): SpeedSeriesPoint[] {
    return this.points.map((point) => ({ ...point }))
  }
}

/** The per-request payload, bounded on both sides so a hand-edited query cannot ask for a byte or a terabyte. */
export function clampDownloadBytes(raw: number | null): number {
  const fallback = NETWORK_PANEL_LIMITS.downloadBytesPreferred
  if (raw === null || !Number.isFinite(raw)) return fallback
  return Math.min(NETWORK_PANEL_LIMITS.downloadBytesMax, Math.max(NETWORK_PANEL_LIMITS.downloadBytesMin, Math.floor(raw)))
}

/** The label a pasted address is filed under: its host, never the whole URL. */
export function nodeLabelFromUrl(url: string): string {
  if (url.startsWith('/')) {
    const path = url.split('?')[0] ?? url
    return path.slice(1) || 'localhost'
  }
  try {
    return new URL(url).hostname || url
  } catch {
    return url.slice(0, 60)
  }
}
