// @vitest-environment node
// Sanitising and parsing are the boundary between a terminal and a model, so each rule is asserted
// on its own rather than through a mocked call.

import { describe, expect, it } from 'vitest'
import {
  boundedString,
  parseJsonObject,
  readConfidence,
  readInteger,
  readRiskLevel,
  readSeverity,
  readStringList,
  redactSecrets,
  stripTerminalControl,
  tailString,
  truncateMiddle,
} from '../src/worker/webssh/ai/text'

describe('stripTerminalControl', () => {
  it('removes colours, cursor moves and carriage returns', () => {
    expect(stripTerminalControl('\x1b[31mred\x1b[0m\r\nnext')).toBe('red\nnext')
    expect(stripTerminalControl('\x1b]0;title\x07hello')).toBe('hello')
    expect(stripTerminalControl('a\x00b\x07c')).toBe('abc')
  })
})

describe('redactSecrets', () => {
  it('removes a private key block', () => {
    const text = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'
    expect(redactSecrets(text)).toBe('[redacted private key]')
  })

  it('redacts assignment-style secrets', () => {
    expect(redactSecrets('password=hunter2')).toBe('password=[redacted]')
    expect(redactSecrets('api_key: sk-live-123')).toBe('api_key: [redacted]')
    expect(redactSecrets('Authorization: Bearer abc.def')).toBe('Authorization: [redacted]')
    expect(redactSecrets('curl --password pass123 https://x')).toBe('curl --password [redacted] https://x')
    expect(redactSecrets('sshpass -p s3cret ssh host')).toBe('sshpass -p [redacted] ssh host')
  })

  it('leaves ordinary output alone', () => {
    expect(redactSecrets('Permission denied (publickey)')).toBe('Permission denied (publickey)')
  })
})

describe('bounded text', () => {
  it('keeps the start for a bounded string and the tail for a transcript', () => {
    const text = `${'a'.repeat(100)}${'b'.repeat(100)}`
    expect(boundedString(text, 50)).toBe('a'.repeat(50))
    expect(tailString(text, 50)).toBe('b'.repeat(50))
  })

  it('cuts a long text in the middle', () => {
    const text = `${'a'.repeat(100)}${'b'.repeat(100)}`
    const cut = truncateMiddle(text, 60)
    expect(cut).toContain('[truncated]')
    expect(cut.startsWith('a')).toBe(true)
    expect(cut.endsWith('b')).toBe(true)
    expect(cut.length).toBeLessThanOrEqual(60)
  })
})

describe('parseJsonObject', () => {
  it('reads an answer wrapped in prose or fences', () => {
    expect(parseJsonObject('Here it is:\n```json\n{"command":"ls"}\n```')).toEqual({ command: 'ls' })
  })

  it('refuses a non-object answer', () => {
    expect(parseJsonObject('[1,2,3]')).toBeNull()
    expect(parseJsonObject('not json')).toBeNull()
  })
})

describe('validators', () => {
  it('defaults unknown enum values to the cautious arm', () => {
    expect(readRiskLevel('safe')).toBe('safe')
    expect(readRiskLevel('danger')).toBe('danger')
    expect(readRiskLevel('whatever')).toBe('caution')
    expect(readConfidence('high')).toBe('high')
    expect(readConfidence('nope')).toBe('low')
    expect(readSeverity('warning')).toBe('warning')
    expect(readSeverity('nope')).toBe('info')
  })

  it('bounds lists and integers', () => {
    expect(readStringList(['a', '', 1, 'b'], 1, 10)).toEqual(['a'])
    expect(readInteger(3.9, 1, 5)).toBe(3)
    expect(readInteger(9, 1, 5)).toBeNull()
    expect(readInteger('9', 1, 5)).toBeNull()
  })
})
