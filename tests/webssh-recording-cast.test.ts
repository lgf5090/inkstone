// @vitest-environment node
// Cast v2 encoding is the replay contract: one header line, one event per line, and text split at
// code-point boundaries so concatenating events reproduces the terminal bytes exactly.

import { describe, expect, it } from 'vitest'
import {
  castOutputEvent,
  castResizeEvent,
  castTime,
  encodeCastEvent,
  encodeCastHeader,
  parseCastLine,
  splitCastText,
} from '../src/worker/webssh/recording/cast'
import { recordingObjectKey } from '../src/worker/webssh/recording/recorder'
import { newId } from '../src/worker/lib/id'

describe('cast encoding', () => {
  it('writes a v2 header and canonical event lines', () => {
    const header = encodeCastHeader({ version: 2, width: 120, height: 40, timestamp: 1, env: { TERM: 'xterm' } })
    expect(header.endsWith('\n')).toBe(true)
    expect(JSON.parse(header)).toMatchObject({ version: 2, width: 120, height: 40 })

    const event = castOutputEvent(1_000, 2_250, 'hello\r\n')
    expect(event).toEqual([1.25, 'o', 'hello\r\n'])
    expect(encodeCastEvent(event)).toBe('[1.25,"o","hello\\r\\n"]\n')
  })

  it('parses a header and both event kinds', () => {
    expect(parseCastLine('{"version":2,"width":80,"height":24,"timestamp":7}') ).toEqual({
      header: { version: 2, width: 80, height: 24, timestamp: 7 },
    })
    expect(parseCastLine('[0.5,"o","x"]')).toEqual({ event: [0.5, 'o', 'x'] })
    expect(parseCastLine(encodeCastEvent(castResizeEvent(0, 1_000, 100, 30)))).toEqual({
      event: [1, 'r', '100x30'],
    })
    expect(parseCastLine('')).toEqual({})
  })

  it('rejects corrupt lines rather than replaying garbage', () => {
    expect(() => parseCastLine('not-json')).toThrow('recording_corrupt')
    expect(() => parseCastLine('[1,"x","y"]')).toThrow('recording_corrupt')
    expect(() => parseCastLine('{"version":1}')).toThrow('recording_corrupt')
  })

  it('splits text without separating a surrogate pair', () => {
    expect(splitCastText('abcdef', 6)).toEqual(['abcdef'])
    expect(splitCastText('abcdefg', 3)).toEqual(['abc', 'def', 'g'])

    const emoji = 'a😀b'
    const pieces = splitCastText(emoji, 2)
    // The cut moves back to before the high surrogate, so the pair is never separated.
    expect(pieces).toEqual(['a', '😀', 'b'])
    expect(pieces.join('')).toBe(emoji)
  })

  it('keeps sub-millisecond timing out of the cast while rounding to milliseconds', () => {
    expect(castTime(1_000, 1_000)).toBe(0)
    expect(castTime(1_000, 1_001)).toBe(0.001)
    expect(castTime(1_000, 1_999)).toBe(0.999)
    expect(castTime(1_000, 999)).toBe(0)
  })
})

describe('recording object keys', () => {
  it('follows webssh/txt/recordings/<user>/<yyyy>/<mm>/<session>.cast', () => {
    const userId = newId()
    const sessionId = newId()
    const createdAt = Date.UTC(2026, 10, 7, 12)
    expect(recordingObjectKey(userId, sessionId, createdAt)).toBe(
      `webssh/txt/recordings/${userId}/2026/11/${sessionId}.cast`,
    )
  })

  it('refuses ids that are not the project id shape', () => {
    expect(() => recordingObjectKey('../x', newId(), 0)).toThrow('invalid_webssh_recording_key')
    expect(() => recordingObjectKey(newId(), 'short', 0)).toThrow('invalid_webssh_recording_key')
  })
})
