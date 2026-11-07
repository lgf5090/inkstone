// Host import (plan W7-02): `~/.ssh/config` and CSV are parsed to a preview first, then the confirmed
// rows are created. Imported hosts intentionally carry no credential/key; they appear as "missing
// reference" until the user attaches one, so an import cannot invent an authentication secret.

import type { WebsshImportCandidate, WebsshImportPreview } from '@shared/webssh/types'
import { ApiError } from '../lib/errors'
import {
  normalizeHostAddress,
  normalizeHostName,
  normalizeHostPort,
  normalizeHostTags,
  normalizeHostUsername,
} from './hosts'
import { normalizeProviderId } from '@shared/webssh/providers'

export const WEBSSH_IMPORT_CONTENT_MAX = 1024 * 1024
export const WEBSSH_IMPORT_CANDIDATE_MAX = 200

const WILDCARD = /[*?[\]!]/

function issueList(candidate: Omit<WebsshImportCandidate, 'issues'>): string[] {
  const issues: string[] = []
  try {
    normalizeHostName(candidate.name, true)
  } catch {
    issues.push('name_invalid')
  }
  try {
    normalizeHostAddress(candidate.host)
  } catch {
    issues.push('host_invalid')
  }
  try {
    normalizeHostPort(candidate.port)
  } catch {
    issues.push('port_invalid')
  }
  try {
    normalizeHostUsername(candidate.username)
  } catch {
    issues.push('username_missing')
  }
  try {
    normalizeHostTags(candidate.tags)
  } catch {
    issues.push('tags_invalid')
  }
  return issues
}

function toCandidate(raw: { name: string; host: string; port: number; username: string; tags: string[]; provider?: string }): WebsshImportCandidate {
  const candidate = {
    name: raw.name.trim(),
    host: raw.host.trim(),
    port: raw.port,
    username: raw.username.trim(),
    tags: raw.tags,
    provider: normalizeProviderId(raw.provider ?? ''),
  }
  return { ...candidate, issues: issueList(candidate) }
}

function parsePort(value: string): number {
  if (!value.trim()) return 22
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) ? parsed : 0
}

/** Splits a CSV line, honouring double quotes and `""` escapes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
    } else if (character === ',') {
      cells.push(cell)
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell)
  return cells
}

function splitTags(value: string): string[] {
  return value.split(/[|;]/).map((tag) => tag.trim()).filter(Boolean)
}

export function detectImportFormat(content: string): 'ssh-config' | 'csv' {
  return /^\s*(?:host|hostname|match)\s+/im.test(content) && /\bhostname\b|\buser\b/im.test(content)
    ? 'ssh-config'
    : 'csv'
}

export function parseSshConfig(content: string): WebsshImportPreview {
  const candidates: WebsshImportCandidate[] = []
  let rejected = 0
  let block: { aliases: string[]; hostname: string; port: number; username: string; provider: string } | null = null
  let skipBlock = false

  const flush = () => {
    if (!block) return
    if (skipBlock) {
      rejected += 1
      block = null
      return
    }
    const alias = block.aliases[0] ?? ''
    candidates.push(toCandidate({
      name: alias || block.hostname,
      host: block.hostname || alias,
      port: block.port,
      username: block.username,
      tags: [],
      provider: block.provider,
    }))
    block = null
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    const comment = /^\s*#\s*provider\s*:\s*(\S+)/i.exec(rawLine)
    if (comment) {
      if (block) block.provider = normalizeProviderId(comment[1])
      continue
    }
    if (!line || line.startsWith('#')) continue
    const match = /^(\S+)(?:\s+(.*))?$/.exec(line)
    if (!match) continue
    const keyword = match[1].toLowerCase()
    const argument = (match[2] ?? '').trim()
    if (keyword === 'host') {
      flush()
      const aliases = argument.split(/\s+/).filter(Boolean)
      block = { aliases, hostname: '', port: 22, username: '', provider: 'other' }
      // A pattern entry describes many machines; importing it as one host would be a guess.
      skipBlock = aliases.length === 0 || aliases.some((alias) => WILDCARD.test(alias))
      continue
    }
    if (keyword === 'match') {
      flush()
      skipBlock = false
      continue
    }
    if (!block || skipBlock) continue
    if (keyword === 'hostname') block.hostname = argument
    else if (keyword === 'port') block.port = parsePort(argument)
    else if (keyword === 'user') block.username = argument
  }
  flush()

  return {
    format: 'ssh-config',
    candidates: candidates.slice(0, WEBSSH_IMPORT_CANDIDATE_MAX),
    rejected: rejected + Math.max(0, candidates.length - WEBSSH_IMPORT_CANDIDATE_MAX),
  }
}

export function parseCsv(content: string): WebsshImportPreview {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  const candidates: WebsshImportCandidate[] = []
  let rejected = 0
  let columns: { name: number; host: number; port: number; username: number; tags: number; provider: number } | null = null

  for (const line of lines) {
    if (!line.trim()) continue
    const cells = splitCsvLine(line)
    if (!columns) {
      const header = cells.map((cell) => cell.trim().toLowerCase())
      if (header.includes('host') || header.includes('hostname')) {
        columns = {
          name: Math.max(0, header.indexOf('name')),
          host: Math.max(header.indexOf('host'), header.indexOf('hostname')),
          port: header.indexOf('port'),
          username: Math.max(header.indexOf('username'), header.indexOf('user')),
          tags: header.indexOf('tags'),
          provider: header.indexOf('provider'),
        }
        continue
      }
      columns = { name: 0, host: 1, port: 2, username: 3, tags: 4, provider: 5 }
    }
    try {
      const name = (cells[columns.name] ?? '').trim()
      const host = (cells[columns.host] ?? '').trim()
      if (!name || !host) {
        rejected += 1
        continue
      }
      candidates.push(toCandidate({
        name,
        host,
        port: parsePort(cells[columns.port] ?? ''),
        username: (cells[columns.username] ?? '').trim(),
        tags: columns.tags >= 0 ? splitTags(cells[columns.tags] ?? '') : [],
        provider: columns.provider >= 0 ? cells[columns.provider] ?? '' : '',
      }))
    } catch {
      rejected += 1
    }
  }

  return {
    format: 'csv',
    candidates: candidates.slice(0, WEBSSH_IMPORT_CANDIDATE_MAX),
    rejected: rejected + Math.max(0, candidates.length - WEBSSH_IMPORT_CANDIDATE_MAX),
  }
}

export function previewImport(input: unknown, format: unknown): WebsshImportPreview {
  if (typeof input !== 'string' || !input.trim()) throw ApiError.badRequest('Import content is required')
  if (input.length > WEBSSH_IMPORT_CONTENT_MAX) {
    throw ApiError.badRequest(`Import content cannot exceed ${WEBSSH_IMPORT_CONTENT_MAX} characters`)
  }
  const resolved = format === 'ssh-config' || format === 'csv'
    ? format
    : format === 'auto' || format === undefined || format === null || format === ''
      ? detectImportFormat(input)
      : null
  if (!resolved) throw ApiError.badRequest('Import format must be ssh-config, csv or auto')
  return resolved === 'ssh-config' ? parseSshConfig(input) : parseCsv(input)
}

export interface WebsshImportCommitInput {
  name: string
  host: string
  port: number
  username: string
  tags: string[]
  provider?: string
}

/** Validates one confirmed row and returns the normalized host input, or the reasons it was skipped. */
export function normalizeImportCommit(value: unknown): { input: WebsshImportCommitInput | null; issues: string[] } {
  if (typeof value !== 'object' || value === null) return { input: null, issues: ['invalid'] }
  const raw = value as Record<string, unknown>
  const issues: string[] = []
  let name = ''
  let host = ''
  let port = 22
  let username = ''
  let tags: string[] = []
  try {
    name = normalizeHostName(raw.name, true)
  } catch {
    issues.push('name_invalid')
  }
  try {
    host = normalizeHostAddress(raw.host)
  } catch {
    issues.push('host_invalid')
  }
  try {
    port = normalizeHostPort(raw.port)
  } catch {
    issues.push('port_invalid')
  }
  try {
    username = normalizeHostUsername(raw.username)
  } catch {
    issues.push('username_missing')
  }
  try {
    tags = normalizeHostTags(raw.tags)
  } catch {
    issues.push('tags_invalid')
  }
  return issues.length
    ? { input: null, issues }
    : { input: { name, host, port, username, tags, provider: normalizeProviderId(raw.provider) }, issues }
}
