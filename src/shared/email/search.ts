import type { EmailSearchQuery } from './model'

const OPERATOR_RE = /\b(from|to|subject|in|is|has|tag|before|after):(?:"([^"]*?)"|(\S+))/gi

function normalizeDate(value: string): string | undefined {
  try {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  } catch {
    return undefined
  }
}

export function parseEmailSearchQuery(input: string): EmailSearchQuery {
  const result: EmailSearchQuery = { query: '' }
  OPERATOR_RE.lastIndex = 0
  const matches: { full: string; op: string; value: string }[] = []
  let match: RegExpExecArray | null
  while ((match = OPERATOR_RE.exec(input)) !== null) {
    matches.push({ full: match[0], op: match[1]!.toLowerCase(), value: match[2] ?? match[3] ?? '' })
  }
  let remaining = input
  for (const entry of matches) remaining = remaining.replace(entry.full, '')
  result.query = remaining.replace(/\s+/g, ' ').trim()
  for (const { op, value } of matches) {
    switch (op) {
      case 'from':
        result.from = value
        break
      case 'to':
        result.to = value
        break
      case 'subject':
        result.subject = value
        break
      case 'in':
        result.folder = value.toLowerCase()
        break
      case 'is':
        switch (value.toLowerCase()) {
          case 'unread':
            result.isRead = false
            break
          case 'read':
            result.isRead = true
            break
          case 'starred':
            result.isStarred = true
            break
          case 'unstarred':
            result.isStarred = false
            break
          case 'important':
            result.important = true
            break
          case 'muted':
            result.muted = true
            break
          case 'followup':
            result.followUp = true
            break
        }
        break
      case 'has':
        if (value.toLowerCase() === 'attachment') result.hasAttachment = true
        break
      case 'tag':
        result.tag = value
        break
      case 'before':
        result.dateEnd = normalizeDate(value)
        break
      case 'after':
        result.dateStart = normalizeDate(value)
        break
    }
  }
  return result
}

export function emailSearchParams(query: EmailSearchQuery): Record<string, string> {
  const params: Record<string, string> = {}
  if (query.query) params.query = query.query
  if (query.from) params.from = query.from
  if (query.to) params.to = query.to
  if (query.subject) params.subject = query.subject
  if (query.folder) params.folder = query.folder
  if (query.isRead !== undefined) params.is_read = String(query.isRead)
  if (query.isStarred !== undefined) params.is_starred = String(query.isStarred)
  if (query.important !== undefined) params.is_important = String(query.important)
  if (query.muted !== undefined) params.is_muted = String(query.muted)
  if (query.followUp !== undefined) params.is_followup = String(query.followUp)
  if (query.hasAttachment) params.has_attachment = 'true'
  if (query.tag) params.tag = query.tag
  if (query.dateStart) params.date_start = query.dateStart
  if (query.dateEnd) params.date_end = query.dateEnd
  return params
}
