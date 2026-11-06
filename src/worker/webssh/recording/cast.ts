// asciinema cast v2 encoding for WebSSH recordings (plan D-09).
//
// A cast file is one JSON header line followed by one JSON tuple per line:
//   [seconds, "o", text]  terminal output
//   [seconds, "r", "colsxrows"]  terminal resize
//
// Output is recorded as decoded text, which re-encodes to the same bytes as the terminal stream; the
// recorder only splits events, so concatenating them preserves both order and the original bytes.

import type { WebsshCastEvent, WebsshCastHeader } from '@shared/webssh/types'

export function encodeCastHeader(header: WebsshCastHeader): string {
  return `${JSON.stringify(header)}\n`
}

export function encodeCastEvent(event: WebsshCastEvent): string {
  return `${JSON.stringify(event)}\n`
}

/** Seconds with millisecond precision, the precision cast v2 examples use. */
export function castTime(startedAt: number, now: number): number {
  const elapsed = Math.max(0, now - startedAt)
  return Number((elapsed / 1000).toFixed(3))
}

export function castOutputEvent(startedAt: number, now: number, data: string): WebsshCastEvent {
  return [castTime(startedAt, now), 'o', data]
}

export function castResizeEvent(startedAt: number, now: number, cols: number, rows: number): WebsshCastEvent {
  return [castTime(startedAt, now), 'r', `${cols}x${rows}`]
}

export interface ParsedCastLine {
  header?: WebsshCastHeader
  event?: WebsshCastEvent
}

/**
 * Parse one complete NDJSON line. Blank lines answer `{}`; anything that is neither the cast header
 * nor a well-formed event is rejected so a corrupted object cannot silently replay as garbage.
 */
export function parseCastLine(line: string): ParsedCastLine {
  const text = line.trim()
  if (!text) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('recording_corrupt')
  }
  if (Array.isArray(value)) {
    if (value.length !== 3) throw new Error('recording_corrupt')
    const [time, kind, payload] = value
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) throw new Error('recording_corrupt')
    if (kind !== 'o' && kind !== 'r') throw new Error('recording_corrupt')
    if (typeof payload !== 'string') throw new Error('recording_corrupt')
    return { event: [time, kind, payload] }
  }
  if (!value || typeof value !== 'object') throw new Error('recording_corrupt')
  const header = value as Partial<WebsshCastHeader>
  if (
    header.version !== 2 ||
    typeof header.width !== 'number' ||
    typeof header.height !== 'number' ||
    typeof header.timestamp !== 'number'
  ) {
    throw new Error('recording_corrupt')
  }
  return { header: header as WebsshCastHeader }
}

/**
 * Split decoded terminal text at `maxChars` code units without separating a surrogate pair. Each
 * piece becomes its own cast event; concatenation is byte-identical to the unsplit text.
 */
export function splitCastText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const pieces: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    pieces.push(text.slice(start, end))
    start = end
  }
  return pieces
}
