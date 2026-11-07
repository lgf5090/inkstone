/**
 * Text hygiene for every WebSSH AI call.
 *
 * Terminal output is untrusted input twice over: the remote host chose it and the reader pasted it.
 * This module removes the control sequences a model cannot read, redacts the shapes of secrets a
 * terminal often prints by accident, and cuts a long transcript in the middle so both the beginning
 * (the command that caused the problem) and the end (the error) survive.
 */

/** CSI, OSC and the two-character escapes xterm understands. */
// OSC first: the single-character branch below also covers `]`, so an unterminated ordering would
// leave the title text behind as ordinary output.
const ANSI_SEQUENCE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

/** The shapes a secret takes when a command or its output echo one. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/(authorization\s*:\s*)(?:bearer|basic)\s+[^\s]+/gi, '$1[redacted]'],
  [/((?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  [/((?:api[_-]?key|access[_-]?key|token|secret)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"'],
  [/(--(?:password|passwd|token)(?:=|\s+))(\S+)/gi, '$1[redacted]'],
  [/(sshpass\s+-p\s*)(\S+)/gi, '$1[redacted]'],
]

/** Terminal output as plain lines: no escapes, no carriage returns, no NUL bytes. */
export function stripTerminalControl(text: string): string {
  return text
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\x00/g, '')
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/** A transcript with the common secret shapes replaced before anything leaves the worker. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text)
}

/** Clean, redacted text ready for a prompt. */
export function sanitizeTerminalText(text: string): string {
  return redactSecrets(stripTerminalControl(text))
}

/**
 * Cut a long text in the middle rather than at the end.
 *
 * A terminal's first lines say what the reader ran and its last lines say how it failed; truncating
 * only the tail throws away the one line a diagnosis is usually about.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = '\n…[truncated]…\n'
  const budget = Math.max(2, maxChars - marker.length)
  const head = Math.ceil(budget * 0.35)
  const tail = budget - head
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`
}

/** One bounded, trimmed string, or '' when the value is not one. */
export function boundedString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxChars)
}

/**
 * The last `maxChars` of a string.
 *
 * A terminal's useful context is its tail: the error is at the bottom and the command that caused it
 * is a few lines above. Cutting from the front would keep the login banner and drop both.
 */
export function tailString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length <= maxChars ? text : text.slice(text.length - maxChars)
}

/** A bounded string with no empty answer, or null. */
export function optionalBoundedString(value: unknown, maxChars: number): string | null {
  const text = boundedString(value, maxChars)
  return text || null
}

/** A bounded count, or null when the value is not a finite non-negative integer. */
export function boundedCount(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(Math.trunc(value), max)
}

export type ParsedJsonObject = Record<string, unknown>

/**
 * The first complete JSON object in a model answer.
 *
 * Providers sometimes wrap JSON in prose or a fenced block even when asked not to. Extracting the
 * outermost brace pair is the one repair that cannot change the meaning of a well-formed answer, so
 * anything else is treated as unparseable rather than guessed at.
 */
export function parseJsonObject(text: string): ParsedJsonObject | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as ParsedJsonObject
  } catch {
    return null
  }
}

/** Up to `maxItems` non-empty strings from a JSON value. */
export function readStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim().slice(0, maxChars)
    if (text) out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

export type RiskLevel = 'safe' | 'caution' | 'danger'

/** A model's risk label, defaulting to `caution`: an unknown label is not permission. */
export function readRiskLevel(value: unknown): RiskLevel {
  return value === 'safe' || value === 'danger' ? value : 'caution'
}

/** A model's confidence label. */
export function readConfidence(value: unknown): 'low' | 'medium' | 'high' {
  return value === 'high' || value === 'medium' ? value : 'low'
}

/** A finding/severity label. */
export function readSeverity(value: unknown): 'info' | 'warning' | 'danger' {
  return value === 'warning' || value === 'danger' ? value : 'info'
}

/** A bounded integer field a model returned. */
export function readInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const parsed = Math.trunc(value)
  return parsed >= min && parsed <= max ? parsed : null
}
